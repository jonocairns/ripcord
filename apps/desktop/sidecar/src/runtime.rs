use std::collections::VecDeque;
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::protocol::{
    PushKeybindKind, SidecarError, SidecarEvent, SidecarResponse, APP_AUDIO_BINARY_EGRESS_FRAMING,
    APP_AUDIO_CHANNELS, MAX_APP_AUDIO_BINARY_FRAME_BYTES, PCM_ENCODING, PROTOCOL_VERSION,
};

#[derive(Debug)]
pub(crate) struct PushKeybindWatcher {
    pub(crate) stop_flag: Arc<AtomicBool>,
    pub(crate) handle: JoinHandle<()>,
}

impl PushKeybindWatcher {
    pub(crate) fn new(stop_flag: Arc<AtomicBool>, handle: JoinHandle<()>) -> Self {
        Self { stop_flag, handle }
    }
}

#[derive(Debug)]
pub(crate) struct AppAudioBinaryEgress {
    pub(crate) port: u16,
    pub(crate) stream: Arc<Mutex<Option<TcpStream>>>,
    pub(crate) stop_flag: Arc<AtomicBool>,
    pub(crate) handle: JoinHandle<()>,
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
pub(crate) struct FrameQueue {
    capacity: usize,
    dropped_count: AtomicU64,
    state: Mutex<FrameQueueState>,
    condvar: Condvar,
}

impl FrameQueue {
    pub(crate) fn new(capacity: usize) -> Self {
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

    pub(crate) fn close(&self) {
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

pub(crate) fn now_unix_ms() -> u128 {
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

pub(crate) fn write_response(
    stdout: &Arc<Mutex<io::Stdout>>,
    id: &str,
    result: Result<Value, String>,
) {
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

pub(crate) fn write_event(stdout: &Arc<Mutex<io::Stdout>>, event: &str, params: Value) {
    let envelope = SidecarEvent { event, params };
    write_json_line(stdout, &envelope);
}

pub(crate) fn start_frame_writer(
    stdout: Arc<Mutex<io::Stdout>>,
    queue: Arc<FrameQueue>,
) -> JoinHandle<()> {
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
pub(crate) fn enqueue_frame_event(
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
pub(crate) fn try_write_app_audio_binary_frame(
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

    let payload_len = 2
        + session_id_bytes.len()
        + 2
        + target_id_bytes.len()
        + 8
        + 4
        + 2
        + 4
        + 4
        + 4
        + 4
        + pcm_bytes.len();

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
pub(crate) fn enqueue_push_keybind_state_event(
    queue: &Arc<FrameQueue>,
    kind: PushKeybindKind,
    active: bool,
) {
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

pub(crate) fn start_app_audio_binary_egress() -> Result<AppAudioBinaryEgress, String> {
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

pub(crate) fn audio_capture_binary_egress_info(
    app_audio_binary_egress: &AppAudioBinaryEgress,
) -> Value {
    json!({
        "port": app_audio_binary_egress.port,
        "framing": APP_AUDIO_BINARY_EGRESS_FRAMING,
        "protocolVersion": PROTOCOL_VERSION,
    })
}
