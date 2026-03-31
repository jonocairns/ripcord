use serde_json::{json, Value};
mod platform;
mod protocol;
mod runtime;

#[cfg(any(windows, test, target_os = "linux"))]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::ffi::{c_char, c_void, CStr, CString};
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "macos")]
use std::io::Read;
use std::io::{self, BufRead};
use std::net::TcpStream;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, RecvTimeoutError};
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use base64::engine::general_purpose::STANDARD as BASE64;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use base64::Engine;
#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(windows)]
use std::ptr;
#[cfg(windows)]
use windows::core::{IUnknown, Interface, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, WAIT_TIMEOUT};
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient, IAudioClient,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_INVALID_STREAM_FLAG, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
#[cfg(windows)]
use windows::Win32::System::Variant::VT_BLOB;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};
#[cfg(windows)]
use windows_core::implement;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub(crate) use protocol::PushKeybindKind;
#[cfg(target_os = "linux")]
pub(crate) use protocol::APP_AUDIO_FRAME_BYTES;
#[cfg(target_os = "macos")]
pub(crate) use protocol::MAX_APP_AUDIO_BINARY_FRAME_BYTES;
pub(crate) use protocol::{
    AudioTarget, CaptureEndReason, CaptureOutcome, ListTargetsParams, ResolveSourceParams,
    SetPushKeybindsParams, SidecarRequest, StartAudioCaptureParams, StopAudioCaptureParams,
    APP_AUDIO_CHANNELS, APP_AUDIO_FRAME_SIZE, APP_AUDIO_SAMPLE_RATE, PCM_ENCODING,
    PROTOCOL_VERSION,
};
#[cfg(target_os = "macos")]
pub(crate) use protocol::{AudioTargetListResponse, ResolveSourceResult, MACOS_HELPER_BINARY_NAME};
pub(crate) use runtime::{
    audio_capture_binary_egress_info, enqueue_frame_event, enqueue_push_keybind_state_event,
    now_unix_ms, start_app_audio_binary_egress, start_frame_writer,
    try_write_app_audio_binary_frame, write_event, write_response, FrameQueue, PushKeybindWatcher,
};

#[derive(Debug)]
struct CaptureSession {
    session_id: String,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct LinuxPulseSinkInfo {
    index: u32,
    name: String,
    description: Option<String>,
    monitor_source_name: Option<String>,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct LinuxPulseTargetInfo {
    id: String,
    label: String,
    pid: u32,
    process_name: String,
    sink_index: u32,
    monitor_source_name: String,
}

#[cfg(target_os = "linux")]
struct LinuxPulseSinkInputInfo {
    sink_index: u32,
    pid: u32,
    app_name: String,
    process_name: String,
    media_name: Option<String>,
}

#[cfg(target_os = "linux")]
struct LinuxPulseServerInfo {
    default_sink_name: Option<String>,
}

#[cfg(target_os = "linux")]
struct LinuxPulseAudioSnapshot {
    default_sink_name: Option<String>,
    sinks: Vec<LinuxPulseSinkInfo>,
    targets: Vec<LinuxPulseTargetInfo>,
}

#[cfg(target_os = "linux")]
pub(crate) struct LinuxPulseCaptureSource {
    monitor_source_name: String,
    target_id: String,
}

#[cfg(target_os = "linux")]
struct LinuxPulseOperationState<T> {
    mainloop: *mut PaThreadedMainloop,
    completed: bool,
    value: Option<T>,
}

#[cfg(target_os = "linux")]
struct LinuxPulseSinkListState {
    mainloop: *mut PaThreadedMainloop,
    completed: bool,
    sinks: Vec<LinuxPulseSinkInfo>,
}

#[cfg(target_os = "linux")]
struct LinuxPulseSinkInputListState {
    mainloop: *mut PaThreadedMainloop,
    completed: bool,
    sink_inputs: Vec<LinuxPulseSinkInputInfo>,
}

#[cfg(target_os = "linux")]
type PaContextNotifyCb = unsafe extern "C" fn(*mut PaContext, *mut c_void);
#[cfg(target_os = "linux")]
type PaServerInfoCb = unsafe extern "C" fn(*mut PaContext, *const PaServerInfo, *mut c_void);
#[cfg(target_os = "linux")]
type PaSinkInfoCb = unsafe extern "C" fn(*mut PaContext, *const PaSinkInfo, i32, *mut c_void);
#[cfg(target_os = "linux")]
type PaSinkInputInfoCb =
    unsafe extern "C" fn(*mut PaContext, *const PaSinkInputInfo, i32, *mut c_void);

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
unsafe impl Send for LinuxPulseLib {}
#[cfg(target_os = "linux")]
unsafe impl Sync for LinuxPulseLib {}

#[cfg(target_os = "linux")]
struct LinuxPulseConnection {
    lib: &'static LinuxPulseLib,
    mainloop: *mut PaThreadedMainloop,
    context: *mut PaContext,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaThreadedMainloop {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaMainloopApi {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaContext {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaOperation {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaSpawnApi {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaProplist {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaSimple {
    _private: [u8; 0],
}

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct PaSampleSpec {
    format: i32,
    rate: u32,
    channels: u8,
}

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Clone, Copy)]
struct PaChannelMap {
    channels: u8,
    map: [i32; 32],
}

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Clone, Copy)]
struct PaCVolume {
    channels: u8,
    values: [u32; 32],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct PaBufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
const LINUX_PULSEAUDIO_LIBRARY_NAMES: [&str; 2] = ["libpulse.so.0", "libpulse.so"];
#[cfg(target_os = "linux")]
const LINUX_PULSEAUDIO_SIMPLE_LIBRARY_NAMES: [&str; 2] =
    ["libpulse-simple.so.0", "libpulse-simple.so"];
#[cfg(target_os = "linux")]
const LINUX_PULSEAUDIO_FALLBACK_LIBRARY_DIRS: [&str; 2] = [
    "/nix/var/nix/profiles/default/lib",
    "/run/current-system/sw/lib",
];
#[cfg(target_os = "linux")]
const LINUX_PULSE_TARGET_PREFIX: &str = "pulse:pid:";
#[cfg(target_os = "linux")]
const PA_CONTEXT_READY: i32 = 4;
#[cfg(target_os = "linux")]
const PA_CONTEXT_FAILED: i32 = 5;
#[cfg(target_os = "linux")]
const PA_CONTEXT_TERMINATED: i32 = 6;
#[cfg(target_os = "linux")]
const PA_OPERATION_RUNNING: i32 = 0;
#[cfg(target_os = "linux")]
pub(crate) const PA_SAMPLE_FLOAT32LE: i32 = 5;
#[cfg(target_os = "linux")]
pub(crate) const PA_STREAM_RECORD: i32 = 2;
#[cfg(target_os = "linux")]
const PA_CONTEXT_NOFLAGS: i32 = 0;
#[cfg(target_os = "linux")]
const LINUX_PULSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(target_os = "linux")]
const LINUX_PULSE_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(target_os = "linux")]
const LINUX_PULSE_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Default)]
struct SidecarState {
    capture_session: Option<CaptureSession>,
    push_keybind_watcher: Option<PushKeybindWatcher>,
}

#[cfg(test)]
fn parse_target_pid(target_id: &str) -> Option<u32> {
    target_id
        .strip_prefix("pid:")
        .and_then(|raw| raw.parse::<u32>().ok())
}

#[cfg(target_os = "linux")]
fn parse_linux_pulse_target_id(target_id: &str) -> Option<(u32, u32)> {
    let raw = target_id.strip_prefix(LINUX_PULSE_TARGET_PREFIX)?;
    let (pid, sink_index) = raw.split_once(":sink:")?;
    let pid = pid.parse::<u32>().ok()?;
    let sink_index = sink_index.parse::<u32>().ok()?;

    Some((pid, sink_index))
}

#[cfg(any(windows, test))]
pub(crate) fn dedupe_window_entries_by_pid(entries: Vec<(u32, String)>) -> HashMap<u32, String> {
    let mut deduped: HashMap<u32, String> = HashMap::new();

    for (pid, title) in entries {
        deduped.entry(pid).or_insert(title);
    }

    deduped
}

#[cfg(any(windows, test))]
pub(crate) fn parse_window_source_id(source_id: &str) -> Option<isize> {
    let mut parts = source_id.split(':');

    if parts.next()? != "window" {
        return None;
    }

    let hwnd_part = parts.next()?;
    hwnd_part.parse::<isize>().ok()
}

#[cfg(target_os = "linux")]
static LINUX_PULSE_LIB: OnceLock<Result<LinuxPulseLib, String>> = OnceLock::new();

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
fn linux_pulse_signal_mainloop(mainloop: *mut PaThreadedMainloop) {
    if mainloop.is_null() {
        return;
    }

    if let Ok(lib) = linux_pulse_lib() {
        unsafe { (lib.pa_threaded_mainloop_signal)(mainloop, 0) };
    }
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
pub(crate) fn linux_pulse_lib() -> Result<&'static LinuxPulseLib, String> {
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

#[cfg(target_os = "linux")]
pub(crate) fn linux_pulse_strerror(lib: &LinuxPulseLib, error_code: i32) -> String {
    linux_cstr_to_string(unsafe { (lib.pa_strerror)(error_code) })
        .unwrap_or_else(|| format!("PulseAudio error {error_code}"))
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
unsafe extern "C" fn linux_pulse_context_state_callback(
    _context: *mut PaContext,
    userdata: *mut c_void,
) {
    linux_pulse_signal_mainloop(userdata.cast::<PaThreadedMainloop>());
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
pub(crate) fn linux_pulse_capture_source_for_target(
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

#[cfg(any(target_os = "linux", test))]
fn clamp_audio_samples(frame_samples: &mut [f32]) {
    for sample in frame_samples.iter_mut() {
        *sample = sample.clamp(-1.0, 1.0);
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn emit_linux_audio_frame(
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

#[cfg(target_os = "macos")]
pub(crate) fn resolve_macos_helper_path() -> Result<std::path::PathBuf, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Failed to locate sidecar executable: {error}"))?;
    let executable_dir = current_exe
        .parent()
        .ok_or_else(|| "Failed to resolve sidecar executable directory.".to_string())?;
    let helper_path = executable_dir.join(MACOS_HELPER_BINARY_NAME);

    if helper_path.is_file() {
        return Ok(helper_path);
    }

    Err(format!(
        "macOS audio helper not found at {}. Rebuild the desktop sidecar.",
        helper_path.display()
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn run_macos_helper_command(arguments: &[&str]) -> Result<Vec<u8>, String> {
    let helper_path = resolve_macos_helper_path()?;
    let output = Command::new(helper_path)
        .args(arguments)
        .output()
        .map_err(|error| format!("failed to launch macOS helper: {error}"))?;

    if !output.status.success() {
        let stderr_output = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "macOS helper {} failed: {}",
            arguments.first().copied().unwrap_or("command"),
            stderr_output.trim()
        ));
    }

    Ok(output.stdout)
}

#[cfg(windows)]
pub(crate) fn process_is_alive(process_handle: HANDLE) -> bool {
    unsafe { WaitForSingleObject(process_handle, 0) == WAIT_TIMEOUT }
}

#[cfg(windows)]
pub(crate) fn open_process_for_liveness(pid: u32) -> Option<HANDLE> {
    unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .ok()
}

#[cfg(windows)]
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateAudioInterfaceCallback {
    signal: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(windows)]
impl ActivateAudioInterfaceCallback {
    fn new(signal: Arc<(Mutex<bool>, Condvar)>) -> Self {
        Self { signal }
    }
}

#[cfg(windows)]
impl windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler_Impl
    for ActivateAudioInterfaceCallback_Impl
{
    fn ActivateCompleted(
        &self,
        _activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let (lock, condvar) = &*self.signal;
        if let Ok(mut done) = lock.lock() {
            *done = true;
            condvar.notify_all();
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) fn activate_process_loopback_client(
    pid: u32,
    mode: PROCESS_LOOPBACK_MODE,
) -> Result<IAudioClient, String> {
    let signal = Arc::new((Mutex::new(false), Condvar::new()));
    let callback: IActivateAudioInterfaceCompletionHandler =
        ActivateAudioInterfaceCallback::new(Arc::clone(&signal)).into();

    let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: mode,
            },
        },
    };

    let activation_prop = windows_core::imp::PROPVARIANT {
        Anonymous: windows_core::imp::PROPVARIANT_0 {
            Anonymous: windows_core::imp::PROPVARIANT_0_0 {
                vt: VT_BLOB.0,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: windows_core::imp::PROPVARIANT_0_0_0 {
                    blob: windows_core::imp::BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&mut activation_params as *mut AUDIOCLIENT_ACTIVATION_PARAMS)
                            .cast::<u8>(),
                    },
                },
            },
        },
    };
    let activation_prop_ptr = (&activation_prop as *const windows_core::imp::PROPVARIANT)
        .cast::<windows_core::PROPVARIANT>();

    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(activation_prop_ptr),
            &callback,
        )
        .map_err(|error| format!("ActivateAudioInterfaceAsync failed: {error}"))?
    };

    let (lock, condvar) = &*signal;
    let done_guard = lock
        .lock()
        .map_err(|_| "Failed to lock activate callback state".to_string())?;
    let (done_guard, _wait_result) = condvar
        .wait_timeout_while(done_guard, Duration::from_secs(5), |done| !*done)
        .map_err(|_| "Failed waiting for activate callback".to_string())?;

    if !*done_guard {
        return Err("ActivateAudioInterfaceAsync timed out".to_string());
    }

    let mut activate_result = Default::default();
    let mut activated_interface: Option<IUnknown> = None;

    unsafe {
        operation
            .GetActivateResult(&mut activate_result, &mut activated_interface)
            .map_err(|error| format!("GetActivateResult failed: {error}"))?
    };

    activate_result.ok().map_err(|error| {
        if error.code().0 == -2147024809 {
            return format!(
                "Activation returned failure HRESULT: {error}. Process loopback activation payload was rejected."
            );
        }

        format!("Activation returned failure HRESULT: {error}")
    })?;

    activated_interface
        .ok_or_else(|| "Activation returned no interface".to_string())?
        .cast::<IAudioClient>()
        .map_err(|error| format!("Activated interface is not IAudioClient: {error}"))
}

fn start_capture_thread(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
    session_id: String,
    source_id: Option<String>,
    target_id: String,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let outcome = platform::capture_loopback_audio(
            &session_id,
            source_id.as_deref(),
            &target_id,
            target_pid,
            self_exclude_pid,
            Arc::clone(&stop_flag),
            Arc::clone(&frame_queue),
            app_audio_binary_stream.clone(),
        );

        let mut ended_params = json!({
            "sessionId": session_id,
            "targetId": target_id,
            "reason": outcome.reason.as_str(),
            "protocolVersion": PROTOCOL_VERSION,
        });

        if let Some(error) = outcome.error {
            ended_params["error"] = json!(error);
        }

        write_event(&stdout, "audio_capture.ended", ended_params);
    })
}

fn handle_health_ping() -> Result<Value, String> {
    Ok(json!({
        "status": "ok",
        "timestampMs": now_unix_ms(),
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_capabilities_get() -> Result<Value, String> {
    Ok(platform::capabilities())
}

fn handle_windows_resolve_source(params: Value) -> Result<Value, String> {
    let parsed: ResolveSourceParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    let pid = platform::resolve_source_to_pid(&parsed.source_id);

    Ok(json!({
        "sourceId": parsed.source_id,
        "pid": pid,
    }))
}

fn handle_audio_targets_list(params: Value) -> Result<Value, String> {
    let parsed: ListTargetsParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    let targets = platform::list_audio_targets();
    let suggested_target_id = parsed
        .source_id
        .as_deref()
        .and_then(platform::resolve_source_to_pid)
        .map(|pid| format!("pid:{pid}"))
        .filter(|target_id| targets.iter().any(|target| target.id == target_id.as_str()));
    #[cfg(target_os = "linux")]
    let requires_manual_selection = true;
    #[cfg(not(target_os = "linux"))]
    let requires_manual_selection = suggested_target_id.is_none();
    #[cfg(target_os = "linux")]
    let warning = if targets.is_empty() {
        Some(
            "No running app audio targets were found. Start playback in the app you want to share, then choose it here."
                .to_string(),
        )
    } else if parsed
        .source_id
        .as_deref()
        .is_some_and(|source_id| source_id.starts_with("window:"))
    {
        Some(
            "Linux per-app audio does not automatically follow the selected window. Choose the app that is producing sound."
                .to_string(),
        )
    } else {
        Some("Linux per-app audio requires choosing the app that is producing sound.".to_string())
    };
    #[cfg(not(target_os = "linux"))]
    let warning: Option<String> = None;

    let mut response = json!({
        "targets": targets,
        "requiresManualSelection": requires_manual_selection,
        "protocolVersion": PROTOCOL_VERSION,
    });

    if let Some(suggested_target_id) = suggested_target_id {
        response["suggestedTargetId"] = json!(suggested_target_id);
    }

    if let Some(warning) = warning {
        response["warning"] = json!(warning);
    }

    Ok(response)
}

fn stop_capture_session(state: &mut SidecarState, requested_session_id: Option<&str>) {
    let Some(active_session) = state.capture_session.take() else {
        return;
    };

    let should_stop = requested_session_id
        .map(|session_id| session_id == active_session.session_id)
        .unwrap_or(true);

    if should_stop {
        active_session.stop_flag.store(true, Ordering::Relaxed);
        let _ = active_session.handle.join();
        return;
    }

    state.capture_session = Some(active_session);
}

fn stop_push_keybind_watcher(state: &mut SidecarState) {
    let Some(active_watcher) = state.push_keybind_watcher.take() else {
        return;
    };

    active_watcher.stop_flag.store(true, Ordering::Relaxed);
    let _ = active_watcher.handle.join();
}

fn handle_audio_capture_start(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    if !cfg!(windows) && !cfg!(target_os = "macos") && !cfg!(target_os = "linux") {
        return Err(
            "Per-app audio capture is only available on Windows, macOS, and Linux.".to_string(),
        );
    }

    let parsed: StartAudioCaptureParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    stop_capture_session(state, None);

    let self_exclude_pid = parsed.self_exclude_pid;

    // Use system-wide exclude mode only when selfExcludePid is provided AND the caller
    // has not requested a specific app target.  When an explicit target is given, use
    // the normal per-app include-mode path — Ripcord's audio is never present in another
    // app's process tree, so exclusion is a no-op there anyway.
    //
    // Note: sourceId is always present in the request (it is a required field), so we
    // cannot use `source_id.is_none()` as the gate.  Instead we resolve it: a display/
    // monitor source like "screen:0" will not map to any process PID, so exclude mode
    // is appropriate; a window source like "window:12345" resolves to a specific app PID
    // and should stay in per-app include mode.
    let source_resolves_to_pid = parsed
        .source_id
        .as_deref()
        .and_then(platform::resolve_source_to_pid)
        .is_some();

    let use_exclude_mode = self_exclude_pid.is_some()
        && parsed.app_audio_target_id.is_none()
        && !source_resolves_to_pid;

    let available_targets = platform::list_audio_targets();

    let (target_id, target_pid, target_process_name) = if use_exclude_mode {
        // Capture all system audio except the excluded process.  Use "loopback" as the
        // target identifier so downstream consumers see a meaningful label, not Ripcord's PID.
        ("loopback".to_string(), 0u32, "loopback".to_string())
    } else {
        if cfg!(target_os = "linux") && parsed.app_audio_target_id.is_none() {
            return Err(
                "Linux per-app audio capture requires selecting an application target.".to_string(),
            );
        }

        let source_pid = parsed
            .source_id
            .as_deref()
            .and_then(platform::resolve_source_to_pid)
            .map(|pid| format!("pid:{pid}"));

        let id = parsed.app_audio_target_id.or(source_pid).ok_or_else(|| {
            "No app audio target was provided and source mapping failed".to_string()
        })?;

        let target = available_targets
            .into_iter()
            .find(|target| target.id == id)
            .ok_or_else(|| format!("Target audio source `{id}` is not available"))?;

        (target.id, target.pid, target.process_name)
    };

    // The current native Linux backend does not support process-tree exclusion at the
    // monitor-source level, so `selfExcludePid` is only used to select system mode.
    let effective_exclude_pid = if use_exclude_mode {
        self_exclude_pid
    } else {
        None
    };

    let session_id = Uuid::new_v4().to_string();
    eprintln!(
        "[capture-sidecar] start targetId={} targetPid={} targetProcess={} selfExcludePid={:?}",
        target_id, target_pid, target_process_name, self_exclude_pid
    );
    let stop_flag = Arc::new(AtomicBool::new(false));
    let handle = start_capture_thread(
        stdout,
        frame_queue,
        app_audio_binary_stream,
        session_id.clone(),
        parsed.source_id.clone(),
        target_id.clone(),
        target_pid,
        effective_exclude_pid,
        Arc::clone(&stop_flag),
    );

    state.capture_session = Some(CaptureSession {
        session_id: session_id.clone(),
        stop_flag,
        handle,
    });

    Ok(json!({
        "sessionId": session_id,
        "targetId": target_id,
        "sampleRate": APP_AUDIO_SAMPLE_RATE,
        "channels": APP_AUDIO_CHANNELS,
        "framesPerBuffer": APP_AUDIO_FRAME_SIZE,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    }))
}

fn handle_audio_capture_stop(state: &mut SidecarState, params: Value) -> Result<Value, String> {
    let parsed: StopAudioCaptureParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    stop_capture_session(state, parsed.session_id.as_deref());

    Ok(json!({
        "stopped": true,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_push_keybinds_set(
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: SetPushKeybindsParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    stop_push_keybind_watcher(state);

    let registration = platform::register_push_keybinds(
        frame_queue,
        parsed.push_to_talk_keybind.as_deref(),
        parsed.push_to_mute_keybind.as_deref(),
    );

    state.push_keybind_watcher = registration.watcher;

    Ok(json!({
        "talkRegistered": registration.talk_registered,
        "muteRegistered": registration.mute_registered,
        "errors": registration.errors,
    }))
}

fn main() {
    eprintln!("[capture-sidecar] starting");

    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let frame_queue = Arc::new(FrameQueue::new(50));
    let frame_writer = start_frame_writer(Arc::clone(&stdout), Arc::clone(&frame_queue));
    let state = Arc::new(Mutex::new(SidecarState::default()));
    let app_audio_binary_egress = match start_app_audio_binary_egress() {
        Ok(app_audio_binary_egress) => {
            eprintln!(
                "[capture-sidecar] app-audio binary egress listening on 127.0.0.1:{}",
                app_audio_binary_egress.port
            );
            Some(app_audio_binary_egress)
        }
        Err(error) => {
            eprintln!("[capture-sidecar] app-audio binary egress unavailable: {error}");
            None
        }
    };

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            Err(error) => {
                eprintln!("[capture-sidecar] invalid request json: {error}");
                continue;
            }
        };

        let request_stdout = Arc::clone(&stdout);
        let request_frame_queue = Arc::clone(&frame_queue);

        let result = match request.method.as_str() {
            "health.ping" => handle_health_ping(),
            "capabilities.get" => handle_capabilities_get(),
            "windows.resolve_source" => handle_windows_resolve_source(request.params),
            "audio_targets.list" => handle_audio_targets_list(request.params),
            "audio_capture.binary_egress_info" => match app_audio_binary_egress.as_ref() {
                Some(app_audio_binary_egress) => {
                    Ok(audio_capture_binary_egress_info(app_audio_binary_egress))
                }
                None => Err("Binary app-audio egress is unavailable".to_string()),
            },
            "audio_capture.start" => match state.lock() {
                Ok(mut state_lock) => handle_audio_capture_start(
                    Arc::clone(&request_stdout),
                    request_frame_queue,
                    app_audio_binary_egress
                        .as_ref()
                        .map(|binary_egress| Arc::clone(&binary_egress.stream)),
                    &mut state_lock,
                    request.params,
                ),
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "audio_capture.stop" => match state.lock() {
                Ok(mut state_lock) => handle_audio_capture_stop(&mut state_lock, request.params),
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "push_keybinds.set" => match state.lock() {
                Ok(mut state_lock) => handle_push_keybinds_set(
                    request_frame_queue.clone(),
                    &mut state_lock,
                    request.params,
                ),
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            _ => Err(format!("Unknown method: {}", request.method)),
        };

        if let Some(id) = request.id.as_deref() {
            write_response(&request_stdout, id, result);
        } else if let Err(error) = result {
            eprintln!(
                "[capture-sidecar] notification method={} failed: {}",
                request.method, error
            );
        }
    }

    if let Some(app_audio_binary_egress) = app_audio_binary_egress {
        app_audio_binary_egress
            .stop_flag
            .store(true, Ordering::Relaxed);
        let _ = app_audio_binary_egress.handle.join();
    }

    if let Ok(mut state_lock) = state.lock() {
        stop_capture_session(&mut state_lock, None);
        stop_push_keybind_watcher(&mut state_lock);
    } else {
        eprintln!("[capture-sidecar] sidecar state lock poisoned during shutdown");
    }
    frame_queue.close();
    let _ = frame_writer.join();

    eprintln!("[capture-sidecar] stopping");
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_audio_samples, dedupe_window_entries_by_pid, parse_target_pid,
        parse_window_source_id, CaptureEndReason,
    };

    #[test]
    fn parses_window_source_id() {
        assert_eq!(parse_window_source_id("window:1337:0"), Some(1337));
        assert_eq!(parse_window_source_id("screen:3:0"), None);
        assert_eq!(parse_window_source_id("window:not-a-number:0"), None);
    }

    #[test]
    fn parses_target_pid() {
        assert_eq!(parse_target_pid("pid:4321"), Some(4321));
        assert_eq!(parse_target_pid("pid:abc"), None);
        assert_eq!(parse_target_pid("4321"), None);
    }

    #[test]
    fn dedupes_entries_by_pid() {
        let deduped = dedupe_window_entries_by_pid(vec![
            (100, "First title".to_string()),
            (100, "Second title".to_string()),
            (200, "Other".to_string()),
        ]);

        assert_eq!(deduped.get(&100).map(String::as_str), Some("First title"));
        assert_eq!(deduped.get(&200).map(String::as_str), Some("Other"));
    }

    #[test]
    fn maps_capture_end_reasons() {
        assert_eq!(CaptureEndReason::CaptureError.as_str(), "capture_error");
        assert_eq!(CaptureEndReason::CaptureStopped.as_str(), "capture_stopped");
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::AppExited.as_str(), "app_exited");
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::DeviceLost.as_str(), "device_lost");
    }

    #[test]
    fn clamps_audio_samples_to_expected_range() {
        let mut frame_samples = vec![-1.5, -1.0, 0.25, 1.4];
        clamp_audio_samples(&mut frame_samples);

        assert_eq!(frame_samples, vec![-1.0, -1.0, 0.25, 1.0]);
    }
}
