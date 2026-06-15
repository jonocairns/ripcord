use serde_json::{json, Value};
use std::io::{self, BufRead};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;
use uuid::Uuid;

use crate::platform;
use crate::protocol::{
    ListTargetsParams, ResolveSourceParams, SetPushKeybindsParams, SidecarRequest,
    StartAudioCaptureParams, StopAudioCaptureParams, APP_AUDIO_CHANNELS, APP_AUDIO_FRAME_SIZE,
    APP_AUDIO_SAMPLE_RATE, PCM_ENCODING, PROTOCOL_VERSION,
};
use crate::runtime::{
    audio_capture_binary_egress_info, now_unix_ms, start_app_audio_binary_egress,
    start_frame_writer, write_event, write_response, AppAudioBinaryEgress, FrameQueue,
    PushKeybindWatcher,
};

const JSON_EVENT_QUEUE_CAPACITY: usize = 8;

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

struct SidecarApp {
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    frame_writer: JoinHandle<()>,
    state: Mutex<SidecarState>,
    app_audio_binary_egress: Option<AppAudioBinaryEgress>,
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

impl SidecarApp {
    fn new() -> Self {
        let stdout = Arc::new(Mutex::new(io::stdout()));
        let frame_queue = Arc::new(FrameQueue::new(JSON_EVENT_QUEUE_CAPACITY));
        let frame_writer = start_frame_writer(Arc::clone(&stdout), Arc::clone(&frame_queue));
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

        Self {
            stdout,
            frame_queue,
            frame_writer,
            state: Mutex::new(SidecarState::default()),
            app_audio_binary_egress,
        }
    }

    fn with_state(
        &self,
        handler: impl FnOnce(&mut SidecarState) -> Result<Value, String>,
    ) -> Result<Value, String> {
        match self.state.lock() {
            Ok(mut state_lock) => handler(&mut state_lock),
            Err(_) => Err("Sidecar state lock poisoned".to_string()),
        }
    }

    fn handle_health_ping(&self) -> Value {
        json!({
            "status": "ok",
            "timestampMs": now_unix_ms(),
            "protocolVersion": PROTOCOL_VERSION,
        })
    }

    fn handle_windows_resolve_source(&self, params: Value) -> Result<Value, String> {
        let parsed: ResolveSourceParams =
            serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

        let pid = platform::resolve_source_to_pid(&parsed.source_id);

        Ok(json!({
            "sourceId": parsed.source_id,
            "pid": pid,
        }))
    }

    fn handle_audio_targets_list(&self, params: Value) -> Result<Value, String> {
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
            Some(
                "Linux per-app audio requires choosing the app that is producing sound."
                    .to_string(),
            )
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

    fn handle_audio_capture_start(
        &self,
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
        // has not requested a specific app target. When an explicit target is given, use
        // the normal per-app include-mode path.
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
            ("loopback".to_string(), 0u32, "loopback".to_string())
        } else {
            if cfg!(target_os = "linux") && parsed.app_audio_target_id.is_none() {
                return Err(
                    "Linux per-app audio capture requires selecting an application target."
                        .to_string(),
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
            Arc::clone(&self.stdout),
            Arc::clone(&self.frame_queue),
            self.app_audio_binary_egress
                .as_ref()
                .map(|binary_egress| Arc::clone(&binary_egress.stream)),
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

    fn handle_audio_capture_stop(
        &self,
        state: &mut SidecarState,
        params: Value,
    ) -> Result<Value, String> {
        let parsed: StopAudioCaptureParams =
            serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

        stop_capture_session(state, parsed.session_id.as_deref());

        Ok(json!({
            "stopped": true,
            "protocolVersion": PROTOCOL_VERSION,
        }))
    }

    fn handle_push_keybinds_set(
        &self,
        state: &mut SidecarState,
        params: Value,
    ) -> Result<Value, String> {
        let parsed: SetPushKeybindsParams =
            serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

        stop_push_keybind_watcher(state);

        let registration = platform::register_push_keybinds(
            Arc::clone(&self.frame_queue),
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

    fn handle_request(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "health.ping" => Ok(self.handle_health_ping()),
            "capabilities.get" => Ok(platform::capabilities()),
            "windows.resolve_source" => self.handle_windows_resolve_source(params),
            "audio_targets.list" => self.handle_audio_targets_list(params),
            "audio_capture.binary_egress_info" => match self.app_audio_binary_egress.as_ref() {
                Some(app_audio_binary_egress) => {
                    Ok(audio_capture_binary_egress_info(app_audio_binary_egress))
                }
                None => Err("Binary app-audio egress is unavailable".to_string()),
            },
            "audio_capture.start" => {
                self.with_state(|state| self.handle_audio_capture_start(state, params))
            }
            "audio_capture.stop" => {
                self.with_state(|state| self.handle_audio_capture_stop(state, params))
            }
            "push_keybinds.set" => {
                self.with_state(|state| self.handle_push_keybinds_set(state, params))
            }
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn shutdown(mut self) {
        if let Some(app_audio_binary_egress) = self.app_audio_binary_egress.take() {
            app_audio_binary_egress
                .stop_flag
                .store(true, Ordering::Relaxed);
            let _ = app_audio_binary_egress.handle.join();
        }

        if let Ok(mut state_lock) = self.state.lock() {
            stop_capture_session(&mut state_lock, None);
            stop_push_keybind_watcher(&mut state_lock);
        } else {
            eprintln!("[capture-sidecar] sidecar state lock poisoned during shutdown");
        }

        self.frame_queue.close();
        let _ = self.frame_writer.join();
    }
}

pub(crate) fn run() {
    eprintln!("[capture-sidecar] starting");

    let stdin = io::stdin();
    let app = SidecarApp::new();

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

        let SidecarRequest { id, method, params } = request;
        let result = app.handle_request(&method, params);

        if let Some(id) = id.as_deref() {
            write_response(&app.stdout, id, result);
        } else if let Err(error) = result {
            eprintln!(
                "[capture-sidecar] notification method={} failed: {}",
                method, error
            );
        }
    }

    app.shutdown();

    eprintln!("[capture-sidecar] stopping");
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::CaptureEndReason;

    fn parse_target_pid(target_id: &str) -> Option<u32> {
        target_id
            .strip_prefix("pid:")
            .and_then(|raw| raw.parse::<u32>().ok())
    }

    fn dedupe_window_entries_by_pid(entries: Vec<(u32, String)>) -> HashMap<u32, String> {
        let mut deduped: HashMap<u32, String> = HashMap::new();

        for (pid, title) in entries {
            deduped.entry(pid).or_insert(title);
        }

        deduped
    }

    fn parse_window_source_id(source_id: &str) -> Option<isize> {
        let mut parts = source_id.split(':');

        if parts.next()? != "window" {
            return None;
        }

        let hwnd_part = parts.next()?;
        hwnd_part.parse::<isize>().ok()
    }

    fn clamp_audio_samples(frame_samples: &mut [f32]) {
        for sample in frame_samples.iter_mut() {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }

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
        assert_eq!(CaptureEndReason::AppExited.as_str(), "app_exited");
        assert_eq!(CaptureEndReason::DeviceLost.as_str(), "device_lost");
    }

    #[test]
    fn clamps_audio_samples_to_expected_range() {
        let mut frame_samples = vec![-1.5, -1.0, 0.25, 1.4];
        clamp_audio_samples(&mut frame_samples);

        assert_eq!(frame_samples, vec![-1.0, -1.0, 0.25, 1.0]);
    }
}
