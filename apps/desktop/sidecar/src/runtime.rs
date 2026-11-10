use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

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

pub(crate) struct AppAudioBinaryEgress {
    pub(crate) port: u16,
    pub(crate) auth_token: String,
    pub(crate) stream: Arc<Mutex<Option<TcpStream>>>,
    pub(crate) stop_flag: Arc<AtomicBool>,
    pub(crate) handle: JoinHandle<()>,
}

// Hand-written so a debug print can never put the stream's auth token in a log.
impl std::fmt::Debug for AppAudioBinaryEgress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppAudioBinaryEgress")
            .field("port", &self.port)
            .field("auth_token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
struct OutputQueueState {
    // Control events (e.g. push_keybind.state) are non-dropping and preserve
    // FIFO ordering. They are drained ahead of any queued audio frames.
    control_events: VecDeque<String>,
    // Audio frames are bounded and drop-oldest under backpressure.
    audio_frames: VecDeque<String>,
    closed: bool,
}

/// Two-lane output queue feeding the single stdout writer.
///
/// The audio-frame lane is bounded and drop-oldest so bulk capture cannot grow
/// memory without bound. The control-event lane is unbounded, non-dropping, and
/// drained before any queued audio frame, so latency-sensitive keybind edges
/// are never lost or stuck behind the audio backlog.
#[cfg_attr(
    not(any(windows, target_os = "macos", target_os = "linux")),
    allow(dead_code)
)]
pub(crate) struct OutputQueue {
    audio_frame_capacity: usize,
    dropped_count: AtomicU64,
    state: Mutex<OutputQueueState>,
    condvar: Condvar,
}

impl OutputQueue {
    pub(crate) fn new(audio_frame_capacity: usize) -> Self {
        Self {
            audio_frame_capacity,
            dropped_count: AtomicU64::new(0),
            state: Mutex::new(OutputQueueState::default()),
            condvar: Condvar::new(),
        }
    }

    /// Enqueue an audio-frame line. Bounded and drop-oldest: under sustained
    /// backpressure the oldest queued frame is discarded and counted so the
    /// next frame can advertise `droppedFrameCount`.
    #[cfg_attr(
        not(any(windows, target_os = "macos", target_os = "linux")),
        allow(dead_code)
    )]
    fn push_audio_frame(&self, line: String) {
        let mut lock = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };

        if lock.closed {
            return;
        }

        if lock.audio_frames.len() >= self.audio_frame_capacity {
            let _ = lock.audio_frames.pop_front();
            self.dropped_count.fetch_add(1, Ordering::Relaxed);
        }

        lock.audio_frames.push_back(line);
        self.condvar.notify_one();
    }

    /// Enqueue a control-event line. Never dropped due to audio pressure and
    /// FIFO-ordered. This only touches the queue's own mutex; it never performs
    /// stdout I/O nor waits on the stdout mutex, so key-polling threads cannot
    /// stall here.
    #[cfg_attr(
        not(any(windows, target_os = "macos", target_os = "linux")),
        allow(dead_code)
    )]
    fn push_control_event(&self, line: String) {
        let mut lock = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };

        if lock.closed {
            return;
        }

        lock.control_events.push_back(line);
        self.condvar.notify_one();
    }

    /// Pop the next line to write, draining all queued control events before any
    /// queued audio frame. Blocks until a line is available, or the queue is
    /// closed and both lanes are fully drained.
    fn pop(&self) -> Option<String> {
        let mut lock = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return None,
        };

        loop {
            if let Some(line) = lock.control_events.pop_front() {
                return Some(line);
            }

            if let Some(line) = lock.audio_frames.pop_front() {
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

    #[cfg_attr(
        not(any(windows, target_os = "macos", target_os = "linux")),
        allow(dead_code)
    )]
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

pub(crate) fn start_output_writer(
    stdout: Arc<Mutex<io::Stdout>>,
    queue: Arc<OutputQueue>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Some(line) = queue.pop() {
            let mut lock = match stdout.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };

            let _ = writeln!(lock, "{line}");
            let _ = lock.flush();
        }
    })
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub(crate) fn enqueue_frame_event(
    queue: &Arc<OutputQueue>,
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
        queue.push_audio_frame(serialized);
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
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
    queue: &Arc<OutputQueue>,
    kind: PushKeybindKind,
    active: bool,
) {
    // Push-keybind state changes ride the control-event lane: non-dropping and
    // drained ahead of any queued audio frame, so an edge is never lost or stuck
    // behind the audio backlog. Enqueueing only touches the output queue's own
    // mutex — never stdout — so key-polling threads never block on stdout I/O.
    // (A queued control event may still wait behind the single frame the writer
    // is already flushing, but not behind the queued audio backlog.) A lost or
    // stalled edge would leave the mic stuck muted or, worse, leak audio while
    // the user believes push-to-mute is engaged.
    if let Ok(serialized) = serde_json::to_string(&SidecarEvent {
        event: "push_keybind.state",
        params: json!({
            "kind": kind.as_str(),
            "active": active,
        }),
    }) {
        queue.push_control_event(serialized);
    }
}

// Bound the whole handshake, including clients that trickle bytes. Never hold the
// active stream lock while authenticating a new connection.
fn authenticate_app_audio_stream(stream: &mut TcpStream, token: &[u8]) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut received = [0_u8; 64];
    let mut offset = 0;
    while offset < received.len() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Authentication timed out"))?;
        stream.set_read_timeout(Some(remaining))?;
        match stream.read(&mut received[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Incomplete authentication",
                ))
            }
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Authentication timed out",
        ));
    }
    let mut difference = 0_u8;
    for (actual, expected) in received.iter().zip(token) {
        difference |= actual ^ expected;
    }
    if difference != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid authentication",
        ));
    }

    stream.set_read_timeout(None)?;
    // Preserve the pre-authentication write behavior explicitly: accept inherits
    // nonblocking on Windows/macOS; Linux accept4 uses only SOCK_CLOEXEC.
    stream.set_nonblocking(cfg!(any(windows, target_os = "macos")))?;
    stream.set_nodelay(true)?;
    stream.set_write_timeout(Some(Duration::from_millis(15)))?;
    Ok(())
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

    let auth_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let worker_auth_token = auth_token.clone();
    let stream = Arc::new(Mutex::new(None::<TcpStream>));
    let worker_stream = Arc::clone(&stream);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        while !worker_stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut accepted_stream, _peer)) => {
                    if authenticate_app_audio_stream(
                        &mut accepted_stream,
                        worker_auth_token.as_bytes(),
                    )
                    .is_err()
                    {
                        eprintln!("[capture-sidecar] app-audio binary egress client rejected");
                        continue;
                    }
                    if let Ok(mut lock) = worker_stream.lock() {
                        *lock = Some(accepted_stream);
                        eprintln!("[capture-sidecar] app-audio binary egress client accepted");
                    } else {
                        eprintln!("[capture-sidecar] app-audio binary egress client rejected");
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
        auth_token,
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
        "authToken": app_audio_binary_egress.auth_token,
        "framing": APP_AUDIO_BINARY_EGRESS_FRAMING,
        "protocolVersion": PROTOCOL_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::OutputQueue;

    use super::{start_app_audio_binary_egress, AppAudioBinaryEgress};
    use std::io::{Read, Write};
    use std::net::{Shutdown, SocketAddr, TcpStream};
    use std::sync::atomic::Ordering;
    use std::thread;
    use std::time::{Duration, Instant};

    struct TestEgress(Option<AppAudioBinaryEgress>);

    impl Drop for TestEgress {
        fn drop(&mut self) {
            if let Some(egress) = self.0.take() {
                egress.stop_flag.store(true, Ordering::Relaxed);
                egress.handle.join().unwrap();
            }
        }
    }

    fn wait_for_client(egress: &AppAudioBinaryEgress, address: SocketAddr) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if egress
                .stream
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|stream| stream.peer_addr().unwrap() == address)
            {
                return;
            }
            assert!(Instant::now() < deadline, "Client was not installed");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn binary_egress_authenticates_before_replacing_active_stream() {
        let guard = TestEgress(Some(start_app_audio_binary_egress().unwrap()));
        let egress = guard.0.as_ref().unwrap();
        assert_eq!(egress.auth_token.len(), 64);
        assert!(egress
            .auth_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        let mut first = TcpStream::connect(("127.0.0.1", egress.port)).unwrap();
        first.write_all(egress.auth_token.as_bytes()).unwrap();
        let first_address = first.local_addr().unwrap();
        wait_for_client(egress, first_address);

        for bytes in [
            &[b'x'; 64][..],
            &egress.auth_token.as_bytes()[..10],
            &[][..],
        ] {
            let mut rejected = TcpStream::connect(("127.0.0.1", egress.port)).unwrap();
            rejected
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            rejected.write_all(bytes).unwrap();
            if !bytes.is_empty() && bytes.len() < 64 {
                rejected.shutdown(Shutdown::Write).unwrap();
            }
            // Silent clients stay open: the server must enforce its own deadline.
            let started = Instant::now();
            let mut byte = [0];
            match rejected.read(&mut byte) {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                result => panic!("Rejected connection was not closed: {result:?}"),
            }
            assert!(started.elapsed() < Duration::from_secs(2));
            wait_for_client(egress, first_address);
            // Rejections must preserve actual delivery, not just slot identity.
            egress
                .stream
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .write_all(b"a")
                .unwrap();
            first
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            first.read_exact(&mut byte).unwrap();
            assert_eq!(byte, [b'a']);
        }

        let mut second = TcpStream::connect(("127.0.0.1", egress.port)).unwrap();
        second.write_all(egress.auth_token.as_bytes()).unwrap();
        wait_for_client(egress, second.local_addr().unwrap());
        first
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        assert_eq!(first.read(&mut [0]).unwrap(), 0);
    }

    fn audio_line(n: usize) -> String {
        format!("audio-{n}")
    }

    #[test]
    fn drains_control_events_before_queued_audio_frames() {
        let queue = OutputQueue::new(8);

        queue.push_audio_frame(audio_line(1));
        queue.push_audio_frame(audio_line(2));
        queue.push_control_event("control-1".to_string());
        queue.push_control_event("control-2".to_string());

        // Control events come out first, in FIFO order, ahead of the audio
        // frames that were enqueued before them.
        assert_eq!(queue.pop(), Some("control-1".to_string()));
        assert_eq!(queue.pop(), Some("control-2".to_string()));
        assert_eq!(queue.pop(), Some(audio_line(1)));
        assert_eq!(queue.pop(), Some(audio_line(2)));
    }

    #[test]
    fn overflowing_audio_lane_preserves_control_events() {
        let capacity = 4;
        let queue = OutputQueue::new(capacity);

        queue.push_control_event("control".to_string());

        // Push far more audio frames than the lane can hold.
        let pushed = capacity * 3;
        for n in 0..pushed {
            queue.push_audio_frame(audio_line(n));
        }

        // The control event survives regardless of audio pressure and is drained
        // first.
        assert_eq!(queue.pop(), Some("control".to_string()));

        // Only the most recent `capacity` audio frames remain; the rest were
        // dropped-oldest.
        let mut remaining = Vec::new();
        for _ in 0..capacity {
            remaining.push(queue.pop().expect("expected a queued audio frame"));
        }
        let expected: Vec<String> = ((pushed - capacity)..pushed).map(audio_line).collect();
        assert_eq!(remaining, expected);
        assert_eq!(queue.take_dropped_count(), (pushed - capacity) as u64);
    }

    #[test]
    fn close_drains_queued_events_before_returning_none() {
        let queue = OutputQueue::new(8);

        queue.push_control_event("control".to_string());
        queue.push_audio_frame(audio_line(1));
        queue.close();

        // Closing does not discard already-enqueued lines; they drain in
        // priority order first, then `None` signals end-of-stream.
        assert_eq!(queue.pop(), Some("control".to_string()));
        assert_eq!(queue.pop(), Some(audio_line(1)));
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn audio_dropped_count_tracks_discarded_frames() {
        let queue = OutputQueue::new(2);

        queue.push_audio_frame(audio_line(1));
        queue.push_audio_frame(audio_line(2));
        assert_eq!(queue.take_dropped_count(), 0);

        queue.push_audio_frame(audio_line(3)); // drops audio-1
        queue.push_audio_frame(audio_line(4)); // drops audio-2
        assert_eq!(queue.take_dropped_count(), 2);
        // Taking the count resets it.
        assert_eq!(queue.take_dropped_count(), 0);

        assert_eq!(queue.pop(), Some(audio_line(3)));
        assert_eq!(queue.pop(), Some(audio_line(4)));
    }
}
