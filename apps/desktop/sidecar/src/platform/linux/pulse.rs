use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use crate::runtime::{enqueue_frame_event, try_write_app_audio_binary_frame};
use crate::{
    AudioTarget, CaptureEndReason, CaptureOutcome, FrameQueue, APP_AUDIO_CHANNELS,
    APP_AUDIO_FRAME_BYTES, APP_AUDIO_FRAME_SIZE, APP_AUDIO_SAMPLE_RATE, PROTOCOL_VERSION,
};

#[derive(Clone)]
pub(super) struct LinuxAudioBackendProbe {
    pub(super) backend: &'static str,
    pub(super) uses_shell_outs: bool,
    pub(super) runtime_available: bool,
    pub(super) runtime_reason: Option<String>,
    pub(super) per_app_audio_supported: bool,
    pub(super) per_app_audio_reason: Option<String>,
    pub(super) per_app_audio_reason_code: Option<&'static str>,
}

struct LinuxAudioBackendProbeCacheEntry {
    expires_at: Instant,
    probe: LinuxAudioBackendProbe,
}

#[derive(Clone)]
struct LinuxPulseSinkInfo {
    index: u32,
    name: String,
    description: Option<String>,
    monitor_source_name: Option<String>,
}

#[derive(Clone)]
struct LinuxPulseTargetInfo {
    id: String,
    label: String,
    pid: u32,
    process_name: String,
    sink_index: u32,
    monitor_source_name: String,
}

struct LinuxPulseSinkInputInfo {
    sink_index: u32,
    pid: u32,
    app_name: String,
    process_name: String,
    media_name: Option<String>,
}

struct LinuxPulseServerInfo {
    default_sink_name: Option<String>,
}

struct LinuxPulseAudioSnapshot {
    default_sink_name: Option<String>,
    sinks: Vec<LinuxPulseSinkInfo>,
    targets: Vec<LinuxPulseTargetInfo>,
}

struct LinuxPulseCaptureSource {
    monitor_source_name: String,
    target_id: String,
}

struct LinuxPulseOperationState<T> {
    mainloop: *mut PaThreadedMainloop,
    completed: bool,
    value: Option<T>,
}

struct LinuxPulseSinkListState {
    mainloop: *mut PaThreadedMainloop,
    completed: bool,
    sinks: Vec<LinuxPulseSinkInfo>,
}

struct LinuxPulseSinkInputListState {
    mainloop: *mut PaThreadedMainloop,
    completed: bool,
    sink_inputs: Vec<LinuxPulseSinkInputInfo>,
}

type PaContextNotifyCb = unsafe extern "C" fn(*mut PaContext, *mut c_void);
type PaServerInfoCb = unsafe extern "C" fn(*mut PaContext, *const PaServerInfo, *mut c_void);
type PaSinkInfoCb = unsafe extern "C" fn(*mut PaContext, *const PaSinkInfo, i32, *mut c_void);
type PaSinkInputInfoCb =
    unsafe extern "C" fn(*mut PaContext, *const PaSinkInputInfo, i32, *mut c_void);

struct LinuxPulseLib {
    _pulse_handle: *mut c_void,
    _pulse_simple_handle: *mut c_void,
    pa_threaded_mainloop_new: unsafe extern "C" fn() -> *mut PaThreadedMainloop,
    pa_threaded_mainloop_free: unsafe extern "C" fn(*mut PaThreadedMainloop),
    pa_threaded_mainloop_start: unsafe extern "C" fn(*mut PaThreadedMainloop) -> i32,
    pa_threaded_mainloop_stop: unsafe extern "C" fn(*mut PaThreadedMainloop),
    pa_threaded_mainloop_lock: unsafe extern "C" fn(*mut PaThreadedMainloop),
    pa_threaded_mainloop_unlock: unsafe extern "C" fn(*mut PaThreadedMainloop),
    pa_threaded_mainloop_signal: unsafe extern "C" fn(*mut PaThreadedMainloop, i32),
    pa_threaded_mainloop_get_api:
        unsafe extern "C" fn(*mut PaThreadedMainloop) -> *mut PaMainloopApi,
    pa_context_new: unsafe extern "C" fn(*mut PaMainloopApi, *const c_char) -> *mut PaContext,
    pa_context_set_state_callback:
        unsafe extern "C" fn(*mut PaContext, Option<PaContextNotifyCb>, *mut c_void),
    pa_context_connect:
        unsafe extern "C" fn(*mut PaContext, *const c_char, i32, *const PaSpawnApi) -> i32,
    pa_context_disconnect: unsafe extern "C" fn(*mut PaContext),
    pa_context_unref: unsafe extern "C" fn(*mut PaContext),
    pa_context_get_state: unsafe extern "C" fn(*const PaContext) -> i32,
    pa_context_errno: unsafe extern "C" fn(*const PaContext) -> i32,
    pa_context_get_server_info: unsafe extern "C" fn(
        *mut PaContext,
        Option<PaServerInfoCb>,
        *mut c_void,
    ) -> *mut PaOperation,
    pa_context_get_sink_info_list:
        unsafe extern "C" fn(*mut PaContext, Option<PaSinkInfoCb>, *mut c_void) -> *mut PaOperation,
    pa_context_get_sink_input_info_list: unsafe extern "C" fn(
        *mut PaContext,
        Option<PaSinkInputInfoCb>,
        *mut c_void,
    ) -> *mut PaOperation,
    pa_operation_get_state: unsafe extern "C" fn(*const PaOperation) -> i32,
    pa_operation_unref: unsafe extern "C" fn(*mut PaOperation),
    pa_proplist_gets: unsafe extern "C" fn(*const PaProplist, *const c_char) -> *const c_char,
    pa_strerror: unsafe extern "C" fn(i32) -> *const c_char,
    pa_simple_new: unsafe extern "C" fn(
        *const c_char,
        *const c_char,
        i32,
        *const c_char,
        *const c_char,
        *const PaSampleSpec,
        *const PaChannelMap,
        *const PaBufferAttr,
        *mut i32,
    ) -> *mut PaSimple,
    pa_simple_free: unsafe extern "C" fn(*mut PaSimple),
    pa_simple_read: unsafe extern "C" fn(*mut PaSimple, *mut c_void, usize, *mut i32) -> i32,
}

unsafe impl Send for LinuxPulseLib {}
unsafe impl Sync for LinuxPulseLib {}

struct LinuxPulseConnection {
    lib: &'static LinuxPulseLib,
    mainloop: *mut PaThreadedMainloop,
    context: *mut PaContext,
}

#[repr(C)]
struct PaThreadedMainloop {
    _private: [u8; 0],
}

#[repr(C)]
struct PaMainloopApi {
    _private: [u8; 0],
}

#[repr(C)]
struct PaContext {
    _private: [u8; 0],
}

#[repr(C)]
struct PaOperation {
    _private: [u8; 0],
}

#[repr(C)]
struct PaSpawnApi {
    _private: [u8; 0],
}

#[repr(C)]
struct PaProplist {
    _private: [u8; 0],
}

#[repr(C)]
struct PaSimple {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PaSampleSpec {
    format: i32,
    rate: u32,
    channels: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PaChannelMap {
    channels: u8,
    map: [i32; 32],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PaCVolume {
    channels: u8,
    values: [u32; 32],
}

#[repr(C)]
struct PaBufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

#[repr(C)]
struct PaSinkInfo {
    name: *const c_char,
    index: u32,
    description: *const c_char,
    sample_spec: PaSampleSpec,
    channel_map: PaChannelMap,
    owner_module: u32,
    volume: PaCVolume,
    mute: i32,
    monitor_source: u32,
    monitor_source_name: *const c_char,
}

#[repr(C)]
struct PaSinkInputInfo {
    index: u32,
    name: *const c_char,
    owner_module: u32,
    client: u32,
    sink: u32,
    sample_spec: PaSampleSpec,
    channel_map: PaChannelMap,
    volume: PaCVolume,
    buffer_usec: u64,
    sink_usec: u64,
    resample_method: *const c_char,
    driver: *const c_char,
    mute: i32,
    proplist: *mut PaProplist,
}

#[repr(C)]
struct PaServerInfo {
    user_name: *const c_char,
    host_name: *const c_char,
    server_version: *const c_char,
    server_name: *const c_char,
    sample_spec: PaSampleSpec,
    default_sink_name: *const c_char,
    default_source_name: *const c_char,
    cookie: u32,
    channel_map: PaChannelMap,
}

const LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE: &str = "pulseaudio-native";
const LINUX_AUDIO_BACKEND_UNAVAILABLE_CODE: &str = "linux-native-audio-backend-unavailable";
const LINUX_AUDIO_BACKEND_PROBE_CACHE_TTL: Duration = Duration::from_secs(2);
const LINUX_PULSEAUDIO_LIBRARY_NAMES: [&str; 2] = ["libpulse.so.0", "libpulse.so"];
const LINUX_PULSEAUDIO_SIMPLE_LIBRARY_NAMES: [&str; 2] =
    ["libpulse-simple.so.0", "libpulse-simple.so"];
const LINUX_PULSEAUDIO_FALLBACK_LIBRARY_DIRS: [&str; 2] = [
    "/nix/var/nix/profiles/default/lib",
    "/run/current-system/sw/lib",
];
const LINUX_PULSE_TARGET_PREFIX: &str = "pulse:pid:";
const PA_ERR_CONNECTIONTERMINATED: i32 = 11;
const PA_ERR_KILLED: i32 = 12;
const PA_CONTEXT_READY: i32 = 4;
const PA_CONTEXT_FAILED: i32 = 5;
const PA_CONTEXT_TERMINATED: i32 = 6;
const PA_OPERATION_RUNNING: i32 = 0;
const PA_SAMPLE_FLOAT32LE: i32 = 5;
const PA_STREAM_RECORD: i32 = 2;
const PA_CONTEXT_NOFLAGS: i32 = 0;
const LINUX_PULSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const LINUX_PULSE_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
const LINUX_PULSE_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

static LINUX_AUDIO_BACKEND_PROBE_CACHE: OnceLock<Mutex<Option<LinuxAudioBackendProbeCacheEntry>>> =
    OnceLock::new();
static LINUX_PULSE_LIB: OnceLock<Result<LinuxPulseLib, String>> = OnceLock::new();

pub(super) fn probe_audio_backend() -> LinuxAudioBackendProbe {
    let cache = LINUX_AUDIO_BACKEND_PROBE_CACHE.get_or_init(|| Mutex::new(None));
    let now = Instant::now();

    if let Ok(cache_guard) = cache.lock() {
        if let Some(entry) = cache_guard.as_ref() {
            if now < entry.expires_at {
                return entry.probe.clone();
            }
        }
    }

    let probe = match linux_pulse_lib() {
        Ok(_) => match linux_pulse_audio_snapshot() {
            Ok(_) => LinuxAudioBackendProbe {
                backend: LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE,
                uses_shell_outs: false,
                runtime_available: true,
                runtime_reason: None,
                per_app_audio_supported: true,
                per_app_audio_reason: None,
                per_app_audio_reason_code: None,
            },
            Err(error) => LinuxAudioBackendProbe {
                backend: LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE,
                uses_shell_outs: false,
                runtime_available: true,
                runtime_reason: None,
                per_app_audio_supported: false,
                per_app_audio_reason: Some(error),
                per_app_audio_reason_code: Some(LINUX_AUDIO_BACKEND_UNAVAILABLE_CODE),
            },
        },
        Err(error) => LinuxAudioBackendProbe {
            backend: LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE,
            uses_shell_outs: false,
            runtime_available: false,
            runtime_reason: Some(error.clone()),
            per_app_audio_supported: false,
            per_app_audio_reason: Some(error),
            per_app_audio_reason_code: Some(LINUX_AUDIO_BACKEND_UNAVAILABLE_CODE),
        },
    };

    if let Ok(mut cache_guard) = cache.lock() {
        *cache_guard = Some(LinuxAudioBackendProbeCacheEntry {
            expires_at: Instant::now() + LINUX_AUDIO_BACKEND_PROBE_CACHE_TTL,
            probe: probe.clone(),
        });
    }

    probe
}

pub(super) fn list_audio_targets() -> Result<Vec<AudioTarget>, String> {
    Ok(linux_pulse_audio_snapshot()?
        .targets
        .into_iter()
        .map(|target| AudioTarget {
            id: target.id,
            label: target.label,
            pid: target.pid,
            process_name: target.process_name,
        })
        .collect())
}

pub(super) fn capture_loopback_audio(
    session_id: &str,
    target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    if target_pid == 0 && self_exclude_pid.is_some() {
        eprintln!(
            "[capture-sidecar] selfExcludePid is not supported on Linux loopback capture; proceeding without exclusion"
        );
    }
    let capture_source = match linux_pulse_capture_source_for_target(if target_pid == 0 {
        "loopback"
    } else {
        target_id
    }) {
        Ok(capture_source) => capture_source,
        Err(error) => return CaptureOutcome::capture_error(error),
    };

    let lib = match linux_pulse_lib() {
        Ok(lib) => lib,
        Err(error) => return CaptureOutcome::capture_error(error),
    };

    let app_name = CString::new("Sharkord Capture Sidecar")
        .unwrap_or_else(|_| CString::new("Sharkord").unwrap());
    let stream_name = CString::new("Sharkord App Audio Capture")
        .unwrap_or_else(|_| CString::new("Capture").unwrap());
    let source_name = match CString::new(capture_source.monitor_source_name.clone()) {
        Ok(source_name) => source_name,
        Err(error) => {
            return CaptureOutcome::capture_error(format!(
                "Invalid Linux monitor source name: {error}"
            ));
        }
    };

    let sample_spec = PaSampleSpec {
        format: PA_SAMPLE_FLOAT32LE,
        rate: APP_AUDIO_SAMPLE_RATE,
        channels: APP_AUDIO_CHANNELS as u8,
    };
    let mut error_code = 0;
    let simple = unsafe {
        (lib.pa_simple_new)(
            std::ptr::null(),
            app_name.as_ptr(),
            PA_STREAM_RECORD,
            source_name.as_ptr(),
            stream_name.as_ptr(),
            &sample_spec,
            std::ptr::null(),
            std::ptr::null(),
            &mut error_code,
        )
    };

    if simple.is_null() {
        return CaptureOutcome::capture_error(format!(
            "Failed to start Linux audio capture: {}",
            linux_pulse_strerror(lib, error_code)
        ));
    }

    let mut sequence: u64 = 0;
    let mut frame_bytes = vec![0u8; APP_AUDIO_FRAME_BYTES];

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            unsafe { (lib.pa_simple_free)(simple) };
            return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
        }

        if unsafe {
            (lib.pa_simple_read)(
                simple,
                frame_bytes.as_mut_ptr().cast::<c_void>(),
                frame_bytes.len(),
                &mut error_code,
            )
        } < 0
        {
            unsafe { (lib.pa_simple_free)(simple) };
            if matches!(error_code, PA_ERR_CONNECTIONTERMINATED | PA_ERR_KILLED) {
                return CaptureOutcome::from_reason(CaptureEndReason::DeviceLost);
            }
            return CaptureOutcome::capture_error(format!(
                "Failed reading Linux audio frames: {}",
                linux_pulse_strerror(lib, error_code)
            ));
        }

        if target_pid != 0 && !std::path::Path::new(&format!("/proc/{target_pid}")).exists() {
            unsafe { (lib.pa_simple_free)(simple) };
            return CaptureOutcome::from_reason(CaptureEndReason::AppExited);
        }

        let mut frame_samples = frame_bytes
            .chunks_exact(4)
            .map(|sample_bytes| {
                f32::from_le_bytes([
                    sample_bytes[0],
                    sample_bytes[1],
                    sample_bytes[2],
                    sample_bytes[3],
                ])
            })
            .collect::<Vec<f32>>();
        clamp_audio_samples(&mut frame_samples);

        emit_linux_audio_frame(
            session_id,
            &capture_source.target_id,
            sequence,
            &frame_samples,
            &frame_queue,
            &app_audio_binary_stream,
        );
        sequence = sequence.saturating_add(1);
    }
}

fn parse_linux_pulse_target_id(target_id: &str) -> Option<(u32, u32)> {
    let raw = target_id.strip_prefix(LINUX_PULSE_TARGET_PREFIX)?;
    let (pid, sink_index) = raw.split_once(":sink:")?;
    let pid = pid.parse::<u32>().ok()?;
    let sink_index = sink_index.parse::<u32>().ok()?;

    Some((pid, sink_index))
}

fn linux_cstr_to_string(value: *const c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }

    unsafe { CStr::from_ptr(value) }
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn linux_pulse_signal_mainloop(mainloop: *mut PaThreadedMainloop) {
    if mainloop.is_null() {
        return;
    }

    if let Ok(lib) = linux_pulse_lib() {
        unsafe { (lib.pa_threaded_mainloop_signal)(mainloop, 0) };
    }
}

fn linux_library_search_paths() -> Vec<PathBuf> {
    let mut search_paths = Vec::new();

    for env_name in ["LD_LIBRARY_PATH", "NIX_LD_LIBRARY_PATH"] {
        let Some(value) = std::env::var_os(env_name) else {
            continue;
        };

        for path in std::env::split_paths(&value) {
            if path.as_os_str().is_empty() || search_paths.iter().any(|existing| existing == &path)
            {
                continue;
            }

            search_paths.push(path);
        }
    }

    for directory in LINUX_PULSEAUDIO_FALLBACK_LIBRARY_DIRS {
        let path = PathBuf::from(directory);
        if search_paths.iter().any(|existing| existing == &path) {
            continue;
        }

        search_paths.push(path);
    }

    search_paths
}

fn linux_dlopen_path(candidate_path: &std::path::Path) -> Option<*mut c_void> {
    if !candidate_path.is_file() {
        return None;
    }

    let candidate_path = CString::new(candidate_path.to_string_lossy().as_ref()).ok()?;
    let handle =
        unsafe { libc::dlopen(candidate_path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };

    if handle.is_null() {
        return None;
    }

    Some(handle)
}

fn linux_dlopen_any(library_names: &[&str]) -> Result<*mut c_void, String> {
    for library_name in library_names {
        let Ok(library_name) = CString::new(*library_name) else {
            continue;
        };

        let handle =
            unsafe { libc::dlopen(library_name.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
        if !handle.is_null() {
            return Ok(handle);
        }
    }

    for search_path in linux_library_search_paths() {
        if !search_path.is_dir() {
            continue;
        }

        for library_name in library_names {
            let candidate_path = search_path.join(library_name);
            if let Some(handle) = linux_dlopen_path(&candidate_path) {
                return Ok(handle);
            }
        }
    }

    if let Ok(entries) = fs::read_dir("/nix/store") {
        for entry in entries.flatten() {
            for library_name in library_names {
                let candidate_path = entry.path().join("lib").join(library_name);
                if let Some(handle) = linux_dlopen_path(&candidate_path) {
                    return Ok(handle);
                }
            }
        }
    }

    Err(format!(
        "Could not load any of the required Linux audio libraries: {}",
        library_names.join(", ")
    ))
}

unsafe fn linux_load_symbol<T: Copy>(handle: *mut c_void, symbol_name: &CStr) -> Result<T, String> {
    let symbol = libc::dlsym(handle, symbol_name.as_ptr());
    if symbol.is_null() {
        return Err(format!(
            "Missing Linux audio symbol `{}`.",
            symbol_name.to_string_lossy()
        ));
    }

    Ok(std::mem::transmute_copy(&symbol))
}

fn linux_pulse_lib() -> Result<&'static LinuxPulseLib, String> {
    let result = LINUX_PULSE_LIB.get_or_init(|| {
        let pulse_handle = linux_dlopen_any(&LINUX_PULSEAUDIO_LIBRARY_NAMES)?;
        let pulse_simple_handle = linux_dlopen_any(&LINUX_PULSEAUDIO_SIMPLE_LIBRARY_NAMES)?;

        unsafe {
            let load_symbol = |handle: *mut c_void, symbol_name: &'static [u8]| {
                linux_load_symbol::<unsafe extern "C" fn()>(
                    handle,
                    CStr::from_bytes_with_nul_unchecked(symbol_name),
                )
            };

            let lib = LinuxPulseLib {
                _pulse_handle: pulse_handle,
                _pulse_simple_handle: pulse_simple_handle,
                pa_threaded_mainloop_new: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_new\0",
                )?),
                pa_threaded_mainloop_free: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_free\0",
                )?),
                pa_threaded_mainloop_start: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_start\0",
                )?),
                pa_threaded_mainloop_stop: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_stop\0",
                )?),
                pa_threaded_mainloop_lock: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_lock\0",
                )?),
                pa_threaded_mainloop_unlock: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_unlock\0",
                )?),
                pa_threaded_mainloop_signal: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_signal\0",
                )?),
                pa_threaded_mainloop_get_api: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_threaded_mainloop_get_api\0",
                )?),
                pa_context_new: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_new\0",
                )?),
                pa_context_set_state_callback: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_set_state_callback\0",
                )?),
                pa_context_connect: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_connect\0",
                )?),
                pa_context_disconnect: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_disconnect\0",
                )?),
                pa_context_unref: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_unref\0",
                )?),
                pa_context_get_state: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_get_state\0",
                )?),
                pa_context_errno: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_errno\0",
                )?),
                pa_context_get_server_info: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_get_server_info\0",
                )?),
                pa_context_get_sink_info_list: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_get_sink_info_list\0",
                )?),
                pa_context_get_sink_input_info_list: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_context_get_sink_input_info_list\0",
                )?),
                pa_operation_get_state: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_operation_get_state\0",
                )?),
                pa_operation_unref: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_operation_unref\0",
                )?),
                pa_proplist_gets: std::mem::transmute(load_symbol(
                    pulse_handle,
                    b"pa_proplist_gets\0",
                )?),
                pa_strerror: std::mem::transmute(load_symbol(pulse_handle, b"pa_strerror\0")?),
                pa_simple_new: std::mem::transmute(load_symbol(
                    pulse_simple_handle,
                    b"pa_simple_new\0",
                )?),
                pa_simple_free: std::mem::transmute(load_symbol(
                    pulse_simple_handle,
                    b"pa_simple_free\0",
                )?),
                pa_simple_read: std::mem::transmute(load_symbol(
                    pulse_simple_handle,
                    b"pa_simple_read\0",
                )?),
            };

            Ok(lib)
        }
    });

    result.as_ref().map_err(Clone::clone)
}

fn linux_pulse_strerror(lib: &LinuxPulseLib, error_code: i32) -> String {
    linux_cstr_to_string(unsafe { (lib.pa_strerror)(error_code) })
        .unwrap_or_else(|| format!("PulseAudio error {error_code}"))
}

fn linux_pulse_proplist_get(
    lib: &LinuxPulseLib,
    proplist: *mut PaProplist,
    key: &str,
) -> Option<String> {
    let Ok(key) = CString::new(key) else {
        return None;
    };

    linux_cstr_to_string(unsafe { (lib.pa_proplist_gets)(proplist, key.as_ptr()) })
}

unsafe extern "C" fn linux_pulse_context_state_callback(
    _context: *mut PaContext,
    userdata: *mut c_void,
) {
    linux_pulse_signal_mainloop(userdata.cast::<PaThreadedMainloop>());
}

unsafe extern "C" fn linux_pulse_server_info_callback(
    _context: *mut PaContext,
    info: *const PaServerInfo,
    userdata: *mut c_void,
) {
    let Some(state) = userdata
        .cast::<LinuxPulseOperationState<LinuxPulseServerInfo>>()
        .as_mut()
    else {
        return;
    };

    if !info.is_null() {
        state.value = Some(LinuxPulseServerInfo {
            default_sink_name: linux_cstr_to_string((*info).default_sink_name),
        });
    }

    state.completed = true;
    linux_pulse_signal_mainloop(state.mainloop);
}

unsafe extern "C" fn linux_pulse_sink_info_callback(
    _context: *mut PaContext,
    info: *const PaSinkInfo,
    eol: i32,
    userdata: *mut c_void,
) {
    let Some(state) = userdata.cast::<LinuxPulseSinkListState>().as_mut() else {
        return;
    };

    if eol != 0 || info.is_null() {
        state.completed = true;
        linux_pulse_signal_mainloop(state.mainloop);
        return;
    }

    let sink = &*info;
    let Some(name) = linux_cstr_to_string(sink.name) else {
        return;
    };

    state.sinks.push(LinuxPulseSinkInfo {
        index: sink.index,
        name,
        description: linux_cstr_to_string(sink.description),
        monitor_source_name: linux_cstr_to_string(sink.monitor_source_name),
    });
}

unsafe extern "C" fn linux_pulse_sink_input_info_callback(
    _context: *mut PaContext,
    info: *const PaSinkInputInfo,
    eol: i32,
    userdata: *mut c_void,
) {
    let Some(state) = userdata.cast::<LinuxPulseSinkInputListState>().as_mut() else {
        return;
    };

    if eol != 0 || info.is_null() {
        state.completed = true;
        linux_pulse_signal_mainloop(state.mainloop);
        return;
    }

    let Ok(lib) = linux_pulse_lib() else {
        state.completed = true;
        linux_pulse_signal_mainloop(state.mainloop);
        return;
    };

    let sink_input = &*info;
    let Some(pid) = linux_pulse_proplist_get(lib, sink_input.proplist, "application.process.id")
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return;
    };

    let app_name = linux_pulse_proplist_get(lib, sink_input.proplist, "application.name")
        .or_else(|| linux_cstr_to_string(sink_input.name))
        .unwrap_or_else(|| "Unknown app".to_string());
    let process_name =
        linux_pulse_proplist_get(lib, sink_input.proplist, "application.process.binary")
            .unwrap_or_else(|| app_name.clone());
    let media_name = linux_pulse_proplist_get(lib, sink_input.proplist, "media.name")
        .or_else(|| linux_cstr_to_string(sink_input.name))
        .filter(|value| !value.eq_ignore_ascii_case(&app_name));

    state.sink_inputs.push(LinuxPulseSinkInputInfo {
        sink_index: sink_input.sink,
        pid,
        app_name,
        process_name,
        media_name,
    });
}

impl LinuxPulseConnection {
    fn connect() -> Result<Self, String> {
        let lib = linux_pulse_lib()?;
        let mainloop = unsafe { (lib.pa_threaded_mainloop_new)() };
        if mainloop.is_null() {
            return Err("Failed to create the Linux audio mainloop.".to_string());
        }

        let start_result = unsafe { (lib.pa_threaded_mainloop_start)(mainloop) };
        if start_result < 0 {
            unsafe { (lib.pa_threaded_mainloop_free)(mainloop) };
            return Err("Failed to start the Linux audio mainloop.".to_string());
        }

        unsafe { (lib.pa_threaded_mainloop_lock)(mainloop) };

        let app_name =
            CString::new("Sharkord Capture Sidecar").map_err(|error| error.to_string())?;
        let context = unsafe {
            (lib.pa_context_new)(
                (lib.pa_threaded_mainloop_get_api)(mainloop),
                app_name.as_ptr(),
            )
        };
        if context.is_null() {
            unsafe {
                (lib.pa_threaded_mainloop_unlock)(mainloop);
                (lib.pa_threaded_mainloop_stop)(mainloop);
                (lib.pa_threaded_mainloop_free)(mainloop);
            }
            return Err("Failed to create the Linux audio context.".to_string());
        }

        unsafe {
            (lib.pa_context_set_state_callback)(
                context,
                Some(linux_pulse_context_state_callback),
                mainloop.cast::<c_void>(),
            );
        }

        if unsafe {
            (lib.pa_context_connect)(
                context,
                std::ptr::null(),
                PA_CONTEXT_NOFLAGS,
                std::ptr::null(),
            )
        } < 0
        {
            let error = linux_pulse_strerror(lib, unsafe { (lib.pa_context_errno)(context) });
            unsafe {
                (lib.pa_context_unref)(context);
                (lib.pa_threaded_mainloop_unlock)(mainloop);
                (lib.pa_threaded_mainloop_stop)(mainloop);
                (lib.pa_threaded_mainloop_free)(mainloop);
            }
            return Err(format!(
                "Failed to connect to the Linux audio server: {error}"
            ));
        }

        let connection = Self {
            lib,
            mainloop,
            context,
        };

        if let Err(error) = connection.wait_for_ready_locked() {
            unsafe { (lib.pa_threaded_mainloop_unlock)(mainloop) };
            drop(connection);
            return Err(error);
        }

        unsafe { (lib.pa_threaded_mainloop_unlock)(mainloop) };
        Ok(connection)
    }

    fn wait_for_ready_locked(&self) -> Result<(), String> {
        let deadline = Instant::now() + LINUX_PULSE_CONNECT_TIMEOUT;

        loop {
            let state = unsafe { (self.lib.pa_context_get_state)(self.context) };
            match state {
                PA_CONTEXT_READY => return Ok(()),
                PA_CONTEXT_FAILED | PA_CONTEXT_TERMINATED => {
                    let error = linux_pulse_strerror(self.lib, unsafe {
                        (self.lib.pa_context_errno)(self.context)
                    });
                    return Err(format!(
                        "Failed to connect to the Linux audio server: {error}"
                    ));
                }
                _ => {
                    if Instant::now() >= deadline {
                        return Err(
                            "Timed out while waiting for the Linux audio server to become ready."
                                .to_string(),
                        );
                    }

                    unsafe { (self.lib.pa_threaded_mainloop_unlock)(self.mainloop) };
                    thread::sleep(LINUX_PULSE_WAIT_POLL_INTERVAL);
                    unsafe { (self.lib.pa_threaded_mainloop_lock)(self.mainloop) };
                }
            }
        }
    }

    fn wait_for_operation_locked(
        &self,
        operation: *mut PaOperation,
        completed: &mut bool,
    ) -> Result<(), String> {
        if operation.is_null() {
            let error = linux_pulse_strerror(self.lib, unsafe {
                (self.lib.pa_context_errno)(self.context)
            });
            return Err(format!("Linux audio query failed: {error}"));
        }

        let deadline = Instant::now() + LINUX_PULSE_OPERATION_TIMEOUT;

        loop {
            if *completed {
                break;
            }

            let context_state = unsafe { (self.lib.pa_context_get_state)(self.context) };
            if matches!(context_state, PA_CONTEXT_FAILED | PA_CONTEXT_TERMINATED) {
                let error = linux_pulse_strerror(self.lib, unsafe {
                    (self.lib.pa_context_errno)(self.context)
                });
                unsafe { (self.lib.pa_operation_unref)(operation) };
                return Err(format!("Linux audio server disconnected: {error}"));
            }

            let operation_state = unsafe { (self.lib.pa_operation_get_state)(operation) };
            if operation_state != PA_OPERATION_RUNNING {
                break;
            }

            if Instant::now() >= deadline {
                unsafe { (self.lib.pa_operation_unref)(operation) };
                return Err(
                    "Timed out while waiting for the Linux audio server to answer the query."
                        .to_string(),
                );
            }

            unsafe { (self.lib.pa_threaded_mainloop_unlock)(self.mainloop) };
            thread::sleep(LINUX_PULSE_WAIT_POLL_INTERVAL);
            unsafe { (self.lib.pa_threaded_mainloop_lock)(self.mainloop) };
        }

        unsafe { (self.lib.pa_operation_unref)(operation) };
        Ok(())
    }

    fn get_server_info(&self) -> Result<LinuxPulseServerInfo, String> {
        unsafe { (self.lib.pa_threaded_mainloop_lock)(self.mainloop) };

        let mut state = LinuxPulseOperationState::<LinuxPulseServerInfo> {
            mainloop: self.mainloop,
            completed: false,
            value: None,
        };
        let operation = unsafe {
            (self.lib.pa_context_get_server_info)(
                self.context,
                Some(linux_pulse_server_info_callback),
                (&mut state as *mut LinuxPulseOperationState<LinuxPulseServerInfo>)
                    .cast::<c_void>(),
            )
        };

        let result = self
            .wait_for_operation_locked(operation, &mut state.completed)
            .and_then(|_| {
                state
                    .value
                    .ok_or_else(|| "Failed to query the default Linux audio sink.".to_string())
            });

        unsafe { (self.lib.pa_threaded_mainloop_unlock)(self.mainloop) };
        result
    }

    fn list_sinks(&self) -> Result<Vec<LinuxPulseSinkInfo>, String> {
        unsafe { (self.lib.pa_threaded_mainloop_lock)(self.mainloop) };

        let mut state = LinuxPulseSinkListState {
            mainloop: self.mainloop,
            completed: false,
            sinks: Vec::new(),
        };
        let operation = unsafe {
            (self.lib.pa_context_get_sink_info_list)(
                self.context,
                Some(linux_pulse_sink_info_callback),
                (&mut state as *mut LinuxPulseSinkListState).cast::<c_void>(),
            )
        };

        let result = self
            .wait_for_operation_locked(operation, &mut state.completed)
            .map(|_| state.sinks);

        unsafe { (self.lib.pa_threaded_mainloop_unlock)(self.mainloop) };
        result
    }

    fn list_sink_inputs(&self) -> Result<Vec<LinuxPulseSinkInputInfo>, String> {
        unsafe { (self.lib.pa_threaded_mainloop_lock)(self.mainloop) };

        let mut state = LinuxPulseSinkInputListState {
            mainloop: self.mainloop,
            completed: false,
            sink_inputs: Vec::new(),
        };
        let operation = unsafe {
            (self.lib.pa_context_get_sink_input_info_list)(
                self.context,
                Some(linux_pulse_sink_input_info_callback),
                (&mut state as *mut LinuxPulseSinkInputListState).cast::<c_void>(),
            )
        };

        let result = self
            .wait_for_operation_locked(operation, &mut state.completed)
            .map(|_| state.sink_inputs);

        unsafe { (self.lib.pa_threaded_mainloop_unlock)(self.mainloop) };
        result
    }
}

impl Drop for LinuxPulseConnection {
    fn drop(&mut self) {
        unsafe {
            (self.lib.pa_threaded_mainloop_lock)(self.mainloop);
            (self.lib.pa_context_disconnect)(self.context);
            (self.lib.pa_context_unref)(self.context);
            (self.lib.pa_threaded_mainloop_unlock)(self.mainloop);
            (self.lib.pa_threaded_mainloop_stop)(self.mainloop);
            (self.lib.pa_threaded_mainloop_free)(self.mainloop);
        }
    }
}

fn linux_pulse_audio_snapshot() -> Result<LinuxPulseAudioSnapshot, String> {
    let connection = LinuxPulseConnection::connect()?;
    let server_info = connection.get_server_info()?;
    let sinks = connection.list_sinks()?;
    let sink_inputs = connection.list_sink_inputs()?;

    if sinks.is_empty() {
        return Err(
            "No capture-capable Linux audio sinks were found for the current session.".to_string(),
        );
    }

    let sinks_by_index = sinks
        .iter()
        .map(|sink| (sink.index, sink))
        .collect::<HashMap<_, _>>();
    let mut grouped_targets = HashMap::<(u32, u32), LinuxPulseTargetInfo>::new();

    for sink_input in sink_inputs {
        let Some(sink) = sinks_by_index.get(&sink_input.sink_index) else {
            continue;
        };
        let Some(monitor_source_name) = sink.monitor_source_name.clone() else {
            continue;
        };

        let key = (sink_input.pid, sink_input.sink_index);
        let stream_detail = sink_input.media_name.clone();
        let sink_detail = sink
            .description
            .clone()
            .or_else(|| Some(sink.name.clone()))
            .filter(|value| !value.eq_ignore_ascii_case(&sink_input.app_name));
        let label = match (stream_detail, sink_detail) {
            (Some(stream_detail), Some(sink_detail)) => format!(
                "{} [{}] - {} via {} ({})",
                sink_input.app_name,
                sink_input.process_name,
                stream_detail,
                sink_detail,
                sink_input.pid
            ),
            (Some(stream_detail), None) => format!(
                "{} [{}] - {} ({})",
                sink_input.app_name, sink_input.process_name, stream_detail, sink_input.pid
            ),
            (None, Some(sink_detail)) => format!(
                "{} [{}] via {} ({})",
                sink_input.app_name, sink_input.process_name, sink_detail, sink_input.pid
            ),
            (None, None) => format!(
                "{} [{}] ({})",
                sink_input.app_name, sink_input.process_name, sink_input.pid
            ),
        };

        grouped_targets
            .entry(key)
            .or_insert_with(|| LinuxPulseTargetInfo {
                id: format!(
                    "{LINUX_PULSE_TARGET_PREFIX}{}:sink:{}",
                    sink_input.pid, sink_input.sink_index
                ),
                label,
                pid: sink_input.pid,
                process_name: sink_input.process_name.clone(),
                sink_index: sink_input.sink_index,
                monitor_source_name,
            });
    }

    let mut targets = grouped_targets.into_values().collect::<Vec<_>>();
    targets.sort_by(|left, right| left.label.cmp(&right.label));

    Ok(LinuxPulseAudioSnapshot {
        default_sink_name: server_info.default_sink_name,
        sinks,
        targets,
    })
}

fn linux_default_pulse_capture_source(
    snapshot: &LinuxPulseAudioSnapshot,
) -> Result<LinuxPulseCaptureSource, String> {
    if let Some(default_sink_name) = snapshot.default_sink_name.as_deref() {
        if let Some(sink) = snapshot
            .sinks
            .iter()
            .find(|sink| sink.name == default_sink_name)
            .and_then(|sink| {
                sink.monitor_source_name
                    .as_deref()
                    .map(|monitor_source_name| LinuxPulseCaptureSource {
                        monitor_source_name: monitor_source_name.to_string(),
                        target_id: "loopback".to_string(),
                    })
            })
        {
            return Ok(sink);
        }
    }

    snapshot
        .sinks
        .iter()
        .find_map(|sink| {
            sink.monitor_source_name
                .as_deref()
                .map(|monitor_source_name| LinuxPulseCaptureSource {
                    monitor_source_name: monitor_source_name.to_string(),
                    target_id: "loopback".to_string(),
                })
        })
        .ok_or_else(|| {
            "No Linux audio monitor source is available for system audio capture.".to_string()
        })
}

fn linux_pulse_capture_source_for_target(
    target_id: &str,
) -> Result<LinuxPulseCaptureSource, String> {
    if target_id == "loopback" {
        return linux_default_pulse_capture_source(&linux_pulse_audio_snapshot()?);
    }

    let (pid, sink_index) = parse_linux_pulse_target_id(target_id)
        .ok_or_else(|| "Invalid Linux audio target id.".to_string())?;

    let snapshot = linux_pulse_audio_snapshot()?;
    snapshot
        .targets
        .into_iter()
        .find(|target| target.pid == pid && target.sink_index == sink_index)
        .map(|target| LinuxPulseCaptureSource {
            monitor_source_name: target.monitor_source_name,
            target_id: target.id,
        })
        .ok_or_else(|| format!("Target audio source `{target_id}` is not available"))
}

fn clamp_audio_samples(frame_samples: &mut [f32]) {
    for sample in frame_samples.iter_mut() {
        *sample = sample.clamp(-1.0, 1.0);
    }
}

fn emit_linux_audio_frame(
    session_id: &str,
    target_id: &str,
    sequence: u64,
    frame_samples: &[f32],
    frame_queue: &Arc<FrameQueue>,
    app_audio_binary_stream: &Option<Arc<Mutex<Option<TcpStream>>>>,
) {
    let wrote_binary = app_audio_binary_stream
        .as_ref()
        .map(|stream_slot| {
            try_write_app_audio_binary_frame(
                stream_slot,
                session_id,
                target_id,
                sequence,
                APP_AUDIO_SAMPLE_RATE as usize,
                APP_AUDIO_CHANNELS,
                APP_AUDIO_FRAME_SIZE,
                PROTOCOL_VERSION,
                0,
                frame_samples,
            )
        })
        .unwrap_or(false);

    if !wrote_binary {
        let frame_bytes = bytemuck::cast_slice(frame_samples);
        let pcm_base64 = BASE64.encode(frame_bytes);

        enqueue_frame_event(
            frame_queue,
            session_id,
            target_id,
            sequence,
            APP_AUDIO_SAMPLE_RATE as usize,
            APP_AUDIO_FRAME_SIZE,
            pcm_base64,
        );
    }
}
