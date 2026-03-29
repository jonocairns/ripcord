use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(any(windows, test, target_os = "linux"))]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::collections::VecDeque;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::io::Read;
use std::io::{self, BufRead, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
#[cfg(windows)]
use std::ptr;
#[cfg(any(windows, target_os = "linux"))]
use std::time::Instant;
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
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};
#[cfg(windows)]
use windows_core::implement;

const PROTOCOL_VERSION: u32 = 1;
const PCM_ENCODING: &str = "f32le_base64";
const APP_AUDIO_BINARY_EGRESS_FRAMING: &str = "length_prefixed_f32le_v1";
const APP_AUDIO_FRAME_SIZE: usize = 960;
const APP_AUDIO_SAMPLE_RATE: u32 = 48_000;
const APP_AUDIO_CHANNELS: usize = 1;
#[cfg(target_os = "linux")]
const APP_AUDIO_FRAME_BYTES: usize = APP_AUDIO_FRAME_SIZE * APP_AUDIO_CHANNELS * 4;
#[allow(dead_code)]
const MAX_APP_AUDIO_BINARY_FRAME_BYTES: usize = 4 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MACOS_HELPER_BINARY_NAME: &str = "sharkord-capture-sidecar-macos-helper";

#[derive(Debug, Deserialize)]
struct SidecarRequest {
    #[serde(default)]
    id: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct SidecarResponse<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SidecarError>,
}

#[derive(Debug, Serialize)]
struct SidecarError {
    message: String,
}

#[derive(Debug, Serialize)]
struct SidecarEvent<'a> {
    event: &'a str,
    params: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AudioTarget {
    id: String,
    label: String,
    pid: u32,
    process_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveSourceParams {
    source_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListTargetsParams {
    source_id: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioTargetListResponse {
    targets: Vec<AudioTarget>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveSourceResult {
    pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAudioCaptureParams {
    source_id: Option<String>,
    app_audio_target_id: Option<String>,
    self_exclude_pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopAudioCaptureParams {
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPushKeybindsParams {
    push_to_talk_keybind: Option<String>,
    push_to_mute_keybind: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum CaptureEndReason {
    CaptureStopped,
    #[cfg(windows)]
    AppExited,
    CaptureError,
    #[cfg(windows)]
    DeviceLost,
}

impl CaptureEndReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::CaptureStopped => "capture_stopped",
            #[cfg(windows)]
            Self::AppExited => "app_exited",
            Self::CaptureError => "capture_error",
            #[cfg(windows)]
            Self::DeviceLost => "device_lost",
        }
    }
}

#[derive(Debug)]
struct CaptureOutcome {
    reason: CaptureEndReason,
    error: Option<String>,
}

impl CaptureOutcome {
    fn from_reason(reason: CaptureEndReason) -> Self {
        Self {
            reason,
            error: None,
        }
    }

    fn capture_error(error: String) -> Self {
        Self {
            reason: CaptureEndReason::CaptureError,
            error: Some(error),
        }
    }
}

#[derive(Debug)]
struct CaptureSession {
    session_id: String,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[cfg(target_os = "linux")]
enum LinuxCaptureEvent {
    Frame {
        target_id: String,
        frame_samples: Vec<f32>,
    },
    ReadError {
        target_id: String,
        error: String,
    },
}

#[cfg(target_os = "linux")]
struct LinuxTargetCapture {
    stop_flag: Arc<AtomicBool>,
    process: Child,
    stdout_thread: JoinHandle<()>,
    stderr_thread: Option<JoinHandle<()>>,
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushKeybindKind {
    Talk,
    Mute,
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl PushKeybindKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Talk => "talk",
            Self::Mute => "mute",
        }
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsPushKeybind {
    key_code: i32,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

#[derive(Debug)]
struct PushKeybindWatcher {
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Debug)]
struct AppAudioBinaryEgress {
    port: u16,
    stream: Arc<Mutex<Option<TcpStream>>>,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct SidecarState {
    capture_session: Option<CaptureSession>,
    push_keybind_watcher: Option<PushKeybindWatcher>,
}

#[derive(Default)]
struct FrameQueueState {
    queue: VecDeque<String>,
    closed: bool,
}

#[cfg_attr(
    not(any(windows, target_os = "macos", target_os = "linux")),
    allow(dead_code)
)]
struct FrameQueue {
    capacity: usize,
    dropped_count: AtomicU64,
    state: Mutex<FrameQueueState>,
    condvar: Condvar,
}

impl FrameQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            dropped_count: AtomicU64::new(0),
            state: Mutex::new(FrameQueueState::default()),
            condvar: Condvar::new(),
        }
    }

    #[cfg_attr(
        not(any(windows, target_os = "macos", target_os = "linux")),
        allow(dead_code)
    )]
    fn push_line(&self, line: String) {
        let mut lock = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };

        if lock.closed {
            return;
        }

        if lock.queue.len() >= self.capacity {
            let _ = lock.queue.pop_front();
            self.dropped_count.fetch_add(1, Ordering::Relaxed);
        }

        lock.queue.push_back(line);
        self.condvar.notify_one();
    }

    fn pop_line(&self) -> Option<String> {
        let mut lock = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return None,
        };

        loop {
            if let Some(line) = lock.queue.pop_front() {
                return Some(line);
            }

            if lock.closed {
                return None;
            }

            lock = match self.condvar.wait(lock) {
                Ok(guard) => guard,
                Err(_) => return None,
            };
        }
    }

    fn close(&self) {
        if let Ok(mut lock) = self.state.lock() {
            lock.closed = true;
            self.condvar.notify_all();
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn take_dropped_count(&self) -> u64 {
        self.dropped_count.swap(0, Ordering::Relaxed)
    }
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn write_json_line<T: Serialize>(stdout: &Arc<Mutex<io::Stdout>>, payload: &T) {
    let mut lock = match stdout.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    if let Ok(serialized) = serde_json::to_string(payload) {
        let _ = writeln!(lock, "{serialized}");
        let _ = lock.flush();
    }
}

fn write_response(stdout: &Arc<Mutex<io::Stdout>>, id: &str, result: Result<Value, String>) {
    match result {
        Ok(result_payload) => {
            let response = SidecarResponse {
                id,
                ok: true,
                result: Some(result_payload),
                error: None,
            };
            write_json_line(stdout, &response);
        }
        Err(message) => {
            let response = SidecarResponse {
                id,
                ok: false,
                result: None,
                error: Some(SidecarError { message }),
            };
            write_json_line(stdout, &response);
        }
    }
}

fn write_event(stdout: &Arc<Mutex<io::Stdout>>, event: &str, params: Value) {
    let envelope = SidecarEvent { event, params };
    write_json_line(stdout, &envelope);
}

fn start_frame_writer(stdout: Arc<Mutex<io::Stdout>>, queue: Arc<FrameQueue>) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Some(line) = queue.pop_line() {
            let mut lock = match stdout.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };

            let _ = writeln!(lock, "{line}");
            let _ = lock.flush();
        }
    })
}

#[cfg(any(windows, target_os = "linux"))]
fn enqueue_frame_event(
    queue: &Arc<FrameQueue>,
    session_id: &str,
    target_id: &str,
    sequence: u64,
    sample_rate: usize,
    frame_count: usize,
    pcm_base64: String,
) {
    let dropped_count = queue.take_dropped_count();

    let mut params = json!({
        "sessionId": session_id,
        "targetId": target_id,
        "sequence": sequence,
        "sampleRate": sample_rate,
        "channels": APP_AUDIO_CHANNELS,
        "frameCount": frame_count,
        "pcmBase64": pcm_base64,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    });

    if dropped_count > 0 {
        params["droppedFrameCount"] = json!(dropped_count);
    }

    if let Ok(serialized) = serde_json::to_string(&SidecarEvent {
        event: "audio_capture.frame",
        params,
    }) {
        queue.push_line(serialized);
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn try_write_app_audio_binary_frame(
    stream_slot: &Arc<Mutex<Option<TcpStream>>>,
    session_id: &str,
    target_id: &str,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    protocol_version: u32,
    dropped_frame_count: u32,
    frame_samples: &[f32],
) -> bool {
    let session_id_bytes = session_id.as_bytes();
    let target_id_bytes = target_id.as_bytes();

    if session_id_bytes.is_empty() || session_id_bytes.len() > u16::MAX as usize {
        return false;
    }
    if target_id_bytes.is_empty() || target_id_bytes.len() > u16::MAX as usize {
        return false;
    }
    if sample_rate == 0 || sample_rate > u32::MAX as usize {
        return false;
    }
    if channels == 0 || channels > u16::MAX as usize {
        return false;
    }
    if frame_count == 0 || frame_count > u32::MAX as usize {
        return false;
    }
    if frame_samples.is_empty() || frame_samples.len() % channels != 0 {
        return false;
    }

    let pcm_bytes = bytemuck::cast_slice(frame_samples);
    if pcm_bytes.is_empty() || pcm_bytes.len() > u32::MAX as usize {
        return false;
    }

    let payload_len = 2 + // session id length
        session_id_bytes.len() +
        2 + // target id length
        target_id_bytes.len() +
        8 + // sequence
        4 + // sample rate
        2 + // channels
        4 + // frame count
        4 + // protocol version
        4 + // dropped frame count
        4 + // pcm byte length
        pcm_bytes.len();

    if payload_len == 0 || payload_len > MAX_APP_AUDIO_BINARY_FRAME_BYTES {
        return false;
    }

    let mut packet = Vec::with_capacity(4 + payload_len);
    packet.extend_from_slice(&(payload_len as u32).to_le_bytes());
    packet.extend_from_slice(&(session_id_bytes.len() as u16).to_le_bytes());
    packet.extend_from_slice(session_id_bytes);
    packet.extend_from_slice(&(target_id_bytes.len() as u16).to_le_bytes());
    packet.extend_from_slice(target_id_bytes);
    packet.extend_from_slice(&sequence.to_le_bytes());
    packet.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    packet.extend_from_slice(&(channels as u16).to_le_bytes());
    packet.extend_from_slice(&(frame_count as u32).to_le_bytes());
    packet.extend_from_slice(&protocol_version.to_le_bytes());
    packet.extend_from_slice(&dropped_frame_count.to_le_bytes());
    packet.extend_from_slice(&(pcm_bytes.len() as u32).to_le_bytes());
    packet.extend_from_slice(pcm_bytes);

    let mut lock = match stream_slot.lock() {
        Ok(lock) => lock,
        Err(_) => return false,
    };

    let Some(stream) = lock.as_mut() else {
        return false;
    };

    match stream.write_all(&packet) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[capture-sidecar] app-audio binary egress write failed: {error}");
            *lock = None;
            false
        }
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn enqueue_push_keybind_state_event(queue: &Arc<FrameQueue>, kind: PushKeybindKind, active: bool) {
    let params = json!({
        "kind": kind.as_str(),
        "active": active,
    });

    if let Ok(serialized) = serde_json::to_string(&SidecarEvent {
        event: "push_keybind.state",
        params,
    }) {
        queue.push_line(serialized);
    }
}
#[cfg(windows)]
const VK_LSHIFT: i32 = 0xA0;
#[cfg(windows)]
const VK_RSHIFT: i32 = 0xA1;
#[cfg(windows)]
const VK_LCONTROL: i32 = 0xA2;
#[cfg(windows)]
const VK_RCONTROL: i32 = 0xA3;
#[cfg(windows)]
const VK_LMENU: i32 = 0xA4;
#[cfg(windows)]
const VK_RMENU: i32 = 0xA5;
#[cfg(windows)]
const VK_LWIN: i32 = 0x5B;
#[cfg(windows)]
const VK_RWIN: i32 = 0x5C;

#[cfg(windows)]
fn map_key_code_to_virtual_key(key_code: &str) -> Option<i32> {
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let key = key_code.chars().nth(3)?;
        if key.is_ascii_alphabetic() {
            return Some(key.to_ascii_uppercase() as i32);
        }
    }

    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let key = key_code.chars().nth(5)?;
        if key.is_ascii_digit() {
            return Some(key as i32);
        }
    }

    if let Some(function_key) = key_code.strip_prefix('F') {
        if let Ok(function_number) = function_key.parse::<i32>() {
            if (1..=24).contains(&function_number) {
                return Some(0x6F + function_number);
            }
        }
    }

    if let Some(numpad_key) = key_code.strip_prefix("Numpad") {
        if numpad_key.len() == 1 {
            let key = numpad_key.chars().next()?;
            if key.is_ascii_digit() {
                return Some(0x60 + (key as i32 - '0' as i32));
            }
        }
    }

    match key_code {
        "Space" => Some(0x20),
        "Enter" => Some(0x0D),
        "Escape" => Some(0x1B),
        "Backspace" => Some(0x08),
        "Tab" => Some(0x09),
        "CapsLock" => Some(0x14),
        "NumLock" => Some(0x90),
        "ScrollLock" => Some(0x91),
        "ArrowUp" => Some(0x26),
        "ArrowDown" => Some(0x28),
        "ArrowLeft" => Some(0x25),
        "ArrowRight" => Some(0x27),
        "Delete" => Some(0x2E),
        "Insert" => Some(0x2D),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        "Minus" => Some(0xBD),
        "Equal" => Some(0xBB),
        "BracketLeft" => Some(0xDB),
        "BracketRight" => Some(0xDD),
        "Backslash" => Some(0xDC),
        "Semicolon" => Some(0xBA),
        "Quote" => Some(0xDE),
        "Comma" => Some(0xBC),
        "Period" => Some(0xBE),
        "Slash" => Some(0xBF),
        "Backquote" => Some(0xC0),
        "NumpadMultiply" => Some(0x6A),
        "NumpadAdd" => Some(0x6B),
        "NumpadSubtract" => Some(0x6D),
        "NumpadDecimal" => Some(0x6E),
        "NumpadDivide" => Some(0x6F),
        "NumpadEnter" => Some(0x0D),
        _ => None,
    }
}

#[cfg(windows)]
fn parse_push_keybind(keybind: Option<&str>) -> Result<Option<WindowsPushKeybind>, String> {
    let Some(keybind) = keybind else {
        return Ok(None);
    };

    if keybind.trim().is_empty() {
        return Ok(None);
    }

    let tokens: Vec<&str> = keybind
        .split('+')
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.is_empty() {
        return Ok(None);
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key_code_token: Option<&str> = None;

    for token in tokens {
        match token {
            "Control" | "Ctrl" => {
                ctrl = true;
            }
            "Alt" => {
                alt = true;
            }
            "Shift" => {
                shift = true;
            }
            "Meta" | "Command" => {
                meta = true;
            }
            _ => {
                if key_code_token.is_some() {
                    return Err("Invalid keybind format.".to_string());
                }

                key_code_token = Some(token);
            }
        }
    }

    let key_code_name = key_code_token.ok_or_else(|| "Missing key code in keybind.".to_string())?;
    let key_code = map_key_code_to_virtual_key(key_code_name)
        .ok_or_else(|| "Unsupported key for global keybind monitoring.".to_string())?;

    Ok(Some(WindowsPushKeybind {
        key_code,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

#[cfg(windows)]
fn is_virtual_key_down(key_code: i32) -> bool {
    (unsafe { GetAsyncKeyState(key_code) } as u16 & 0x8000) != 0
}

#[cfg(windows)]
fn current_modifiers_match(keybind: &WindowsPushKeybind) -> bool {
    let ctrl = is_virtual_key_down(VK_LCONTROL) || is_virtual_key_down(VK_RCONTROL);
    let alt = is_virtual_key_down(VK_LMENU) || is_virtual_key_down(VK_RMENU);
    let shift = is_virtual_key_down(VK_LSHIFT) || is_virtual_key_down(VK_RSHIFT);
    let meta = is_virtual_key_down(VK_LWIN) || is_virtual_key_down(VK_RWIN);

    ctrl == keybind.ctrl && alt == keybind.alt && shift == keybind.shift && meta == keybind.meta
}

#[cfg(windows)]
fn is_push_keybind_active(keybind: &WindowsPushKeybind) -> bool {
    is_virtual_key_down(keybind.key_code) && current_modifiers_match(keybind)
}

#[cfg(windows)]
fn start_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<WindowsPushKeybind>,
    mute_keybind: Option<WindowsPushKeybind>,
) -> PushKeybindWatcher {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        let mut talk_active = false;
        let mut mute_active = false;

        while !thread_stop_flag.load(Ordering::Relaxed) {
            let next_talk_active = talk_keybind.as_ref().is_some_and(is_push_keybind_active);
            let next_mute_active = mute_keybind.as_ref().is_some_and(is_push_keybind_active);

            if next_talk_active != talk_active {
                talk_active = next_talk_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, talk_active);
            }

            if next_mute_active != mute_active {
                mute_active = next_mute_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, mute_active);
            }

            thread::sleep(Duration::from_millis(8));
        }

        if talk_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, false);
        }

        if mute_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, false);
        }
    });

    PushKeybindWatcher { stop_flag, handle }
}

// ===== macOS keybind support =====

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(stateID: i32, keycode: u16) -> bool;
}

// kCGEventSourceStateHIDSystemState = 1
#[cfg(target_os = "macos")]
const CG_HID_SYSTEM_STATE: i32 = 1;

#[cfg(target_os = "macos")]
const VK_MAC_SHIFT_LEFT: u16 = 0x38;
#[cfg(target_os = "macos")]
const VK_MAC_SHIFT_RIGHT: u16 = 0x3C;
#[cfg(target_os = "macos")]
const VK_MAC_CONTROL_LEFT: u16 = 0x3B;
#[cfg(target_os = "macos")]
const VK_MAC_CONTROL_RIGHT: u16 = 0x3E;
#[cfg(target_os = "macos")]
const VK_MAC_OPTION_LEFT: u16 = 0x3A;
#[cfg(target_os = "macos")]
const VK_MAC_OPTION_RIGHT: u16 = 0x3D;
#[cfg(target_os = "macos")]
const VK_MAC_COMMAND_LEFT: u16 = 0x37;
#[cfg(target_os = "macos")]
const VK_MAC_COMMAND_RIGHT: u16 = 0x36;

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MacosPushKeybind {
    key_code: u16,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

#[cfg(target_os = "macos")]
fn map_key_code_to_cg_keycode(key_code: &str) -> Option<u16> {
    // Letters — macOS ANSI key codes follow physical keyboard layout, not ASCII order.
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let ch = key_code.chars().nth(3)?;
        return match ch {
            'A' => Some(0x00),
            'S' => Some(0x01),
            'D' => Some(0x02),
            'F' => Some(0x03),
            'H' => Some(0x04),
            'G' => Some(0x05),
            'Z' => Some(0x06),
            'X' => Some(0x07),
            'C' => Some(0x08),
            'V' => Some(0x09),
            'B' => Some(0x0B),
            'Q' => Some(0x0C),
            'W' => Some(0x0D),
            'E' => Some(0x0E),
            'R' => Some(0x0F),
            'Y' => Some(0x10),
            'T' => Some(0x11),
            'O' => Some(0x1F),
            'U' => Some(0x20),
            'I' => Some(0x22),
            'P' => Some(0x23),
            'L' => Some(0x25),
            'J' => Some(0x26),
            'K' => Some(0x28),
            'N' => Some(0x2D),
            'M' => Some(0x2E),
            _ => None,
        };
    }

    // Digits — also non-sequential on macOS.
    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let ch = key_code.chars().nth(5)?;
        return match ch {
            '1' => Some(0x12),
            '2' => Some(0x13),
            '3' => Some(0x14),
            '4' => Some(0x15),
            '5' => Some(0x17),
            '6' => Some(0x16),
            '7' => Some(0x1A),
            '8' => Some(0x1C),
            '9' => Some(0x19),
            '0' => Some(0x1D),
            _ => None,
        };
    }

    // Function keys — scattered CGKeyCodes.
    if let Some(num_str) = key_code.strip_prefix('F') {
        if let Ok(n) = num_str.parse::<u16>() {
            return match n {
                1 => Some(0x7A),
                2 => Some(0x78),
                3 => Some(0x63),
                4 => Some(0x76),
                5 => Some(0x60),
                6 => Some(0x61),
                7 => Some(0x62),
                8 => Some(0x64),
                9 => Some(0x65),
                10 => Some(0x6D),
                11 => Some(0x67),
                12 => Some(0x6F),
                13 => Some(0x69),
                14 => Some(0x6B),
                15 => Some(0x71),
                16 => Some(0x6A),
                17 => Some(0x40),
                18 => Some(0x4F),
                19 => Some(0x50),
                20 => Some(0x5A),
                _ => None,
            };
        }
    }

    // Numpad digits.
    if let Some(num_str) = key_code.strip_prefix("Numpad") {
        if num_str.len() == 1 {
            let ch = num_str.chars().next()?;
            return match ch {
                '0' => Some(0x52),
                '1' => Some(0x53),
                '2' => Some(0x54),
                '3' => Some(0x55),
                '4' => Some(0x56),
                '5' => Some(0x57),
                '6' => Some(0x58),
                '7' => Some(0x59),
                '8' => Some(0x5B),
                '9' => Some(0x5C),
                _ => None,
            };
        }
    }

    match key_code {
        "Space" => Some(0x31),
        "Enter" => Some(0x24),
        "Escape" => Some(0x35),
        "Backspace" => Some(0x33),
        "Tab" => Some(0x30),
        "CapsLock" => Some(0x39),
        "ArrowLeft" => Some(0x7B),
        "ArrowRight" => Some(0x7C),
        "ArrowDown" => Some(0x7D),
        "ArrowUp" => Some(0x7E),
        "Delete" => Some(0x75), // Forward Delete
        "Home" => Some(0x73),
        "End" => Some(0x77),
        "PageUp" => Some(0x74),
        "PageDown" => Some(0x79),
        "Minus" => Some(0x1B),
        "Equal" => Some(0x18),
        "BracketLeft" => Some(0x21),
        "BracketRight" => Some(0x1E),
        "Backslash" => Some(0x2A),
        "Semicolon" => Some(0x29),
        "Quote" => Some(0x27),
        "Comma" => Some(0x2B),
        "Period" => Some(0x2F),
        "Slash" => Some(0x2C),
        "Backquote" => Some(0x32),
        "NumpadMultiply" => Some(0x43),
        "NumpadAdd" => Some(0x45),
        "NumpadSubtract" => Some(0x4E),
        "NumpadDecimal" => Some(0x41),
        "NumpadDivide" => Some(0x4B),
        "NumpadEnter" => Some(0x4C),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn parse_push_keybind(keybind: Option<&str>) -> Result<Option<MacosPushKeybind>, String> {
    let Some(keybind) = keybind else {
        return Ok(None);
    };

    if keybind.trim().is_empty() {
        return Ok(None);
    }

    let tokens: Vec<&str> = keybind
        .split('+')
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.is_empty() {
        return Ok(None);
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key_code_token: Option<&str> = None;

    for token in tokens {
        match token {
            "Control" | "Ctrl" => {
                ctrl = true;
            }
            "Alt" | "Option" => {
                alt = true;
            }
            "Shift" => {
                shift = true;
            }
            "Meta" | "Command" => {
                meta = true;
            }
            _ => {
                if key_code_token.is_some() {
                    return Err("Invalid keybind format.".to_string());
                }

                key_code_token = Some(token);
            }
        }
    }

    let key_code_name = key_code_token.ok_or_else(|| "Missing key code in keybind.".to_string())?;
    let key_code = map_key_code_to_cg_keycode(key_code_name)
        .ok_or_else(|| "Unsupported key for global keybind monitoring.".to_string())?;

    Ok(Some(MacosPushKeybind {
        key_code,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

#[cfg(target_os = "macos")]
fn is_cg_key_down(keycode: u16) -> bool {
    unsafe { CGEventSourceKeyState(CG_HID_SYSTEM_STATE, keycode) }
}

#[cfg(target_os = "macos")]
fn current_modifiers_match(keybind: &MacosPushKeybind) -> bool {
    let ctrl = is_cg_key_down(VK_MAC_CONTROL_LEFT) || is_cg_key_down(VK_MAC_CONTROL_RIGHT);
    let alt = is_cg_key_down(VK_MAC_OPTION_LEFT) || is_cg_key_down(VK_MAC_OPTION_RIGHT);
    let shift = is_cg_key_down(VK_MAC_SHIFT_LEFT) || is_cg_key_down(VK_MAC_SHIFT_RIGHT);
    let meta = is_cg_key_down(VK_MAC_COMMAND_LEFT) || is_cg_key_down(VK_MAC_COMMAND_RIGHT);

    ctrl == keybind.ctrl && alt == keybind.alt && shift == keybind.shift && meta == keybind.meta
}

#[cfg(target_os = "macos")]
fn is_push_keybind_active(keybind: &MacosPushKeybind) -> bool {
    is_cg_key_down(keybind.key_code) && current_modifiers_match(keybind)
}

#[cfg(target_os = "macos")]
fn start_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<MacosPushKeybind>,
    mute_keybind: Option<MacosPushKeybind>,
) -> PushKeybindWatcher {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        let mut talk_active = false;
        let mut mute_active = false;

        while !thread_stop_flag.load(Ordering::Relaxed) {
            let next_talk_active = talk_keybind.as_ref().is_some_and(is_push_keybind_active);
            let next_mute_active = mute_keybind.as_ref().is_some_and(is_push_keybind_active);

            if next_talk_active != talk_active {
                talk_active = next_talk_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, talk_active);
            }

            if next_mute_active != mute_active {
                mute_active = next_mute_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, mute_active);
            }

            thread::sleep(Duration::from_millis(8));
        }

        if talk_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, false);
        }

        if mute_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, false);
        }
    });

    PushKeybindWatcher { stop_flag, handle }
}

// ===== Linux keybind support (X11 / XWayland) =====

#[cfg(target_os = "linux")]
use x11_dl::xlib;

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LinuxPushKeybind {
    key_sym: u64, // X11 KeySym
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

// Maps a WebCode-style key name to an X11 KeySym value.
// Letters and digits map directly to their lowercase ASCII values (X11 convention).
// Function keys: XK_F1 = 0xFFBE, incrementing by 1 up to F24.
#[cfg(target_os = "linux")]
fn map_key_code_to_x11_keysym(key_code: &str) -> Option<u64> {
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let ch = key_code.chars().nth(3)?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_lowercase() as u64);
        }
    }

    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let ch = key_code.chars().nth(5)?;
        if ch.is_ascii_digit() {
            return Some(ch as u64);
        }
    }

    if let Some(num_str) = key_code.strip_prefix('F') {
        if let Ok(n) = num_str.parse::<u64>() {
            if (1..=24).contains(&n) {
                return Some(0xFFBD + n); // XK_F1 = 0xFFBE = 0xFFBD + 1
            }
        }
    }

    if let Some(num_str) = key_code.strip_prefix("Numpad") {
        if num_str.len() == 1 {
            let ch = num_str.chars().next()?;
            if ch.is_ascii_digit() {
                return Some(0xFFB0 + (ch as u64 - '0' as u64)); // XK_KP_0 = 0xFFB0
            }
        }
    }

    match key_code {
        "Space" => Some(0x0020),
        "Enter" => Some(0xFF0D),
        "Escape" => Some(0xFF1B),
        "Backspace" => Some(0xFF08),
        "Tab" => Some(0xFF09),
        "CapsLock" => Some(0xFFE5),
        "ArrowLeft" => Some(0xFF51),
        "ArrowRight" => Some(0xFF53),
        "ArrowUp" => Some(0xFF52),
        "ArrowDown" => Some(0xFF54),
        "Delete" => Some(0xFFFF),
        "Insert" => Some(0xFF63),
        "Home" => Some(0xFF50),
        "End" => Some(0xFF57),
        "PageUp" => Some(0xFF55),
        "PageDown" => Some(0xFF56),
        "Minus" => Some(0x002D),
        "Equal" => Some(0x003D),
        "BracketLeft" => Some(0x005B),
        "BracketRight" => Some(0x005D),
        "Backslash" => Some(0x005C),
        "Semicolon" => Some(0x003B),
        "Quote" => Some(0x0027),
        "Comma" => Some(0x002C),
        "Period" => Some(0x002E),
        "Slash" => Some(0x002F),
        "Backquote" => Some(0x0060),
        "NumpadMultiply" => Some(0xFFAA),
        "NumpadAdd" => Some(0xFFAB),
        "NumpadSubtract" => Some(0xFFAD),
        "NumpadDecimal" => Some(0xFFAE),
        "NumpadDivide" => Some(0xFFAF),
        "NumpadEnter" => Some(0xFF8D),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn parse_push_keybind(keybind: Option<&str>) -> Result<Option<LinuxPushKeybind>, String> {
    let Some(keybind) = keybind else {
        return Ok(None);
    };

    if keybind.trim().is_empty() {
        return Ok(None);
    }

    let tokens: Vec<&str> = keybind
        .split('+')
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.is_empty() {
        return Ok(None);
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key_code_token: Option<&str> = None;

    for token in tokens {
        match token {
            "Control" | "Ctrl" => {
                ctrl = true;
            }
            "Alt" => {
                alt = true;
            }
            "Shift" => {
                shift = true;
            }
            "Meta" | "Super" => {
                meta = true;
            }
            _ => {
                if key_code_token.is_some() {
                    return Err("Invalid keybind format.".to_string());
                }

                key_code_token = Some(token);
            }
        }
    }

    let key_code_name = key_code_token.ok_or_else(|| "Missing key code in keybind.".to_string())?;
    let key_sym = map_key_code_to_x11_keysym(key_code_name)
        .ok_or_else(|| "Unsupported key for global keybind monitoring.".to_string())?;

    Ok(Some(LinuxPushKeybind {
        key_sym,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

// Opens an X11 display, resolves each keybind's KeySym to a hardware KeyCode,
// and closes the display. Returns Err if X11 is unavailable. A resolved KeyCode
// of 0 means the key has no mapping on the current layout and is returned as
// None so the caller can surface a useful error instead of a silent no-op.
#[cfg(target_os = "linux")]
fn open_x11_and_resolve_keycodes(
    talk_keybind: Option<&LinuxPushKeybind>,
    mute_keybind: Option<&LinuxPushKeybind>,
) -> Result<(Option<u8>, Option<u8>), String> {
    use std::ptr;

    let xlib = xlib::Xlib::open().map_err(|_| {
        "X11 library (libX11.so) not found. Keybind monitoring requires X11 or XWayland."
            .to_string()
    })?;

    let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
    if display.is_null() {
        return Err(
            "Could not connect to X11 display. Ensure $DISPLAY is set or XWayland is running."
                .to_string(),
        );
    }

    let resolve = |sym: u64| -> Option<u8> {
        let kc = unsafe { (xlib.XKeysymToKeycode)(display, sym) };
        if kc == 0 {
            eprintln!(
                "[capture-sidecar] XKeysymToKeycode returned 0 for KeySym {sym:#x} — key not present in current layout"
            );
            None
        } else {
            Some(kc)
        }
    };

    let talk_kc = talk_keybind.and_then(|kb| resolve(kb.key_sym));
    let mute_kc = mute_keybind.and_then(|kb| resolve(kb.key_sym));

    unsafe { (xlib.XCloseDisplay)(display) };

    Ok((talk_kc, mute_kc))
}

#[cfg(target_os = "linux")]
fn start_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<(LinuxPushKeybind, u8)>,
    mute_keybind: Option<(LinuxPushKeybind, u8)>,
) -> PushKeybindWatcher {
    use std::ptr;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        let xlib = match xlib::Xlib::open() {
            Ok(lib) => lib,
            Err(e) => {
                eprintln!("[capture-sidecar] X11 unavailable in keybind thread: {e}");
                return;
            }
        };

        let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
        if display.is_null() {
            eprintln!("[capture-sidecar] could not open X11 display in keybind thread");
            return;
        }

        // KeyCodes for talk/mute were resolved before the thread was spawned.
        // Resolve modifier KeyCodes here since they don't need to be checked upfront.
        let resolve = |sym: u64| -> u8 { unsafe { (xlib.XKeysymToKeycode)(display, sym) } };

        let shift_l = resolve(0xFFE1); // XK_Shift_L
        let shift_r = resolve(0xFFE2); // XK_Shift_R
        let ctrl_l = resolve(0xFFE3); // XK_Control_L
        let ctrl_r = resolve(0xFFE4); // XK_Control_R
        let alt_l = resolve(0xFFE9); // XK_Alt_L
        let alt_r = resolve(0xFFEA); // XK_Alt_R
        let meta_l = resolve(0xFFEB); // XK_Super_L
        let meta_r = resolve(0xFFEC); // XK_Super_R

        let mut talk_active = false;
        let mut mute_active = false;

        while !thread_stop_flag.load(Ordering::Relaxed) {
            let mut keys = [0i8; 32];
            unsafe { (xlib.XQueryKeymap)(display, keys.as_mut_ptr()) };

            let kc_down =
                |kc: u8| -> bool { kc != 0 && (keys[kc as usize / 8] & (1 << (kc % 8))) != 0 };

            let keybind_active = |(kb, kc): &(LinuxPushKeybind, u8)| -> bool {
                if !kc_down(*kc) {
                    return false;
                }
                let ctrl = kc_down(ctrl_l) || kc_down(ctrl_r);
                let alt = kc_down(alt_l) || kc_down(alt_r);
                let shift = kc_down(shift_l) || kc_down(shift_r);
                let meta = kc_down(meta_l) || kc_down(meta_r);
                ctrl == kb.ctrl && alt == kb.alt && shift == kb.shift && meta == kb.meta
            };

            let next_talk_active = talk_keybind.as_ref().is_some_and(keybind_active);
            let next_mute_active = mute_keybind.as_ref().is_some_and(keybind_active);

            if next_talk_active != talk_active {
                talk_active = next_talk_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, talk_active);
            }

            if next_mute_active != mute_active {
                mute_active = next_mute_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, mute_active);
            }

            thread::sleep(Duration::from_millis(8));
        }

        if talk_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, false);
        }

        if mute_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, false);
        }

        unsafe { (xlib.XCloseDisplay)(display) };
    });

    PushKeybindWatcher { stop_flag, handle }
}

fn parse_target_pid(target_id: &str) -> Option<u32> {
    target_id
        .strip_prefix("pid:")
        .and_then(|raw| raw.parse::<u32>().ok())
}

#[cfg(target_os = "linux")]
fn parse_linux_target_node_id(target_id: &str) -> Option<&str> {
    target_id
        .strip_prefix("node:")
        .filter(|raw| !raw.is_empty())
}

#[cfg(any(windows, test))]
fn dedupe_window_entries_by_pid(entries: Vec<(u32, String)>) -> HashMap<u32, String> {
    let mut deduped: HashMap<u32, String> = HashMap::new();

    for (pid, title) in entries {
        deduped.entry(pid).or_insert(title);
    }

    deduped
}

#[cfg(any(windows, test))]
fn parse_window_source_id(source_id: &str) -> Option<isize> {
    let mut parts = source_id.split(':');

    if parts.next()? != "window" {
        return None;
    }

    let hwnd_part = parts.next()?;
    hwnd_part.parse::<isize>().ok()
}

#[cfg(windows)]
fn window_title(hwnd: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };

    if length <= 0 {
        return None;
    }

    let mut buf = vec![0u16; (length + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, &mut buf) };

    if read <= 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&buf[..read as usize]))
}

#[cfg(windows)]
fn is_user_visible_window(hwnd: HWND) -> bool {
    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return false;
    }

    if unsafe { GetWindow(hwnd, GW_OWNER) }
        .ok()
        .is_some_and(|owner| !owner.is_invalid())
    {
        return false;
    }

    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let tool_window = (ex_style & WS_EX_TOOLWINDOW.0 as i32) != 0;

    !tool_window
}

#[cfg(windows)]
fn process_name_from_pid(pid: u32) -> Option<String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .ok()?;

    let mut buffer = vec![0u16; 4096];
    let mut size = buffer.len() as u32;

    let success = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok()
    };

    let _ = unsafe { windows::Win32::Foundation::CloseHandle(process) };

    if !success {
        return None;
    }

    let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
    let file_name = Path::new(&full_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or(full_path);

    Some(file_name)
}

#[cfg(all(not(windows), not(target_os = "linux")))]
fn process_name_from_pid(_pid: u32) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn pipewire_command_exists(command: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg("command -v \"$1\" >/dev/null 2>&1")
        .arg("sh")
        .arg(command)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn missing_pipewire_tools() -> Vec<&'static str> {
    let mut missing = Vec::new();

    if !pipewire_command_exists("pw-dump") {
        missing.push("pw-dump");
    }

    if !pipewire_command_exists("pw-record") {
        missing.push("pw-record");
    }

    missing
}

#[cfg(target_os = "linux")]
fn pipewire_tools_available() -> bool {
    missing_pipewire_tools().is_empty()
}

#[cfg(not(target_os = "linux"))]
fn pipewire_tools_available() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn missing_pipewire_tools_reason() -> String {
    let missing_tools = missing_pipewire_tools();
    if missing_tools.is_empty() {
        return String::new();
    }

    format!(
        "Linux per-app audio capture requires the PipeWire tools `{}`.",
        missing_tools.join("`, `")
    )
}

#[cfg(not(target_os = "linux"))]
fn missing_pipewire_tools_reason() -> String {
    String::new()
}

#[cfg(target_os = "linux")]
fn detect_linux_session_type() -> String {
    let session_type = std::env::var("XDG_SESSION_TYPE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    if let Some(session_type) = session_type {
        return session_type;
    }

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return "wayland".to_string();
    }

    if std::env::var_os("DISPLAY").is_some() {
        return "x11".to_string();
    }

    "unknown".to_string()
}

#[cfg(target_os = "linux")]
fn probe_linux_x11_display() -> (bool, Option<String>) {
    use std::ptr;

    if std::env::var_os("DISPLAY").is_none() {
        return (
            false,
            Some("No X11 display was detected for the current Linux session.".to_string()),
        );
    }

    let xlib = match xlib::Xlib::open() {
        Ok(xlib) => xlib,
        Err(_) => {
            return (
                false,
                Some("X11 library (libX11.so) not found. Global push keybind monitoring requires X11 or XWayland.".to_string()),
            )
        }
    };

    let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
    if display.is_null() {
        return (
            false,
            Some(
                "Could not connect to the current X11 display. Global push keybind monitoring requires X11 or XWayland."
                    .to_string(),
            ),
        );
    }

    unsafe { (xlib.XCloseDisplay)(display) };
    (true, None)
}

#[cfg(target_os = "linux")]
fn linux_process_cmdline_contains(needle: &str) -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };

    entries
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .into_string()
                .ok()
                .filter(|name| name.chars().all(|char| char.is_ascii_digit()))
        })
        .any(|pid| {
            let cmdline_path = format!("/proc/{pid}/cmdline");
            let Ok(cmdline) = fs::read(cmdline_path) else {
                return false;
            };

            cmdline
                .split(|byte| *byte == 0)
                .filter_map(|segment| std::str::from_utf8(segment).ok())
                .any(|segment| segment.contains(needle))
        })
}

#[cfg(target_os = "linux")]
fn probe_linux_desktop_portal() -> (bool, Option<String>) {
    // This is intentionally a best-effort readiness heuristic, not a hard gate:
    // some desktop sessions rely on D-Bus socket activation, so the portal
    // process may not appear in `/proc` until the first request triggers it.
    // We still surface the missing-portal result as guidance because it catches
    // the common broken-session case without adding a D-Bus dependency here.
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return (
            false,
            Some(
                "No D-Bus session bus was detected. Wayland screen sharing requires xdg-desktop-portal."
                    .to_string(),
            ),
        );
    }

    if !linux_process_cmdline_contains("xdg-desktop-portal") {
        return (
            false,
            Some(
                "xdg-desktop-portal is not running for the current desktop session. Wayland screen sharing requires it."
                    .to_string(),
            ),
        );
    }

    (true, None)
}

#[cfg(target_os = "linux")]
fn run_pipewire_command(command: &str, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new(command)
        .args(arguments)
        .output()
        .map_err(|error| format!("failed to launch `{command}`: {error}"))?;

    if !output.status.success() {
        let stderr_output = String::from_utf8_lossy(&output.stderr);
        return Err(format!("`{command}` failed: {}", stderr_output.trim()));
    }

    Ok(output.stdout)
}

#[cfg(target_os = "linux")]
fn linux_value_as_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|raw| u32::try_from(raw).ok())
        .or_else(|| value.as_str().and_then(|raw| raw.parse::<u32>().ok()))
}

#[cfg(target_os = "linux")]
fn linux_prop_as_u32(props: &Value, key: &str) -> Option<u32> {
    props.get(key).and_then(linux_value_as_u32)
}

#[cfg(target_os = "linux")]
fn linux_prop_as_str<'a>(props: &'a Value, key: &str) -> Option<&'a str> {
    props
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "linux")]
fn get_linux_process_tree_pids(root_pid: u32) -> HashSet<u32> {
    let mut process_tree_pids = HashSet::from([root_pid]);

    loop {
        let mut added_any = false;
        let entries = match fs::read_dir("/proc") {
            Ok(entries) => entries,
            Err(_) => break,
        };

        for entry in entries.flatten() {
            let Some(file_name) = entry.file_name().to_str().map(ToString::to_string) else {
                continue;
            };
            let Ok(pid) = file_name.parse::<u32>() else {
                continue;
            };

            let status_path = entry.path().join("status");
            let Ok(status_text) = fs::read_to_string(status_path) else {
                continue;
            };
            let parent_pid = status_text.lines().find_map(|line| {
                line.strip_prefix("PPid:")
                    .map(str::trim)
                    .and_then(|value| value.parse::<u32>().ok())
            });

            if parent_pid.is_some_and(|parent_pid| process_tree_pids.contains(&parent_pid))
                && process_tree_pids.insert(pid)
            {
                added_any = true;
            }
        }

        if !added_any {
            break;
        }
    }

    process_tree_pids
}

#[cfg(target_os = "linux")]
fn stop_linux_target_capture(mut capture: LinuxTargetCapture) {
    capture.stop_flag.store(true, Ordering::Relaxed);
    let _ = capture.process.kill();
    let _ = capture.process.wait();
    let _ = capture.stdout_thread.join();
    if let Some(stderr_thread) = capture.stderr_thread.take() {
        let _ = stderr_thread.join();
    }
}

fn clamp_audio_samples(frame_samples: &mut [f32]) {
    for sample in frame_samples.iter_mut() {
        *sample = sample.clamp(-1.0, 1.0);
    }
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
fn start_linux_target_capture(
    target_id: &str,
    event_sender: std::sync::mpsc::Sender<LinuxCaptureEvent>,
) -> Result<LinuxTargetCapture, String> {
    let Some(target_object_id) = parse_linux_target_node_id(target_id) else {
        return Err("Invalid Linux PipeWire target id.".to_string());
    };

    let mut child = Command::new("pw-record")
        .args([
            "--target",
            target_object_id,
            "--rate",
            "48000",
            "--channels",
            "1",
            "--format",
            "f32",
            "--latency",
            "20ms",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to launch `pw-record` for {target_id}: {error}"))?;

    let Some(stdout_pipe) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "`pw-record` did not expose stdout for {target_id}."
        ));
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = Arc::clone(&stop_flag);
    let target_id_for_stdout = target_id.to_string();
    let stdout_thread = thread::spawn(move || {
        let mut stdout_reader = io::BufReader::new(stdout_pipe);

        loop {
            if stop_flag_for_thread.load(Ordering::Relaxed) {
                return;
            }

            let mut frame_bytes = vec![0u8; APP_AUDIO_FRAME_BYTES];
            match stdout_reader.read_exact(&mut frame_bytes) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return,
                Err(error) => {
                    let _ = event_sender.send(LinuxCaptureEvent::ReadError {
                        target_id: target_id_for_stdout.clone(),
                        error: format!("Failed reading `pw-record` PCM data: {error}"),
                    });
                    return;
                }
            }

            let frame_samples = frame_bytes
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

            if event_sender
                .send(LinuxCaptureEvent::Frame {
                    target_id: target_id_for_stdout.clone(),
                    frame_samples,
                })
                .is_err()
            {
                return;
            }
        }
    });

    let stderr_thread = child.stderr.take().map(|stderr_pipe| {
        let target_id = target_id.to_string();
        thread::spawn(move || {
            let stderr_reader = io::BufReader::new(stderr_pipe);
            for line in stderr_reader.lines().map_while(Result::ok) {
                let trimmed_line = line.trim();
                if trimmed_line.is_empty() {
                    continue;
                }

                eprintln!(
                    "[capture-sidecar] linux target {}: {}",
                    target_id, trimmed_line
                );
            }
        })
    });

    Ok(LinuxTargetCapture {
        stop_flag,
        process: child,
        stdout_thread,
        stderr_thread,
    })
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !is_user_visible_window(hwnd) {
        return BOOL(1);
    }

    let title = match window_title(hwnd) {
        Some(value) if !value.trim().is_empty() => value,
        _ => return BOOL(1),
    };

    let mut pid = 0u32;
    let _thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));

    if pid == 0 {
        return BOOL(1);
    }

    let entries_ptr = lparam.0 as *mut Vec<(u32, String)>;
    if !entries_ptr.is_null() {
        (*entries_ptr).push((pid, title));
    }

    BOOL(1)
}

#[cfg(target_os = "macos")]
fn resolve_macos_helper_path() -> Result<std::path::PathBuf, String> {
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
fn run_macos_helper_command(arguments: &[&str]) -> Result<Vec<u8>, String> {
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

#[cfg(target_os = "macos")]
fn get_audio_targets() -> Vec<AudioTarget> {
    match run_macos_helper_command(&["list-targets"]).and_then(|output| {
        serde_json::from_slice::<AudioTargetListResponse>(&output)
            .map_err(|error| error.to_string())
    }) {
        Ok(response) => response.targets,
        Err(error) => {
            eprintln!("[capture-sidecar] {error}");
            Vec::new()
        }
    }
}

#[cfg(windows)]
fn get_audio_targets() -> Vec<AudioTarget> {
    let mut entries: Vec<(u32, String)> = Vec::new();

    let _ = unsafe {
        EnumWindows(
            Some(enum_windows_callback),
            LPARAM((&mut entries as *mut Vec<(u32, String)>) as isize),
        )
    };

    let deduped = dedupe_window_entries_by_pid(entries);

    let mut targets = Vec::new();

    for (pid, title) in deduped {
        let process_name = process_name_from_pid(pid).unwrap_or_else(|| "unknown.exe".to_string());
        let label = format!("{} - {} ({})", title.trim(), process_name, pid);

        targets.push(AudioTarget {
            id: format!("pid:{pid}"),
            label,
            pid,
            process_name,
        });
    }

    targets.sort_by(|left, right| left.label.cmp(&right.label));
    targets
}

#[cfg(target_os = "linux")]
fn get_audio_targets() -> Vec<AudioTarget> {
    let output = match run_pipewire_command("pw-dump", &[]) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[capture-sidecar] {error}");
            return Vec::new();
        }
    };

    let objects: Vec<Value> = match serde_json::from_slice(&output) {
        Ok(objects) => objects,
        Err(error) => {
            eprintln!("[capture-sidecar] Failed to parse `pw-dump` JSON: {error}");
            return Vec::new();
        }
    };

    let mut targets = Vec::new();

    for object in objects {
        let Some(object_type) = object.get("type").and_then(Value::as_str) else {
            continue;
        };
        if !object_type.ends_with(":Node") {
            continue;
        }

        let Some(props) = object.get("info").and_then(|info| info.get("props")) else {
            continue;
        };
        let Some(media_class) = linux_prop_as_str(props, "media.class") else {
            continue;
        };
        if !media_class.starts_with("Stream/Output/Audio") {
            continue;
        }

        let Some(pid) = linux_prop_as_u32(props, "application.process.id")
            .or_else(|| linux_prop_as_u32(props, "pipewire.sec.pid"))
        else {
            continue;
        };
        let Some(target_object_id) = linux_prop_as_str(props, "object.serial")
            .map(ToString::to_string)
            .or_else(|| {
                object
                    .get("id")
                    .and_then(linux_value_as_u32)
                    .map(|raw| raw.to_string())
            })
        else {
            continue;
        };

        let app_name = linux_prop_as_str(props, "application.name")
            .or_else(|| linux_prop_as_str(props, "node.description"))
            .or_else(|| linux_prop_as_str(props, "node.nick"))
            .or_else(|| linux_prop_as_str(props, "node.name"))
            .unwrap_or("Unknown app");
        let node_label = linux_prop_as_str(props, "node.description")
            .or_else(|| linux_prop_as_str(props, "node.nick"))
            .unwrap_or(app_name);
        let process_name = linux_prop_as_str(props, "application.process.binary")
            .unwrap_or(app_name)
            .to_string();
        let label = if node_label.eq_ignore_ascii_case(app_name) {
            if process_name.eq_ignore_ascii_case(app_name) {
                format!("{app_name} ({pid})")
            } else {
                format!("{app_name} [{process_name}] ({pid})")
            }
        } else {
            format!("{app_name} [{process_name}] - {node_label} ({pid})")
        };

        targets.push(AudioTarget {
            id: format!("node:{target_object_id}"),
            label,
            pid,
            process_name,
        });
    }

    targets.sort_by(|left, right| left.label.cmp(&right.label));
    targets
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn get_audio_targets() -> Vec<AudioTarget> {
    Vec::new()
}

#[cfg(windows)]
fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    let hwnd_value = parse_window_source_id(source_id)?;
    let hwnd = HWND(hwnd_value as *mut c_void);

    if !unsafe { IsWindow(hwnd).as_bool() } {
        return None;
    }

    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }

    if pid == 0 {
        return None;
    }

    Some(pid)
}

#[cfg(target_os = "macos")]
fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    let output = run_macos_helper_command(&["resolve-source", "--source-id", source_id]).ok()?;
    let response = serde_json::from_slice::<ResolveSourceResult>(&output).ok()?;
    response.pid
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn resolve_source_to_pid(_source_id: &str) -> Option<u32> {
    None
}

#[cfg(windows)]
fn process_is_alive(process_handle: HANDLE) -> bool {
    unsafe { WaitForSingleObject(process_handle, 0) == WAIT_TIMEOUT }
}

#[cfg(windows)]
fn open_process_for_liveness(pid: u32) -> Option<HANDLE> {
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
fn activate_process_loopback_client(
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

#[cfg(windows)]
fn capture_loopback_audio(
    session_id: &str,
    _source_id: Option<&str>,
    target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    let process_handle = if self_exclude_pid.is_none() {
        match open_process_for_liveness(target_pid) {
            Some(handle) => Some(handle),
            None => return CaptureOutcome::from_reason(CaptureEndReason::AppExited),
        }
    } else {
        None
    };

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };

    let reason = (|| {
        let (activation_pid, activation_mode) = match self_exclude_pid {
            Some(exclude_pid) => (
                exclude_pid,
                PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            ),
            None => (
                target_pid,
                PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            ),
        };
        let audio_client = activate_process_loopback_client(activation_pid, activation_mode)?;
        let capture_format = WAVEFORMATEX {
            wFormatTag: 0x0003, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: APP_AUDIO_CHANNELS as u16,
            nSamplesPerSec: APP_AUDIO_SAMPLE_RATE,
            nAvgBytesPerSec: APP_AUDIO_SAMPLE_RATE * APP_AUDIO_CHANNELS as u32 * 4,
            nBlockAlign: (APP_AUDIO_CHANNELS * 4) as u16,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        let init_result = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                20 * 10_000,
                0,
                &capture_format,
                None,
            )
        };

        if let Err(error) = init_result {
            if error.code() == AUDCLNT_E_INVALID_STREAM_FLAG {
                return Err(format!(
                    "Failed to initialize loopback client: {error} (invalid stream flags for process loopback)"
                ));
            }
            return Err(format!("Failed to initialize loopback client: {error}"));
        }

        let capture_client: IAudioCaptureClient = unsafe {
            audio_client
                .GetService()
                .map_err(|error| format!("Failed to get IAudioCaptureClient: {error}"))?
        };

        if let Err(error) = unsafe { audio_client.Start() } {
            return Err(format!("Failed to start audio client: {error}"));
        }

        let mut pending = Vec::<f32>::new();
        let mut sequence: u64 = 0;
        let mut last_liveness_check = Instant::now();

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = unsafe { audio_client.Stop() };
                return Ok(CaptureEndReason::CaptureStopped);
            }

            if last_liveness_check.elapsed() >= Duration::from_millis(300) {
                if let Some(handle) = process_handle {
                    if !process_is_alive(handle) {
                        let _ = unsafe { audio_client.Stop() };
                        return Ok(CaptureEndReason::AppExited);
                    }
                }

                last_liveness_check = Instant::now();
            }

            let mut packet_size = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(size) => size,
                Err(_) => {
                    let _ = unsafe { audio_client.Stop() };
                    return Ok(CaptureEndReason::DeviceLost);
                }
            };

            if packet_size == 0 {
                thread::sleep(Duration::from_millis(4));
                continue;
            }

            while packet_size > 0 {
                let mut data_ptr: *mut u8 = ptr::null_mut();
                let mut frame_count = 0u32;
                let mut flags = 0u32;

                if unsafe {
                    capture_client.GetBuffer(
                        &mut data_ptr,
                        &mut frame_count,
                        &mut flags,
                        None,
                        None,
                    )
                }
                .is_err()
                {
                    let _ = unsafe { audio_client.Stop() };
                    return Ok(CaptureEndReason::CaptureError);
                }

                let chunk = if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    vec![0.0f32; frame_count as usize * APP_AUDIO_CHANNELS]
                } else {
                    let sample_count = frame_count as usize * APP_AUDIO_CHANNELS;
                    unsafe { std::slice::from_raw_parts(data_ptr as *const f32, sample_count) }
                        .to_vec()
                };

                pending.extend_from_slice(&chunk);

                let _ = unsafe { capture_client.ReleaseBuffer(frame_count) };

                while pending.len() >= APP_AUDIO_FRAME_SIZE * APP_AUDIO_CHANNELS {
                    let frame_samples: Vec<f32> = pending
                        .drain(..APP_AUDIO_FRAME_SIZE * APP_AUDIO_CHANNELS)
                        .collect();
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
                                &frame_samples,
                            )
                        })
                        .unwrap_or(false);

                    if !wrote_binary {
                        let frame_bytes = bytemuck::cast_slice(&frame_samples);
                        let pcm_base64 = BASE64.encode(frame_bytes);

                        enqueue_frame_event(
                            &frame_queue,
                            session_id,
                            target_id,
                            sequence,
                            APP_AUDIO_SAMPLE_RATE as usize,
                            APP_AUDIO_FRAME_SIZE,
                            pcm_base64,
                        );
                    }

                    sequence = sequence.saturating_add(1);
                }

                packet_size = match unsafe { capture_client.GetNextPacketSize() } {
                    Ok(size) => size,
                    Err(_) => {
                        let _ = unsafe { audio_client.Stop() };
                        return Ok(CaptureEndReason::DeviceLost);
                    }
                };
            }
        }
    })();

    if let Some(handle) = process_handle {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
    }
    if com_initialized {
        unsafe { CoUninitialize() };
    }

    match reason {
        Ok(value) => CaptureOutcome::from_reason(value),
        Err(error) => {
            eprintln!(
                "[capture-sidecar] capture error targetId={} targetPid={}: {}",
                target_id, target_pid, error
            );
            CaptureOutcome::capture_error(error)
        }
    }
}

#[cfg(target_os = "linux")]
fn capture_loopback_audio(
    session_id: &str,
    _source_id: Option<&str>,
    target_id: &str,
    _target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    if let Some(self_exclude_pid) = self_exclude_pid {
        let (event_sender, event_receiver) = std::sync::mpsc::channel::<LinuxCaptureEvent>();
        let mut captures: HashMap<String, LinuxTargetCapture> = HashMap::new();
        let mut sequence: u64 = 0;
        let mut last_refresh_at = Instant::now() - Duration::from_secs(1);

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                for capture in captures.into_values() {
                    stop_linux_target_capture(capture);
                }
                return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
            }

            if last_refresh_at.elapsed() >= Duration::from_millis(750) {
                let excluded_pids = get_linux_process_tree_pids(self_exclude_pid);
                let next_targets = get_audio_targets()
                    .into_iter()
                    .filter(|target| !excluded_pids.contains(&target.pid))
                    .collect::<Vec<_>>();

                let next_target_ids = next_targets
                    .iter()
                    .map(|target| target.id.clone())
                    .collect::<HashSet<_>>();
                let stale_target_ids = captures
                    .keys()
                    .filter(|target_id| !next_target_ids.contains(*target_id))
                    .cloned()
                    .collect::<Vec<_>>();

                for stale_target_id in stale_target_ids {
                    if let Some(capture) = captures.remove(&stale_target_id) {
                        stop_linux_target_capture(capture);
                    }
                }

                let mut spawn_error: Option<String> = None;

                for next_target in next_targets {
                    if captures.contains_key(&next_target.id) {
                        continue;
                    }

                    match start_linux_target_capture(&next_target.id, event_sender.clone()) {
                        Ok(capture) => {
                            captures.insert(next_target.id, capture);
                        }
                        Err(error) => {
                            eprintln!("[capture-sidecar] {error}");
                            spawn_error = Some(error);
                        }
                    }
                }

                if captures.is_empty() && spawn_error.is_some() {
                    for capture in captures.into_values() {
                        stop_linux_target_capture(capture);
                    }
                    return CaptureOutcome::capture_error(
                        spawn_error.unwrap_or_else(|| "Linux system capture failed.".to_string()),
                    );
                }

                last_refresh_at = Instant::now();
            }

            let frame_deadline = Instant::now() + Duration::from_millis(20);
            let mut mixed_frame = vec![0.0f32; APP_AUDIO_FRAME_SIZE * APP_AUDIO_CHANNELS];

            loop {
                let now = Instant::now();
                if now >= frame_deadline {
                    break;
                }

                match event_receiver.recv_timeout(frame_deadline.saturating_duration_since(now)) {
                    Ok(LinuxCaptureEvent::Frame {
                        target_id: _target_id,
                        frame_samples,
                    }) => {
                        for (mixed_sample, incoming_sample) in
                            mixed_frame.iter_mut().zip(frame_samples.iter())
                        {
                            *mixed_sample += *incoming_sample;
                        }
                    }
                    Ok(LinuxCaptureEvent::ReadError { target_id, error }) => {
                        eprintln!("[capture-sidecar] linux target {}: {}", target_id, error);
                        if let Some(capture) = captures.remove(&target_id) {
                            stop_linux_target_capture(capture);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        for capture in captures.into_values() {
                            stop_linux_target_capture(capture);
                        }
                        return CaptureOutcome::capture_error(
                            "Linux system capture channel disconnected unexpectedly.".to_string(),
                        );
                    }
                }
            }

            let exited_target_ids = captures
                .iter_mut()
                .filter_map(
                    |(capture_target_id, capture)| match capture.process.try_wait() {
                        Ok(Some(_status)) => Some(capture_target_id.clone()),
                        Ok(None) => None,
                        Err(error) => {
                            eprintln!(
                                "[capture-sidecar] Failed waiting on `pw-record` for {}: {}",
                                capture_target_id, error
                            );
                            Some(capture_target_id.clone())
                        }
                    },
                )
                .collect::<Vec<_>>();

            for exited_target_id in exited_target_ids {
                if let Some(capture) = captures.remove(&exited_target_id) {
                    stop_linux_target_capture(capture);
                }
            }

            clamp_audio_samples(&mut mixed_frame);
            emit_linux_audio_frame(
                session_id,
                target_id,
                sequence,
                &mixed_frame,
                &frame_queue,
                &app_audio_binary_stream,
            );
            sequence = sequence.saturating_add(1);
        }
    }

    let Some(target_object_id) = parse_linux_target_node_id(target_id) else {
        return CaptureOutcome::capture_error("Invalid Linux PipeWire target id.".to_string());
    };

    let mut child = match Command::new("pw-record")
        .args([
            "--target",
            target_object_id,
            "--rate",
            "48000",
            "--channels",
            "1",
            "--format",
            "f32",
            "--latency",
            "20ms",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CaptureOutcome::capture_error(format!("Failed to launch `pw-record`: {error}"))
        }
    };

    let Some(stdout_pipe) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CaptureOutcome::capture_error("`pw-record` did not expose stdout.".to_string());
    };

    let stderr_slot = Arc::new(Mutex::new(String::new()));
    let stderr_slot_for_thread = Arc::clone(&stderr_slot);
    let stderr_thread = child.stderr.take().map(|stderr_pipe| {
        thread::spawn(move || {
            let mut stderr_reader = io::BufReader::new(stderr_pipe);
            let mut stderr_output = String::new();
            let _ = stderr_reader.read_to_string(&mut stderr_output);
            if let Ok(mut stderr_lock) = stderr_slot_for_thread.lock() {
                *stderr_lock = stderr_output;
            }
        })
    });

    let (frame_sender, frame_receiver) = std::sync::mpsc::channel::<Result<Vec<f32>, String>>();
    let stdout_thread = thread::spawn(move || {
        let mut stdout_reader = io::BufReader::new(stdout_pipe);

        loop {
            let mut frame_bytes = vec![0u8; APP_AUDIO_FRAME_BYTES];
            match stdout_reader.read_exact(&mut frame_bytes) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => {
                    let _ = frame_sender
                        .send(Err(format!("Failed reading `pw-record` PCM data: {error}")));
                    return;
                }
            }

            let frame_samples = frame_bytes
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

            if frame_sender.send(Ok(frame_samples)).is_err() {
                return;
            }
        }
    });

    let mut sequence: u64 = 0;

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            if let Some(stderr_thread) = stderr_thread {
                let _ = stderr_thread.join();
            }
            return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
        }

        match frame_receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(frame_samples)) => {
                emit_linux_audio_frame(
                    session_id,
                    target_id,
                    sequence,
                    &frame_samples,
                    &frame_queue,
                    &app_audio_binary_stream,
                );
                sequence = sequence.saturating_add(1);
            }
            Ok(Err(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                if let Some(stderr_thread) = stderr_thread {
                    let _ = stderr_thread.join();
                }
                return CaptureOutcome::capture_error(error);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => match child.try_wait() {
                Ok(Some(status)) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }

                    if stop_flag.load(Ordering::Relaxed) {
                        return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
                    }

                    let stderr_output = stderr_slot
                        .lock()
                        .ok()
                        .map(|stderr_lock| stderr_lock.trim().to_string())
                        .filter(|stderr_output| !stderr_output.is_empty());
                    let error_message = stderr_output.unwrap_or_else(|| {
                        format!("`pw-record` exited unexpectedly (status={status}).")
                    });

                    return CaptureOutcome::capture_error(error_message);
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(format!(
                        "Failed waiting on `pw-record`: {error}"
                    ));
                }
            },
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => match child.wait() {
                Ok(status) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }

                    if stop_flag.load(Ordering::Relaxed) {
                        return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
                    }

                    let stderr_output = stderr_slot
                        .lock()
                        .ok()
                        .map(|stderr_lock| stderr_lock.trim().to_string())
                        .filter(|stderr_output| !stderr_output.is_empty());
                    let error_message = stderr_output.unwrap_or_else(|| {
                        format!("`pw-record` exited unexpectedly (status={status}).")
                    });

                    return CaptureOutcome::capture_error(error_message);
                }
                Err(error) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(format!(
                        "Failed waiting on `pw-record`: {error}"
                    ));
                }
            },
        }
    }
}

#[cfg(target_os = "macos")]
fn capture_loopback_audio(
    session_id: &str,
    source_id: Option<&str>,
    target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    let helper_path = match resolve_macos_helper_path() {
        Ok(helper_path) => helper_path,
        Err(error) => return CaptureOutcome::capture_error(error),
    };

    let mut capture_command = Command::new(helper_path);
    capture_command.arg("capture");
    if let Some(source_id) = source_id {
        capture_command.arg("--source-id").arg(source_id);
    }

    if let Some(exclude_pid) = self_exclude_pid {
        capture_command
            .arg("--exclude-pid")
            .arg(exclude_pid.to_string());
    } else {
        capture_command
            .arg("--target-pid")
            .arg(target_pid.to_string());
    }

    let mut child = match capture_command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CaptureOutcome::capture_error(format!(
                "Failed to launch macOS audio helper: {error}"
            ))
        }
    };

    let Some(stdout_pipe) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CaptureOutcome::capture_error(
            "macOS audio helper did not expose stdout.".to_string(),
        );
    };

    let stderr_slot = Arc::new(Mutex::new(String::new()));
    let stderr_slot_for_thread = Arc::clone(&stderr_slot);
    let stderr_thread = child.stderr.take().map(|stderr_pipe| {
        thread::spawn(move || {
            let mut stderr_reader = io::BufReader::new(stderr_pipe);
            let mut stderr_output = String::new();
            let _ = stderr_reader.read_to_string(&mut stderr_output);
            if let Ok(mut stderr_lock) = stderr_slot_for_thread.lock() {
                *stderr_lock = stderr_output;
            }
        })
    });

    let (frame_sender, frame_receiver) = mpsc::channel::<Result<Vec<f32>, String>>();
    let stdout_thread = thread::spawn(move || {
        let mut stdout_reader = io::BufReader::new(stdout_pipe);

        loop {
            let mut packet_length_bytes = [0u8; 4];
            match stdout_reader.read_exact(&mut packet_length_bytes) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => {
                    let _ = frame_sender.send(Err(format!(
                        "Failed reading macOS audio packet header: {error}"
                    )));
                    return;
                }
            }

            let packet_length = u32::from_le_bytes(packet_length_bytes) as usize;
            if packet_length == 0
                || packet_length > MAX_APP_AUDIO_BINARY_FRAME_BYTES
                || packet_length % std::mem::size_of::<f32>() != 0
            {
                let _ = frame_sender.send(Err(
                    "Received malformed packet from macOS audio helper.".to_string(),
                ));
                return;
            }

            let mut payload = vec![0u8; packet_length];
            if let Err(error) = stdout_reader.read_exact(&mut payload) {
                let _ = frame_sender.send(Err(format!(
                    "Failed reading macOS audio packet payload: {error}"
                )));
                return;
            }

            let mut frame_samples = Vec::with_capacity(packet_length / std::mem::size_of::<f32>());
            for sample_bytes in payload.chunks_exact(std::mem::size_of::<f32>()) {
                frame_samples.push(f32::from_le_bytes([
                    sample_bytes[0],
                    sample_bytes[1],
                    sample_bytes[2],
                    sample_bytes[3],
                ]));
            }

            if frame_sender.send(Ok(frame_samples)).is_err() {
                return;
            }
        }
    });

    let mut sequence: u64 = 0;

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            if let Some(stderr_thread) = stderr_thread {
                let _ = stderr_thread.join();
            }
            return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
        }

        match frame_receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(frame_samples)) => {
                let frame_count = frame_samples.len() / APP_AUDIO_CHANNELS;
                if frame_count == 0 || frame_count * APP_AUDIO_CHANNELS != frame_samples.len() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(
                        "Received malformed PCM frame from macOS audio helper.".to_string(),
                    );
                }

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
                            frame_count,
                            PROTOCOL_VERSION,
                            0,
                            &frame_samples,
                        )
                    })
                    .unwrap_or(false);

                if !wrote_binary {
                    let frame_bytes = bytemuck::cast_slice(&frame_samples);
                    let pcm_base64 = BASE64.encode(frame_bytes);

                    enqueue_frame_event(
                        &frame_queue,
                        session_id,
                        target_id,
                        sequence,
                        APP_AUDIO_SAMPLE_RATE as usize,
                        frame_count,
                        pcm_base64,
                    );
                }

                sequence = sequence.saturating_add(1);
            }
            Ok(Err(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                if let Some(stderr_thread) = stderr_thread {
                    let _ = stderr_thread.join();
                }
                return CaptureOutcome::capture_error(error);
            }
            Err(RecvTimeoutError::Timeout) => match child.try_wait() {
                Ok(Some(status)) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }

                    if stop_flag.load(Ordering::Relaxed) {
                        return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
                    }

                    let stderr_output = stderr_slot
                        .lock()
                        .ok()
                        .map(|stderr_lock| stderr_lock.trim().to_string())
                        .filter(|stderr_output| !stderr_output.is_empty());
                    let error_message = stderr_output.unwrap_or_else(|| {
                        format!("macOS audio helper exited unexpectedly (status={status}).")
                    });

                    return CaptureOutcome::capture_error(error_message);
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(format!(
                        "Failed waiting on macOS audio helper: {error}"
                    ));
                }
            },
            Err(RecvTimeoutError::Disconnected) => match child.wait() {
                Ok(status) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }

                    if stop_flag.load(Ordering::Relaxed) {
                        return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
                    }

                    let stderr_output = stderr_slot
                        .lock()
                        .ok()
                        .map(|stderr_lock| stderr_lock.trim().to_string())
                        .filter(|stderr_output| !stderr_output.is_empty());
                    let error_message = stderr_output.unwrap_or_else(|| {
                        format!("macOS audio helper exited unexpectedly (status={status}).")
                    });

                    return CaptureOutcome::capture_error(error_message);
                }
                Err(error) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(format!(
                        "Failed waiting on macOS audio helper: {error}"
                    ));
                }
            },
        }
    }
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn capture_loopback_audio(
    _session_id: &str,
    _source_id: Option<&str>,
    _target_id: &str,
    _target_pid: u32,
    _self_exclude_pid: Option<u32>,
    _stop_flag: Arc<AtomicBool>,
    _frame_queue: Arc<FrameQueue>,
    _app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    CaptureOutcome::capture_error(
        "Per-app audio capture is only available on Windows, macOS, and Linux.".to_string(),
    )
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
        let outcome = capture_loopback_audio(
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

#[cfg(target_os = "macos")]
fn classify_macos_helper_error_code(error: &str) -> &'static str {
    let normalized_error = error.to_ascii_lowercase();

    if normalized_error.contains("not found at")
        || normalized_error.contains("failed to launch macos helper")
    {
        return "macos-helper-unavailable";
    }

    if normalized_error.contains("requires macos 13 or newer") {
        return "macos-version-unsupported";
    }

    if normalized_error.contains("permission")
        || normalized_error.contains("not authorized")
        || normalized_error.contains("not permitted")
        || normalized_error.contains("shareable display")
    {
        return "macos-screen-recording-permission-required";
    }

    "macos-screen-audio-unavailable"
}

fn handle_capabilities_get() -> Result<Value, String> {
    let platform = std::env::consts::OS;
    #[cfg(target_os = "macos")]
    let macos_helper_probe_error = run_macos_helper_command(&["list-targets"]).err();

    #[cfg(not(target_os = "macos"))]
    let macos_helper_probe_error: Option<String> = None;

    #[cfg(target_os = "macos")]
    let macos_helper_probe_error_code = macos_helper_probe_error
        .as_deref()
        .map(classify_macos_helper_error_code);

    let (system_audio, per_app_audio, per_app_audio_reason, reason) = if cfg!(windows) {
        ("supported", "supported", None, None)
    } else if cfg!(target_os = "macos") {
        if macos_helper_probe_error.is_none() {
            ("supported", "supported", None, None)
        } else {
            (
                "unsupported",
                "unsupported",
                None,
                macos_helper_probe_error.clone(),
            )
        }
    } else if cfg!(target_os = "linux") {
        if pipewire_tools_available() {
            ("best-effort", "best-effort", None, None)
        } else {
            (
                "best-effort",
                "unsupported",
                Some(missing_pipewire_tools_reason()),
                None,
            )
        }
    } else {
        ("unsupported", "unsupported", None, None)
    };

    let mut response = json!({
        "platform": platform,
        "systemAudio": system_audio,
        "perAppAudio": per_app_audio,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    });

    if let Some(per_app_audio_reason) = per_app_audio_reason {
        response["perAppAudioReason"] = json!(per_app_audio_reason);
    }

    if let Some(reason) = reason {
        response["reason"] = json!(reason);
    }

    #[cfg(target_os = "macos")]
    if let Some(reason_code) = macos_helper_probe_error_code {
        response["reasonCode"] = json!(reason_code);
    }

    #[cfg(target_os = "linux")]
    {
        let session_type = detect_linux_session_type();
        let pipewire_tools_available = pipewire_tools_available();
        let (portal_available, portal_reason) = probe_linux_desktop_portal();
        let (x11_display_available, x11_display_reason) = probe_linux_x11_display();
        let app_audio_target_enumeration_reason = if pipewire_tools_available {
            None
        } else {
            Some(missing_pipewire_tools_reason())
        };
        let source_audio_target_inference_reason = Some(
            "Linux does not infer an app-audio target from the selected share source; choose a target manually."
                .to_string(),
        );
        let (global_push_keybinds, global_push_keybinds_reason) = if x11_display_available {
            if session_type == "wayland" {
                (
                    "best-effort",
                    Some(
                        "Global push keybinds use XWayland in Wayland sessions and may not work in every compositor."
                            .to_string(),
                    ),
                )
            } else {
                ("supported", None)
            }
        } else {
            ("unsupported", x11_display_reason.clone())
        };

        response["sessionType"] = json!(session_type);
        response["pipewireToolsAvailable"] = json!(pipewire_tools_available);
        response["portalAvailable"] = json!(portal_available);
        response["appAudioTargetEnumerationSupported"] = json!(pipewire_tools_available);
        response["sourceAudioTargetInferenceSupported"] = json!(false);
        response["globalPushKeybinds"] = json!(global_push_keybinds);
        response["x11DisplayAvailable"] = json!(x11_display_available);

        if let Some(reason) = portal_reason {
            response["portalReason"] = json!(reason);
            response["portalReasonCode"] = json!("linux-desktop-portal-required");
        }

        if let Some(reason) = app_audio_target_enumeration_reason {
            response["appAudioTargetEnumerationReason"] = json!(reason);
            response["appAudioTargetEnumerationReasonCode"] =
                json!("linux-pipewire-tools-missing");
            response["perAppAudioReasonCode"] = json!("linux-pipewire-tools-missing");
        }

        if let Some(reason) = source_audio_target_inference_reason {
            response["sourceAudioTargetInferenceReason"] = json!(reason);
            response["sourceAudioTargetInferenceReasonCode"] =
                json!("linux-manual-app-target-selection-required");
        }

        if let Some(reason) = global_push_keybinds_reason {
            response["globalPushKeybindsReason"] = json!(reason);
            response["globalPushKeybindsReasonCode"] = json!(if x11_display_available {
                "linux-xwayland-best-effort"
            } else {
                "linux-x11-display-required"
            });
        }

        if let Some(reason) = x11_display_reason {
            response["x11DisplayReason"] = json!(reason);
            response["x11DisplayReasonCode"] = json!("linux-x11-display-required");
        }
    }

    Ok(response)
}

fn handle_windows_resolve_source(params: Value) -> Result<Value, String> {
    let parsed: ResolveSourceParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    let pid = resolve_source_to_pid(&parsed.source_id);

    Ok(json!({
        "sourceId": parsed.source_id,
        "pid": pid,
    }))
}

fn handle_audio_targets_list(params: Value) -> Result<Value, String> {
    let parsed: ListTargetsParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    let targets = get_audio_targets();
    let suggested_target_id = parsed
        .source_id
        .as_deref()
        .and_then(resolve_source_to_pid)
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
        .and_then(resolve_source_to_pid)
        .is_some();

    let use_exclude_mode = self_exclude_pid.is_some()
        && parsed.app_audio_target_id.is_none()
        && !source_resolves_to_pid;

    let available_targets = get_audio_targets();

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
            .and_then(resolve_source_to_pid)
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

    // In per-app mode selfExcludePid is not forwarded — the include-mode loopback only
    // captures the target's process tree, so Ripcord's audio is never present there.
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

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let _ = &frame_queue;

    #[cfg(windows)]
    {
        let mut errors: Vec<String> = Vec::new();

        let talk_keybind = match parse_push_keybind(parsed.push_to_talk_keybind.as_deref()) {
            Ok(parsed_keybind) => parsed_keybind,
            Err(error) => {
                errors.push(format!("Push-to-talk keybind is invalid: {error}"));
                None
            }
        };

        let mut mute_keybind = match parse_push_keybind(parsed.push_to_mute_keybind.as_deref()) {
            Ok(parsed_keybind) => parsed_keybind,
            Err(error) => {
                errors.push(format!("Push-to-mute keybind is invalid: {error}"));
                None
            }
        };

        if talk_keybind.is_some() && mute_keybind.is_some() && talk_keybind == mute_keybind {
            mute_keybind = None;
            errors.push("Push-to-mute keybind matches push-to-talk and was ignored.".to_string());
        }

        if talk_keybind.is_some() || mute_keybind.is_some() {
            state.push_keybind_watcher = Some(start_push_keybind_watcher(
                frame_queue,
                talk_keybind,
                mute_keybind,
            ));
        }

        let talk_registered = talk_keybind.is_some();
        let mute_registered = mute_keybind.is_some();

        return Ok(json!({
            "talkRegistered": talk_registered,
            "muteRegistered": mute_registered,
            "errors": errors,
        }));
    }

    #[cfg(target_os = "macos")]
    {
        let mut errors: Vec<String> = Vec::new();

        let talk_keybind = match parse_push_keybind(parsed.push_to_talk_keybind.as_deref()) {
            Ok(parsed_keybind) => parsed_keybind,
            Err(error) => {
                errors.push(format!("Push-to-talk keybind is invalid: {error}"));
                None
            }
        };

        let mut mute_keybind = match parse_push_keybind(parsed.push_to_mute_keybind.as_deref()) {
            Ok(parsed_keybind) => parsed_keybind,
            Err(error) => {
                errors.push(format!("Push-to-mute keybind is invalid: {error}"));
                None
            }
        };

        if talk_keybind.is_some() && mute_keybind.is_some() && talk_keybind == mute_keybind {
            mute_keybind = None;
            errors.push("Push-to-mute keybind matches push-to-talk and was ignored.".to_string());
        }

        if talk_keybind.is_some() || mute_keybind.is_some() {
            state.push_keybind_watcher = Some(start_push_keybind_watcher(
                frame_queue,
                talk_keybind,
                mute_keybind,
            ));
        }

        let talk_registered = talk_keybind.is_some();
        let mute_registered = mute_keybind.is_some();

        return Ok(json!({
            "talkRegistered": talk_registered,
            "muteRegistered": mute_registered,
            "errors": errors,
        }));
    }

    #[cfg(target_os = "linux")]
    {
        let mut errors: Vec<String> = Vec::new();

        let talk_keybind = match parse_push_keybind(parsed.push_to_talk_keybind.as_deref()) {
            Ok(parsed_keybind) => parsed_keybind,
            Err(error) => {
                errors.push(format!("Push-to-talk keybind is invalid: {error}"));
                None
            }
        };

        let mut mute_keybind = match parse_push_keybind(parsed.push_to_mute_keybind.as_deref()) {
            Ok(parsed_keybind) => parsed_keybind,
            Err(error) => {
                errors.push(format!("Push-to-mute keybind is invalid: {error}"));
                None
            }
        };

        if talk_keybind.is_some() && mute_keybind.is_some() && talk_keybind == mute_keybind {
            mute_keybind = None;
            errors.push("Push-to-mute keybind matches push-to-talk and was ignored.".to_string());
        }

        // Only connect to X11 when at least one keybind is actually being registered.
        // Clearing keybinds (both None) must succeed without touching X11 so that
        // Wayland-only machines don't receive a spurious connectivity error.
        let mut resolved_talk: Option<(LinuxPushKeybind, u8)> = None;
        let mut resolved_mute: Option<(LinuxPushKeybind, u8)> = None;

        if talk_keybind.is_some() || mute_keybind.is_some() {
            match open_x11_and_resolve_keycodes(talk_keybind.as_ref(), mute_keybind.as_ref()) {
                Err(e) => errors.push(e),
                Ok((talk_kc, mute_kc)) => {
                    if talk_keybind.is_some() && talk_kc.is_none() {
                        errors.push(
                            "Push-to-talk key has no mapping on this keyboard layout.".to_string(),
                        );
                    }
                    if mute_keybind.is_some() && mute_kc.is_none() {
                        errors.push(
                            "Push-to-mute key has no mapping on this keyboard layout.".to_string(),
                        );
                    }
                    resolved_talk = talk_keybind.zip(talk_kc);
                    resolved_mute = mute_keybind.zip(mute_kc);

                    if resolved_talk.is_some() || resolved_mute.is_some() {
                        state.push_keybind_watcher = Some(start_push_keybind_watcher(
                            frame_queue,
                            resolved_talk,
                            resolved_mute,
                        ));
                    }
                }
            }
        }

        let talk_registered = resolved_talk.is_some();
        let mute_registered = resolved_mute.is_some();

        return Ok(json!({
            "talkRegistered": talk_registered,
            "muteRegistered": mute_registered,
            "errors": errors,
        }));
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let mut errors = Vec::new();
        if parsed.push_to_talk_keybind.is_some() || parsed.push_to_mute_keybind.is_some() {
            errors.push(
                "Global push keybind monitoring is not supported on this platform.".to_string(),
            );
        }

        Ok(json!({
            "talkRegistered": false,
            "muteRegistered": false,
            "errors": errors,
        }))
    }
}

fn start_app_audio_binary_egress() -> Result<AppAudioBinaryEgress, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Failed to bind app-audio binary egress listener: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| {
        format!("Failed to configure app-audio binary egress listener: {error}")
    })?;

    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read app-audio binary egress listener port: {error}"))?
        .port();

    let stream = Arc::new(Mutex::new(None::<TcpStream>));
    let worker_stream = Arc::clone(&stream);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        while !worker_stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((accepted_stream, _peer)) => {
                    let _ = accepted_stream.set_nodelay(true);
                    let _ = accepted_stream.set_write_timeout(Some(Duration::from_millis(15)));

                    if let Ok(mut lock) = worker_stream.lock() {
                        *lock = Some(accepted_stream);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => {
                    eprintln!("[capture-sidecar] app-audio binary egress accept error: {error}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        if let Ok(mut lock) = worker_stream.lock() {
            *lock = None;
        }
    });

    Ok(AppAudioBinaryEgress {
        port,
        stream,
        stop_flag,
        handle,
    })
}

fn handle_audio_capture_binary_egress_info(
    app_audio_binary_egress: &AppAudioBinaryEgress,
) -> Result<Value, String> {
    Ok(json!({
        "port": app_audio_binary_egress.port,
        "framing": APP_AUDIO_BINARY_EGRESS_FRAMING,
        "protocolVersion": PROTOCOL_VERSION,
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
                    handle_audio_capture_binary_egress_info(app_audio_binary_egress)
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
