use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use deep_filter::tract::{DfParams, DfTract, ReduceMask, RuntimeParams};
use ndarray::Array2;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
#[cfg(any(windows, test))]
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};
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
use std::time::{Duration, Instant};

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
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
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

const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: usize = 2;
const FRAME_SIZE: usize = 960;
const PROTOCOL_VERSION: u32 = 1;
const PCM_ENCODING: &str = "f32le_base64";

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAudioCaptureParams {
    source_id: Option<String>,
    app_audio_target_id: Option<String>,
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

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum VoiceFilterStrength {
    Low,
    Balanced,
    High,
    Aggressive,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartVoiceFilterParams {
    sample_rate: usize,
    channels: usize,
    suppression_level: VoiceFilterStrength,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopVoiceFilterParams {
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceFilterPushFrameParams {
    session_id: String,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    pcm_base64: String,
    protocol_version: Option<u32>,
    encoding: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum CaptureEndReason {
    #[cfg(windows)]
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
            #[cfg(windows)]
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
    #[cfg(windows)]
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

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushKeybindKind {
    Talk,
    Mute,
}

#[cfg(windows)]
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

#[derive(Debug, Clone, Copy)]
struct VoiceFilterConfig {
    post_filter_beta: f32,
    atten_lim_db: f32,
    min_db_thresh: f32,
    max_db_erb_thresh: f32,
    max_db_df_thresh: f32,
}

struct DeepFilterProcessor {
    model: DfTract,
    hop_size: usize,
    input_buffers: Vec<VecDeque<f32>>,
    output_buffers: Vec<VecDeque<f32>>,
}

enum VoiceFilterProcessor {
    DeepFilter(DeepFilterProcessor),
}

struct VoiceFilterSession {
    session_id: String,
    sample_rate: usize,
    channels: usize,
    processor: VoiceFilterProcessor,
}

#[derive(Default)]
struct SidecarState {
    capture_session: Option<CaptureSession>,
    voice_filter_session: Option<VoiceFilterSession>,
    push_keybind_watcher: Option<PushKeybindWatcher>,
}

#[derive(Default)]
struct FrameQueueState {
    queue: VecDeque<String>,
    closed: bool,
}

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

#[cfg(windows)]
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
        "channels": TARGET_CHANNELS,
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

fn enqueue_voice_filter_frame_event(
    queue: &Arc<FrameQueue>,
    session_id: &str,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    pcm_base64: String,
) {
    let dropped_count = queue.take_dropped_count();

    let mut params = json!({
        "sessionId": session_id,
        "sequence": sequence,
        "sampleRate": sample_rate,
        "channels": channels,
        "frameCount": frame_count,
        "pcmBase64": pcm_base64,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    });

    if dropped_count > 0 {
        params["droppedFrameCount"] = json!(dropped_count);
    }

    if let Ok(serialized) = serde_json::to_string(&SidecarEvent {
        event: "voice_filter.frame",
        params,
    }) {
        queue.push_line(serialized);
    }
}

fn enqueue_voice_filter_ended_event(
    queue: &Arc<FrameQueue>,
    session_id: &str,
    reason: &str,
    error: Option<String>,
) {
    let mut params = json!({
        "sessionId": session_id,
        "reason": reason,
        "protocolVersion": PROTOCOL_VERSION,
    });

    if let Some(message) = error {
        params["error"] = json!(message);
    }

    if let Ok(serialized) = serde_json::to_string(&SidecarEvent {
        event: "voice_filter.ended",
        params,
    }) {
        queue.push_line(serialized);
    }
}

#[cfg(windows)]
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

fn voice_filter_config(strength: VoiceFilterStrength) -> VoiceFilterConfig {
    match strength {
        VoiceFilterStrength::Low => VoiceFilterConfig {
            post_filter_beta: 0.0,
            atten_lim_db: 24.0,
            min_db_thresh: -15.0,
            max_db_erb_thresh: 35.0,
            max_db_df_thresh: 20.0,
        },
        VoiceFilterStrength::Balanced => VoiceFilterConfig {
            post_filter_beta: 0.01,
            atten_lim_db: 40.0,
            min_db_thresh: -15.0,
            max_db_erb_thresh: 33.0,
            max_db_df_thresh: 18.0,
        },
        VoiceFilterStrength::High => VoiceFilterConfig {
            post_filter_beta: 0.02,
            atten_lim_db: 55.0,
            min_db_thresh: -18.0,
            max_db_erb_thresh: 30.0,
            max_db_df_thresh: 15.0,
        },
        VoiceFilterStrength::Aggressive => VoiceFilterConfig {
            post_filter_beta: 0.03,
            atten_lim_db: 70.0,
            min_db_thresh: -20.0,
            max_db_erb_thresh: 28.0,
            max_db_df_thresh: 12.0,
        },
    }
}

fn create_deep_filter_processor(
    channels: usize,
    suppression_level: VoiceFilterStrength,
) -> Result<DeepFilterProcessor, String> {
    let config = voice_filter_config(suppression_level);

    let reduce_mask = if channels > 1 {
        ReduceMask::MEAN
    } else {
        ReduceMask::NONE
    };

    let runtime_params = RuntimeParams::default_with_ch(channels)
        .with_mask_reduce(reduce_mask)
        .with_post_filter(config.post_filter_beta)
        .with_atten_lim(config.atten_lim_db)
        .with_thresholds(
            config.min_db_thresh,
            config.max_db_erb_thresh,
            config.max_db_df_thresh,
        );

    let df_params = DfParams::default();
    let model = DfTract::new(df_params, &runtime_params)
        .map_err(|error| format!("Failed to initialize DeepFilterNet runtime: {error}"))?;
    let hop_size = model.hop_size;

    Ok(DeepFilterProcessor {
        model,
        hop_size,
        input_buffers: (0..channels).map(|_| VecDeque::new()).collect(),
        output_buffers: (0..channels).map(|_| VecDeque::new()).collect(),
    })
}

fn create_voice_filter_session(
    session_id: String,
    sample_rate: usize,
    channels: usize,
    suppression_level: VoiceFilterStrength,
) -> Result<VoiceFilterSession, String> {
    if sample_rate != TARGET_SAMPLE_RATE as usize {
        return Err("DeepFilterNet currently requires 48kHz input".to_string());
    }

    if channels == 0 {
        return Err("Unsupported voice filter channel count".to_string());
    }

    let processor = create_deep_filter_processor(channels, suppression_level)?;

    Ok(VoiceFilterSession {
        session_id,
        sample_rate,
        channels,
        processor: VoiceFilterProcessor::DeepFilter(processor),
    })
}

fn decode_f32le_base64(pcm_base64: &str) -> Result<Vec<f32>, String> {
    let decoded = BASE64
        .decode(pcm_base64)
        .map_err(|error| format!("Failed to decode PCM base64: {error}"))?;

    if decoded.len() % 4 != 0 {
        return Err("Invalid PCM byte length".to_string());
    }

    let mut samples = Vec::with_capacity(decoded.len() / 4);
    for chunk in decoded.chunks_exact(4) {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        samples.push(sample);
    }

    Ok(samples)
}

fn process_voice_filter_frame(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
    channels: usize,
) -> Result<usize, String> {
    if samples.is_empty() || channels == 0 {
        return Ok(0);
    }

    let frame_count = samples.len() / channels;

    if frame_count == 0 {
        return Ok(0);
    }

    if samples.len() != frame_count * channels {
        return Err("Voice filter frame sample count mismatch".to_string());
    }

    match &mut session.processor {
        VoiceFilterProcessor::DeepFilter(processor) => {
            let hop_size = processor.hop_size;

            for frame_index in 0..frame_count {
                for channel_index in 0..channels {
                    let sample = samples[frame_index * channels + channel_index];
                    processor.input_buffers[channel_index].push_back(sample);
                }
            }

            while processor
                .input_buffers
                .iter()
                .all(|buffer| buffer.len() >= hop_size)
            {
                let mut noisy = Array2::<f32>::zeros((channels, hop_size));
                let mut enhanced = Array2::<f32>::zeros((channels, hop_size));

                for channel_index in 0..channels {
                    for sample_index in 0..hop_size {
                        noisy[(channel_index, sample_index)] = processor.input_buffers
                            [channel_index]
                            .pop_front()
                            .unwrap_or(0.0);
                    }
                }

                processor
                    .model
                    .process(noisy.view(), enhanced.view_mut())
                    .map_err(|error| format!("DeepFilterNet processing failed: {error}"))?;

                for channel_index in 0..channels {
                    for sample_index in 0..hop_size {
                        processor.output_buffers[channel_index]
                            .push_back(enhanced[(channel_index, sample_index)]);
                    }
                }
            }

            for frame_index in 0..frame_count {
                for channel_index in 0..channels {
                    let index = frame_index * channels + channel_index;
                    if let Some(filtered_sample) =
                        processor.output_buffers[channel_index].pop_front()
                    {
                        samples[index] = filtered_sample;
                    }
                }
            }

            Ok(frame_count)
        }
    }
}

fn voice_filter_frames_per_buffer(session: &VoiceFilterSession) -> usize {
    match &session.processor {
        VoiceFilterProcessor::DeepFilter(processor) => processor.hop_size,
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

fn parse_target_pid(target_id: &str) -> Option<u32> {
    target_id
        .strip_prefix("pid:")
        .and_then(|raw| raw.parse::<u32>().ok())
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

#[cfg(not(windows))]
fn process_name_from_pid(_pid: u32) -> Option<String> {
    None
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

#[cfg(not(windows))]
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

#[cfg(not(windows))]
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
fn activate_process_loopback_client(target_pid: u32) -> Result<IAudioClient, String> {
    let signal = Arc::new((Mutex::new(false), Condvar::new()));
    let callback: IActivateAudioInterfaceCompletionHandler =
        ActivateAudioInterfaceCallback::new(Arc::clone(&signal)).into();

    let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target_pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
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
    target_id: &str,
    target_pid: u32,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
) -> CaptureOutcome {
    let process_handle = match open_process_for_liveness(target_pid) {
        Some(handle) => handle,
        None => return CaptureOutcome::from_reason(CaptureEndReason::AppExited),
    };

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };

    let reason = (|| {
        let audio_client = activate_process_loopback_client(target_pid)?;
        let capture_format = WAVEFORMATEX {
            wFormatTag: 0x0003, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: TARGET_CHANNELS as u16,
            nSamplesPerSec: TARGET_SAMPLE_RATE,
            nAvgBytesPerSec: TARGET_SAMPLE_RATE * TARGET_CHANNELS as u32 * 4,
            nBlockAlign: (TARGET_CHANNELS * 4) as u16,
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
                if !process_is_alive(process_handle) {
                    let _ = unsafe { audio_client.Stop() };
                    return Ok(CaptureEndReason::AppExited);
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
                    vec![0.0f32; frame_count as usize * TARGET_CHANNELS]
                } else {
                    let sample_count = frame_count as usize * TARGET_CHANNELS;
                    unsafe { std::slice::from_raw_parts(data_ptr as *const f32, sample_count) }
                        .to_vec()
                };

                pending.extend_from_slice(&chunk);

                let _ = unsafe { capture_client.ReleaseBuffer(frame_count) };

                while pending.len() >= FRAME_SIZE * TARGET_CHANNELS {
                    let frame_samples: Vec<f32> =
                        pending.drain(..FRAME_SIZE * TARGET_CHANNELS).collect();
                    let frame_bytes = bytemuck::cast_slice(&frame_samples);
                    let pcm_base64 = BASE64.encode(frame_bytes);

                    enqueue_frame_event(
                        &frame_queue,
                        session_id,
                        target_id,
                        sequence,
                        TARGET_SAMPLE_RATE as usize,
                        FRAME_SIZE,
                        pcm_base64,
                    );

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

    let _ = unsafe { windows::Win32::Foundation::CloseHandle(process_handle) };
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

#[cfg(not(windows))]
fn capture_loopback_audio(
    _session_id: &str,
    _target_id: &str,
    _target_pid: u32,
    _stop_flag: Arc<AtomicBool>,
    _frame_queue: Arc<FrameQueue>,
) -> CaptureOutcome {
    CaptureOutcome::capture_error("Per-app audio capture is only available on Windows.".to_string())
}

fn start_capture_thread(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    session_id: String,
    target_id: String,
    target_pid: u32,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let outcome = capture_loopback_audio(
            &session_id,
            &target_id,
            target_pid,
            Arc::clone(&stop_flag),
            Arc::clone(&frame_queue),
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
    let platform = std::env::consts::OS;
    let per_app_audio = if cfg!(windows) {
        "supported"
    } else {
        "unsupported"
    };
    let voice_filter = "supported";

    Ok(json!({
        "platform": platform,
        "perAppAudio": per_app_audio,
        "voiceFilter": voice_filter,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    }))
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
        .map(|pid| format!("pid:{pid}"));

    Ok(json!({
        "targets": targets,
        "suggestedTargetId": suggested_target_id,
        "protocolVersion": PROTOCOL_VERSION,
    }))
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

fn stop_voice_filter_session(
    state: &mut SidecarState,
    frame_queue: &Arc<FrameQueue>,
    requested_session_id: Option<&str>,
    reason: &str,
    error: Option<String>,
) {
    let Some(active_session) = state.voice_filter_session.take() else {
        return;
    };

    let should_stop = requested_session_id
        .map(|session_id| session_id == active_session.session_id)
        .unwrap_or(true);

    if should_stop {
        enqueue_voice_filter_ended_event(frame_queue, &active_session.session_id, reason, error);
        return;
    }

    state.voice_filter_session = Some(active_session);
}

fn handle_audio_capture_start(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("Per-app audio capture is only available on Windows.".to_string());
    }

    let parsed: StartAudioCaptureParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    stop_capture_session(state, None);

    let source_pid = parsed
        .source_id
        .as_deref()
        .and_then(resolve_source_to_pid)
        .map(|pid| format!("pid:{pid}"));

    let target_id = parsed
        .app_audio_target_id
        .or(source_pid)
        .ok_or_else(|| "No app audio target was provided and source mapping failed".to_string())?;

    let target_pid =
        parse_target_pid(&target_id).ok_or_else(|| "Invalid app audio target id".to_string())?;

    let target_exists = get_audio_targets()
        .iter()
        .any(|target| target.id == target_id);

    if !target_exists {
        return Err(format!(
            "Target process with pid {target_pid} is not available"
        ));
    }

    let session_id = Uuid::new_v4().to_string();
    let target_process_name =
        process_name_from_pid(target_pid).unwrap_or_else(|| "unknown.exe".to_string());
    eprintln!(
        "[capture-sidecar] start session={} targetId={} targetPid={} targetProcess={}",
        session_id, target_id, target_pid, target_process_name
    );
    let stop_flag = Arc::new(AtomicBool::new(false));
    let handle = start_capture_thread(
        stdout,
        frame_queue,
        session_id.clone(),
        target_id.clone(),
        target_pid,
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
        "sampleRate": TARGET_SAMPLE_RATE,
        "channels": TARGET_CHANNELS,
        "framesPerBuffer": FRAME_SIZE,
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

    #[cfg(not(windows))]
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

    #[cfg(not(windows))]
    {
        let mut errors = Vec::new();
        if parsed.push_to_talk_keybind.is_some() || parsed.push_to_mute_keybind.is_some() {
            errors.push(
                "Global push keybind monitoring via sidecar is only available on Windows."
                    .to_string(),
            );
        }

        Ok(json!({
            "talkRegistered": false,
            "muteRegistered": false,
            "errors": errors,
        }))
    }
}

fn handle_voice_filter_start(
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: StartVoiceFilterParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    if parsed.sample_rate != TARGET_SAMPLE_RATE as usize {
        return Err("DeepFilterNet currently supports only 48kHz input".to_string());
    }

    if parsed.channels == 0 || parsed.channels > 2 {
        return Err("Unsupported voice filter channel count".to_string());
    }

    stop_voice_filter_session(state, &frame_queue, None, "capture_stopped", None);

    let session_id = Uuid::new_v4().to_string();
    let session = create_voice_filter_session(
        session_id.clone(),
        parsed.sample_rate,
        parsed.channels,
        parsed.suppression_level,
    )?;
    let frames_per_buffer = voice_filter_frames_per_buffer(&session);

    state.voice_filter_session = Some(session);

    Ok(json!({
        "sessionId": session_id,
        "sampleRate": parsed.sample_rate,
        "channels": parsed.channels,
        "framesPerBuffer": frames_per_buffer,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    }))
}

fn handle_voice_filter_push_frame(
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: VoiceFilterPushFrameParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    let Some(session) = state.voice_filter_session.as_mut() else {
        return Err("No active voice filter session".to_string());
    };

    if session.session_id != parsed.session_id {
        return Err("Voice filter session mismatch".to_string());
    }

    if let Some(protocol_version) = parsed.protocol_version {
        if protocol_version != PROTOCOL_VERSION {
            return Err("Unsupported voice filter protocol version".to_string());
        }
    }

    if let Some(encoding) = parsed.encoding {
        if encoding != PCM_ENCODING {
            return Err("Unsupported voice filter frame encoding".to_string());
        }
    }

    if parsed.sample_rate != session.sample_rate {
        return Err("Voice filter sample rate mismatch".to_string());
    }

    if parsed.channels != session.channels {
        return Err("Voice filter channel count mismatch".to_string());
    }

    if parsed.channels == 0 || parsed.channels > 2 {
        return Err("Unsupported voice filter frame channel count".to_string());
    }

    let mut samples = decode_f32le_base64(&parsed.pcm_base64)?;
    process_voice_filter_frame(session, &mut samples, parsed.channels)?;

    let expected_frame_count = parsed.frame_count;

    if samples.len() != expected_frame_count * parsed.channels {
        return Err("Voice filter frame sample count mismatch".to_string());
    }

    let frame_bytes = bytemuck::cast_slice(&samples);
    let pcm_base64 = BASE64.encode(frame_bytes);

    enqueue_voice_filter_frame_event(
        &frame_queue,
        &session.session_id,
        parsed.sequence,
        parsed.sample_rate,
        parsed.channels,
        expected_frame_count,
        pcm_base64,
    );

    Ok(json!({
        "accepted": true,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_voice_filter_stop(
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: StopVoiceFilterParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    stop_voice_filter_session(
        state,
        &frame_queue,
        parsed.session_id.as_deref(),
        "capture_stopped",
        None,
    );

    Ok(json!({
        "stopped": true,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn main() {
    eprintln!("[capture-sidecar] starting");

    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let frame_queue = Arc::new(FrameQueue::new(50));
    let frame_writer = start_frame_writer(Arc::clone(&stdout), Arc::clone(&frame_queue));
    let mut state = SidecarState::default();

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
            "audio_capture.start" => handle_audio_capture_start(
                Arc::clone(&request_stdout),
                request_frame_queue,
                &mut state,
                request.params,
            ),
            "audio_capture.stop" => handle_audio_capture_stop(&mut state, request.params),
            "push_keybinds.set" => {
                handle_push_keybinds_set(request_frame_queue.clone(), &mut state, request.params)
            }
            "voice_filter.start" => {
                handle_voice_filter_start(request_frame_queue.clone(), &mut state, request.params)
            }
            "voice_filter.push_frame" => handle_voice_filter_push_frame(
                request_frame_queue.clone(),
                &mut state,
                request.params,
            ),
            "voice_filter.stop" => {
                handle_voice_filter_stop(request_frame_queue.clone(), &mut state, request.params)
            }
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

    stop_capture_session(&mut state, None);
    stop_push_keybind_watcher(&mut state);
    stop_voice_filter_session(&mut state, &frame_queue, None, "capture_stopped", None);
    frame_queue.close();
    let _ = frame_writer.join();

    eprintln!("[capture-sidecar] stopping");
}

#[cfg(test)]
mod tests {
    use super::{
        dedupe_window_entries_by_pid, parse_target_pid, parse_window_source_id, CaptureEndReason,
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
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::CaptureStopped.as_str(), "capture_stopped");
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::AppExited.as_str(), "app_exited");
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::DeviceLost.as_str(), "device_lost");
    }
}
