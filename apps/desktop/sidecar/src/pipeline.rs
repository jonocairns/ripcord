use super::*;
#[cfg(windows)]
use std::sync::atomic::{AtomicU32, AtomicUsize};

#[cfg(windows)]
const MIC_CAPTURE_RING_BUFFER_FRAMES: usize = 32;
#[cfg(windows)]
const MIC_CAPTURE_WORKER_IDLE_WAIT: Duration = Duration::from_millis(5);

pub(crate) struct AudioFrame {
    pub(crate) samples: Vec<f32>,
    pub(crate) sample_rate: usize,
    pub(crate) channels: usize,
    pub(crate) timestamp_ms: Option<f64>,
    pub(crate) sequence: u64,
    pub(crate) protocol_version: Option<u32>,
}

impl AudioFrame {
    pub(crate) fn new(
        samples: Vec<f32>,
        sample_rate: usize,
        channels: usize,
        timestamp_ms: Option<f64>,
        sequence: u64,
        protocol_version: Option<u32>,
    ) -> Result<Self, String> {
        if channels == 0 {
            return Err("Audio frame channel count must be > 0".to_string());
        }

        if samples.len() % channels != 0 {
            return Err("Audio frame sample count mismatch".to_string());
        }

        Ok(Self {
            samples,
            sample_rate,
            channels,
            timestamp_ms: timestamp_ms.filter(|value| value.is_finite()),
            sequence,
            protocol_version,
        })
    }

    pub(crate) fn frame_count(&self) -> usize {
        self.samples.len() / self.channels
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, Default)]
pub(crate) struct StageStats {
    pub(crate) processed_frames: usize,
    pub(crate) processed_samples: usize,
}

#[cfg(windows)]
impl StageStats {
    fn for_frame(frame: &AudioFrame) -> Self {
        Self {
            processed_frames: frame.frame_count(),
            processed_samples: frame.samples.len(),
        }
    }
}

#[cfg(windows)]
pub(crate) trait Stage: Send {
    fn process(&mut self, frame: &mut AudioFrame) -> Result<StageStats, String>;
}

#[cfg(windows)]
pub(crate) struct Pipeline {
    stages: Vec<Box<dyn Stage>>,
}

#[cfg(windows)]
impl Pipeline {
    pub(crate) fn new() -> Self {
        Self { stages: Vec::new() }
    }

    pub(crate) fn push_stage(&mut self, stage: impl Stage + 'static) {
        self.stages.push(Box::new(stage));
    }

    pub(crate) fn process(&mut self, frame: &mut AudioFrame) -> Result<Vec<StageStats>, String> {
        let mut stats = Vec::with_capacity(self.stages.len());

        for stage in &mut self.stages {
            stats.push(stage.process(frame)?);
        }

        Ok(stats)
    }
}

#[cfg(windows)]
struct SampleRingBuffer {
    capacity: usize,
    slots: Box<[AtomicU32]>,
    read_index: AtomicUsize,
    write_index: AtomicUsize,
    dropped_samples: AtomicU64,
}

#[cfg(windows)]
impl SampleRingBuffer {
    fn new(capacity: usize) -> Self {
        let slots = std::iter::repeat_with(|| AtomicU32::new(0))
            .take(capacity.max(1))
            .collect::<Vec<_>>()
            .into_boxed_slice();

        Self {
            capacity: slots.len(),
            slots,
            read_index: AtomicUsize::new(0),
            write_index: AtomicUsize::new(0),
            dropped_samples: AtomicU64::new(0),
        }
    }

    fn available_samples(&self) -> usize {
        let write = self.write_index.load(Ordering::Acquire);
        let read = self.read_index.load(Ordering::Acquire);
        write.saturating_sub(read)
    }

    fn push_overwrite(&self, input: &[f32]) -> usize {
        if input.is_empty() {
            return 0;
        }

        let mut slice = input;
        let mut write = self.write_index.load(Ordering::Relaxed);
        let mut read = self.read_index.load(Ordering::Acquire);

        if slice.len() >= self.capacity {
            let dropped = slice.len().saturating_sub(self.capacity);
            self.dropped_samples.fetch_add(
                (write.saturating_sub(read) + dropped) as u64,
                Ordering::Relaxed,
            );
            slice = &slice[slice.len() - self.capacity..];
            read = write;
            self.read_index.store(read, Ordering::Release);
        } else {
            let available = write.saturating_sub(read);
            let free = self.capacity.saturating_sub(available);
            if slice.len() > free {
                let to_drop = slice.len() - free;
                self.dropped_samples
                    .fetch_add(to_drop as u64, Ordering::Relaxed);
                read = read.saturating_add(to_drop);
                self.read_index.store(read, Ordering::Release);
            }
        }

        for (offset, sample) in slice.iter().enumerate() {
            let index = (write + offset) % self.capacity;
            self.slots[index].store(sample.to_bits(), Ordering::Relaxed);
        }

        write = write.saturating_add(slice.len());
        self.write_index.store(write, Ordering::Release);
        slice.len()
    }

    fn pop_exact_into(&self, output: &mut [f32]) -> bool {
        if output.is_empty() {
            return true;
        }

        let read = self.read_index.load(Ordering::Relaxed);
        let write = self.write_index.load(Ordering::Acquire);
        if write.saturating_sub(read) < output.len() {
            return false;
        }

        for (offset, sample) in output.iter_mut().enumerate() {
            let index = (read + offset) % self.capacity;
            *sample = f32::from_bits(self.slots[index].load(Ordering::Relaxed));
        }

        self.read_index
            .store(read.saturating_add(output.len()), Ordering::Release);
        true
    }
}

#[cfg(windows)]
struct WorkerSignal {
    state: Mutex<()>,
    condvar: Condvar,
}

#[cfg(windows)]
impl WorkerSignal {
    fn new() -> Self {
        Self {
            state: Mutex::new(()),
            condvar: Condvar::new(),
        }
    }

    fn notify(&self) {
        self.condvar.notify_one();
    }

    fn wait_for_samples(
        &self,
        stop_flag: &AtomicBool,
        ring_buffer: &SampleRingBuffer,
        required_samples: usize,
    ) {
        if stop_flag.load(Ordering::Relaxed) || ring_buffer.available_samples() >= required_samples
        {
            return;
        }

        let Ok(lock) = self.state.lock() else {
            return;
        };

        if stop_flag.load(Ordering::Relaxed) || ring_buffer.available_samples() >= required_samples
        {
            return;
        }

        let _ = self
            .condvar
            .wait_timeout(lock, MIC_CAPTURE_WORKER_IDLE_WAIT);
    }
}

#[cfg(windows)]
struct VoiceFilterStage {
    state: Arc<Mutex<SidecarState>>,
    session_id: String,
    stop_flag: Arc<AtomicBool>,
    diagnostics: Arc<Mutex<Option<VoiceFilterDiagnostics>>>,
}

#[cfg(windows)]
impl VoiceFilterStage {
    fn new(
        state: Arc<Mutex<SidecarState>>,
        session_id: String,
        stop_flag: Arc<AtomicBool>,
        diagnostics: Arc<Mutex<Option<VoiceFilterDiagnostics>>>,
    ) -> Self {
        Self {
            state,
            session_id,
            stop_flag,
            diagnostics,
        }
    }
}

#[cfg(windows)]
impl Stage for VoiceFilterStage {
    fn process(&mut self, frame: &mut AudioFrame) -> Result<StageStats, String> {
        let result = {
            let mut state_lock = self
                .state
                .lock()
                .map_err(|_| "Sidecar state lock poisoned in pipeline stage".to_string())?;
            super::process_voice_filter_audio_frame(&mut state_lock, &self.session_id, frame)
        };

        match result {
            Ok(diagnostics) => {
                let mut slot = self
                    .diagnostics
                    .lock()
                    .map_err(|_| "Pipeline diagnostics lock poisoned".to_string())?;
                *slot = Some(diagnostics);
                Ok(StageStats::for_frame(frame))
            }
            Err(error) => {
                if matches!(
                    error.as_str(),
                    "No active voice filter session"
                        | "Voice filter session mismatch"
                        | "Sidecar state lock poisoned in pipeline stage"
                ) {
                    self.stop_flag.store(true, Ordering::Relaxed);
                }
                Err(error)
            }
        }
    }
}

#[cfg(windows)]
struct TransportStage {
    frame_queue: Arc<FrameQueue>,
    session_id: String,
    egress_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
    diagnostics: Arc<Mutex<Option<VoiceFilterDiagnostics>>>,
}

#[cfg(windows)]
impl TransportStage {
    fn new(
        frame_queue: Arc<FrameQueue>,
        session_id: String,
        egress_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
        diagnostics: Arc<Mutex<Option<VoiceFilterDiagnostics>>>,
    ) -> Self {
        Self {
            frame_queue,
            session_id,
            egress_stream,
            diagnostics,
        }
    }
}

#[cfg(windows)]
impl Stage for TransportStage {
    fn process(&mut self, frame: &mut AudioFrame) -> Result<StageStats, String> {
        let mut diagnostics_slot = self
            .diagnostics
            .lock()
            .map_err(|_| "Pipeline diagnostics lock poisoned".to_string())?;
        let diagnostics = diagnostics_slot
            .take()
            .ok_or_else(|| "Missing voice filter diagnostics".to_string())?;

        super::emit_voice_filter_audio_frame(
            &self.frame_queue,
            self.egress_stream.as_ref(),
            &self.session_id,
            frame,
            &diagnostics,
        );

        Ok(StageStats::for_frame(frame))
    }
}

#[cfg(windows)]
fn process_ring_buffer_frames(
    stop_flag: Arc<AtomicBool>,
    wake_signal: Arc<WorkerSignal>,
    ring_buffer: Arc<SampleRingBuffer>,
    mut pipeline: Pipeline,
) {
    let frame_samples = MIC_CAPTURE_FRAME_SIZE * TARGET_CHANNELS;
    let mut sequence: u64 = 0;
    let mut samples = vec![0.0f32; frame_samples];

    loop {
        while ring_buffer.pop_exact_into(&mut samples) {
            let mut frame = match AudioFrame::new(
                samples,
                TARGET_SAMPLE_RATE as usize,
                TARGET_CHANNELS,
                Some(super::steady_now_ms()),
                sequence,
                None,
            ) {
                Ok(frame) => frame,
                Err(error) => {
                    eprintln!("[capture-sidecar] mic pipeline frame error: {error}");
                    samples = vec![0.0f32; frame_samples];
                    break;
                }
            };

            match pipeline.process(&mut frame) {
                Ok(stage_stats) => {
                    let _ = stage_stats.iter().fold(0usize, |acc, stats| {
                        acc + stats.processed_frames + stats.processed_samples
                    });
                }
                Err(error) => {
                    eprintln!("[capture-sidecar] mic pipeline process error: {error}");
                    if stop_flag.load(Ordering::Relaxed) {
                        return;
                    }
                }
            }

            sequence = sequence.saturating_add(1);
            samples = frame.samples;
            if samples.len() != frame_samples {
                samples.resize(frame_samples, 0.0);
            }
        }

        if stop_flag.load(Ordering::Relaxed) && ring_buffer.available_samples() < frame_samples {
            return;
        }

        wake_signal.wait_for_samples(stop_flag.as_ref(), &ring_buffer, frame_samples);
    }
}

#[cfg(windows)]
pub(crate) fn capture_mic_audio(
    session_id: String,
    device_id: Option<String>,
    stop_flag: Arc<AtomicBool>,
    state: Arc<Mutex<SidecarState>>,
    frame_queue: Arc<FrameQueue>,
) {
    let frame_samples = MIC_CAPTURE_FRAME_SIZE * TARGET_CHANNELS;
    let ring_buffer = Arc::new(SampleRingBuffer::new(
        frame_samples * MIC_CAPTURE_RING_BUFFER_FRAMES,
    ));
    let wake_signal = Arc::new(WorkerSignal::new());
    let diagnostics = Arc::new(Mutex::new(None));
    let egress_stream = state
        .lock()
        .ok()
        .and_then(|state_lock| state_lock.voice_filter_binary_egress_stream.clone());

    let mut pipeline = Pipeline::new();
    pipeline.push_stage(VoiceFilterStage::new(
        Arc::clone(&state),
        session_id.clone(),
        Arc::clone(&stop_flag),
        Arc::clone(&diagnostics),
    ));
    pipeline.push_stage(TransportStage::new(
        Arc::clone(&frame_queue),
        session_id.clone(),
        egress_stream,
        Arc::clone(&diagnostics),
    ));

    let worker_stop_flag = Arc::clone(&stop_flag);
    let worker_signal = Arc::clone(&wake_signal);
    let worker_ring_buffer = Arc::clone(&ring_buffer);
    let processing_handle = thread::spawn(move || {
        process_ring_buffer_frames(
            worker_stop_flag,
            worker_signal,
            worker_ring_buffer,
            pipeline,
        );
    });

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };

    let result: Result<(), String> = (|| {
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| format!("CoCreateInstance IMMDeviceEnumerator failed: {error}"))?
        };

        let device = if let Some(ref id) = device_id {
            let id_wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                enumerator
                    .GetDevice(PCWSTR(id_wide.as_ptr()))
                    .map_err(|error| format!("GetDevice failed: {error}"))?
            }
        } else {
            unsafe {
                enumerator
                    .GetDefaultAudioEndpoint(eCapture, eConsole)
                    .map_err(|error| format!("GetDefaultAudioEndpoint failed: {error}"))?
            }
        };

        let audio_client: IAudioClient = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|error| format!("IMMDevice::Activate IAudioClient failed: {error}"))?
        };

        // Request RAW mode to bypass Windows APOs (audio processing objects) such as
        // noise suppression, equalisation, and other driver-level enhancements that
        // would otherwise interfere with our own signal chain.  This is best-effort:
        // some devices/Windows versions do not support raw mode, in which case we
        // silently continue without it.
        let raw_mode_result: Result<(), String> = match audio_client.cast::<IAudioClient2>() {
            Err(error) => Err(format!("IAudioClient2 not available: {error}")),
            Ok(audio_client2) => {
                let props = AudioClientProperties {
                    cbSize: std::mem::size_of::<AudioClientProperties>() as u32,
                    bIsOffload: false.into(),
                    eCategory: windows::Win32::Media::Audio::AudioCategory_Communications,
                    Options: AUDCLNT_STREAMOPTIONS_RAW,
                };
                unsafe { audio_client2.SetClientProperties(&props) }
                    .map_err(|error| format!("SetClientProperties failed: {error}"))
            }
        };

        let capture_format = WAVEFORMATEX {
            wFormatTag: 0x0003, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: TARGET_CHANNELS as u16,
            nSamplesPerSec: TARGET_SAMPLE_RATE,
            nAvgBytesPerSec: TARGET_SAMPLE_RATE * TARGET_CHANNELS as u32 * 4,
            nBlockAlign: (TARGET_CHANNELS * 4) as u16,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        unsafe {
            audio_client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    0,
                    0,
                    &capture_format,
                    None,
                )
                .map_err(|error| format!("IAudioClient::Initialize failed: {error}"))?
        };

        let mut engine_period_hns = 0i64;
        unsafe {
            audio_client
                .GetDevicePeriod(Some(&mut engine_period_hns), None)
                .map_err(|error| format!("IAudioClient::GetDevicePeriod failed: {error}"))?
        };

        let capture_ready_event = OwnedHandle(
            unsafe { CreateEventW(None, false, false, None) }
                .map_err(|error| format!("CreateEventW failed: {error}"))?,
        );

        unsafe {
            audio_client
                .SetEventHandle(capture_ready_event.raw())
                .map_err(|error| format!("IAudioClient::SetEventHandle failed: {error}"))?
        };

        let engine_period_ms = ((engine_period_hns.max(0) as u64) + 9_999) / 10_000;
        let wait_timeout_ms = engine_period_ms.clamp(1, u32::MAX as u64) as u32;

        let capture_client: IAudioCaptureClient = unsafe {
            audio_client
                .GetService()
                .map_err(|error| format!("GetService IAudioCaptureClient failed: {error}"))?
        };

        unsafe {
            audio_client
                .Start()
                .map_err(|error| format!("IAudioClient::Start failed: {error}"))?
        };

        let raw_mode_status = match &raw_mode_result {
            Ok(()) => "enabled".to_string(),
            Err(reason) => format!("failed: {reason}"),
        };
        eprintln!("[sidecar] mic capture raw mode: {raw_mode_status}");
        if let Ok(event_json) = serde_json::to_string(&SidecarEvent {
            event: "mic_capture.status",
            params: json!({
                "sessionId": session_id,
                "rawModeEnabled": raw_mode_result.is_ok(),
                "rawModeStatus": raw_mode_status,
            }),
        }) {
            frame_queue.push_line(event_json);
        }

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = unsafe { audio_client.Stop() };
                return Ok(());
            }

            let wait_result =
                unsafe { WaitForSingleObject(capture_ready_event.raw(), wait_timeout_ms) };
            if wait_result == WAIT_TIMEOUT {
                continue;
            }
            if wait_result == WAIT_FAILED {
                let _ = unsafe { audio_client.Stop() };
                return Err("WaitForSingleObject failed for mic capture event".to_string());
            }
            if wait_result != WAIT_OBJECT_0 {
                let _ = unsafe { audio_client.Stop() };
                return Err(format!(
                    "Unexpected wait result for mic capture event: {}",
                    wait_result.0
                ));
            }

            let mut packet_size = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(size) => size,
                Err(_) => {
                    let _ = unsafe { audio_client.Stop() };
                    return Err("GetNextPacketSize failed (device lost)".to_string());
                }
            };

            if packet_size == 0 {
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
                    return Err("GetBuffer failed".to_string());
                }

                let chunk = if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    vec![0.0f32; frame_count as usize * TARGET_CHANNELS]
                } else {
                    let sample_count = frame_count as usize * TARGET_CHANNELS;
                    unsafe { std::slice::from_raw_parts(data_ptr as *const f32, sample_count) }
                        .to_vec()
                };

                let _ = unsafe { capture_client.ReleaseBuffer(frame_count) };

                if !chunk.is_empty() {
                    ring_buffer.push_overwrite(&chunk);
                    wake_signal.notify();
                }

                packet_size = match unsafe { capture_client.GetNextPacketSize() } {
                    Ok(size) => size,
                    Err(_) => {
                        let _ = unsafe { audio_client.Stop() };
                        return Err("GetNextPacketSize failed (device lost)".to_string());
                    }
                };
            }
        }
    })();

    stop_flag.store(true, Ordering::Relaxed);
    wake_signal.notify();
    let _ = processing_handle.join();

    if com_initialized {
        unsafe { CoUninitialize() };
    }

    if let Err(error) = result {
        eprintln!("[capture-sidecar] mic capture thread error: {error}");
        enqueue_voice_filter_ended_event(&frame_queue, &session_id, "capture_error", Some(error));
    }
}

#[cfg(not(windows))]
pub(crate) fn capture_mic_audio(
    _session_id: String,
    _device_id: Option<String>,
    _stop_flag: Arc<AtomicBool>,
    _state: Arc<Mutex<SidecarState>>,
    _frame_queue: Arc<FrameQueue>,
) {
}
