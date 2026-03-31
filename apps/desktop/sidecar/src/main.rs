use serde_json::{json, Value};
mod platform;
mod protocol;
mod runtime;

#[cfg(any(windows, test))]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::io::Read;
use std::io::{self, BufRead};
use std::net::TcpStream;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;
#[cfg(windows)]
use std::time::Duration;
use uuid::Uuid;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use std::path::Path;
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

#[cfg(any(target_os = "linux", test))]
fn clamp_audio_samples(frame_samples: &mut [f32]) {
    for sample in frame_samples.iter_mut() {
        *sample = sample.clamp(-1.0, 1.0);
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
