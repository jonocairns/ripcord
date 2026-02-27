use aec3::voip::VoipAec3;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use deep_filter::tract::{DfParams, DfTract, ReduceMask, RuntimeParams};
use ndarray::Array2;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(any(windows, test))]
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{self, BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
use std::time::Instant;

#[cfg(windows)]
use windows::core::GUID;
#[cfg(windows)]
use windows::core::{IUnknown, Interface, PCWSTR, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{
    BOOL, HANDLE, HWND, LPARAM, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, AudioClientProperties, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient, IAudioClient, IAudioClient2,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_INVALID_STREAM_FLAG, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDCLNT_STREAMOPTIONS_RAW, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
#[cfg(windows)]
use windows::Win32::System::Variant::VT_BLOB;
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
#[cfg(windows)]
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};
#[cfg(windows)]
use windows_core::implement;

const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: usize = 1;
const FRAME_SIZE: usize = 960;
const PROTOCOL_VERSION: u32 = 1;
const PCM_ENCODING: &str = "f32le_base64";
const APP_AUDIO_BINARY_EGRESS_FRAMING: &str = "length_prefixed_f32le_v1";
const VOICE_FILTER_BINARY_FRAMING: &str = "length_prefixed_f32le_v1";
#[cfg(windows)]
const MAX_APP_AUDIO_BINARY_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_VOICE_FILTER_BINARY_FRAME_BYTES: usize = 4 * 1024 * 1024;
const VOICE_FILTER_BINARY_EGRESS_FRAMING: &str = "length_prefixed_f32le_diag_v1";
const DEEP_FILTER_WARMUP_BLOCKS: usize = 20;
const ECHO_REFERENCE_MAX_BUFFER_MS: usize = 1_200;
const ECHO_REFERENCE_DELAY_MS: usize = 80;
const ECHO_CANCELLER_BLOCK_MS: usize = 10;
const ECHO_CANCELLER_FILTER_TAPS: usize = 192;
const ECHO_CANCELLER_REFERENCE_RMS_FLOOR: f32 = 3e-4;
const ECHO_CANCELLER_NLMS_STEP_SIZE: f32 = 0.14;
const ECHO_CANCELLER_NLMS_LEAK: f32 = 0.999_8;
const ECHO_CANCELLER_NLMS_ENERGY_FLOOR: f32 = 1e-4;
const ECHO_CANCELLER_NEAR_DOMINANCE_THRESHOLD: f32 = 1.8;
const ECHO_CANCELLER_RESIDUAL_CORRELATION_FLOOR: f32 = 0.2;
const ECHO_CANCELLER_DOUBLE_TALK_MIX: f32 = 0.35;
const ECHO_CANCELLER_NEAR_DOMINANT_MIX: f32 = 0.7;
const ECHO_CANCELLER_COEFFICIENT_LIMIT: f32 = 2.0;
const ECHO_CANCELLATION_BACKEND_ADAPTIVE: &str = "adaptive_nlms";
const ECHO_CANCELLATION_BACKEND_WEBRTC: &str = "webrtc_aec3";
// High-pass filter: 2nd-order Butterworth at 80 Hz / 48 kHz (Direct Form II transposed).
// Removes DC offset and low-frequency rumble (HVAC, desk vibration, electrical hum) before
// DeepFilterNet sees the signal.  Sub-80 Hz energy registers as broadband noise and causes
// the model to over-suppress uncertain bands — a common far-field mic problem.
// Coefficients computed via bilinear transform: fc=80 Hz, Q=1/√2, fs=48 kHz.
const HP_B0: f32 = 0.992_617;
const HP_B1: f32 = -1.985_234;
const HP_B2: f32 = 0.992_617;
const HP_A1: f32 = -1.985_207;
const HP_A2: f32 = 0.985_307;

// Limiter: threshold just below full scale, ~1ms attack, ~100ms release at 48kHz
#[cfg(windows)]
const MIC_CAPTURE_FRAME_SIZE: usize = 480; // 10ms at 48kHz — matches DeepFilterNet hop size
const LIMITER_THRESHOLD: f32 = 0.95;
const LIMITER_ATTACK_COEFF: f32 = 0.979_2; // exp(-1/48)
const LIMITER_RELEASE_COEFF: f32 = 0.999_8; // exp(-1/4800)

#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl OwnedHandle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

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
struct MicDevice {
    id: String,
    label: String,
}

#[cfg(windows)]
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_values(
        0xa45c_254e,
        0xdf1c,
        0x4efd,
        [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
    ),
    pid: 14,
};

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
    noise_suppression: Option<bool>,
    auto_gain_control: Option<bool>,
    echo_cancellation: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartVoiceFilterWithCaptureParams {
    sample_rate: usize,
    channels: usize,
    suppression_level: VoiceFilterStrength,
    noise_suppression: Option<bool>,
    auto_gain_control: Option<bool>,
    echo_cancellation: Option<bool>,
    device_id: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceFilterPushReferenceFrameParams {
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

// SAFETY: `DeepFilterProcessor` is never accessed concurrently. It is always
// stored inside `SidecarState`, which is guarded by `Mutex<SidecarState>`.
// This guarantees serialized access when the state is touched from different
// threads (command loop and binary-ingress worker).
unsafe impl Send for DeepFilterProcessor {}

enum VoiceFilterProcessor {
    DeepFilter(DeepFilterProcessor),
    Passthrough,
}

#[derive(Clone, Copy, Default)]
struct AdaptiveEchoMetrics {
    erle_db: Option<f32>,
    delay_ms: Option<f32>,
    double_talk_confidence: Option<f32>,
}

struct AdaptiveEchoCanceller {
    coefficients: Vec<f32>,
    estimated_echo: Vec<f32>,
    last_metrics: AdaptiveEchoMetrics,
}

impl AdaptiveEchoCanceller {
    fn new() -> Self {
        Self {
            coefficients: vec![0.0; ECHO_CANCELLER_FILTER_TAPS],
            estimated_echo: Vec::new(),
            last_metrics: AdaptiveEchoMetrics::default(),
        }
    }

    fn filter_len(&self) -> usize {
        self.coefficients.len()
    }

    fn last_metrics(&self) -> AdaptiveEchoMetrics {
        self.last_metrics
    }

    fn process_block(&mut self, near: &mut [f32], reference_window: &[f32]) {
        let filter_len = self.filter_len();
        self.last_metrics = AdaptiveEchoMetrics::default();
        if near.is_empty()
            || filter_len == 0
            || reference_window.len() < near.len() + filter_len.saturating_sub(1)
        {
            return;
        }

        self.estimated_echo.resize(near.len(), 0.0);

        let mut near_energy = 0.0_f32;
        let mut reference_energy = 0.0_f32;
        let mut estimated_echo_energy = 0.0_f32;
        let mut residual_energy = 0.0_f32;
        let mut residual_reference_dot = 0.0_f32;

        for sample_index in 0..near.len() {
            let mut estimated_echo = 0.0_f32;

            for tap_index in 0..filter_len {
                let reference = reference_window[sample_index + filter_len - 1 - tap_index];
                estimated_echo += self.coefficients[tap_index] * reference;
            }

            let near_sample = near[sample_index];
            let residual = near_sample - estimated_echo;
            let current_reference = reference_window[sample_index + filter_len - 1];

            self.estimated_echo[sample_index] = estimated_echo;
            near_energy += near_sample * near_sample;
            reference_energy += current_reference * current_reference;
            estimated_echo_energy += estimated_echo * estimated_echo;
            residual_energy += residual * residual;
            residual_reference_dot += residual * current_reference;
        }

        let frame_len = near.len() as f32;
        let near_rms = (near_energy / frame_len).sqrt();
        let reference_rms = (reference_energy / frame_len).sqrt();
        if reference_rms < ECHO_CANCELLER_REFERENCE_RMS_FLOOR {
            return;
        }

        let residual_rms = (residual_energy / frame_len).sqrt();
        let residual_correlation = residual_reference_dot.abs()
            / (residual_energy.sqrt() * reference_energy.sqrt() + 1e-6);
        let near_dominance = near_rms / (reference_rms + 1e-6);
        let near_dominance_confidence = ((near_dominance - 1.0)
            / (ECHO_CANCELLER_NEAR_DOMINANCE_THRESHOLD - 1.0))
            .clamp(0.0, 1.0);
        let decorrelation_confidence =
            (1.0 - residual_correlation / ECHO_CANCELLER_RESIDUAL_CORRELATION_FLOOR)
                .clamp(0.0, 1.0);
        let double_talk_confidence = near_dominance_confidence * decorrelation_confidence;
        let double_talk = double_talk_confidence >= 0.6;

        let erle_db = if estimated_echo_energy > ECHO_CANCELLER_NLMS_ENERGY_FLOOR
            && residual_energy > ECHO_CANCELLER_NLMS_ENERGY_FLOOR
        {
            Some(
                (10.0 * (estimated_echo_energy / residual_energy).log10()).clamp(-20.0, 45.0),
            )
        } else {
            None
        };
        self.last_metrics = AdaptiveEchoMetrics {
            erle_db,
            delay_ms: Some(ECHO_REFERENCE_DELAY_MS as f32),
            double_talk_confidence: Some(double_talk_confidence),
        };

        let cancellation_mix = if double_talk {
            ECHO_CANCELLER_DOUBLE_TALK_MIX
        } else if near_dominance > 1.25 {
            ECHO_CANCELLER_NEAR_DOMINANT_MIX
        } else {
            1.0
        };

        let mut adaptation_gate = if double_talk {
            0.0
        } else if near_dominance > 1.5 {
            0.35
        } else {
            1.0
        };
        adaptation_gate *= (residual_rms / (reference_rms + 1e-6)).clamp(0.15, 1.0);

        for sample_index in 0..near.len() {
            let near_sample = near[sample_index];
            let mut estimated_echo = 0.0_f32;
            let mut reference_energy_sum = 0.0_f32;
            for tap_index in 0..filter_len {
                let reference = reference_window[sample_index + filter_len - 1 - tap_index];
                estimated_echo += self.coefficients[tap_index] * reference;
                reference_energy_sum += reference * reference;
            }

            near[sample_index] = near_sample - estimated_echo * cancellation_mix;

            if adaptation_gate <= 0.0 {
                continue;
            }

            let residual = near_sample - estimated_echo;
            let step = ECHO_CANCELLER_NLMS_STEP_SIZE * adaptation_gate * residual
                / (reference_energy_sum + ECHO_CANCELLER_NLMS_ENERGY_FLOOR);

            for tap_index in 0..filter_len {
                let reference = reference_window[sample_index + filter_len - 1 - tap_index];
                self.coefficients[tap_index] =
                    (self.coefficients[tap_index] * ECHO_CANCELLER_NLMS_LEAK + step * reference)
                        .clamp(
                            -ECHO_CANCELLER_COEFFICIENT_LIMIT,
                            ECHO_CANCELLER_COEFFICIENT_LIMIT,
                        );
            }
        }
    }
}

struct WebRtcEchoCanceller {
    processor: VoipAec3,
    block_sample_len: usize,
    capture_output: Vec<f32>,
}

// SAFETY: same rationale as DeepFilterProcessor. The processor is always held
// behind the sidecar state mutex and accessed serially.
unsafe impl Send for WebRtcEchoCanceller {}

impl WebRtcEchoCanceller {
    fn new(sample_rate: usize, channels: usize) -> Result<Self, String> {
        let block_sample_len = (sample_rate / 100)
            .checked_mul(channels)
            .ok_or_else(|| "WebRTC AEC3 block size overflow".to_string())?;
        let processor = VoipAec3::builder(sample_rate, channels, channels)
            .build()
            .map_err(|error| format!("Failed to initialize WebRTC AEC3: {error}"))?;

        Ok(Self {
            processor,
            block_sample_len,
            capture_output: vec![0.0; block_sample_len],
        })
    }

    fn process_block(
        &mut self,
        near: &mut [f32],
        reference_block: &[f32],
    ) -> Result<AdaptiveEchoMetrics, String> {
        if near.len() != self.block_sample_len || reference_block.len() != self.block_sample_len {
            return Err("WebRTC AEC3 block size mismatch".to_string());
        }

        self.processor
            .handle_render_frame(reference_block)
            .map_err(|error| format!("WebRTC AEC3 render processing failed: {error}"))?;

        let metrics = self
            .processor
            .process_capture_frame(near, false, &mut self.capture_output)
            .map_err(|error| format!("WebRTC AEC3 capture processing failed: {error}"))?;
        near.copy_from_slice(&self.capture_output);

        Ok(AdaptiveEchoMetrics {
            erle_db: Some(metrics.echo_return_loss_enhancement as f32),
            delay_ms: Some(metrics.delay_ms as f32),
            double_talk_confidence: None,
        })
    }
}

enum EchoCancellerBackend {
    AdaptiveNlms(AdaptiveEchoCanceller),
    WebRtcAec3(WebRtcEchoCanceller),
}

impl EchoCancellerBackend {
    fn backend_name(&self) -> &'static str {
        match self {
            Self::AdaptiveNlms(_) => ECHO_CANCELLATION_BACKEND_ADAPTIVE,
            Self::WebRtcAec3(_) => ECHO_CANCELLATION_BACKEND_WEBRTC,
        }
    }
}

struct VoiceFilterSession {
    session_id: String,
    sample_rate: usize,
    channels: usize,
    processor: VoiceFilterProcessor,
    suppression_startup_ramp_ms_remaining: u32,
    high_pass_filters: Vec<HighPassFilter>,
    auto_gain_control: bool,
    trim_level_rms: f32,
    trim_gain: f32,
    agc_startup_bypass_ms_remaining: u32,
    echo_canceller: Option<EchoCancellerBackend>,
    echo_reference_interleaved: VecDeque<f32>,
    limiter_gain: f32,
    expander_envelope: f32,
    expander_gain: f32,
    expander_hangover_samples_remaining: u32,
    dfn_output_rms_prev: f32,
    noise_rng_state: u32,
    dezipper_prev_sample: f32,
    vad: VadState,
    transient_suppressor: TransientSuppressorState,
    lsnr_smoothed: f32,
}

impl VoiceFilterSession {
    fn echo_cancellation_backend(&self) -> Option<&'static str> {
        self.echo_canceller
            .as_ref()
            .map(EchoCancellerBackend::backend_name)
    }

    fn push_echo_reference_samples(
        &mut self,
        input_samples: &[f32],
        input_channels: usize,
    ) -> Result<(), String> {
        if input_channels == 0 || input_channels > 2 {
            return Err("Unsupported reference frame channel count".to_string());
        }

        if self.channels == 0 || self.channels > 2 {
            return Err("Unsupported voice filter session channel count".to_string());
        }

        if input_samples.is_empty() {
            return Ok(());
        }

        let input_frame_count = input_samples.len() / input_channels;
        if input_frame_count == 0 || input_samples.len() != input_frame_count * input_channels {
            return Err("Reference frame sample count mismatch".to_string());
        }

        let max_reference_frames =
            ((self.sample_rate * ECHO_REFERENCE_MAX_BUFFER_MS) / 1_000).max(FRAME_SIZE);
        let max_reference_samples = max_reference_frames * self.channels;
        let incoming_samples = input_frame_count * self.channels;
        if incoming_samples > max_reference_samples {
            return Ok(());
        }

        for frame_index in 0..input_frame_count {
            match (input_channels, self.channels) {
                (1, 1) | (2, 2) => {
                    for channel_index in 0..self.channels {
                        let sample = input_samples[frame_index * input_channels + channel_index];
                        self.echo_reference_interleaved.push_back(sample);
                    }
                }
                (1, 2) => {
                    let sample = input_samples[frame_index];
                    self.echo_reference_interleaved.push_back(sample);
                    self.echo_reference_interleaved.push_back(sample);
                }
                (2, 1) => {
                    let left = input_samples[frame_index * 2];
                    let right = input_samples[frame_index * 2 + 1];
                    self.echo_reference_interleaved
                        .push_back((left + right) * 0.5);
                }
                _ => {
                    return Err("Unsupported reference channel conversion".to_string());
                }
            }
        }

        while self.echo_reference_interleaved.len() > max_reference_samples {
            let _ = self.echo_reference_interleaved.pop_front();
        }

        Ok(())
    }

    fn get_echo_reference_window(&self, sample_len: usize, history_len: usize) -> Option<Vec<f32>> {
        if sample_len == 0 {
            return None;
        }

        let required_delay_samples =
            ((self.sample_rate * ECHO_REFERENCE_DELAY_MS) / 1_000) * self.channels;
        let total_required_samples = required_delay_samples + history_len + sample_len;
        if self.echo_reference_interleaved.len() < total_required_samples {
            return None;
        }

        let start = self.echo_reference_interleaved.len() - total_required_samples;
        let end = start + history_len + sample_len;
        let mut out = Vec::with_capacity(sample_len);
        out.extend(
            self.echo_reference_interleaved
                .iter()
                .skip(start)
                .take(end - start)
                .copied(),
        );

        Some(out)
    }

    fn pop_echo_reference_block_or_silence(&mut self, sample_len: usize) -> Vec<f32> {
        if sample_len == 0 {
            return Vec::new();
        }

        let available_samples = sample_len.min(self.echo_reference_interleaved.len());
        let mut out = Vec::with_capacity(sample_len);

        for _ in 0..available_samples {
            if let Some(sample) = self.echo_reference_interleaved.pop_front() {
                out.push(sample);
            }
        }

        if out.len() < sample_len {
            out.resize(sample_len, 0.0);
        }

        out
    }
}

#[derive(Debug)]
struct AppAudioBinaryEgress {
    port: u16,
    stream: Arc<Mutex<Option<TcpStream>>>,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Debug)]
struct VoiceFilterBinaryEgress {
    port: u16,
    stream: Arc<Mutex<Option<TcpStream>>>,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Debug)]
struct VoiceFilterBinaryIngress {
    port: u16,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Debug)]
struct VoiceFilterBinaryFrame {
    session_id: String,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    protocol_version: u32,
    samples: Vec<f32>,
}

#[derive(Default)]
struct SidecarState {
    capture_session: Option<CaptureSession>,
    voice_filter_session: Option<VoiceFilterSession>,
    push_keybind_watcher: Option<PushKeybindWatcher>,
    mic_capture_stop_flag: Option<Arc<AtomicBool>>,
    // Binary egress stream for processed voice-filter frames. None until the
    // egress TCP server is started and set by main(). Arc clone is cheap.
    voice_filter_binary_egress_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
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

#[cfg(windows)]
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

// Write one processed voice-filter frame as a length-prefixed binary packet.
//
// Frame layout (all values little-endian):
//   [4]  payload_length (u32)
//   [2]  session_id_len (u16)
//   [N]  session_id (UTF-8)
//   [8]  sequence (u64)
//   [4]  sample_rate (u32)
//   [2]  channels (u16)
//   [4]  frame_count (u32)
//   [4]  protocol_version (u32)
//   [4]  dropped_frame_count (u32)
//   [1]  diag_flags  (bit 0 = lsnr present, bit 1 = agc_gain present, bit 2 = aec present)
//   [4]  ramp_wet_mix (f32, always)
//   [12] lsnr_mean + lsnr_min + lsnr_max (f32 each, if bit 0)
//   [4]  agc_gain (f32, if bit 1)
//   [12] aec_erle_db + aec_delay_ms + aec_double_talk_confidence (f32 each, if bit 2)
//   [4]  pcm_byte_length (u32)
//   [M]  pcm data (f32le)
fn try_write_voice_filter_binary_egress_frame(
    stream_slot: &Arc<Mutex<Option<TcpStream>>>,
    session_id: &str,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    protocol_version: u32,
    dropped_frame_count: u32,
    diagnostics: &VoiceFilterDiagnostics,
    frame_samples: &[f32],
) -> bool {
    let session_id_bytes = session_id.as_bytes();
    if session_id_bytes.is_empty() || session_id_bytes.len() > u16::MAX as usize {
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
    if frame_samples.is_empty() {
        return false;
    }

    let pcm_bytes = bytemuck::cast_slice(frame_samples);
    if pcm_bytes.len() > u32::MAX as usize {
        return false;
    }

    let mut diag_flags: u8 = 0;
    if diagnostics.lsnr_mean.is_some() {
        diag_flags |= 0x01;
    }
    if diagnostics.agc_gain.is_some() {
        diag_flags |= 0x02;
    }
    if diagnostics.aec_erle_db.is_some() {
        diag_flags |= 0x04;
    }
    let lsnr_bytes: usize = if diag_flags & 0x01 != 0 { 12 } else { 0 };
    let agc_bytes: usize = if diag_flags & 0x02 != 0 { 4 } else { 0 };
    let aec_bytes: usize = if diag_flags & 0x04 != 0 { 12 } else { 0 };

    let payload_len = 2
        + session_id_bytes.len()
        + 8  // sequence
        + 4  // sample_rate
        + 2  // channels
        + 4  // frame_count
        + 4  // protocol_version
        + 4  // dropped_frame_count
        + 1  // diag_flags
        + 4  // ramp_wet_mix
        + lsnr_bytes
        + agc_bytes
        + aec_bytes
        + 4  // pcm_byte_length
        + pcm_bytes.len();

    if payload_len > MAX_VOICE_FILTER_BINARY_FRAME_BYTES {
        return false;
    }

    let mut packet = Vec::with_capacity(4 + payload_len);
    packet.extend_from_slice(&(payload_len as u32).to_le_bytes());
    packet.extend_from_slice(&(session_id_bytes.len() as u16).to_le_bytes());
    packet.extend_from_slice(session_id_bytes);
    packet.extend_from_slice(&sequence.to_le_bytes());
    packet.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    packet.extend_from_slice(&(channels as u16).to_le_bytes());
    packet.extend_from_slice(&(frame_count as u32).to_le_bytes());
    packet.extend_from_slice(&protocol_version.to_le_bytes());
    packet.extend_from_slice(&dropped_frame_count.to_le_bytes());
    packet.push(diag_flags);
    packet.extend_from_slice(&diagnostics.ramp_wet_mix.to_le_bytes());
    if let Some(mean) = diagnostics.lsnr_mean {
        packet.extend_from_slice(&mean.to_le_bytes());
        packet.extend_from_slice(&diagnostics.lsnr_min.unwrap_or(0.0).to_le_bytes());
        packet.extend_from_slice(&diagnostics.lsnr_max.unwrap_or(0.0).to_le_bytes());
    }
    if let Some(gain) = diagnostics.agc_gain {
        packet.extend_from_slice(&gain.to_le_bytes());
    }
    if let Some(erle_db) = diagnostics.aec_erle_db {
        packet.extend_from_slice(&erle_db.to_le_bytes());
        packet.extend_from_slice(&diagnostics.aec_delay_ms.unwrap_or(0.0).to_le_bytes());
        packet.extend_from_slice(
            &diagnostics
                .aec_double_talk_confidence
                .unwrap_or(0.0)
                .to_le_bytes(),
        );
    }
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
            eprintln!("[capture-sidecar] voice-filter binary egress write failed: {error}");
            *lock = None;
            false
        }
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
    diagnostics: &VoiceFilterDiagnostics,
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
        "diag": {
            "rampWetMix": diagnostics.ramp_wet_mix,
        },
    });

    if let Some(mean) = diagnostics.lsnr_mean {
        params["diag"]["lsnrMean"] = json!(mean);
        params["diag"]["lsnrMin"] = json!(diagnostics.lsnr_min);
        params["diag"]["lsnrMax"] = json!(diagnostics.lsnr_max);
    }

    if let Some(gain) = diagnostics.agc_gain {
        params["diag"]["agcGain"] = json!(gain);
    }

    if let Some(erle_db) = diagnostics.aec_erle_db {
        params["diag"]["aecErleDb"] = json!(erle_db);
        params["diag"]["aecDelayMs"] = json!(diagnostics.aec_delay_ms);
        params["diag"]["aecDoubleTalkConfidence"] =
            json!(diagnostics.aec_double_talk_confidence);
    }

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

struct HighPassFilter {
    s1: f32,
    s2: f32,
}

impl HighPassFilter {
    fn new() -> Self {
        Self { s1: 0.0, s2: 0.0 }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = HP_B0 * x + self.s1;
        self.s1 = HP_B1 * x - HP_A1 * y + self.s2;
        self.s2 = HP_B2 * x - HP_A2 * y;
        y
    }
}

struct VoiceFilterDiagnostics {
    // Per-buffer LSNR stats from DeepFilterNet (None when running in passthrough mode).
    // Low values indicate the model sees mostly noise — the primary signal for over-suppression.
    lsnr_mean: Option<f32>,
    lsnr_min: Option<f32>,
    lsnr_max: Option<f32>,
    // Adaptive AEC metrics (None when AEC is disabled or has no valid reference).
    aec_erle_db: Option<f32>,
    aec_delay_ms: Option<f32>,
    aec_double_talk_confidence: Option<f32>,
    // AGC gain applied to this buffer (None when AGC is disabled).
    agc_gain: Option<f32>,
    // Dry/wet mix at the end of the startup ramp (0.0 = fully dry, 1.0 = fully wet/processed).
    // 1.0 once the ramp has completed.
    ramp_wet_mix: f32,
}

fn voice_filter_config(strength: VoiceFilterStrength) -> VoiceFilterConfig {
    // post_filter_beta sharpens the soft mask toward binary (0/1): speech bands
    // approach 1.0 (untouched), noise bands approach 0.0 (suppressed).  Small
    // values reduce the partial-suppression smearing that causes tinniness.
    // atten_lim_db caps the maximum suppression depth; lower ceilings prevent
    // the model from making deep mistakes on ambiguous speech bands.
    // min_db_thresh sets the SNR floor below which full suppression is applied.
    match strength {
        VoiceFilterStrength::Low => VoiceFilterConfig {
            post_filter_beta: 0.03,
            atten_lim_db: 15.0,
            min_db_thresh: -10.0,
            max_db_erb_thresh: 35.0,
            max_db_df_thresh: 20.0,
        },
        VoiceFilterStrength::Balanced => VoiceFilterConfig {
            post_filter_beta: 0.07,
            atten_lim_db: 25.0,
            min_db_thresh: -12.0,
            max_db_erb_thresh: 33.0,
            max_db_df_thresh: 18.0,
        },
        VoiceFilterStrength::High => VoiceFilterConfig {
            post_filter_beta: 0.13,
            atten_lim_db: 35.0,
            min_db_thresh: -15.0,
            max_db_erb_thresh: 30.0,
            max_db_df_thresh: 15.0,
        },
        VoiceFilterStrength::Aggressive => VoiceFilterConfig {
            post_filter_beta: 0.18,
            atten_lim_db: 45.0,
            min_db_thresh: -18.0,
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
    let mut model = DfTract::new(df_params, &runtime_params)
        .map_err(|error| format!("Failed to initialize DeepFilterNet runtime: {error}"))?;
    let hop_size = model.hop_size;

    // Warm the model upfront so first live frames don't pay cold-start inference cost.
    if DEEP_FILTER_WARMUP_BLOCKS > 0 {
        let noisy = Array2::<f32>::zeros((channels, hop_size));
        let mut enhanced = Array2::<f32>::zeros((channels, hop_size));
        for _ in 0..DEEP_FILTER_WARMUP_BLOCKS {
            model
                .process(noisy.view(), enhanced.view_mut())
                .map_err(|error| format!("Failed to warm DeepFilterNet runtime: {error}"))?;
            enhanced.fill(0.0);
        }
    }

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
    noise_suppression: bool,
    auto_gain_control: bool,
    echo_cancellation: bool,
) -> Result<VoiceFilterSession, String> {
    if sample_rate != TARGET_SAMPLE_RATE as usize {
        return Err("DeepFilterNet currently requires 48kHz input".to_string());
    }

    if channels == 0 {
        return Err("Unsupported voice filter channel count".to_string());
    }

    // Always operate in mono — DeepFilterNet quality is optimal on mono input,
    // and stereo doubles the model workload for no perceptual gain on voice.
    let mono_channels = 1;

    let processor = if noise_suppression {
        VoiceFilterProcessor::DeepFilter(create_deep_filter_processor(
            mono_channels,
            suppression_level,
        )?)
    } else {
        VoiceFilterProcessor::Passthrough
    };

    let echo_canceller = if echo_cancellation {
        Some(create_echo_canceller_backend(sample_rate, mono_channels))
    } else {
        None
    };

    Ok(VoiceFilterSession {
        session_id,
        sample_rate,
        channels: mono_channels,
        processor,
        auto_gain_control,
        trim_level_rms: 0.0,
        trim_gain: 1.0,
        suppression_startup_ramp_ms_remaining: if noise_suppression {
            SUPPRESSION_STARTUP_RAMP_MS
        } else {
            0
        },
        high_pass_filters: (0..mono_channels).map(|_| HighPassFilter::new()).collect(),
        agc_startup_bypass_ms_remaining: AGC_STARTUP_BYPASS_MS,
        echo_canceller,
        echo_reference_interleaved: VecDeque::new(),
        limiter_gain: 1.0,
        expander_envelope: 0.0,
        expander_gain: 1.0,
        expander_hangover_samples_remaining: 0,
        dfn_output_rms_prev: 0.0,
        noise_rng_state: 0x9e37_79b9, // arbitrary non-zero seed for xorshift32
        dezipper_prev_sample: 0.0,
        vad: VadState::default(),
        transient_suppressor: TransientSuppressorState::default(),
        lsnr_smoothed: 0.0,
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

fn create_echo_canceller_backend(sample_rate: usize, channels: usize) -> EchoCancellerBackend {
    match WebRtcEchoCanceller::new(sample_rate, channels) {
        Ok(canceller) => EchoCancellerBackend::WebRtcAec3(canceller),
        Err(error) => {
            eprintln!(
                "[capture-sidecar] WebRTC AEC3 unavailable, falling back to adaptive NLMS: {error}"
            );
            EchoCancellerBackend::AdaptiveNlms(AdaptiveEchoCanceller::new())
        }
    }
}

// Slow post-DFN trim: a long-time-constant RMS normaliser that makes coarse gain
// adjustments without any within-frame dynamics.  Updates once per 10ms frame.
// "Trim, not AGC" — the slew limit of ±0.1 dB/frame (= ±1 dB/100ms) means even
// large level changes take several hundred milliseconds to track, eliminating the
// watery pumping artifacts caused by fast pre-model gain riding.
const TRIM_TARGET_RMS: f32 = 0.12;           // desired long-term RMS level
const TRIM_LEVEL_TC_S: f32 = 0.400;          // 400ms IIR for level measurement
const TRIM_MIN_GAIN: f32 = 0.5;              // floor: -6 dB
const TRIM_MAX_GAIN: f32 = 2.0;              // ceil: +6 dB (4.0/+12 dB caused onset pumping)
const TRIM_SLEW_DB_PER_FRAME: f32 = 0.1;    // max change per 10ms frame = ±1 dB/100ms
const AGC_STARTUP_BYPASS_MS: u32 = 1_500;
// Suppression slew limit: cap how fast DFN can drop its output RMS per frame.
// Prevents abrupt suppression onsets from creating "clipped tail" artifacts.
const DFN_SLEW_MAX_DROP_DB_PER_FRAME: f32 = 6.0;  // max drop per 10ms = 60 dB/s
const DFN_SLEW_MIN_ACTIVE_DBFS: f32 = -60.0;      // don't apply below this (true silence)
// Comfort noise: inject shaped noise to prevent dead-flat digital silence.
const COMFORT_NOISE_THRESHOLD_DBFS: f32 = -65.0;  // apply when output RMS < this
const COMFORT_NOISE_LEVEL_DBFS: f32 = -72.0;      // injected noise amplitude
// Output de-zipper: one-pole IIR applied to the raw DFN output to smooth inter-hop
// amplitude discontinuities and mild musical noise before the slew limit / trim / expander
// chain.  Coefficient α=0.25 → -3dB at ≈10.6 kHz, -1.6 dB at 8 kHz — barely audible
// but enough to attenuate model-rate micro-variation at the hop boundary.
const DEZIPPER_COEFF: f32 = 0.25;
const SUPPRESSION_STARTUP_RAMP_MS: u32 = 1_000;
const SUPPRESSION_STARTUP_PRE_WARM_MS: f32 = 200.0; // hold fully dry while DFN calibrates
// Per-utterance onset ramp: on each new speech segment the DFN wet-mix is held at 0
// and ramped linearly to 1.0 over this many frames (10 ms each = 100 ms total).
// Gives the DFN model time to update its spectral mask from noise-suppression to
// speech-preservation mode before operating at full depth, eliminating onset tinniness.
const ONSET_WET_RAMP_FRAMES: u32 = 10;

// Downward expander — gentle noise-floor suppression placed after echo cancellation.
// A 1.5:1 expansion ratio attenuates residual noise without killing tails or plosives.
// The 150 ms hangover keeps gain at unity through brief inter-word silences so words
// don't clip at their onset.
const EXPANDER_THRESHOLD_DBFS: f32 = -35.0;    // dBFS gate point (baseline)
const EXPANDER_RATIO: f32 = 1.2;               // expansion ratio below threshold
const EXPANDER_ATTACK_MS: f32 = 2.0;           // envelope follower attack (ms)
const EXPANDER_RELEASE_MS: f32 = 600.0;        // envelope follower / gain release (ms)
const EXPANDER_HANGOVER_MS: f32 = 150.0;       // hold time after signal drops (ms)
// LSNR-driven threshold nudge: when DFN reports a low log-SNR the expander threshold
// is raised (more aggressive) so residual noise is suppressed harder.  When LSNR is
// clearly positive the threshold returns to baseline so clean speech is not touched.
const EXPANDER_LSNR_NUDGE_LOW_DB: f32 = -10.0;  // LSNR at/below this → full nudge
const EXPANDER_LSNR_NUDGE_HIGH_DB: f32 = 5.0;   // LSNR at/above this → no nudge
const EXPANDER_LSNR_THRESHOLD_RAISE_DB: f32 = 8.0; // max upward shift applied to threshold
// EWMA smoothing for the LSNR value that drives the threshold nudge.
// α=0.9 at 10ms frames → ~95ms time constant; kills frame-to-frame jitter.
const EXPANDER_LSNR_SMOOTH_ALPHA: f32 = 0.9;

// VAD: lightweight energy-based voice activity detector.
// Produces a speech probability and state machine per 10ms frame used as a control
// signal for the slow trim and expander — VAD never multiplies the audio directly.
// Design:
//   p_raw   = SNR(frame_rms / noise_floor) mapped to [0, 1] via linear ramp
//   p_smooth = EWMA(p_raw, α=VAD_ALPHA)  — ≈50ms smoothing at 10ms frames
//   state machine: Silence → Speech (onset) → Hangover → Silence (offset)
const VAD_ALPHA: f32 = 0.85;                  // EWMA smoothing coefficient
const VAD_SPEECH_THRESHOLD: f32 = 0.6;        // p_smooth to enter Speech
const VAD_SILENCE_THRESHOLD: f32 = 0.3;       // p_smooth to begin offset counter
const VAD_ONSET_FRAMES: u32 = 2;              // consecutive high-p frames to confirm onset (20ms)
const VAD_OFFSET_FRAMES: u32 = 8;             // consecutive low-p frames to confirm offset (80ms)
const VAD_HANGOVER_FRAMES: u32 = 100;         // hold time in Hangover state after Speech exits (at 10ms/frame = 1 s)
const VAD_ONSET_PROTECTION_FRAMES: u32 = 60;  // expander fully bypassed on new-speech onset (at 10ms/frame = 600 ms)
const VAD_NOISE_ADAPT_RATE: f32 = 0.002;      // noise floor adaptation speed (Silence frames only)
const VAD_SNR_LOW_DB: f32 = -3.0;             // SNR at/below → p_raw = 0.0
const VAD_SNR_HIGH_DB: f32 = 12.0;            // SNR at/above → p_raw = 1.0
const VAD_TRIM_SILENCE_RATE: f32 = 0.0;       // trim fully frozen in Silence — no drift
const VAD_TRIM_HANGOVER_RATE: f32 = 0.05;     // trim IIR / slew rate multiplier in Hangover (near-frozen)
// VAD impulse guard: prevents claps/thuds from being mistaken for speech onset.
// A frame with very high crest AND a sudden large energy jump in Silence is treated
// as an impulse — onset_counter is reset rather than incremented.  Crest threshold
// sits above the post-DFN speech ceiling (~6) and below the keyboard/clap floor (~7+).
const VAD_IMPULSE_CREST_THRESHOLD: f32 = 7.0; // crest above this in Silence → impulse, not speech onset
const VAD_IMPULSE_ENERGY_JUMP: f32 = 4.0;     // frame RMS must also be ×4 above previous frame

// Transient suppressor (clap / impulse detector).
// Detects frames with unusually high crest factor (peak/RMS) outside Speech state,
// then applies a band-split AHR gain envelope — highs cut more than lows — so the
// suppression knocks down the click's snap without thinning the voice's body.
// Post-DFN crest factors are lower than raw-mic values: DFN smooths peak energy so a
// keyboard press that measures crest≈15 at the mic is typically crest≈7–9 post-model.
const TRANS_CREST_THRESHOLD: f32 = 5.8;       // peak/RMS trigger (post-DFN keyboard ≈7–9, speech ≈3–5)
const TRANS_HOLD_MS: u32 = 30;                // hold at peak attenuation (30ms covers mechanical key decay)
const TRANS_RELEASE_MS: f32 = 100.0;          // gain recovery time after hold (100ms)
const TRANS_DEBOUNCE_MS: u32 = 60;            // minimum interval between triggers — prevents cumulative thinning
// Band-split gains: lows are cut less than highs, preserving warmth.
// LP + HP = identity when both gains = 1.0, so the split adds zero coloration at rest.
const TRANS_GAIN_LOW_DB: f32 = -6.0;          // low-band floor in Silence  (−6 dB  ≈ 0.50 linear)
const TRANS_GAIN_HIGH_DB: f32 = -17.0;        // high-band floor in Silence (−17 dB ≈ 0.14 linear)
const TRANS_GAIN_HO_LOW_DB: f32 = -3.0;       // low-band floor in Hangover (−3 dB  ≈ 0.71) — gentler
const TRANS_GAIN_HO_HIGH_DB: f32 = -12.0;     // high-band floor in Hangover (−12 dB ≈ 0.25)
const TRANS_CROSSOVER_HZ: f32 = 300.0;        // LP/HP crossover frequency
// Hangover guard: require a sudden energy rise above prev frame before triggering.
// A keyboard hit jumps from near-silence; a speech tail declines gradually.
const TRANS_ENERGY_JUMP_RATIO: f32 = 4.0;     // ×4 linear = 12 dB above prev frame RMS
// Spike repair: replace isolated single-sample spikes (mouse clicks, cable ticks, digital pops)
// with the average of their two neighbours.  Two conditions must both be true:
//   1. sample amplitude is at least SPIKE_CREST_THRESHOLD × local frame RMS
//   2. both immediate neighbours are less than SPIKE_NEIGHBOR_RATIO × the spike amplitude
// Conservative thresholds mean legitimate signal peaks are never touched.
const SPIKE_CREST_THRESHOLD: f32 = 8.0;       // sample/local_rms to flag as spike
const SPIKE_NEIGHBOR_RATIO: f32 = 0.5;        // each neighbour must be < 50% of spike abs

struct TransientSuppressorState {
    /// Current low-band gain ∈ [floor, 1.0].
    gain_low: f32,
    /// Current high-band gain ∈ [floor, 1.0].
    gain_high: f32,
    /// Remaining samples to hold at peak attenuation.
    hold_samples_remaining: u32,
    /// Remaining samples before a new trigger is allowed (debounce).
    debounce_samples_remaining: u32,
    /// RMS of the previous frame; used by the Hangover energy-jump guard.
    prev_rms: f32,
    /// One-pole LP filter state for the band split.
    lp_state: f32,
}

impl Default for TransientSuppressorState {
    fn default() -> Self {
        Self {
            gain_low: 1.0,
            gain_high: 1.0,
            hold_samples_remaining: 0,
            debounce_samples_remaining: 0,
            prev_rms: 0.0,
            lp_state: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VadSpeechState {
    Silence,
    Speech,
    Hangover,
}

struct VadState {
    /// EWMA-smoothed speech probability ∈ [0, 1].
    p_smooth: f32,
    speech_state: VadSpeechState,
    /// Consecutive frames with p_smooth ≥ VAD_SPEECH_THRESHOLD (onset confirmation).
    onset_counter: u32,
    /// Consecutive frames with p_smooth < VAD_SILENCE_THRESHOLD (offset confirmation).
    offset_counter: u32,
    /// Remaining frames in Hangover state.
    hangover_frames_remaining: u32,
    /// Remaining frames of expander bypass at the start of a new Speech segment.
    onset_protection_frames_remaining: u32,
    /// Remaining frames of the per-utterance DFN wet-mix ramp (0 = inactive / ramp complete).
    onset_wet_ramp_frames_remaining: u32,
    /// Adaptive noise floor RMS; updated only during Silence.
    noise_floor_rms: f32,
    /// RMS of the previous frame; used by the impulse guard to detect sudden energy jumps.
    prev_frame_rms: f32,
}

impl Default for VadState {
    fn default() -> Self {
        Self {
            p_smooth: 0.0,
            speech_state: VadSpeechState::Silence,
            onset_counter: 0,
            offset_counter: 0,
            hangover_frames_remaining: 0,
            onset_protection_frames_remaining: 0,
            onset_wet_ramp_frames_remaining: 0,
            noise_floor_rms: 1e-4, // small non-zero initial noise floor
            prev_frame_rms: 0.0,
        }
    }
}

struct VadOutput {
    speech_state: VadSpeechState,
}

fn suppression_startup_wet_mix(elapsed_ms: f32) -> f32 {
    if elapsed_ms <= SUPPRESSION_STARTUP_PRE_WARM_MS {
        return 0.0; // hold fully dry while DFN sees audio and calibrates its noise model
    }
    // Quadratic ease-in over the remaining window: t² keeps the signal mostly dry
    // while DFN continues to stabilise, then transitions faster once it has converged.
    let ramp_elapsed = elapsed_ms - SUPPRESSION_STARTUP_PRE_WARM_MS;
    let ramp_total = SUPPRESSION_STARTUP_RAMP_MS as f32 - SUPPRESSION_STARTUP_PRE_WARM_MS;
    let t = (ramp_elapsed / ramp_total).clamp(0.0, 1.0);
    t * t
}

// apply_slow_trim: per-frame RMS normaliser with a slew-rate-limited gain.
// Always updates the level estimate (trim_level_rms) so it warms up during the
// startup bypass.  Only applies the gain change when `active` is true.
// `update_rate` ∈ [0.0, 1.0]: scales the IIR time constant and slew limit so the
// VAD can freeze adaptation during silence (0.0) or slows it during hangover (0.3).
// rate=1.0 → normal speed; rate=0.0 → fully frozen (level estimate and gain unchanged).
fn apply_slow_trim(
    samples: &mut [f32],
    trim_level_rms: &mut f32,
    trim_gain: &mut f32,
    sample_rate: usize,
    active: bool,
    update_rate: f32,
) {
    if samples.is_empty() || sample_rate == 0 {
        return;
    }

    let rate = update_rate.clamp(0.0, 1.0);

    // Per-frame RMS measurement.
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let frame_rms = (sum_sq / samples.len() as f32).sqrt();

    // Slow IIR level smoother — one coefficient applied across the whole frame.
    // α = exp(-frame_len / (sample_rate * TC_S))
    // Raising to the `rate` power stretches the effective time constant:
    //   rate=1.0 → α^1 = normal TC; rate=0.0 → α^0 = 1.0 → frozen.
    let level_coeff = (-(samples.len() as f32 / (sample_rate as f32 * TRIM_LEVEL_TC_S))).exp();
    let effective_level_coeff = level_coeff.powf(rate);
    *trim_level_rms =
        effective_level_coeff * *trim_level_rms + (1.0 - effective_level_coeff) * frame_rms;

    if !active {
        return;
    }

    // Desired gain from smoothed level.  Hold current gain when signal is silent.
    let desired_gain = if *trim_level_rms < 1e-6 {
        *trim_gain
    } else {
        (TRIM_TARGET_RMS / *trim_level_rms).clamp(TRIM_MIN_GAIN, TRIM_MAX_GAIN)
    };

    // Slew-limit scaled by update_rate: silence → near-zero slew (gain frozen).
    let slew_db = TRIM_SLEW_DB_PER_FRAME * rate;
    let slew_factor = 10.0f32.powf(slew_db / 20.0);
    *trim_gain = if desired_gain > *trim_gain {
        (*trim_gain * slew_factor).min(desired_gain)
    } else {
        (*trim_gain / slew_factor).max(desired_gain)
    };

    // Apply as a constant gain across the whole frame — no within-frame variation.
    for s in samples.iter_mut() {
        *s = (*s * *trim_gain).clamp(-1.0, 1.0);
    }
}

// inject_comfort_noise: add shaped white noise at a very low level to prevent
// the dead-flat digital silence that makes processed audio sound unnatural.
// `mix` ∈ [0.0, 1.0] scales the noise amplitude so callers can fade it smoothly
// rather than hard-gating — prevents audible pops when speech starts/ends.
// Uses a xorshift32 PRNG — cheap and sufficient for comfort noise.
fn inject_comfort_noise(samples: &mut [f32], rng_state: &mut u32, mix: f32) {
    if samples.is_empty() || mix <= 0.0 {
        return;
    }

    let threshold = 10.0f32.powf(COMFORT_NOISE_THRESHOLD_DBFS / 20.0);
    let noise_amp = 10.0f32.powf(COMFORT_NOISE_LEVEL_DBFS / 20.0) * mix.clamp(0.0, 1.0);

    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();

    if rms >= threshold {
        return;
    }

    for s in samples.iter_mut() {
        // xorshift32
        *rng_state ^= *rng_state << 13;
        *rng_state ^= *rng_state >> 17;
        *rng_state ^= *rng_state << 5;
        let noise = (*rng_state as f32 / u32::MAX as f32) * 2.0 - 1.0;
        *s += noise * noise_amp;
    }
}

fn apply_adaptive_echo_cancellation(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
) -> AdaptiveEchoMetrics {
    if samples.is_empty() {
        return AdaptiveEchoMetrics::default();
    }

    let filter_history_len = ECHO_CANCELLER_FILTER_TAPS.saturating_sub(1);
    let Some(reference_samples) =
        session.get_echo_reference_window(samples.len(), filter_history_len)
    else {
        return AdaptiveEchoMetrics::default();
    };

    let block_frames = ((session.sample_rate * ECHO_CANCELLER_BLOCK_MS) / 1_000).max(1);
    let block_sample_len = block_frames * session.channels;
    let mut sample_offset = 0usize;
    let mut erle_sum = 0.0f32;
    let mut erle_count = 0u32;
    let mut delay_ms = None;
    let mut double_talk_sum = 0.0f32;
    let mut double_talk_count = 0u32;

    while sample_offset < samples.len() {
        let sample_end = (sample_offset + block_sample_len).min(samples.len());
        let reference_start = sample_offset;
        let reference_end = filter_history_len + sample_end;
        let block_metrics = match session.echo_canceller.as_mut() {
            Some(EchoCancellerBackend::AdaptiveNlms(canceller)) => {
                canceller.process_block(
                    &mut samples[sample_offset..sample_end],
                    &reference_samples[reference_start..reference_end],
                );
                canceller.last_metrics()
            }
            _ => AdaptiveEchoMetrics::default(),
        };
        if let Some(erle_db) = block_metrics.erle_db {
            erle_sum += erle_db;
            erle_count += 1;
        }
        if let Some(block_delay_ms) = block_metrics.delay_ms {
            delay_ms = Some(block_delay_ms);
        }
        if let Some(double_talk_confidence) = block_metrics.double_talk_confidence {
            double_talk_sum += double_talk_confidence;
            double_talk_count += 1;
        }
        sample_offset = sample_end;
    }

    AdaptiveEchoMetrics {
        erle_db: if erle_count > 0 {
            Some(erle_sum / erle_count as f32)
        } else {
            None
        },
        delay_ms,
        double_talk_confidence: if double_talk_count > 0 {
            Some(double_talk_sum / double_talk_count as f32)
        } else {
            None
        },
    }
}

fn apply_webrtc_echo_cancellation(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
) -> AdaptiveEchoMetrics {
    if samples.is_empty() {
        return AdaptiveEchoMetrics::default();
    }

    let block_frames = ((session.sample_rate * ECHO_CANCELLER_BLOCK_MS) / 1_000).max(1);
    let block_sample_len = block_frames * session.channels;
    let mut sample_offset = 0usize;
    let mut erle_sum = 0.0f32;
    let mut erle_count = 0u32;
    let mut delay_ms = None;

    while sample_offset < samples.len() {
        let sample_end = (sample_offset + block_sample_len).min(samples.len());
        if sample_end - sample_offset != block_sample_len {
            break;
        }

        let reference_block = session.pop_echo_reference_block_or_silence(block_sample_len);
        let block_metrics = match session.echo_canceller.as_mut() {
            Some(EchoCancellerBackend::WebRtcAec3(canceller)) => {
                match canceller.process_block(&mut samples[sample_offset..sample_end], &reference_block)
                {
                    Ok(metrics) => metrics,
                    Err(error) => {
                        eprintln!("[capture-sidecar] WebRTC AEC3 processing failed: {error}");
                        AdaptiveEchoMetrics::default()
                    }
                }
            }
            _ => AdaptiveEchoMetrics::default(),
        };

        if let Some(erle_db) = block_metrics.erle_db {
            erle_sum += erle_db;
            erle_count += 1;
        }
        if let Some(block_delay_ms) = block_metrics.delay_ms {
            delay_ms = Some(block_delay_ms);
        }

        sample_offset = sample_end;
    }

    AdaptiveEchoMetrics {
        erle_db: if erle_count > 0 {
            Some(erle_sum / erle_count as f32)
        } else {
            None
        },
        delay_ms,
        double_talk_confidence: None,
    }
}

fn apply_output_dezipper(samples: &mut [f32], prev_sample: &mut f32) {
    for s in samples.iter_mut() {
        *prev_sample = *prev_sample * DEZIPPER_COEFF + *s * (1.0 - DEZIPPER_COEFF);
        *s = *prev_sample;
    }
}

// repair_spikes: single-sample interpolation for isolated amplitude spikes.
// Kills mouse clicks, digital pops, and cable ticks that appear as one outlier sample
// flanked by much-quieter neighbours.  Stateless — safe to call every frame.
fn repair_spikes(samples: &mut [f32]) {
    if samples.len() < 3 {
        return;
    }

    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let local_rms = (sum_sq / samples.len() as f32).sqrt().max(1e-6);
    let threshold = local_rms * SPIKE_CREST_THRESHOLD;

    for i in 1..samples.len() - 1 {
        let abs_s = samples[i].abs();
        if abs_s > threshold
            && samples[i - 1].abs() < abs_s * SPIKE_NEIGHBOR_RATIO
            && samples[i + 1].abs() < abs_s * SPIKE_NEIGHBOR_RATIO
        {
            samples[i] = 0.5 * (samples[i - 1] + samples[i + 1]);
        }
    }
}

// apply_transient_suppressor: crest-factor impulse detector with instant-snap attack.
// Only triggers in Silence — leaving speech and hangover completely untouched.
// A clap/thud has crest factor ≥10 post-DFN; steady noise/voice sits at 3–6.
//
// Attack design: crest factor is computed over the whole frame before any sample is
// written, so we have implicit per-frame lookahead.  On trigger we snap gain to the
// attenuation floor immediately — no IIR attack lag — which is the correct behaviour:
// a per-sample IIR attack lets the impulse pass at near-unity gain for the first 1–2 ms
// and then suppresses the empty silence that follows, which is the opposite of what we
// want and makes clicks feel louder by contrast.
fn apply_transient_suppressor(
    state: &mut TransientSuppressorState,
    samples: &mut [f32],
    sample_rate: usize,
    vad_state: VadSpeechState,
    noise_floor_rms: f32,
) {
    if samples.is_empty() || sample_rate == 0 {
        return;
    }

    let sr = sample_rate as f32;
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    let crest = peak / (rms + 1e-6);

    let release_coeff = (-1.0f32 / (sr * TRANS_RELEASE_MS / 1000.0)).exp();
    let hold_samples = ((sr * TRANS_HOLD_MS as f32) / 1000.0) as u32;
    let debounce_samples = ((sr * TRANS_DEBOUNCE_MS as f32) / 1000.0) as u32;

    // Trigger rules (Speech always excluded; debounce prevents cumulative thinning):
    //   Silence  — crest > threshold OR (sudden frame jump ×2 AND above noise floor ×2);
    //              the noise-floor gate stops bed fluctuations from triggering — only
    //              genuine impulses that rise well above the tracked background pass.
    //   Hangover — crest > threshold AND sudden energy rise vs. previous frame.
    //              A keyboard hit jumps from near-silence (×4 or more); a speech tail
    //              declines gradually so prev_rms ≈ current rms, blocking the trigger.
    let triggered = state.debounce_samples_remaining == 0
        && match vad_state {
            VadSpeechState::Silence => {
                crest > TRANS_CREST_THRESHOLD
                    || (state.prev_rms > 0.0
                        && rms > state.prev_rms * 2.0
                        && rms > noise_floor_rms * 2.0)
            }
            VadSpeechState::Hangover => {
                crest > TRANS_CREST_THRESHOLD
                    && state.prev_rms > 0.0
                    && rms > state.prev_rms * TRANS_ENERGY_JUMP_RATIO
            }
            VadSpeechState::Speech => false,
        };

    if triggered {
        // Band-split floors: lows less attenuated than highs, preserving voice warmth.
        // Hangover uses a gentler floor than Silence — less risk of hitting speech tails.
        let (floor_low, floor_high) = match vad_state {
            VadSpeechState::Silence => (
                10.0f32.powf(TRANS_GAIN_LOW_DB / 20.0),
                10.0f32.powf(TRANS_GAIN_HIGH_DB / 20.0),
            ),
            _ => (
                10.0f32.powf(TRANS_GAIN_HO_LOW_DB / 20.0),
                10.0f32.powf(TRANS_GAIN_HO_HIGH_DB / 20.0),
            ),
        };
        state.gain_low = floor_low;
        state.gain_high = floor_high;
        state.hold_samples_remaining = hold_samples.max(1);
        state.debounce_samples_remaining = debounce_samples;
    }

    // Band-split via one-pole LP / complementary HP.
    // LP + HP = identity at unity gain → zero coloration when not attenuating.
    // LP state runs every frame so the filter is primed for smooth onset/release.
    let lp_coeff = (-2.0 * std::f32::consts::PI * TRANS_CROSSOVER_HZ / sr).exp();

    for s in samples.iter_mut() {
        state.lp_state = lp_coeff * state.lp_state + (1.0 - lp_coeff) * *s;
        let hp = *s - state.lp_state;
        *s = state.lp_state * state.gain_low + hp * state.gain_high;

        if state.hold_samples_remaining > 0 {
            state.hold_samples_remaining -= 1;
        } else {
            state.gain_low = release_coeff * state.gain_low + (1.0 - release_coeff) * 1.0;
            state.gain_high = release_coeff * state.gain_high + (1.0 - release_coeff) * 1.0;
        }
    }

    state.prev_rms = rms;
    state.debounce_samples_remaining = state
        .debounce_samples_remaining
        .saturating_sub(samples.len() as u32);
}

// analyze_vad: energy-based VAD tap.  Call once per 10ms frame on post-dezipper audio.
// Returns smoothed speech probability and current state; updates internal state machine.
// The noise floor estimate adapts only during Silence, preventing speech from corrupting it.
fn analyze_vad(vad: &mut VadState, samples: &[f32], sample_rate: usize) -> VadOutput {
    if samples.is_empty() || sample_rate == 0 {
        return VadOutput {
            speech_state: vad.speech_state,
        };
    }

    // Per-frame RMS → SNR relative to adaptive noise floor → p_raw ∈ [0, 1].
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let frame_rms = (sum_sq / samples.len() as f32).sqrt().max(1e-9);
    let snr_db = 20.0 * (frame_rms / vad.noise_floor_rms.max(1e-6)).log10();
    let p_raw = ((snr_db - VAD_SNR_LOW_DB) / (VAD_SNR_HIGH_DB - VAD_SNR_LOW_DB)).clamp(0.0, 1.0);

    // EWMA smoothing: ~50ms time constant at 10ms frames.
    vad.p_smooth = VAD_ALPHA * vad.p_smooth + (1.0 - VAD_ALPHA) * p_raw;

    // Impulse guard: clap/thud detection used to suppress false speech-onset transitions.
    // Requires both high crest (impulse shape) and a large sudden energy jump (from near-silence).
    // Speech onsets have crest ~3–6 and rise gradually; claps are ≥10 with an abrupt jump.
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let crest = peak / (frame_rms + 1e-6);
    let is_impulse = crest > VAD_IMPULSE_CREST_THRESHOLD
        && vad.prev_frame_rms > 0.0
        && frame_rms > vad.prev_frame_rms * VAD_IMPULSE_ENERGY_JUMP;

    // State machine.
    match vad.speech_state {
        VadSpeechState::Silence => {
            if vad.p_smooth >= VAD_SPEECH_THRESHOLD && !is_impulse {
                vad.onset_counter += 1;
                if vad.onset_counter >= VAD_ONSET_FRAMES {
                    vad.speech_state = VadSpeechState::Speech;
                    vad.onset_counter = 0;
                    // Onset protection: bypass expander for VAD_ONSET_PROTECTION_FRAMES frames.
                    vad.onset_protection_frames_remaining = VAD_ONSET_PROTECTION_FRAMES.max(1);
                    // Per-utterance DFN onset ramp: start wet-mix at 0 and ramp to 1.
                    vad.onset_wet_ramp_frames_remaining = ONSET_WET_RAMP_FRAMES;
                }
            } else {
                vad.onset_counter = 0;
            }
            // Adapt noise floor slowly while in Silence so it tracks the background.
            vad.noise_floor_rms = (1.0 - VAD_NOISE_ADAPT_RATE) * vad.noise_floor_rms
                + VAD_NOISE_ADAPT_RATE * frame_rms;
        }
        VadSpeechState::Speech => {
            if vad.p_smooth < VAD_SILENCE_THRESHOLD {
                vad.offset_counter += 1;
                if vad.offset_counter >= VAD_OFFSET_FRAMES {
                    // Enter hangover — hold for VAD_HANGOVER_FRAMES frames.
                    vad.hangover_frames_remaining = VAD_HANGOVER_FRAMES.max(1);
                    vad.speech_state = VadSpeechState::Hangover;
                    vad.offset_counter = 0;
                }
            } else {
                vad.offset_counter = 0;
            }
            if vad.onset_protection_frames_remaining > 0 {
                vad.onset_protection_frames_remaining -= 1;
            }
        }
        VadSpeechState::Hangover => {
            if vad.hangover_frames_remaining > 0 {
                vad.hangover_frames_remaining -= 1;
            } else {
                vad.speech_state = VadSpeechState::Silence;
            }
            if vad.onset_protection_frames_remaining > 0 {
                vad.onset_protection_frames_remaining -= 1;
            }
        }
    }

    vad.prev_frame_rms = frame_rms;
    VadOutput {
        speech_state: vad.speech_state,
    }
}

fn apply_downward_expander(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
    lsnr_mean: Option<f32>,
    // expander_bypass ∈ [0.0, 1.0]: 1.0 = fully bypassed (speech), 0.0 = full effect (silence).
    // Blends the computed expansion gain toward 1.0 so VAD-controlled bypass is smooth.
    expander_bypass: f32,
) {
    if samples.is_empty() || session.sample_rate == 0 {
        return;
    }

    let sr = session.sample_rate as f32;
    let attack_coeff = (-1.0f32 / (sr * EXPANDER_ATTACK_MS / 1000.0)).exp();
    let release_coeff = (-1.0f32 / (sr * EXPANDER_RELEASE_MS / 1000.0)).exp();

    // LSNR nudge: low SNR → raise threshold (gate more aggressively),
    // high SNR → baseline threshold (let clean speech through unaffected).
    let threshold_dbfs = if let Some(lsnr) = lsnr_mean {
        let t = ((lsnr - EXPANDER_LSNR_NUDGE_LOW_DB)
            / (EXPANDER_LSNR_NUDGE_HIGH_DB - EXPANDER_LSNR_NUDGE_LOW_DB))
            .clamp(0.0, 1.0);
        EXPANDER_THRESHOLD_DBFS + EXPANDER_LSNR_THRESHOLD_RAISE_DB * (1.0 - t)
    } else {
        EXPANDER_THRESHOLD_DBFS
    };
    let threshold_linear = 10.0f32.powf(threshold_dbfs / 20.0);
    let hangover_samples = (sr * EXPANDER_HANGOVER_MS / 1000.0) as u32;

    for sample in samples.iter_mut() {
        let abs_val = sample.abs();

        // Peak envelope follower: fast attack, slow release.
        let env_coeff = if abs_val > session.expander_envelope {
            attack_coeff
        } else {
            release_coeff
        };
        session.expander_envelope =
            env_coeff * session.expander_envelope + (1.0 - env_coeff) * abs_val;

        let desired_gain = if session.expander_envelope >= threshold_linear {
            // Above threshold: reset hangover, no expansion.
            session.expander_hangover_samples_remaining = hangover_samples;
            1.0f32
        } else if session.expander_hangover_samples_remaining > 0 {
            // Below threshold but inside hangover window: hold at unity.
            session.expander_hangover_samples_remaining -= 1;
            1.0f32
        } else {
            // Below threshold after hangover: apply downward expansion.
            // gain = (level / threshold) ^ (ratio - 1)
            // For ratio=1.5 this is a square-root taper — gentle and musical.
            if session.expander_envelope > 0.0 {
                (session.expander_envelope / threshold_linear)
                    .powf(EXPANDER_RATIO - 1.0)
                    .clamp(0.0, 1.0)
            } else {
                0.0
            }
        };

        // VAD bypass: blend desired_gain toward 1.0 based on speech probability.
        // During speech (bypass→1.0) the expander is essentially inactive.
        // During hangover bypass decays via hangover_frames_remaining, so expander engages gradually.
        let bypass = expander_bypass.clamp(0.0, 1.0);
        let effective_desired_gain = desired_gain + (1.0 - desired_gain) * bypass;

        // Smooth gain changes with the same time constants as the envelope follower.
        let gain_coeff = if effective_desired_gain < session.expander_gain {
            attack_coeff
        } else {
            release_coeff
        };
        session.expander_gain =
            gain_coeff * session.expander_gain + (1.0 - gain_coeff) * effective_desired_gain;

        *sample *= session.expander_gain;
    }
}

fn process_voice_filter_frame(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
    channels: usize,
) -> Result<VoiceFilterDiagnostics, String> {
    if samples.is_empty() || channels == 0 {
        return Ok(VoiceFilterDiagnostics {
            lsnr_mean: None,
            lsnr_min: None,
            lsnr_max: None,
            aec_erle_db: None,
            aec_delay_ms: None,
            aec_double_talk_confidence: None,
            agc_gain: None,
            ramp_wet_mix: 1.0,
        });
    }

    let frame_count = samples.len() / channels;

    if frame_count == 0 {
        return Ok(VoiceFilterDiagnostics {
            lsnr_mean: None,
            lsnr_min: None,
            lsnr_max: None,
            aec_erle_db: None,
            aec_delay_ms: None,
            aec_double_talk_confidence: None,
            agc_gain: None,
            ramp_wet_mix: 1.0,
        });
    }

    if samples.len() != frame_count * channels {
        return Err("Voice filter frame sample count mismatch".to_string());
    }

    // High-pass filter: strip DC and sub-80 Hz rumble before the model sees the signal.
    // Only applied when DeepFilterNet is active — passthrough mode should not modify audio.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        for frame_index in 0..frame_count {
            for channel_index in 0..channels {
                let idx = frame_index * channels + channel_index;
                if let Some(filter) = session.high_pass_filters.get_mut(channel_index) {
                    samples[idx] = filter.process(samples[idx]);
                }
            }
        }

        // Input safety limiter: hard-clip at ±1.0 before the model.
        // Prevents grossly over-driven input from confusing DFN's noise classifier.
        // In normal use this is a no-op; it only fires on pathological levels.
        for s in samples.iter_mut() {
            *s = s.clamp(-1.0, 1.0);
        }
    }

    // Advance the trim startup-bypass timer.  The level estimate (trim_level_rms) is
    // updated even during bypass so it has converged before the gain is first applied.
    if session.auto_gain_control && session.agc_startup_bypass_ms_remaining > 0 {
        let input_ms = if session.sample_rate > 0 {
            ((frame_count.saturating_mul(1000)) / session.sample_rate) as u32
        } else {
            0
        }
        .max(1);

        session.agc_startup_bypass_ms_remaining = session
            .agc_startup_bypass_ms_remaining
            .saturating_sub(input_ms);
    }

    // Startup ramp: compute wet-mix at frame start.  A single value per 10 ms frame is
    // imperceptible since the ramp spans SUPPRESSION_STARTUP_RAMP_MS.
    let ramp_wet_mix_at_frame_start: f32 = if session.suppression_startup_ramp_ms_remaining > 0
        && matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_))
    {
        let elapsed_ms = SUPPRESSION_STARTUP_RAMP_MS
            .saturating_sub(session.suppression_startup_ramp_ms_remaining)
            as f32;
        suppression_startup_wet_mix(elapsed_ms)
    } else {
        1.0
    };

    // Per-utterance onset ramp: wet-mix starts at 0 on the first post-onset frame and
    // advances linearly to 1.0 over ONSET_WET_RAMP_FRAMES.  Combined with the session
    // startup ramp via min() so the drier of the two always wins.
    let onset_wet_mix = if session.vad.onset_wet_ramp_frames_remaining > 0
        && matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_))
    {
        1.0 - session.vad.onset_wet_ramp_frames_remaining as f32 / ONSET_WET_RAMP_FRAMES as f32
    } else {
        1.0
    };
    let effective_wet_mix = ramp_wet_mix_at_frame_start.min(onset_wet_mix);

    // AEC before DFN: remove echo from the mic signal first so DFN sees a cleaner
    // input.  If AEC is disabled this is a no-op and has no performance cost.
    let aec_metrics = match session.echo_cancellation_backend() {
        Some(ECHO_CANCELLATION_BACKEND_WEBRTC) => apply_webrtc_echo_cancellation(session, samples),
        Some(ECHO_CANCELLATION_BACKEND_ADAPTIVE) => {
            apply_adaptive_echo_cancellation(session, samples)
        }
        _ => AdaptiveEchoMetrics::default(),
    };

    // Diagnostics accumulators — populated only by the DeepFilter path.
    let mut lsnr_sum = 0.0_f32;
    let mut lsnr_min = f32::MAX;
    let mut lsnr_max = f32::MIN;
    let mut lsnr_hop_count = 0u32;

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

                let lsnr = processor
                    .model
                    .process(noisy.view(), enhanced.view_mut())
                    .map_err(|error| format!("DeepFilterNet processing failed: {error}"))?;

                lsnr_sum += lsnr;
                lsnr_hop_count += 1;
                if lsnr < lsnr_min {
                    lsnr_min = lsnr;
                }
                if lsnr > lsnr_max {
                    lsnr_max = lsnr;
                }

                // Startup ramp: blend noisy×(1−t) + enhanced×t per hop.
                // Blending at the hop level (rather than mixing separate dry/wet PCM streams)
                // is phase-coherent — noisy and enhanced share the same signal path —
                // so there is no comb-filtering artifact at the crossover point.
                if effective_wet_mix < 1.0 {
                    let dry_mix = 1.0 - effective_wet_mix;
                    for ch in 0..channels {
                        for s in 0..hop_size {
                            enhanced[(ch, s)] =
                                noisy[(ch, s)] * dry_mix + enhanced[(ch, s)] * effective_wet_mix;
                        }
                    }
                }

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
        }
        VoiceFilterProcessor::Passthrough => {}
    }

    // Output de-zipper: smooth inter-hop DFN amplitude discontinuities and mild
    // musical noise before the slew limit / trim / expander chain processes them.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        apply_output_dezipper(samples, &mut session.dezipper_prev_sample);
    }

    // Step 7.5: VAD analysis tap — post-dezipper, no audio modification.
    // Produces speech_state used as control signal for trim and expander.
    // Tapping here (after DFN + de-zipper, before dynamics) means:
    //   • fewer false positives (signal is already noise-reduced)
    //   • dynamics don't "teach" VAD what speech looks like
    let vad_out = if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        analyze_vad(&mut session.vad, samples, session.sample_rate)
    } else {
        VadOutput {
            speech_state: VadSpeechState::Speech,
        }
    };

    // Suppression slew limit: prevent DFN from dropping its output RMS by more than
    // DFN_SLEW_MAX_DROP_DB_PER_FRAME in a single 10ms frame.  Scales the frame up
    // if the drop exceeds the limit; bypassed when the previous RMS is near silence.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        let slew_active_floor = 10.0f32.powf(DFN_SLEW_MIN_ACTIVE_DBFS / 20.0);
        let max_drop_factor = 10.0f32.powf(-DFN_SLEW_MAX_DROP_DB_PER_FRAME / 20.0);
        let slew_floor = session.dfn_output_rms_prev * max_drop_factor;

        if slew_floor > slew_active_floor {
            let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
            let frame_rms = (sum_sq / samples.len() as f32).sqrt();
            if frame_rms < slew_floor && frame_rms > 0.0 {
                let scale = slew_floor / frame_rms;
                for s in samples.iter_mut() {
                    *s *= scale;
                }
                session.dfn_output_rms_prev = slew_floor;
            } else {
                session.dfn_output_rms_prev = frame_rms;
            }
        } else {
            let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
            session.dfn_output_rms_prev = (sum_sq / samples.len() as f32).sqrt();
        }
    }

    // Spike repair: interpolate isolated single-sample outliers before the transient
    // suppressor so the crest-factor detector sees a cleaner signal.  Stateless and cheap.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        repair_spikes(samples);
    }

    // Transient suppressor: crest-factor detector that knocks down claps/thuds in Silence.
    // Placed after the DFN slew limit so it sees the fully processed signal — suppressing
    // residual impulse energy that DFN left behind rather than the raw mic transient.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        apply_transient_suppressor(
            &mut session.transient_suppressor,
            samples,
            session.sample_rate,
            vad_out.speech_state,
            session.vad.noise_floor_rms,
        );
    }

    // Post-DFN slow trim: long-time-constant RMS normaliser, slew-limited to ±1 dB/100ms.
    // Level estimate warms up during startup bypass; gain is only applied afterwards.
    // update_rate is VAD-controlled: full rate during Speech, frozen during Silence,
    // so trim cannot drift upward on long pauses and blast the limiter on the next word.
    if session.auto_gain_control {
        let active = session.agc_startup_bypass_ms_remaining == 0;
        let trim_update_rate = match vad_out.speech_state {
            VadSpeechState::Speech => 1.0f32,
            VadSpeechState::Hangover => VAD_TRIM_HANGOVER_RATE,
            VadSpeechState::Silence => VAD_TRIM_SILENCE_RATE,
        };
        apply_slow_trim(
            samples,
            &mut session.trim_level_rms,
            &mut session.trim_gain,
            session.sample_rate,
            active,
            trim_update_rate,
        );
    }

    // Advance onset wet ramp (frame-counted; one step per 10 ms frame).
    if session.vad.onset_wet_ramp_frames_remaining > 0 {
        session.vad.onset_wet_ramp_frames_remaining -= 1;
    }

    // Advance startup-ramp timer.  The per-hop blend is done inside the DFN loop above.
    if ramp_wet_mix_at_frame_start < 1.0 {
        let processed_ms = if session.sample_rate > 0 {
            ((frame_count.saturating_mul(1000)) / session.sample_rate) as u32
        } else {
            0
        }
        .max(1);
        session.suppression_startup_ramp_ms_remaining = session
            .suppression_startup_ramp_ms_remaining
            .saturating_sub(processed_ms);
    }

    // Compute per-frame LSNR mean now so the expander can use it to nudge its threshold.
    let (lsnr_mean, lsnr_min_out, lsnr_max_out) = if lsnr_hop_count > 0 {
        (
            Some(lsnr_sum / lsnr_hop_count as f32),
            Some(lsnr_min),
            Some(lsnr_max),
        )
    } else {
        (None, None, None)
    };

    // Downward expander: gently attenuate residual noise floor after all processing.
    // LSNR nudges the threshold; VAD controls bypass so speech is never expanded.
    //
    // expander_bypass: 1.0 = fully bypassed (speech / onset-protection), 0.0 = full effect.
    // Onset protection forces bypass for the first VAD_ONSET_PROTECTION_FRAMES frames of each
    // new speech segment, protecting soft consonant attacks ("t/k/p") that are below threshold.
    // After onset, a time-based ramp (hangover_frames_remaining / VAD_HANGOVER_FRAMES) drives
    // bypass 1.0→0.0 over the hangover window, independent of signal-level fluctuations.
    //
    // Comfort noise is injected only outside Speech (no need during speech; expander is
    // bypassed anyway and noise at -72 dBFS is inaudible under voice).  Gating keeps the
    // noise bed stable — it never "wobbles" with the speech signal.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        // State-driven bypass — binary for Speech/Silence, shaped curve in Hangover.
        // Using p_smooth during Speech would let quiet/borderline speech partially
        // engage the expander, which is worse than not engaging at all.
        let expander_bypass = if session.vad.onset_protection_frames_remaining > 0 {
            1.0f32 // onset protection: full bypass regardless of state
        } else {
            match vad_out.speech_state {
                VadSpeechState::Speech => 1.0,
                // Hangover: use a monotonic time-based ramp (1.0 → 0.0) anchored to
                // hangover_frames_remaining so the expander engages smoothly over the
                // hangover window regardless of signal-level fluctuations.  Using
                // p_smooth here caused audible pumping whenever any sound (keyboard
                // click, clap, background noise) occurred during hangover.
                VadSpeechState::Hangover => {
                    session.vad.hangover_frames_remaining as f32 / VAD_HANGOVER_FRAMES as f32
                }
                VadSpeechState::Silence => 0.0,
            }
        };
        // Fade comfort noise with the inverse of expander_bypass so the room tone
        // crossfades smoothly with speech dynamics rather than popping in/out.
        // noise_mix = 1.0 → full noise (silence); noise_mix = 0.0 → no noise (speech).
        let noise_mix = 1.0 - expander_bypass;
        inject_comfort_noise(samples, &mut session.noise_rng_state, noise_mix);
        if let Some(lsnr) = lsnr_mean {
            session.lsnr_smoothed = EXPANDER_LSNR_SMOOTH_ALPHA * session.lsnr_smoothed
                + (1.0 - EXPANDER_LSNR_SMOOTH_ALPHA) * lsnr;
        }
        apply_downward_expander(
            session,
            samples,
            Some(session.lsnr_smoothed),
            expander_bypass,
        );
    }

    Ok(VoiceFilterDiagnostics {
        lsnr_mean,
        lsnr_min: lsnr_min_out,
        lsnr_max: lsnr_max_out,
        aec_erle_db: aec_metrics.erle_db,
        aec_delay_ms: aec_metrics.delay_ms,
        aec_double_talk_confidence: aec_metrics.double_talk_confidence,
        agc_gain: if session.auto_gain_control {
            Some(session.trim_gain)
        } else {
            None
        },
        ramp_wet_mix: if session.suppression_startup_ramp_ms_remaining > 0 {
            suppression_startup_wet_mix(
                (SUPPRESSION_STARTUP_RAMP_MS
                    .saturating_sub(session.suppression_startup_ramp_ms_remaining))
                    as f32,
            )
        } else {
            1.0
        },
    })
}

fn voice_filter_frames_per_buffer(session: &VoiceFilterSession) -> usize {
    match &session.processor {
        VoiceFilterProcessor::DeepFilter(processor) => processor.hop_size,
        VoiceFilterProcessor::Passthrough => FRAME_SIZE,
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
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
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
                    let wrote_binary = app_audio_binary_stream
                        .as_ref()
                        .map(|stream_slot| {
                            try_write_app_audio_binary_frame(
                                stream_slot,
                                session_id,
                                target_id,
                                sequence,
                                TARGET_SAMPLE_RATE as usize,
                                TARGET_CHANNELS,
                                FRAME_SIZE,
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
                            TARGET_SAMPLE_RATE as usize,
                            FRAME_SIZE,
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
    _app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    CaptureOutcome::capture_error("Per-app audio capture is only available on Windows.".to_string())
}

fn start_capture_thread(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
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

fn stop_mic_capture(state: &mut SidecarState) {
    if let Some(flag) = state.mic_capture_stop_flag.take() {
        flag.store(true, Ordering::Relaxed);
    }
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
        stop_mic_capture(state);
        enqueue_voice_filter_ended_event(frame_queue, &active_session.session_id, reason, error);
        return;
    }

    state.voice_filter_session = Some(active_session);
}

fn handle_audio_capture_start(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
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
        app_audio_binary_stream,
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

/// Read a `VT_LPWSTR` string value out of a `PROPVARIANT` by inspecting
/// raw memory. The COM spec guarantees `PROPVARIANT` is 16 bytes on x64:
///   [vt: u16, wReserved1-3: 3*u16, value: 8 bytes]
/// For `VT_LPWSTR` (31) the 8-byte value is a `*const u16` pointer
/// to a null-terminated UTF-16 string allocated with `CoTaskMem`.
/// We read the string here (which copies the chars) and let `prop`
/// be dropped normally so windows-rs calls `PropVariantClear`.
#[cfg(windows)]
unsafe fn read_propvariant_lpwstr(prop: &windows_core::PROPVARIANT) -> Option<String> {
    const VT_LPWSTR: u16 = 31;
    let raw = prop as *const windows_core::PROPVARIANT as *const u8;
    let vt = u16::from_ne_bytes([*raw, *raw.add(1)]);
    if vt != VT_LPWSTR {
        return None;
    }
    // Pointer is at byte offset 8
    let pwstr_ptr = *(raw.add(8) as *const *const u16);
    if pwstr_ptr.is_null() {
        return None;
    }
    windows::core::PCWSTR(pwstr_ptr).to_string().ok()
}

#[cfg(windows)]
fn list_mic_devices_windows() -> Vec<MicDevice> {
    use windows::Win32::System::Com::CoTaskMemFree;

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };

    let mut devices = Vec::new();

    let result = (|| -> Result<(), windows::core::Error> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };

        let collection = unsafe { enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)? };
        let count = unsafe { collection.GetCount()? };

        for index in 0..count {
            let device = match unsafe { collection.Item(index) } {
                Ok(device) => device,
                Err(_) => continue,
            };

            let id_pwstr = match unsafe { device.GetId() } {
                Ok(pwstr) => pwstr,
                Err(_) => continue,
            };

            let id = unsafe { id_pwstr.to_string() }.unwrap_or_default();
            unsafe { CoTaskMemFree(Some(id_pwstr.0 as *const c_void)) };

            if id.is_empty() {
                continue;
            }

            let label = (|| -> Option<String> {
                // STGM_READ = 0 (read-only access mode)
                let store: IPropertyStore = unsafe {
                    device
                        .OpenPropertyStore(windows::Win32::System::Com::STGM(0))
                        .ok()?
                };
                let prop = unsafe { store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME).ok()? };
                unsafe { read_propvariant_lpwstr(&prop) }
            })()
            .unwrap_or_default();

            devices.push(MicDevice { id, label });
        }

        Ok(())
    })();

    if let Err(error) = result {
        eprintln!("[capture-sidecar] list_mic_devices error: {error}");
    }

    if com_initialized {
        unsafe { CoUninitialize() };
    }

    devices
}

fn handle_mic_devices_list() -> Result<Value, String> {
    #[cfg(windows)]
    {
        let devices = list_mic_devices_windows();
        return Ok(json!({ "devices": devices }));
    }

    #[cfg(not(windows))]
    {
        let empty: Vec<MicDevice> = Vec::new();
        Ok(json!({ "devices": empty }))
    }
}

#[cfg(windows)]
fn capture_mic_audio(
    session_id: String,
    device_id: Option<String>,
    stop_flag: Arc<AtomicBool>,
    state: Arc<Mutex<SidecarState>>,
    frame_queue: Arc<FrameQueue>,
) {
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

        // Emit raw mode status as a sidecar event so the renderer can log it.
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

        let mut pending = Vec::<f32>::new();
        let mut sequence: u64 = 0;

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

                pending.extend_from_slice(&chunk);

                let _ = unsafe { capture_client.ReleaseBuffer(frame_count) };

                while pending.len() >= MIC_CAPTURE_FRAME_SIZE * TARGET_CHANNELS {
                    let samples: Vec<f32> = pending
                        .drain(..MIC_CAPTURE_FRAME_SIZE * TARGET_CHANNELS)
                        .collect();

                    let processed = {
                        let mut state_lock = match state.lock() {
                            Ok(guard) => guard,
                            Err(_) => {
                                let _ = unsafe { audio_client.Stop() };
                                return Err("State lock poisoned in capture thread".to_string());
                            }
                        };

                        if let Some(ref vf_session) = state_lock.voice_filter_session {
                            if vf_session.session_id != session_id {
                                let _ = unsafe { audio_client.Stop() };
                                return Ok(());
                            }
                        } else {
                            let _ = unsafe { audio_client.Stop() };
                            return Ok(());
                        }

                        process_voice_filter_samples(
                            &frame_queue,
                            &mut state_lock,
                            &session_id,
                            sequence,
                            TARGET_SAMPLE_RATE as usize,
                            TARGET_CHANNELS,
                            MIC_CAPTURE_FRAME_SIZE,
                            None,
                            samples,
                        )
                    };

                    if let Err(error) = processed {
                        eprintln!("[capture-sidecar] mic capture process error: {error}");
                    }

                    sequence = sequence.saturating_add(1);
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

    if com_initialized {
        unsafe { CoUninitialize() };
    }

    if let Err(error) = result {
        eprintln!("[capture-sidecar] mic capture thread error: {error}");
        enqueue_voice_filter_ended_event(&frame_queue, &session_id, "capture_error", Some(error));
    }
}

#[cfg(not(windows))]
fn capture_mic_audio(
    _session_id: String,
    _device_id: Option<String>,
    _stop_flag: Arc<AtomicBool>,
    _state: Arc<Mutex<SidecarState>>,
    _frame_queue: Arc<FrameQueue>,
) {
}

fn handle_voice_filter_start_with_capture(
    state_arc: Arc<Mutex<SidecarState>>,
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: StartVoiceFilterWithCaptureParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    if parsed.sample_rate != TARGET_SAMPLE_RATE as usize {
        return Err("DeepFilterNet currently supports only 48kHz input".to_string());
    }

    let noise_suppression = parsed.noise_suppression.unwrap_or(true);
    let auto_gain_control = parsed.auto_gain_control.unwrap_or(false);
    let echo_cancellation = parsed.echo_cancellation.unwrap_or(false);

    stop_voice_filter_session(state, &frame_queue, None, "capture_stopped", None);

    let session_id = Uuid::new_v4().to_string();
    let session = create_voice_filter_session(
        session_id.clone(),
        parsed.sample_rate,
        parsed.channels,
        parsed.suppression_level,
        noise_suppression,
        auto_gain_control,
        echo_cancellation,
    )?;
    let session_channels = session.channels; // always 1 (forced mono)
    // Native capture always sends MIC_CAPTURE_FRAME_SIZE frames per buffer,
    // regardless of whether DeepFilterNet is active.  Report the actual size
    // so the client pipeline can size its buffers correctly.
    #[cfg(windows)]
    let frames_per_buffer = MIC_CAPTURE_FRAME_SIZE;
    #[cfg(not(windows))]
    let frames_per_buffer = voice_filter_frames_per_buffer(&session);

    state.voice_filter_session = Some(session);

    let stop_flag = Arc::new(AtomicBool::new(false));
    state.mic_capture_stop_flag = Some(Arc::clone(&stop_flag));

    let thread_session_id = session_id.clone();
    let thread_device_id = parsed.device_id.clone();
    let thread_state = Arc::clone(&state_arc);
    let thread_queue = Arc::clone(&frame_queue);

    eprintln!(
        "[capture-sidecar] voice_filter.start_with_capture deviceId={:?}",
        parsed.device_id
    );

    thread::spawn(move || {
        capture_mic_audio(
            thread_session_id,
            thread_device_id,
            stop_flag,
            thread_state,
            thread_queue,
        );
    });

    let mut response = json!({
        "sessionId": session_id,
        "sampleRate": parsed.sample_rate,
        "channels": session_channels,
        "framesPerBuffer": frames_per_buffer,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    });
    if let Some(backend) = state
        .voice_filter_session
        .as_ref()
        .and_then(VoiceFilterSession::echo_cancellation_backend)
    {
        response["echoCancellationBackend"] = json!(backend);
    }
    Ok(response)
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

    let noise_suppression = parsed.noise_suppression.unwrap_or(true);
    let auto_gain_control = parsed.auto_gain_control.unwrap_or(false);
    let echo_cancellation = parsed.echo_cancellation.unwrap_or(false);

    if echo_cancellation {
        eprintln!("[capture-sidecar] Voice filter echo cancellation enabled");
    }

    stop_voice_filter_session(state, &frame_queue, None, "capture_stopped", None);

    let session_id = Uuid::new_v4().to_string();
    let session = create_voice_filter_session(
        session_id.clone(),
        parsed.sample_rate,
        parsed.channels,
        parsed.suppression_level,
        noise_suppression,
        auto_gain_control,
        echo_cancellation,
    )?;
    let session_channels = session.channels; // always 1 (forced mono)
    let frames_per_buffer = voice_filter_frames_per_buffer(&session);

    state.voice_filter_session = Some(session);

    let mut response = json!({
        "sessionId": session_id,
        "sampleRate": parsed.sample_rate,
        "channels": session_channels,
        "framesPerBuffer": frames_per_buffer,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    });
    if let Some(backend) = state
        .voice_filter_session
        .as_ref()
        .and_then(VoiceFilterSession::echo_cancellation_backend)
    {
        response["echoCancellationBackend"] = json!(backend);
    }
    Ok(response)
}

fn apply_limiter(samples: &mut [f32], gain: &mut f32) {
    for sample in samples.iter_mut() {
        let abs_val = sample.abs();
        let target_gain = if abs_val > LIMITER_THRESHOLD {
            LIMITER_THRESHOLD / abs_val
        } else {
            1.0
        };

        if target_gain < *gain {
            // Attack: fast gain reduction
            *gain = *gain * LIMITER_ATTACK_COEFF + target_gain * (1.0 - LIMITER_ATTACK_COEFF);
        } else {
            // Release: slow restore toward 1.0
            *gain = (*gain + (1.0 - *gain) * (1.0 - LIMITER_RELEASE_COEFF)).min(1.0);
        }

        *sample *= *gain;
    }
}

fn process_voice_filter_samples(
    frame_queue: &Arc<FrameQueue>,
    state: &mut SidecarState,
    session_id: &str,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    protocol_version: Option<u32>,
    mut samples: Vec<f32>,
) -> Result<(), String> {
    // Clone the Arc before borrowing voice_filter_session so we can use it
    // later without a borrow conflict on `state`.
    let egress_stream = state.voice_filter_binary_egress_stream.clone();

    let Some(session) = state.voice_filter_session.as_mut() else {
        return Err("No active voice filter session".to_string());
    };

    if session.session_id != session_id {
        return Err("Voice filter session mismatch".to_string());
    }

    if let Some(protocol_version) = protocol_version {
        if protocol_version != PROTOCOL_VERSION {
            return Err("Unsupported voice filter protocol version".to_string());
        }
    }

    if sample_rate != session.sample_rate {
        return Err("Voice filter sample rate mismatch".to_string());
    }

    if channels == 0 {
        return Err("Voice filter frame channel count must be > 0".to_string());
    }

    // Downmix to mono if the incoming frame has more channels than the session.
    // The session always runs in mono (session.channels == 1) to minimise model
    // workload and reduce warble on the DFN stereo path.
    let channels = if channels > session.channels {
        let mono_frame_count = samples.len() / channels;
        let mut mono = Vec::with_capacity(mono_frame_count);
        for frame_index in 0..mono_frame_count {
            let mut sum = 0.0f32;
            for ch in 0..channels {
                sum += samples[frame_index * channels + ch];
            }
            mono.push(sum / channels as f32);
        }
        samples = mono;
        session.channels
    } else if channels == session.channels {
        channels
    } else {
        return Err("Voice filter channel count mismatch".to_string());
    };

    let diagnostics = process_voice_filter_frame(session, &mut samples, channels)?;

    if samples.len() != frame_count * channels {
        return Err("Voice filter frame sample count mismatch".to_string());
    }

    // Limiter is only needed after DeepFilterNet to guard against model output peaks.
    // In passthrough mode the raw signal should not be modified.
    if matches!(session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        apply_limiter(&mut samples, &mut session.limiter_gain);
    }

    // Try binary egress first — bypasses the FrameQueue, avoids base64 allocation
    // and JSON serialization entirely. Falls back to JSON stdout on write failure
    // or when no client has connected yet.
    let wrote_binary = if let Some(stream) = egress_stream.as_ref() {
        try_write_voice_filter_binary_egress_frame(
            stream,
            session_id,
            sequence,
            sample_rate,
            channels,
            frame_count,
            PROTOCOL_VERSION,
            0, // dropped_frame_count — always 0 on binary path; TCP socket drops lose frames silently
            &diagnostics,
            &samples,
        )
    } else {
        false
    };

    if !wrote_binary {
        let frame_bytes = bytemuck::cast_slice(&samples);
        let pcm_base64 = BASE64.encode(frame_bytes);
        enqueue_voice_filter_frame_event(
            frame_queue,
            session_id,
            sequence,
            sample_rate,
            channels,
            frame_count,
            pcm_base64,
            &diagnostics,
        );
    }

    Ok(())
}

fn process_voice_filter_reference_samples(
    state: &mut SidecarState,
    session_id: &str,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    protocol_version: Option<u32>,
    samples: Vec<f32>,
) -> Result<(), String> {
    let Some(session) = state.voice_filter_session.as_mut() else {
        return Err("No active voice filter session".to_string());
    };

    if session.session_id != session_id {
        return Err("Voice filter session mismatch".to_string());
    }

    if let Some(protocol_version) = protocol_version {
        if protocol_version != PROTOCOL_VERSION {
            return Err("Unsupported voice filter protocol version".to_string());
        }
    }

    if sample_rate != session.sample_rate {
        return Err("Voice filter sample rate mismatch".to_string());
    }

    if channels == 0 || channels > 2 {
        return Err("Unsupported voice filter reference channel count".to_string());
    }

    if samples.len() != frame_count * channels {
        return Err("Voice filter reference frame sample count mismatch".to_string());
    }

    session.push_echo_reference_samples(&samples, channels)?;
    Ok(())
}

fn handle_voice_filter_push_frame(
    frame_queue: Arc<FrameQueue>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: VoiceFilterPushFrameParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    if let Some(encoding) = parsed.encoding {
        if encoding != PCM_ENCODING {
            return Err("Unsupported voice filter frame encoding".to_string());
        }
    }

    let samples = decode_f32le_base64(&parsed.pcm_base64)?;

    process_voice_filter_samples(
        &frame_queue,
        state,
        &parsed.session_id,
        parsed.sequence,
        parsed.sample_rate,
        parsed.channels,
        parsed.frame_count,
        parsed.protocol_version,
        samples,
    )?;

    Ok(json!({
        "accepted": true,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_voice_filter_push_reference_frame(
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    let parsed: VoiceFilterPushReferenceFrameParams =
        serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))?;

    if let Some(encoding) = parsed.encoding {
        if encoding != PCM_ENCODING {
            return Err("Unsupported voice filter reference frame encoding".to_string());
        }
    }

    let samples = decode_f32le_base64(&parsed.pcm_base64)?;
    let _sequence = parsed.sequence;

    process_voice_filter_reference_samples(
        state,
        &parsed.session_id,
        parsed.sample_rate,
        parsed.channels,
        parsed.frame_count,
        parsed.protocol_version,
        samples,
    )?;

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

fn start_voice_filter_binary_egress() -> Result<VoiceFilterBinaryEgress, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Failed to bind voice-filter binary egress listener: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| {
        format!("Failed to configure voice-filter binary egress listener: {error}")
    })?;

    let port = listener
        .local_addr()
        .map_err(|error| {
            format!("Failed to read voice-filter binary egress listener port: {error}")
        })?
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
                    eprintln!("[capture-sidecar] voice-filter binary egress accept error: {error}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        if let Ok(mut lock) = worker_stream.lock() {
            *lock = None;
        }
    });

    Ok(VoiceFilterBinaryEgress {
        port,
        stream,
        stop_flag,
        handle,
    })
}

fn handle_voice_filter_binary_egress_info(
    egress: &VoiceFilterBinaryEgress,
) -> Result<Value, String> {
    Ok(json!({
        "port": egress.port,
        "framing": VOICE_FILTER_BINARY_EGRESS_FRAMING,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn read_exact_with_stop(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    stop_flag: &Arc<AtomicBool>,
) -> io::Result<bool> {
    let mut offset = 0;

    while offset < buffer.len() {
        if stop_flag.load(Ordering::Relaxed) {
            return Ok(false);
        }

        match stream.read(&mut buffer[offset..]) {
            Ok(0) => {
                if offset == 0 {
                    return Ok(false);
                }

                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream closed while reading frame",
                ));
            }
            Ok(read_len) => {
                offset += read_len;
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                continue;
            }
            Err(error) => return Err(error),
        }
    }

    Ok(true)
}

fn parse_voice_filter_binary_frame(payload: &[u8]) -> Result<VoiceFilterBinaryFrame, String> {
    let mut offset = 0usize;

    let read_u16 = |payload: &[u8], offset: &mut usize| -> Result<u16, String> {
        if payload.len() < *offset + 2 {
            return Err("Binary voice filter frame is truncated".to_string());
        }

        let value = u16::from_le_bytes([payload[*offset], payload[*offset + 1]]);
        *offset += 2;
        Ok(value)
    };

    let read_u32 = |payload: &[u8], offset: &mut usize| -> Result<u32, String> {
        if payload.len() < *offset + 4 {
            return Err("Binary voice filter frame is truncated".to_string());
        }

        let value = u32::from_le_bytes([
            payload[*offset],
            payload[*offset + 1],
            payload[*offset + 2],
            payload[*offset + 3],
        ]);
        *offset += 4;
        Ok(value)
    };

    let read_u64 = |payload: &[u8], offset: &mut usize| -> Result<u64, String> {
        if payload.len() < *offset + 8 {
            return Err("Binary voice filter frame is truncated".to_string());
        }

        let value = u64::from_le_bytes([
            payload[*offset],
            payload[*offset + 1],
            payload[*offset + 2],
            payload[*offset + 3],
            payload[*offset + 4],
            payload[*offset + 5],
            payload[*offset + 6],
            payload[*offset + 7],
        ]);
        *offset += 8;
        Ok(value)
    };

    let session_id_len = read_u16(payload, &mut offset)? as usize;
    if session_id_len == 0 {
        return Err("Binary voice filter frame is missing a session id".to_string());
    }
    if payload.len() < offset + session_id_len {
        return Err("Binary voice filter frame session id is truncated".to_string());
    }

    let session_id = std::str::from_utf8(&payload[offset..offset + session_id_len])
        .map_err(|error| {
            format!("Binary voice filter frame has invalid UTF-8 session id: {error}")
        })?
        .to_string();
    offset += session_id_len;

    let sequence = read_u64(payload, &mut offset)?;
    let sample_rate = read_u32(payload, &mut offset)? as usize;
    let channels = read_u16(payload, &mut offset)? as usize;
    let frame_count = read_u32(payload, &mut offset)? as usize;
    let protocol_version = read_u32(payload, &mut offset)?;
    let pcm_byte_length = read_u32(payload, &mut offset)? as usize;

    if pcm_byte_length == 0 {
        return Err("Binary voice filter frame has no PCM payload".to_string());
    }
    if pcm_byte_length % std::mem::size_of::<f32>() != 0 {
        return Err("Binary voice filter PCM payload is not f32-aligned".to_string());
    }
    if payload.len() != offset + pcm_byte_length {
        return Err("Binary voice filter frame payload length mismatch".to_string());
    }

    let mut samples = Vec::with_capacity(pcm_byte_length / std::mem::size_of::<f32>());
    for chunk in payload[offset..offset + pcm_byte_length].chunks_exact(4) {
        samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }

    Ok(VoiceFilterBinaryFrame {
        session_id,
        sequence,
        sample_rate,
        channels,
        frame_count,
        protocol_version,
        samples,
    })
}

fn handle_voice_filter_binary_stream(
    mut stream: TcpStream,
    frame_queue: Arc<FrameQueue>,
    state: Arc<Mutex<SidecarState>>,
    stop_flag: Arc<AtomicBool>,
) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }

        let mut frame_length_bytes = [0u8; 4];
        match read_exact_with_stop(&mut stream, &mut frame_length_bytes, &stop_flag) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                eprintln!("[capture-sidecar] binary ingress read error: {error}");
                return;
            }
        }

        let frame_length = u32::from_le_bytes(frame_length_bytes) as usize;
        if frame_length == 0 || frame_length > MAX_VOICE_FILTER_BINARY_FRAME_BYTES {
            eprintln!(
                "[capture-sidecar] binary ingress rejected frame with invalid size {}",
                frame_length
            );
            return;
        }

        let mut payload = vec![0u8; frame_length];
        match read_exact_with_stop(&mut stream, &mut payload, &stop_flag) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                eprintln!("[capture-sidecar] binary ingress payload read error: {error}");
                return;
            }
        }

        let frame = match parse_voice_filter_binary_frame(&payload) {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("[capture-sidecar] invalid binary voice filter frame: {error}");
                continue;
            }
        };

        let mut state_lock = match state.lock() {
            Ok(state_lock) => state_lock,
            Err(_) => {
                eprintln!("[capture-sidecar] sidecar state lock poisoned");
                return;
            }
        };

        if let Err(error) = process_voice_filter_samples(
            &frame_queue,
            &mut state_lock,
            &frame.session_id,
            frame.sequence,
            frame.sample_rate,
            frame.channels,
            frame.frame_count,
            Some(frame.protocol_version),
            frame.samples,
        ) {
            eprintln!("[capture-sidecar] binary voice filter frame rejected: {error}");
        }
    }
}

fn start_voice_filter_binary_ingress(
    frame_queue: Arc<FrameQueue>,
    state: Arc<Mutex<SidecarState>>,
) -> Result<VoiceFilterBinaryIngress, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Failed to bind binary voice filter ingress listener: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure binary voice filter listener: {error}"))?;

    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read binary voice filter listener port: {error}"))?
        .port();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop_flag = Arc::clone(&stop_flag);
    let worker_frame_queue = Arc::clone(&frame_queue);
    let worker_state = Arc::clone(&state);

    let handle = thread::spawn(move || {
        while !worker_stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _peer)) => {
                    handle_voice_filter_binary_stream(
                        stream,
                        Arc::clone(&worker_frame_queue),
                        Arc::clone(&worker_state),
                        Arc::clone(&worker_stop_flag),
                    );
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => {
                    eprintln!("[capture-sidecar] binary ingress accept error: {error}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    Ok(VoiceFilterBinaryIngress {
        port,
        stop_flag,
        handle,
    })
}

fn handle_voice_filter_binary_ingress_info(
    binary_ingress: &VoiceFilterBinaryIngress,
) -> Result<Value, String> {
    Ok(json!({
        "port": binary_ingress.port,
        "framing": VOICE_FILTER_BINARY_FRAMING,
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
    let voice_filter_binary_egress = match start_voice_filter_binary_egress() {
        Ok(egress) => {
            eprintln!(
                "[capture-sidecar] voice-filter binary egress listening on 127.0.0.1:{}",
                egress.port
            );
            Some(egress)
        }
        Err(error) => {
            eprintln!("[capture-sidecar] voice-filter binary egress unavailable: {error}");
            None
        }
    };

    // Publish the egress stream into shared state so process_voice_filter_samples
    // can write binary frames without going through the FrameQueue.
    if let Some(egress) = voice_filter_binary_egress.as_ref() {
        if let Ok(mut state_lock) = state.lock() {
            state_lock.voice_filter_binary_egress_stream = Some(Arc::clone(&egress.stream));
        }
    }

    let binary_ingress = match start_voice_filter_binary_ingress(
        Arc::clone(&frame_queue),
        Arc::clone(&state),
    ) {
        Ok(binary_ingress) => {
            eprintln!(
                "[capture-sidecar] voice filter binary ingress listening on 127.0.0.1:{}",
                binary_ingress.port
            );
            Some(binary_ingress)
        }
        Err(error) => {
            eprintln!("[capture-sidecar] voice filter binary ingress unavailable: {error}");
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
            "voice_filter.binary_egress_info" => match voice_filter_binary_egress.as_ref() {
                Some(egress) => handle_voice_filter_binary_egress_info(egress),
                None => Err("Binary voice filter egress is unavailable".to_string()),
            },
            "voice_filter.binary_ingress_info" => match binary_ingress.as_ref() {
                Some(binary_ingress) => handle_voice_filter_binary_ingress_info(binary_ingress),
                None => Err("Binary voice filter ingress is unavailable".to_string()),
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
                Ok(mut state_lock) => {
                    handle_push_keybinds_set(request_frame_queue.clone(), &mut state_lock, request.params)
                }
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "mic_devices.list" => handle_mic_devices_list(),
            "voice_filter.start_with_capture" => match state.lock() {
                Ok(mut state_lock) => handle_voice_filter_start_with_capture(
                    Arc::clone(&state),
                    request_frame_queue.clone(),
                    &mut state_lock,
                    request.params,
                ),
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "voice_filter.start" => match state.lock() {
                Ok(mut state_lock) => {
                    handle_voice_filter_start(request_frame_queue.clone(), &mut state_lock, request.params)
                }
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "voice_filter.push_frame" => match state.lock() {
                Ok(mut state_lock) => handle_voice_filter_push_frame(
                    request_frame_queue.clone(),
                    &mut state_lock,
                    request.params,
                ),
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "voice_filter.push_reference_frame" => match state.lock() {
                Ok(mut state_lock) => {
                    handle_voice_filter_push_reference_frame(&mut state_lock, request.params)
                }
                Err(_) => Err("Sidecar state lock poisoned".to_string()),
            },
            "voice_filter.stop" => match state.lock() {
                Ok(mut state_lock) => {
                    handle_voice_filter_stop(request_frame_queue.clone(), &mut state_lock, request.params)
                }
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

    if let Some(vf_egress) = voice_filter_binary_egress {
        vf_egress.stop_flag.store(true, Ordering::Relaxed);
        let _ = vf_egress.handle.join();
    }

    if let Some(binary_ingress) = binary_ingress {
        binary_ingress.stop_flag.store(true, Ordering::Relaxed);
        let _ = binary_ingress.handle.join();
    }

    if let Ok(mut state_lock) = state.lock() {
        stop_capture_session(&mut state_lock, None);
        stop_push_keybind_watcher(&mut state_lock);
        stop_voice_filter_session(&mut state_lock, &frame_queue, None, "capture_stopped", None);
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
        create_echo_canceller_backend,
        dedupe_window_entries_by_pid, parse_target_pid, parse_window_source_id,
        AdaptiveEchoCanceller, CaptureEndReason, ECHO_CANCELLATION_BACKEND_WEBRTC,
        ECHO_REFERENCE_DELAY_MS,
    };
    use std::collections::VecDeque;

    const TEST_AEC_BLOCK_SIZE: usize = 480;

    fn synthetic_reference_sample(index: usize) -> f32 {
        let t = index as f32;
        (t * 0.073).sin() * 0.55 + (t * 0.017).cos() * 0.25
    }

    fn synthetic_speech_sample(index: usize) -> f32 {
        let t = index as f32;
        (t * 0.041).sin() * 0.45 + (t * 0.011).cos() * 0.18
    }

    fn rms(samples: &[f32]) -> f32 {
        let sum_sq: f32 = samples.iter().map(|sample| sample * sample).sum();
        (sum_sq / samples.len() as f32).sqrt()
    }

    fn mean_abs_diff(lhs: &[f32], rhs: &[f32]) -> f32 {
        lhs.iter()
            .zip(rhs.iter())
            .map(|(left, right)| (left - right).abs())
            .sum::<f32>()
            / lhs.len() as f32
    }

    fn build_reference_window(
        history: &mut VecDeque<f32>,
        block: &[f32],
        filter_len: usize,
    ) -> Vec<f32> {
        let history_len = filter_len.saturating_sub(1);
        let mut window = Vec::with_capacity(history_len + block.len());
        window.extend(history.iter().copied());
        window.extend_from_slice(block);

        for sample in block {
            history.push_back(*sample);
            while history.len() > history_len {
                let _ = history.pop_front();
            }
        }

        window
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
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::CaptureStopped.as_str(), "capture_stopped");
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::AppExited.as_str(), "app_exited");
        #[cfg(windows)]
        assert_eq!(CaptureEndReason::DeviceLost.as_str(), "device_lost");
    }

    #[test]
    fn prefers_webrtc_aec3_backend_for_48khz_mono() {
        let backend = create_echo_canceller_backend(48_000, 1);
        assert_eq!(backend.backend_name(), ECHO_CANCELLATION_BACKEND_WEBRTC);
    }

    #[test]
    fn adaptive_echo_canceller_converges_on_correlated_echo() {
        let mut canceller = AdaptiveEchoCanceller::new();
        let filter_len = canceller.filter_len();
        let mut history = VecDeque::from(vec![0.0; filter_len.saturating_sub(1)]);
        let mut input_rms_sum = 0.0_f32;
        let mut output_rms_sum = 0.0_f32;

        for block_index in 0..120 {
            let start = block_index * TEST_AEC_BLOCK_SIZE;
            let reference_block: Vec<f32> = (0..TEST_AEC_BLOCK_SIZE)
                .map(|offset| synthetic_reference_sample(start + offset))
                .collect();
            let reference_window =
                build_reference_window(&mut history, &reference_block, filter_len);
            let mut near_block: Vec<f32> =
                reference_block.iter().map(|sample| sample * 0.65).collect();

            if block_index >= 80 {
                input_rms_sum += rms(&near_block);
            }

            canceller.process_block(&mut near_block, &reference_window);

            if block_index >= 80 {
                output_rms_sum += rms(&near_block);
            }
        }

        let metrics = canceller.last_metrics();
        assert!(metrics.erle_db.is_some());
        assert_eq!(metrics.delay_ms, Some(ECHO_REFERENCE_DELAY_MS as f32));
        assert!(output_rms_sum < input_rms_sum * 0.45);
    }

    #[test]
    fn adaptive_echo_canceller_preserves_double_talk() {
        let mut canceller = AdaptiveEchoCanceller::new();
        let filter_len = canceller.filter_len();
        let mut history = VecDeque::from(vec![0.0; filter_len.saturating_sub(1)]);

        for block_index in 0..90 {
            let start = block_index * TEST_AEC_BLOCK_SIZE;
            let reference_block: Vec<f32> = (0..TEST_AEC_BLOCK_SIZE)
                .map(|offset| synthetic_reference_sample(start + offset))
                .collect();
            let reference_window =
                build_reference_window(&mut history, &reference_block, filter_len);
            let mut near_block: Vec<f32> =
                reference_block.iter().map(|sample| sample * 0.55).collect();
            canceller.process_block(&mut near_block, &reference_window);
        }

        let start = 90 * TEST_AEC_BLOCK_SIZE;
        let reference_block: Vec<f32> = (0..TEST_AEC_BLOCK_SIZE)
            .map(|offset| synthetic_reference_sample(start + offset))
            .collect();
        let speech_block: Vec<f32> = (0..TEST_AEC_BLOCK_SIZE)
            .map(|offset| synthetic_speech_sample(start + offset))
            .collect();
        let reference_window = build_reference_window(&mut history, &reference_block, filter_len);
        let mut mixed_block: Vec<f32> = speech_block
            .iter()
            .zip(reference_block.iter())
            .map(|(speech, reference)| speech + reference * 0.45)
            .collect();
        let input_error = mean_abs_diff(&mixed_block, &speech_block);

        canceller.process_block(&mut mixed_block, &reference_window);

        let output_error = mean_abs_diff(&mixed_block, &speech_block);
        let metrics = canceller.last_metrics();
        assert!(metrics.double_talk_confidence.is_some());
        assert!(output_error < input_error);
        assert!(rms(&mixed_block) > rms(&speech_block) * 0.6);
    }
}
