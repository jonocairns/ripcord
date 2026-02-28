use aec3::voip::VoipAec3;
use deep_filter::tract::{DfParams, DfTract, ReduceMask, RuntimeParams};
use earshot::Detector;
use ndarray::Array2;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::f32::consts::PI;
use std::time::Instant;

// ── Constants ────────────────────────────────────────────────────────────────

pub const TARGET_SAMPLE_RATE: u32 = 48_000;
pub const TARGET_CHANNELS: usize = 1;
pub const FRAME_SIZE: usize = 960;

// High-pass filter: 2nd-order Butterworth at 80 Hz / 48 kHz (Direct Form II transposed).
// Removes DC offset and low-frequency rumble (HVAC, desk vibration, electrical hum) before
// DeepFilterNet sees the signal.  Sub-80 Hz energy registers as broadband noise and causes
// the model to over-suppress uncertain bands — a common far-field mic problem.
// Coefficients computed via bilinear transform: fc=80 Hz, Q=1/√2, fs=48 kHz.
pub const HP_B0: f32 = 0.992_617;
pub const HP_B1: f32 = -1.985_234;
pub const HP_B2: f32 = 0.992_617;
pub const HP_A1: f32 = -1.985_207;
pub const HP_A2: f32 = 0.985_307;

// Limiter: threshold just below full scale, ~1ms attack, ~100ms release at 48kHz
pub const LIMITER_THRESHOLD: f32 = 0.95;
pub const LIMITER_ATTACK_COEFF: f32 = 0.979_2; // exp(-1/48)
pub const LIMITER_RELEASE_COEFF: f32 = 0.999_8; // exp(-1/4800)
pub const DFN_DEFAULT_WET_MIX: f32 = 1.0;
pub const DFN_GAIN_COMP_ATTACK: f32 = 0.7;
pub const DFN_GAIN_COMP_RELEASE: f32 = 0.92;
pub const DFN_GAIN_COMP_MAX: f32 = 1.08;
pub const DFN_ENERGY_COLLAPSE_RATIO: f32 = 0.08;
pub const DFN_ENERGY_COLLAPSE_MAX_DRY_BOOST: f32 = 0.2;
pub const DFN_SAMPLE_SANITIZE_FLOOR: f32 = 1e-20;
pub const DFN_NOISE_GATE_ATTENUATION: f32 = 0.65;
pub const DFN_NOISE_GATE_KNEE_MULTIPLIER: f32 = 3.0;

pub const ECHO_REFERENCE_MAX_BUFFER_MS: usize = 1_200;
pub const ECHO_CANCELLER_BLOCK_MS: usize = 10;
pub const ECHO_CANCELLER_FILTER_TAPS: usize = 192;
pub const ECHO_CANCELLER_REFERENCE_RMS_FLOOR: f32 = 3e-4;
pub const ECHO_CANCELLER_NLMS_STEP_SIZE: f32 = 0.14;
pub const ECHO_CANCELLER_NLMS_LEAK: f32 = 0.999_8;
pub const ECHO_CANCELLER_NLMS_ENERGY_FLOOR: f32 = 1e-4;
pub const ECHO_CANCELLER_NEAR_DOMINANCE_THRESHOLD: f32 = 1.8;
pub const ECHO_CANCELLER_RESIDUAL_CORRELATION_FLOOR: f32 = 0.2;
pub const ECHO_CANCELLER_DOUBLE_TALK_MIX: f32 = 0.35;
pub const ECHO_CANCELLER_NEAR_DOMINANT_MIX: f32 = 0.7;
pub const ECHO_CANCELLER_COEFFICIENT_LIMIT: f32 = 2.0;
pub const ECHO_CANCELLATION_BACKEND_ADAPTIVE: &str = "adaptive_nlms";
pub const ECHO_CANCELLATION_BACKEND_WEBRTC: &str = "webrtc_aec3";
pub const DEREVERB_MODE_OFF: &str = "off";
pub const DEREVERB_MODE_TAIL: &str = "tail";
pub const DEEP_FILTER_WARMUP_BLOCKS: usize = 20;

// Slow post-DFN trim
pub const TRIM_TARGET_RMS: f32 = 0.12;
pub const TRIM_LEVEL_TC_S: f32 = 0.400;
pub const TRIM_MIN_GAIN: f32 = 0.5;
pub const TRIM_MAX_GAIN: f32 = 2.0;
pub const TRIM_SLEW_DB_PER_FRAME: f32 = 0.1;
pub const AGC_STARTUP_BYPASS_MS: u32 = 1_500;

// Suppression slew limit
pub const DFN_SLEW_MAX_DROP_DB_PER_FRAME: f32 = 6.0;
pub const DFN_SLEW_MIN_ACTIVE_DBFS: f32 = -60.0;

// Comfort noise
pub const COMFORT_NOISE_THRESHOLD_DBFS: f32 = -65.0;
pub const COMFORT_NOISE_LEVEL_DBFS: f32 = -78.0;

// Output de-zipper
pub const DEZIPPER_COEFF: f32 = 0.25;

// Late-stage voice polish. This is intentionally subtle and speech-gated so it
// restores a bit of presence without re-opening the suppressed noise floor.
pub const VOICE_POLISH_HIGH_SHELF_HZ: f32 = 4_800.0;
pub const VOICE_POLISH_PRESENCE_FAST_HZ: f32 = 3_400.0;
pub const VOICE_POLISH_PRESENCE_SLOW_HZ: f32 = 1_200.0;
pub const VOICE_POLISH_EXCITER_HZ: f32 = 2_600.0;
pub const VOICE_POLISH_HIGH_SHELF_MIX: f32 = 0.08;
pub const VOICE_POLISH_PRESENCE_MIX: f32 = 0.04;
pub const VOICE_POLISH_EXCITER_MIX: f32 = 0.015;
pub const VOICE_POLISH_EXCITER_DRIVE: f32 = 1.8;
pub const VOICE_POLISH_HANGOVER_MIX: f32 = 0.35;
pub const VOICE_POLISH_LSNR_FLOOR_DB: f32 = -6.0;
pub const VOICE_POLISH_LSNR_CEIL_DB: f32 = 8.0;
pub const VOICE_POLISH_LSNR_MIN_MIX: f32 = 0.45;

pub const SUPPRESSION_STARTUP_RAMP_MS: u32 = 1_000;
pub const SUPPRESSION_STARTUP_PRE_WARM_MS: f32 = 200.0;
pub const ONSET_WET_RAMP_FRAMES: u32 = 10;
pub const PRE_DFN_ONSET_ASSIST_WET_MIX_FLOOR: f32 = 0.55;
pub const PRE_DFN_ONSET_ASSIST_SCORE_THRESHOLD: f32 = 0.72;
pub const PRE_DFN_ONSET_ASSIST_NOISE_FLOOR_MULTIPLIER: f32 = 3.0;
pub const PRE_DFN_ONSET_ASSIST_MAX_CREST: f32 = 5.8;
pub const PRE_DFN_ONSET_ASSIST_MAX_DIFF_RATIO: f32 = 0.8;

pub const DEREVERB_MIN_LEVEL_DBFS: f32 = -52.0;
pub const DEREVERB_MAX_ATTENUATION_DB: f32 = 6.0;
pub const DEREVERB_FAST_ATTACK_MS: f32 = 2.0;
pub const DEREVERB_FAST_RELEASE_MS: f32 = 35.0;
pub const DEREVERB_TAIL_ATTACK_MS: f32 = 18.0;
pub const DEREVERB_TAIL_RELEASE_MS: f32 = 220.0;
pub const DEREVERB_GAIN_ATTACK_MS: f32 = 8.0;
pub const DEREVERB_GAIN_RELEASE_MS: f32 = 120.0;

// Downward expander
pub const EXPANDER_THRESHOLD_DBFS: f32 = -35.0;
pub const EXPANDER_RATIO: f32 = 1.5;
pub const EXPANDER_ATTACK_MS: f32 = 2.0;
pub const EXPANDER_RELEASE_MS: f32 = 80.0;
pub const EXPANDER_HANGOVER_MS: f32 = 120.0;
pub const EXPANDER_LSNR_NUDGE_LOW_DB: f32 = -10.0;
pub const EXPANDER_LSNR_NUDGE_HIGH_DB: f32 = 5.0;
pub const EXPANDER_LSNR_THRESHOLD_RAISE_DB: f32 = 8.0;
pub const EXPANDER_LSNR_SMOOTH_ALPHA: f32 = 0.9;
pub const EXPANDER_BYPASS_SPEECH_FLOOR: f32 = 0.25;
pub const EXPANDER_BYPASS_SPEECH_FULL: f32 = 0.65;

// VAD
pub const VAD_MODEL_SAMPLE_RATE: usize = 16_000;
pub const VAD_MODEL_FRAME_SAMPLES: usize = 256;
pub const VAD_ALPHA: f32 = 0.85;
pub const VAD_SPEECH_THRESHOLD: f32 = 0.6;
pub const VAD_SILENCE_THRESHOLD: f32 = 0.3;
pub const VAD_ONSET_FRAMES: u32 = 1;
pub const VAD_OFFSET_FRAMES: u32 = 5;
pub const VAD_HANGOVER_FRAMES: u32 = 50;
pub const VAD_ONSET_PROTECTION_FRAMES: u32 = 60;
pub const VAD_STARTUP_NOISE_CALIBRATION_FRAMES: u32 = 30;
pub const VAD_NOISE_ADAPT_RATE: f32 = 0.002;
pub const VAD_SNR_LOW_DB: f32 = -3.0;
pub const VAD_SNR_HIGH_DB: f32 = 12.0;
pub const VAD_TRIM_SILENCE_RATE: f32 = 0.0;
pub const VAD_TRIM_HANGOVER_RATE: f32 = 0.0;
/// Frames of confirmed Silence before the silence gate fully closes (10ms/frame).
/// 80 frames = 800ms — closes before DFN adaptation leak becomes audible (~1-2s)
/// but leaves enough time that brief pauses don't trigger muting.
pub const VAD_SILENCE_GATE_FADE_FRAMES: u32 = 80;
pub const VAD_IMPULSE_CREST_THRESHOLD: f32 = 7.0;
pub const VAD_IMPULSE_ENERGY_JUMP: f32 = 4.0;
pub const VAD_TRANSIENT_NOISE_DIFF_RATIO_THRESHOLD: f32 = 0.95;
pub const VAD_TRANSIENT_NOISE_PENALTY: f32 = 0.55;

// Transient suppressor
pub const TRANS_CREST_THRESHOLD: f32 = 5.8;
pub const TRANS_NON_SPEECH_HP_CREST_THRESHOLD: f32 = 3.4;
pub const TRANS_NON_SPEECH_DIFF_RATIO_THRESHOLD: f32 = 0.7;
pub const TRANS_NON_SPEECH_HP_RATIO_THRESHOLD: f32 = 0.72;
pub const TRANS_NON_SPEECH_RMS_JUMP_RATIO: f32 = 1.25;
pub const TRANS_NON_SPEECH_NOISE_FLOOR_RATIO: f32 = 1.3;
pub const TRANS_SPEECH_CREST_THRESHOLD: f32 = 5.4;
pub const TRANS_SPEECH_HP_CREST_THRESHOLD: f32 = 5.8;
pub const TRANS_SPEECH_DIFF_RATIO_THRESHOLD: f32 = 0.62;
pub const TRANS_SPEECH_HP_RATIO_THRESHOLD: f32 = 0.6;
pub const TRANS_SPEECH_BURST_PEAK_THRESHOLD: f32 = 0.8;
pub const TRANS_SPEECH_BURST_RMS_THRESHOLD: f32 = 0.08;
pub const TRANS_SPEECH_BURST_RMS_JUMP_RATIO: f32 = 3.0;
pub const TRANS_SPEECH_BURST_NOISE_FLOOR_RATIO: f32 = 4.0;
pub const TRANS_HOLD_MS: u32 = 80;
pub const TRANS_NON_SPEECH_HOLD_MS: u32 = 140;
pub const TRANS_RELEASE_MS: f32 = 100.0;
pub const TRANS_DEBOUNCE_MS: u32 = 60;
pub const TRANS_GAIN_LOW_DB: f32 = -16.0;
pub const TRANS_GAIN_HIGH_DB: f32 = -30.0;
pub const TRANS_GAIN_HO_LOW_DB: f32 = -12.0;
pub const TRANS_GAIN_HO_HIGH_DB: f32 = -24.0;
pub const TRANS_GAIN_SP_LOW_DB: f32 = -10.0;
pub const TRANS_GAIN_SP_HIGH_DB: f32 = -30.0;
pub const TRANS_CROSSOVER_HZ: f32 = 300.0;
pub const TRANS_ENERGY_JUMP_RATIO: f32 = 4.0;
pub const TRANS_NON_SPEECH_RESIDUAL_PEAK: f32 = 0.003;
pub const TRANS_SPEECH_BURST_RESIDUAL_PEAK: f32 = 0.01;
pub const TRANSIENT_CONTROL_SPEECH_FLOOR: f32 = 0.55;
pub const TRANSIENT_CONTROL_SILENCE_CEIL: f32 = 0.2;
pub const PAUSE_NOISE_GATE_CREST_THRESHOLD: f32 = 4.8;
pub const PAUSE_NOISE_GATE_HP_CREST_THRESHOLD: f32 = 2.4;
pub const PAUSE_NOISE_GATE_DIFF_RATIO_THRESHOLD: f32 = 0.25;
pub const PAUSE_NOISE_GATE_HP_RATIO_THRESHOLD: f32 = 0.5;
pub const PAUSE_NOISE_GATE_NOISE_FLOOR_RATIO: f32 = 1.1;
pub const PAUSE_NOISE_GATE_RMS_JUMP_RATIO: f32 = 1.08;
pub const PAUSE_NOISE_GATE_HOLD_MS: u32 = 240;
pub const PAUSE_NOISE_GATE_RELEASE_MS: f32 = 220.0;
pub const PAUSE_LOW_BURST_CREST_THRESHOLD: f32 = 3.2;
pub const PAUSE_LOW_BURST_HP_RATIO_CEIL: f32 = 0.95;
pub const PAUSE_LOW_BURST_DIFF_RATIO_CEIL: f32 = 0.6;
pub const PAUSE_LOW_BURST_RMS_JUMP_RATIO: f32 = 1.06;
pub const PAUSE_LOW_BURST_HOLD_MS: u32 = 190;
pub const PAUSE_LOW_BURST_RELEASE_MS: f32 = 140.0;

// Spike repair
pub const SPIKE_CREST_THRESHOLD: f32 = 8.0;
pub const SPIKE_NEIGHBOR_RATIO: f32 = 0.5;

// ── Enums ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum VoiceFilterStrength {
    Low,
    Balanced,
    High,
    Aggressive,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VoiceDereverbMode {
    Off,
    Tail,
}

impl VoiceDereverbMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => DEREVERB_MODE_OFF,
            Self::Tail => DEREVERB_MODE_TAIL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadSpeechState {
    Silence,
    Speech,
    Hangover,
}

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceFilterDfnTuningParams {
    pub attenuation_limit_db: Option<f32>,
    pub mix: Option<f32>,
    pub experimental_aggressive_mode: Option<bool>,
    pub noise_gate_floor_dbfs: Option<f32>,
}

#[derive(Debug, Clone, Copy)]
pub struct VoiceFilterConfig {
    pub post_filter_beta: f32,
    pub atten_lim_db: f32,
    pub min_db_thresh: f32,
    pub max_db_erb_thresh: f32,
    pub max_db_df_thresh: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct DfnStageConfig {
    pub mix: f32,
    pub noise_gate_floor: Option<f32>,
}

#[derive(Default)]
pub struct DfnStageStats {
    pub lsnr_sum: f32,
    pub lsnr_min: f32,
    pub lsnr_max: f32,
    pub hop_count: u32,
    pub effective_wet_mix_sum: f32,
    pub dry_recovery_hops: u32,
}

impl DfnStageStats {
    pub fn record_lsnr(&mut self, lsnr: f32) {
        if self.hop_count == 0 {
            self.lsnr_min = lsnr;
            self.lsnr_max = lsnr;
        } else {
            self.lsnr_min = self.lsnr_min.min(lsnr);
            self.lsnr_max = self.lsnr_max.max(lsnr);
        }
        self.lsnr_sum += lsnr;
        self.hop_count += 1;
    }
}

pub struct DfnStage {
    pub model: DfTract,
    pub hop_size: usize,
    pub _latency_samples: usize,
    pub dry_delay_buffer: VecDeque<f32>,
    pub gain_compensation: f32,
    pub config: DfnStageConfig,
}

// SAFETY: `DfnStage` is never accessed concurrently. It is always
// stored inside `SidecarState`, which is guarded by `Mutex<SidecarState>`.
// This guarantees serialized access when the state is touched from different
// threads (command loop and binary-ingress worker).
unsafe impl Send for DfnStage {}

pub enum VoiceFilterProcessor {
    DeepFilter(DfnStage),
    Passthrough,
}

#[derive(Clone, Copy)]
pub struct TailDereverbProcessor {
    pub fast_envelope: f32,
    pub tail_envelope: f32,
    pub gain: f32,
}

impl TailDereverbProcessor {
    pub fn new() -> Self {
        Self {
            fast_envelope: 0.0,
            tail_envelope: 0.0,
            gain: 1.0,
        }
    }

    pub fn process(&mut self, samples: &mut [f32], sample_rate: usize) {
        if samples.is_empty() || sample_rate == 0 {
            return;
        }

        let sr = sample_rate as f32;
        let fast_attack_coeff = (-1.0f32 / (sr * DEREVERB_FAST_ATTACK_MS / 1000.0)).exp();
        let fast_release_coeff = (-1.0f32 / (sr * DEREVERB_FAST_RELEASE_MS / 1000.0)).exp();
        let tail_attack_coeff = (-1.0f32 / (sr * DEREVERB_TAIL_ATTACK_MS / 1000.0)).exp();
        let tail_release_coeff = (-1.0f32 / (sr * DEREVERB_TAIL_RELEASE_MS / 1000.0)).exp();
        let gain_attack_coeff = (-1.0f32 / (sr * DEREVERB_GAIN_ATTACK_MS / 1000.0)).exp();
        let gain_release_coeff = (-1.0f32 / (sr * DEREVERB_GAIN_RELEASE_MS / 1000.0)).exp();
        let min_level = 10.0f32.powf(DEREVERB_MIN_LEVEL_DBFS / 20.0);
        let min_gain = 10.0f32.powf(-DEREVERB_MAX_ATTENUATION_DB / 20.0);

        for sample in samples.iter_mut() {
            let abs_val = sample.abs();

            let fast_coeff = if abs_val > self.fast_envelope {
                fast_attack_coeff
            } else {
                fast_release_coeff
            };
            self.fast_envelope = fast_coeff * self.fast_envelope + (1.0 - fast_coeff) * abs_val;

            let tail_coeff = if abs_val > self.tail_envelope {
                tail_attack_coeff
            } else {
                tail_release_coeff
            };
            self.tail_envelope = tail_coeff * self.tail_envelope + (1.0 - tail_coeff) * abs_val;

            let target_gain = if self.tail_envelope <= min_level {
                1.0
            } else {
                let tail_ratio = ((self.tail_envelope - self.fast_envelope)
                    / (self.tail_envelope + 1e-6))
                    .clamp(0.0, 1.0);
                (1.0 - tail_ratio * (1.0 - min_gain)).clamp(min_gain, 1.0)
            };

            let gain_coeff = if target_gain < self.gain {
                gain_attack_coeff
            } else {
                gain_release_coeff
            };
            self.gain = gain_coeff * self.gain + (1.0 - gain_coeff) * target_gain;
            *sample *= self.gain;
        }
    }
}

pub struct VoicePolishProcessor {
    pub high_shelf_lowpass: Vec<f32>,
    pub presence_fast_lowpass: Vec<f32>,
    pub presence_slow_lowpass: Vec<f32>,
    pub exciter_lowpass: Vec<f32>,
}

impl VoicePolishProcessor {
    pub fn new(channels: usize) -> Self {
        let state_len = channels.max(1);

        Self {
            high_shelf_lowpass: vec![0.0; state_len],
            presence_fast_lowpass: vec![0.0; state_len],
            presence_slow_lowpass: vec![0.0; state_len],
            exciter_lowpass: vec![0.0; state_len],
        }
    }

    pub fn process(
        &mut self,
        samples: &mut [f32],
        channels: usize,
        sample_rate: usize,
        speech_state: VadSpeechState,
        lsnr_db: Option<f32>,
    ) {
        if samples.is_empty() || channels == 0 || sample_rate == 0 {
            return;
        }

        let speech_mix = match speech_state {
            VadSpeechState::Speech => 1.0,
            VadSpeechState::Hangover => VOICE_POLISH_HANGOVER_MIX,
            VadSpeechState::Silence => 0.0,
        };

        if speech_mix <= 0.0 {
            return;
        }

        let lsnr_mix = if let Some(lsnr_db) = lsnr_db {
            let t = ((lsnr_db - VOICE_POLISH_LSNR_FLOOR_DB)
                / (VOICE_POLISH_LSNR_CEIL_DB - VOICE_POLISH_LSNR_FLOOR_DB))
                .clamp(0.0, 1.0);
            VOICE_POLISH_LSNR_MIN_MIX + (1.0 - VOICE_POLISH_LSNR_MIN_MIX) * t
        } else {
            1.0
        };
        let polish_mix = speech_mix * lsnr_mix;

        self.ensure_channels(channels);

        let high_shelf_alpha = one_pole_alpha(sample_rate, VOICE_POLISH_HIGH_SHELF_HZ);
        let presence_fast_alpha = one_pole_alpha(sample_rate, VOICE_POLISH_PRESENCE_FAST_HZ);
        let presence_slow_alpha = one_pole_alpha(sample_rate, VOICE_POLISH_PRESENCE_SLOW_HZ);
        let exciter_alpha = one_pole_alpha(sample_rate, VOICE_POLISH_EXCITER_HZ);

        for (sample_index, sample) in samples.iter_mut().enumerate() {
            let channel_index = sample_index % channels;
            let dry = *sample;

            let high_shelf_lp = one_pole_lowpass_step(
                &mut self.high_shelf_lowpass[channel_index],
                dry,
                high_shelf_alpha,
            );
            let high_band = dry - high_shelf_lp;

            let presence_fast = one_pole_lowpass_step(
                &mut self.presence_fast_lowpass[channel_index],
                dry,
                presence_fast_alpha,
            );
            let presence_slow = one_pole_lowpass_step(
                &mut self.presence_slow_lowpass[channel_index],
                dry,
                presence_slow_alpha,
            );
            let presence_band = presence_fast - presence_slow;

            let exciter_lp = one_pole_lowpass_step(
                &mut self.exciter_lowpass[channel_index],
                dry,
                exciter_alpha,
            );
            let exciter_high = dry - exciter_lp;
            let excited = (exciter_high * VOICE_POLISH_EXCITER_DRIVE).tanh();

            *sample = dry
                + high_band * VOICE_POLISH_HIGH_SHELF_MIX * polish_mix
                + presence_band * VOICE_POLISH_PRESENCE_MIX * polish_mix
                + excited * VOICE_POLISH_EXCITER_MIX * polish_mix;
        }
    }

    fn ensure_channels(&mut self, channels: usize) {
        if self.high_shelf_lowpass.len() < channels {
            self.high_shelf_lowpass.resize(channels, 0.0);
            self.presence_fast_lowpass.resize(channels, 0.0);
            self.presence_slow_lowpass.resize(channels, 0.0);
            self.exciter_lowpass.resize(channels, 0.0);
        }
    }
}

#[derive(Clone, Copy, Default)]
pub struct AdaptiveEchoMetrics {
    pub erle_db: Option<f32>,
    pub delay_ms: Option<f32>,
    pub double_talk_confidence: Option<f32>,
}

pub struct AdaptiveEchoCanceller {
    pub coefficients: Vec<f32>,
    pub estimated_echo: Vec<f32>,
    pub last_metrics: AdaptiveEchoMetrics,
}

impl AdaptiveEchoCanceller {
    pub fn new() -> Self {
        Self {
            coefficients: vec![0.0; ECHO_CANCELLER_FILTER_TAPS],
            estimated_echo: Vec::new(),
            last_metrics: AdaptiveEchoMetrics::default(),
        }
    }

    pub fn filter_len(&self) -> usize {
        self.coefficients.len()
    }

    pub fn last_metrics(&self) -> AdaptiveEchoMetrics {
        self.last_metrics
    }

    pub fn process_block(
        &mut self,
        near: &mut [f32],
        reference_window: &[f32],
        reference_delay_ms: Option<f32>,
    ) {
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
        let decorrelation_confidence = (1.0
            - residual_correlation / ECHO_CANCELLER_RESIDUAL_CORRELATION_FLOOR)
            .clamp(0.0, 1.0);
        let double_talk_confidence = near_dominance_confidence * decorrelation_confidence;
        let double_talk = double_talk_confidence >= 0.6;

        let erle_db = if estimated_echo_energy > ECHO_CANCELLER_NLMS_ENERGY_FLOOR
            && residual_energy > ECHO_CANCELLER_NLMS_ENERGY_FLOOR
        {
            Some((10.0 * (estimated_echo_energy / residual_energy).log10()).clamp(-20.0, 45.0))
        } else {
            None
        };
        self.last_metrics = AdaptiveEchoMetrics {
            erle_db,
            delay_ms: reference_delay_ms,
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

pub struct WebRtcEchoCanceller {
    pub processor: VoipAec3,
    pub block_sample_len: usize,
    pub capture_output: Vec<f32>,
}

// SAFETY: same rationale as `DfnStage`. The processor is always held
// behind the sidecar state mutex and accessed serially.
unsafe impl Send for WebRtcEchoCanceller {}

impl WebRtcEchoCanceller {
    pub fn new(sample_rate: usize, channels: usize) -> Result<Self, String> {
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

    pub fn process_block(
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

pub enum EchoCancellerBackend {
    AdaptiveNlms(AdaptiveEchoCanceller),
    WebRtcAec3(WebRtcEchoCanceller),
}

impl EchoCancellerBackend {
    pub fn backend_name(&self) -> &'static str {
        match self {
            Self::AdaptiveNlms(_) => ECHO_CANCELLATION_BACKEND_ADAPTIVE,
            Self::WebRtcAec3(_) => ECHO_CANCELLATION_BACKEND_WEBRTC,
        }
    }
}

pub struct VoiceFilterSession {
    pub session_id: String,
    pub sample_rate: usize,
    pub channels: usize,
    pub processor: VoiceFilterProcessor,
    pub dereverb: Option<TailDereverbProcessor>,
    pub voice_polish: VoicePolishProcessor,
    pub suppression_startup_ramp_ms_remaining: u32,
    pub high_pass_filters: Vec<HighPassFilter>,
    pub auto_gain_control: bool,
    pub trim_level_rms: f32,
    pub trim_gain: f32,
    pub agc_startup_bypass_ms_remaining: u32,
    pub echo_canceller: Option<EchoCancellerBackend>,
    pub echo_reference_interleaved: VecDeque<f32>,
    pub echo_reference_frames: VecDeque<TimedEchoReferenceFrame>,
    pub echo_reference_frame_samples: usize,
    pub limiter_gain: f32,
    pub expander_envelope: f32,
    pub expander_gain: f32,
    pub expander_hangover_samples_remaining: u32,
    pub dfn_output_rms_prev: f32,
    pub transient_input_prev_rms: f32,
    pub noise_rng_state: u32,
    pub dezipper_prev_sample: f32,
    pub vad: VadState,
    pub pre_dfn_vad_tap: ModelVadTapState,
    pub transient_suppressor: TransientSuppressorState,
    pub transient_lookback_frame: Option<Vec<f32>>,
    pub lsnr_smoothed: f32,
}

#[derive(Clone)]
pub struct TimedEchoReferenceFrame {
    pub sequence: u64,
    pub received_at: Instant,
    pub source_timestamp_ms: Option<f64>,
    pub samples: Vec<f32>,
}

pub fn collect_timed_reference_window(
    frames: &VecDeque<TimedEchoReferenceFrame>,
    required_samples: usize,
    capture_time: Instant,
) -> Option<(Vec<f32>, Option<f32>)> {
    if required_samples == 0 {
        return None;
    }

    let end_index = frames
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, frame)| (frame.received_at <= capture_time).then_some(index))?;

    let mut remaining = required_samples;
    let mut chunks: Vec<&[f32]> = Vec::new();

    for index in (0..=end_index).rev() {
        let frame = frames.get(index)?;
        if frame.samples.is_empty() {
            continue;
        }

        let take = remaining.min(frame.samples.len());
        let start = frame.samples.len().saturating_sub(take);
        chunks.push(&frame.samples[start..]);
        remaining = remaining.saturating_sub(take);

        if remaining == 0 {
            break;
        }
    }

    if remaining > 0 {
        return None;
    }

    chunks.reverse();

    let mut window = Vec::with_capacity(required_samples);
    for chunk in chunks {
        window.extend_from_slice(chunk);
    }

    let delay_ms = frames
        .get(end_index)
        .and_then(|frame| capture_time.checked_duration_since(frame.received_at))
        .map(|duration| duration.as_secs_f32() * 1_000.0);

    Some((window, delay_ms))
}

pub fn collect_source_timed_reference_window(
    frames: &VecDeque<TimedEchoReferenceFrame>,
    required_samples: usize,
    capture_timestamp_ms: f64,
) -> Option<(Vec<f32>, Option<f32>)> {
    if required_samples == 0 || !capture_timestamp_ms.is_finite() {
        return None;
    }

    let end_index = frames.iter().enumerate().rev().find_map(|(index, frame)| {
        let source_timestamp_ms = frame.source_timestamp_ms?;
        (source_timestamp_ms <= capture_timestamp_ms).then_some(index)
    })?;

    let mut remaining = required_samples;
    let mut chunks: Vec<&[f32]> = Vec::new();

    for index in (0..=end_index).rev() {
        let frame = frames.get(index)?;
        if frame.samples.is_empty() {
            continue;
        }

        if frame.source_timestamp_ms.is_none() {
            return None;
        }

        let take = remaining.min(frame.samples.len());
        let start = frame.samples.len().saturating_sub(take);
        chunks.push(&frame.samples[start..]);
        remaining = remaining.saturating_sub(take);

        if remaining == 0 {
            break;
        }
    }

    if remaining > 0 {
        return None;
    }

    chunks.reverse();

    let mut window = Vec::with_capacity(required_samples);
    for chunk in chunks {
        window.extend_from_slice(chunk);
    }

    let delay_ms = frames.get(end_index).and_then(|frame| {
        frame
            .source_timestamp_ms
            .map(|source_timestamp_ms| (capture_timestamp_ms - source_timestamp_ms).max(0.0) as f32)
    });

    Some((window, delay_ms))
}

impl VoiceFilterSession {
    pub fn echo_cancellation_backend(&self) -> Option<&'static str> {
        self.echo_canceller
            .as_ref()
            .map(EchoCancellerBackend::backend_name)
    }

    pub fn dereverb_mode(&self) -> VoiceDereverbMode {
        if self.dereverb.is_some() {
            VoiceDereverbMode::Tail
        } else {
            VoiceDereverbMode::Off
        }
    }

    pub fn push_echo_reference_samples(
        &mut self,
        input_samples: &[f32],
        input_channels: usize,
        sequence: u64,
        received_at: Instant,
        source_timestamp_ms: Option<f64>,
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

        if let Some(previous_sequence) = self
            .echo_reference_frames
            .back()
            .map(|frame| frame.sequence)
        {
            if sequence <= previous_sequence {
                self.echo_reference_interleaved.clear();
                self.echo_reference_frames.clear();
                self.echo_reference_frame_samples = 0;
            }
        }

        let mut normalized_samples = Vec::with_capacity(incoming_samples);
        for frame_index in 0..input_frame_count {
            match (input_channels, self.channels) {
                (1, 1) | (2, 2) => {
                    for channel_index in 0..self.channels {
                        let sample = input_samples[frame_index * input_channels + channel_index];
                        normalized_samples.push(sample);
                    }
                }
                (1, 2) => {
                    let sample = input_samples[frame_index];
                    normalized_samples.push(sample);
                    normalized_samples.push(sample);
                }
                (2, 1) => {
                    let left = input_samples[frame_index * 2];
                    let right = input_samples[frame_index * 2 + 1];
                    normalized_samples.push((left + right) * 0.5);
                }
                _ => {
                    return Err("Unsupported reference channel conversion".to_string());
                }
            }
        }

        for &sample in &normalized_samples {
            self.echo_reference_interleaved.push_back(sample);
        }

        self.echo_reference_frame_samples = self
            .echo_reference_frame_samples
            .saturating_add(normalized_samples.len());
        self.echo_reference_frames
            .push_back(TimedEchoReferenceFrame {
                sequence,
                received_at,
                source_timestamp_ms: source_timestamp_ms.filter(|value| value.is_finite()),
                samples: normalized_samples,
            });

        while self.echo_reference_interleaved.len() > max_reference_samples {
            let _ = self.echo_reference_interleaved.pop_front();
        }

        while self.echo_reference_frame_samples > max_reference_samples {
            let Some(frame) = self.echo_reference_frames.pop_front() else {
                break;
            };
            self.echo_reference_frame_samples = self
                .echo_reference_frame_samples
                .saturating_sub(frame.samples.len());
        }

        Ok(())
    }

    pub fn get_echo_reference_window(
        &self,
        sample_len: usize,
        history_len: usize,
        capture_time: Instant,
        capture_source_timestamp_ms: Option<f64>,
    ) -> Option<(Vec<f32>, Option<f32>)> {
        if sample_len == 0 {
            return None;
        }

        if let Some(capture_source_timestamp_ms) = capture_source_timestamp_ms {
            if let Some(reference_window) = collect_source_timed_reference_window(
                &self.echo_reference_frames,
                history_len + sample_len,
                capture_source_timestamp_ms,
            ) {
                return Some(reference_window);
            }
        }

        collect_timed_reference_window(
            &self.echo_reference_frames,
            history_len + sample_len,
            capture_time,
        )
    }

    pub fn pop_echo_reference_block_or_silence(&mut self, sample_len: usize) -> Vec<f32> {
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

pub struct HighPassFilter {
    pub s1: f32,
    pub s2: f32,
}

impl HighPassFilter {
    pub fn new() -> Self {
        Self { s1: 0.0, s2: 0.0 }
    }

    pub fn process(&mut self, x: f32) -> f32 {
        let y = HP_B0 * x + self.s1;
        self.s1 = HP_B1 * x - HP_A1 * y + self.s2;
        self.s2 = HP_B2 * x - HP_A2 * y;
        y
    }
}

pub struct VoiceFilterDiagnostics {
    // Per-buffer LSNR stats from DeepFilterNet (None when running in passthrough mode).
    // Low values indicate the model sees mostly noise — the primary signal for over-suppression.
    pub lsnr_mean: Option<f32>,
    pub lsnr_min: Option<f32>,
    pub lsnr_max: Option<f32>,
    // Adaptive AEC metrics (None when AEC is disabled or has no valid reference).
    pub aec_erle_db: Option<f32>,
    pub aec_delay_ms: Option<f32>,
    pub aec_double_talk_confidence: Option<f32>,
    // AGC gain applied to this buffer (None when AGC is disabled).
    pub agc_gain: Option<f32>,
    // Dry/wet mix at the end of the startup ramp (0.0 = fully dry, 1.0 = fully wet/processed).
    // 1.0 once the ramp has completed.
    pub ramp_wet_mix: f32,
    // Average effective DFN wet mix after collapse-guard dry recovery for this frame.
    pub effective_wet_mix: Option<f32>,
    // Number of DFN hops in this frame where collapse-guard dry recovery engaged.
    pub dry_recovery_hops: u32,
    // Current smoothed VAD speech probability.
    pub vad_p_smooth: Option<f32>,
    // Effective expander bypass for this frame (0.0 = fully active, 1.0 = fully bypassed).
    pub expander_bypass: Option<f32>,
    // Expander gain at the end of this frame.
    pub expander_gain: Option<f32>,
    // Whether the transient suppressor fired for this frame.
    pub transient_triggered: bool,
    // Whether the transient suppressor fired while the VAD was in Speech.
    pub transient_triggered_in_speech: bool,
    // Whether the pause-time non-speech high-band gate fired for this frame.
    pub pause_non_speech_gate_triggered: bool,
    // Whether the pause-time low-band hard clamp fired for this frame.
    pub pause_low_burst_gate_triggered: bool,
    // Raw transient-detector features for offline tuning.
    pub transient_score: f32,
    pub transient_crest: f32,
    pub transient_hp_crest: f32,
    pub transient_diff_ratio: f32,
    pub transient_hp_ratio: f32,
    pub transient_vad_state: VadSpeechState,
}

pub struct VadState {
    /// Model-based VAD detector running on a 16 kHz sliding window.
    pub detector: Detector,
    /// Pending 16 kHz mono samples waiting to be fed into the model.
    pub model_frame: VecDeque<f32>,
    /// Scratch buffer to hand a contiguous 256-sample frame to the model.
    pub model_frame_scratch: [f32; VAD_MODEL_FRAME_SAMPLES],
    /// Last score produced by the model; reused until another 256-sample chunk is ready.
    pub model_last_score: f32,
    /// Phase accumulator for crude streaming resampling into 16 kHz.
    pub model_resample_phase: usize,
    /// Running bucket sum for the next 16 kHz sample.
    pub model_resample_bucket_sum: f32,
    /// Number of source samples accumulated into the current resample bucket.
    pub model_resample_bucket_count: usize,
    /// EWMA-smoothed speech probability ∈ [0, 1].
    pub p_smooth: f32,
    pub speech_state: VadSpeechState,
    /// Consecutive frames with p_smooth ≥ VAD_SPEECH_THRESHOLD (onset confirmation).
    pub onset_counter: u32,
    /// Consecutive frames with p_smooth < VAD_SILENCE_THRESHOLD (offset confirmation).
    pub offset_counter: u32,
    /// Remaining frames in Hangover state.
    pub hangover_frames_remaining: u32,
    /// Remaining frames of expander bypass at the start of a new Speech segment.
    pub onset_protection_frames_remaining: u32,
    /// Remaining frames of the per-utterance DFN wet-mix ramp (0 = inactive / ramp complete).
    pub onset_wet_ramp_frames_remaining: u32,
    /// Remaining startup frames reserved for fast ambient noise-floor calibration.
    pub startup_noise_calibration_frames_remaining: u32,
    /// Adaptive noise floor RMS; updated only during Silence.
    pub noise_floor_rms: f32,
    /// RMS of the previous frame; used by the impulse guard to detect sudden energy jumps.
    pub prev_frame_rms: f32,
    /// Frames spent in continuous Silence state; drives the slow-fade silence gate.
    pub silence_gate_frames: u32,
}

pub struct ModelVadTapState {
    /// Model-based VAD detector running on a 16 kHz sliding window.
    pub detector: Detector,
    /// Pending 16 kHz mono samples waiting to be fed into the model.
    pub model_frame: VecDeque<f32>,
    /// Scratch buffer to hand a contiguous 256-sample frame to the model.
    pub model_frame_scratch: [f32; VAD_MODEL_FRAME_SAMPLES],
    /// Last score produced by the model; reused until another 256-sample chunk is ready.
    pub model_last_score: f32,
    /// Phase accumulator for crude streaming resampling into 16 kHz.
    pub model_resample_phase: usize,
    /// Running bucket sum for the next 16 kHz sample.
    pub model_resample_bucket_sum: f32,
    /// Number of source samples accumulated into the current resample bucket.
    pub model_resample_bucket_count: usize,
}

impl Default for ModelVadTapState {
    fn default() -> Self {
        Self {
            detector: Detector::default(),
            model_frame: VecDeque::with_capacity(VAD_MODEL_FRAME_SAMPLES * 2),
            model_frame_scratch: [0.0; VAD_MODEL_FRAME_SAMPLES],
            model_last_score: 0.0,
            model_resample_phase: 0,
            model_resample_bucket_sum: 0.0,
            model_resample_bucket_count: 0,
        }
    }
}

impl Default for VadState {
    fn default() -> Self {
        Self {
            detector: Detector::default(),
            model_frame: VecDeque::with_capacity(VAD_MODEL_FRAME_SAMPLES * 2),
            model_frame_scratch: [0.0; VAD_MODEL_FRAME_SAMPLES],
            model_last_score: 0.0,
            model_resample_phase: 0,
            model_resample_bucket_sum: 0.0,
            model_resample_bucket_count: 0,
            p_smooth: 0.0,
            speech_state: VadSpeechState::Silence,
            onset_counter: 0,
            offset_counter: 0,
            hangover_frames_remaining: 0,
            onset_protection_frames_remaining: 0,
            onset_wet_ramp_frames_remaining: 0,
            startup_noise_calibration_frames_remaining: VAD_STARTUP_NOISE_CALIBRATION_FRAMES,
            noise_floor_rms: 1e-4, // small non-zero initial noise floor
            prev_frame_rms: 0.0,
            silence_gate_frames: 0,
        }
    }
}

fn push_vad_model_sample(vad: &mut VadState, sample: f32) {
    vad.model_frame.push_back(sample.clamp(-1.0, 1.0));
}

fn push_model_vad_tap_sample(vad: &mut ModelVadTapState, sample: f32) {
    vad.model_frame.push_back(sample.clamp(-1.0, 1.0));
}

fn predict_model_vad(vad: &mut VadState, samples: &[f32], sample_rate: usize) -> Option<f32> {
    if samples.is_empty() || sample_rate < VAD_MODEL_SAMPLE_RATE {
        return None;
    }

    let mut emitted = false;

    for &sample in samples {
        vad.model_resample_bucket_sum += sample;
        vad.model_resample_bucket_count += 1;
        vad.model_resample_phase += VAD_MODEL_SAMPLE_RATE;

        if vad.model_resample_phase >= sample_rate {
            let bucket_count = vad.model_resample_bucket_count.max(1) as f32;
            let averaged = vad.model_resample_bucket_sum / bucket_count;
            vad.model_resample_phase -= sample_rate;
            vad.model_resample_bucket_sum = 0.0;
            vad.model_resample_bucket_count = 0;
            push_vad_model_sample(vad, averaged);
            emitted = true;
        }
    }

    while vad.model_frame.len() >= VAD_MODEL_FRAME_SAMPLES {
        for slot in vad.model_frame_scratch.iter_mut() {
            *slot = vad
                .model_frame
                .pop_front()
                .expect("model frame length already checked");
        }
        vad.model_last_score = vad.detector.predict_f32(&vad.model_frame_scratch);
        emitted = true;
    }

    if emitted || !vad.model_frame.is_empty() {
        Some(vad.model_last_score)
    } else {
        None
    }
}

fn predict_model_vad_tap(
    vad: &mut ModelVadTapState,
    samples: &[f32],
    sample_rate: usize,
) -> Option<f32> {
    if samples.is_empty() || sample_rate < VAD_MODEL_SAMPLE_RATE {
        return None;
    }

    let mut emitted = false;

    for &sample in samples {
        vad.model_resample_bucket_sum += sample;
        vad.model_resample_bucket_count += 1;
        vad.model_resample_phase += VAD_MODEL_SAMPLE_RATE;

        if vad.model_resample_phase >= sample_rate {
            let bucket_count = vad.model_resample_bucket_count.max(1) as f32;
            let averaged = vad.model_resample_bucket_sum / bucket_count;
            vad.model_resample_phase -= sample_rate;
            vad.model_resample_bucket_sum = 0.0;
            vad.model_resample_bucket_count = 0;
            push_model_vad_tap_sample(vad, averaged);
            emitted = true;
        }
    }

    while vad.model_frame.len() >= VAD_MODEL_FRAME_SAMPLES {
        for slot in vad.model_frame_scratch.iter_mut() {
            *slot = vad
                .model_frame
                .pop_front()
                .expect("model frame length already checked");
        }
        vad.model_last_score = vad.detector.predict_f32(&vad.model_frame_scratch);
        emitted = true;
    }

    if emitted || !vad.model_frame.is_empty() {
        Some(vad.model_last_score)
    } else {
        None
    }
}

pub struct VadOutput {
    pub speech_state: VadSpeechState,
    /// Unsmoothed speech probability for this frame (instant onset response).
    pub p_raw: f32,
}

#[derive(Clone, Copy)]
pub struct TransientTriggerReport {
    pub triggered: bool,
    pub triggered_in_speech: bool,
    pub burst_triggered: bool,
    pub pause_non_speech_gate_triggered: bool,
    pub pause_low_burst_gate_triggered: bool,
    pub vad_state: VadSpeechState,
    pub score: f32,
    pub crest: f32,
    pub hp_crest: f32,
    pub diff_ratio: f32,
    pub hp_ratio: f32,
}

impl Default for TransientTriggerReport {
    fn default() -> Self {
        Self {
            triggered: false,
            triggered_in_speech: false,
            burst_triggered: false,
            pause_non_speech_gate_triggered: false,
            pause_low_burst_gate_triggered: false,
            vad_state: VadSpeechState::Silence,
            score: 0.0,
            crest: 0.0,
            hp_crest: 0.0,
            diff_ratio: 0.0,
            hp_ratio: 0.0,
        }
    }
}

pub struct TransientSuppressorState {
    /// Current low-band gain ∈ [floor, 1.0].
    pub gain_low: f32,
    /// Current high-band gain ∈ [floor, 1.0].
    pub gain_high: f32,
    /// Remaining samples to hold at peak attenuation.
    pub hold_samples_remaining: u32,
    /// Remaining samples before a new trigger is allowed (debounce).
    pub debounce_samples_remaining: u32,
    /// RMS of the previous frame; used by the Hangover energy-jump guard.
    pub prev_rms: f32,
    /// One-pole LP filter state for the band split.
    pub lp_state: f32,
    /// Additional high-band-only pause-time non-speech gate gain.
    pub pause_non_speech_gain_high: f32,
    /// Remaining samples to hold the pause-time non-speech gate.
    pub pause_non_speech_hold_samples_remaining: u32,
    /// Additional low-band-only pause-time hard clamp gain.
    pub pause_low_burst_gain_low: f32,
    /// Remaining samples to hold the pause-time low-band hard clamp.
    pub pause_low_burst_hold_samples_remaining: u32,
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
            pause_non_speech_gain_high: 1.0,
            pause_non_speech_hold_samples_remaining: 0,
            pause_low_burst_gain_low: 1.0,
            pause_low_burst_hold_samples_remaining: 0,
        }
    }
}

// ── AudioFrame (from pipeline.rs) ────────────────────────────────────────────

pub struct AudioFrame {
    pub samples: Vec<f32>,
    pub sample_rate: usize,
    pub channels: usize,
    pub timestamp_ms: Option<f64>,
    pub sequence: u64,
    pub protocol_version: Option<u32>,
}

impl AudioFrame {
    pub fn new(
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

    pub fn frame_count(&self) -> usize {
        self.samples.len() / self.channels
    }
}

// ── DSP free functions ────────────────────────────────────────────────────────

pub fn voice_filter_config(
    strength: VoiceFilterStrength,
    experimental_aggressive_mode: bool,
) -> VoiceFilterConfig {
    let mut config = match strength {
        VoiceFilterStrength::Low => VoiceFilterConfig {
            post_filter_beta: 0.02,
            atten_lim_db: 40.0,
            min_db_thresh: -10.0,
            max_db_erb_thresh: 35.0,
            max_db_df_thresh: 20.0,
        },
        VoiceFilterStrength::Balanced => VoiceFilterConfig {
            post_filter_beta: 0.03,
            atten_lim_db: 50.0,
            min_db_thresh: -12.0,
            max_db_erb_thresh: 33.0,
            max_db_df_thresh: 18.0,
        },
        VoiceFilterStrength::High => VoiceFilterConfig {
            post_filter_beta: 0.04,
            atten_lim_db: 60.0,
            min_db_thresh: -15.0,
            max_db_erb_thresh: 30.0,
            max_db_df_thresh: 15.0,
        },
        VoiceFilterStrength::Aggressive => VoiceFilterConfig {
            post_filter_beta: 0.05,
            atten_lim_db: 80.0,
            min_db_thresh: -18.0,
            max_db_erb_thresh: 28.0,
            max_db_df_thresh: 12.0,
        },
    };

    if experimental_aggressive_mode {
        config.post_filter_beta = (config.post_filter_beta + 0.01).min(0.05);
        config.min_db_thresh -= 2.0;
        config.max_db_erb_thresh = (config.max_db_erb_thresh - 3.0).max(18.0);
        config.max_db_df_thresh = (config.max_db_df_thresh - 2.0).max(8.0);
    }

    config
}

pub fn sanitize_dfn_sample(sample: f32) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }

    let sample = if sample.abs() < DFN_SAMPLE_SANITIZE_FLOOR {
        0.0
    } else {
        sample
    };

    sample.clamp(-1.0, 1.0)
}

pub fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum_sq: f32 = samples.iter().map(|sample| sample * sample).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

pub fn dbfs_to_linear(dbfs: f32) -> f32 {
    10.0f32.powf(dbfs / 20.0)
}

pub fn clamp_dfn_tuning(tuning: VoiceFilterDfnTuningParams) -> VoiceFilterDfnTuningParams {
    VoiceFilterDfnTuningParams {
        attenuation_limit_db: tuning
            .attenuation_limit_db
            .map(|value| value.clamp(0.0, 60.0)),
        mix: tuning.mix.map(|value| value.clamp(0.0, 1.0)),
        experimental_aggressive_mode: Some(tuning.experimental_aggressive_mode.unwrap_or(false)),
        noise_gate_floor_dbfs: tuning
            .noise_gate_floor_dbfs
            .map(|value| value.clamp(-80.0, -36.0)),
    }
}

impl DfnStage {
    pub fn new(
        channels: usize,
        suppression_level: VoiceFilterStrength,
        tuning: VoiceFilterDfnTuningParams,
    ) -> Result<Self, String> {
        let tuning = clamp_dfn_tuning(tuning);
        let mut config = voice_filter_config(
            suppression_level,
            tuning.experimental_aggressive_mode.unwrap_or(false),
        );
        if let Some(attenuation_limit_db) = tuning.attenuation_limit_db {
            config.atten_lim_db = attenuation_limit_db;
        }

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
        let latency_samples = model.fft_size.saturating_sub(model.hop_size)
            + model.lookahead.saturating_mul(model.hop_size);

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

        let mut dry_delay_buffer = VecDeque::with_capacity(latency_samples + hop_size);
        dry_delay_buffer.extend(std::iter::repeat(0.0).take(latency_samples));

        Ok(Self {
            model,
            hop_size,
            _latency_samples: latency_samples,
            dry_delay_buffer,
            gain_compensation: 1.0,
            config: DfnStageConfig {
                mix: tuning.mix.unwrap_or(DFN_DEFAULT_WET_MIX),
                noise_gate_floor: tuning.noise_gate_floor_dbfs.map(dbfs_to_linear),
            },
        })
    }

    pub fn frames_per_buffer(&self) -> usize {
        self.hop_size
    }

    pub fn delayed_dry_block(&mut self, input: &[f32]) -> Vec<f32> {
        let mut delayed = Vec::with_capacity(input.len());

        for sample in input {
            self.dry_delay_buffer.push_back(*sample);
            delayed.push(self.dry_delay_buffer.pop_front().unwrap_or(0.0));
        }

        delayed
    }

    pub fn apply_noise_gate(&self, samples: &mut [f32]) {
        let Some(floor) = self.config.noise_gate_floor else {
            return;
        };

        let knee = floor * DFN_NOISE_GATE_KNEE_MULTIPLIER;
        for sample in samples.iter_mut() {
            let abs_val = sample.abs();
            if abs_val <= floor {
                *sample *= DFN_NOISE_GATE_ATTENUATION;
                continue;
            }

            if abs_val >= knee {
                continue;
            }

            let t = ((abs_val - floor) / (knee - floor)).clamp(0.0, 1.0);
            let gain = DFN_NOISE_GATE_ATTENUATION + (1.0 - DFN_NOISE_GATE_ATTENUATION) * t;
            *sample *= gain;
        }
    }

    pub fn process(
        &mut self,
        samples: &mut [f32],
        ramp_wet_mix: f32,
    ) -> Result<DfnStageStats, String> {
        if samples.is_empty() {
            return Ok(DfnStageStats::default());
        }

        if samples.len() % self.hop_size != 0 {
            return Err(format!(
                "DeepFilterNet requires {}-sample mono frames; got {} samples",
                self.hop_size,
                samples.len()
            ));
        }

        let mut stats = DfnStageStats::default();

        for hop in samples.chunks_exact_mut(self.hop_size) {
            let dry_input = hop
                .iter()
                .copied()
                .map(sanitize_dfn_sample)
                .collect::<Vec<_>>();
            let delayed_dry = self.delayed_dry_block(&dry_input);
            let noisy = Array2::from_shape_vec((1, self.hop_size), dry_input)
                .map_err(|error| format!("Failed to prepare DeepFilterNet input: {error}"))?;
            let mut enhanced = Array2::<f32>::zeros((1, self.hop_size));
            let lsnr = self
                .model
                .process(noisy.view(), enhanced.view_mut())
                .map_err(|error| format!("DeepFilterNet processing failed: {error}"))?;
            stats.record_lsnr(lsnr);

            let wet_block = (0..self.hop_size)
                .map(|index| sanitize_dfn_sample(enhanced[(0, index)]))
                .collect::<Vec<_>>();

            let dry_rms = rms_level(&delayed_dry);
            let wet_rms = rms_level(&wet_block);
            let mut wet_mix = (ramp_wet_mix * self.config.mix).clamp(0.0, 1.0);
            if dry_rms > 1e-4 && wet_rms < dry_rms * DFN_ENERGY_COLLAPSE_RATIO {
                let collapse_ratio = (wet_rms / dry_rms).clamp(0.0, DFN_ENERGY_COLLAPSE_RATIO);
                let recovery = 1.0 - collapse_ratio / DFN_ENERGY_COLLAPSE_RATIO;
                wet_mix *= 1.0 - DFN_ENERGY_COLLAPSE_MAX_DRY_BOOST * recovery;
                stats.dry_recovery_hops += 1;
            }
            stats.effective_wet_mix_sum += wet_mix;
            let dry_mix = 1.0 - wet_mix;

            for (sample, (dry_sample, wet_sample)) in
                hop.iter_mut().zip(delayed_dry.iter().zip(wet_block.iter()))
            {
                *sample = sanitize_dfn_sample(*dry_sample * dry_mix + *wet_sample * wet_mix);
            }

            self.apply_noise_gate(hop);

            // Keep makeup gain intentionally small. Matching the original hop RMS
            // makes suppression sound ineffective because it lifts the residual
            // bed back toward the noisy level. This only restores a little body.
            let target_gain =
                (1.0 + wet_mix * (DFN_GAIN_COMP_MAX - 1.0)).clamp(1.0, DFN_GAIN_COMP_MAX);

            let smoothing = if target_gain < self.gain_compensation {
                DFN_GAIN_COMP_RELEASE
            } else {
                DFN_GAIN_COMP_ATTACK
            };
            self.gain_compensation =
                self.gain_compensation * smoothing + target_gain * (1.0 - smoothing);

            for sample in hop.iter_mut() {
                *sample = sanitize_dfn_sample(*sample * self.gain_compensation);
            }
        }

        Ok(stats)
    }
}

pub fn create_voice_filter_session(
    session_id: String,
    sample_rate: usize,
    channels: usize,
    suppression_level: VoiceFilterStrength,
    dfn_tuning: VoiceFilterDfnTuningParams,
    noise_suppression: bool,
    auto_gain_control: bool,
    echo_cancellation: bool,
    dereverb_mode: VoiceDereverbMode,
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
        VoiceFilterProcessor::DeepFilter(DfnStage::new(
            mono_channels,
            suppression_level,
            dfn_tuning,
        )?)
    } else {
        VoiceFilterProcessor::Passthrough
    };

    let echo_canceller = if echo_cancellation {
        Some(create_echo_canceller_backend(sample_rate, mono_channels))
    } else {
        None
    };

    let dereverb = match dereverb_mode {
        VoiceDereverbMode::Off => None,
        VoiceDereverbMode::Tail => Some(TailDereverbProcessor::new()),
    };

    Ok(VoiceFilterSession {
        session_id,
        sample_rate,
        channels: mono_channels,
        processor,
        dereverb,
        voice_polish: VoicePolishProcessor::new(mono_channels),
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
        echo_reference_frames: VecDeque::new(),
        echo_reference_frame_samples: 0,
        limiter_gain: 1.0,
        expander_envelope: 0.0,
        expander_gain: 1.0,
        expander_hangover_samples_remaining: 0,
        dfn_output_rms_prev: 0.0,
        transient_input_prev_rms: 0.0,
        noise_rng_state: 0x9e37_79b9, // arbitrary non-zero seed for xorshift32
        dezipper_prev_sample: 0.0,
        vad: VadState::default(),
        pre_dfn_vad_tap: ModelVadTapState::default(),
        transient_suppressor: TransientSuppressorState::default(),
        transient_lookback_frame: None,
        lsnr_smoothed: 0.0,
    })
}

pub fn create_echo_canceller_backend(sample_rate: usize, channels: usize) -> EchoCancellerBackend {
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

pub fn suppression_startup_wet_mix(elapsed_ms: f32) -> f32 {
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
pub fn apply_slow_trim(
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
pub fn inject_comfort_noise(samples: &mut [f32], rng_state: &mut u32, mix: f32) {
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

pub fn apply_adaptive_echo_cancellation(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
    capture_time: Instant,
    capture_source_timestamp_ms: Option<f64>,
) -> AdaptiveEchoMetrics {
    if samples.is_empty() {
        return AdaptiveEchoMetrics::default();
    }

    let filter_history_len = ECHO_CANCELLER_FILTER_TAPS.saturating_sub(1);
    let Some((reference_samples, reference_delay_ms)) = session.get_echo_reference_window(
        samples.len(),
        filter_history_len,
        capture_time,
        capture_source_timestamp_ms,
    ) else {
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
                    reference_delay_ms,
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

pub fn apply_webrtc_echo_cancellation(
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
                match canceller
                    .process_block(&mut samples[sample_offset..sample_end], &reference_block)
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

pub fn apply_output_dezipper(samples: &mut [f32], prev_sample: &mut f32) {
    for s in samples.iter_mut() {
        *prev_sample = *prev_sample * DEZIPPER_COEFF + *s * (1.0 - DEZIPPER_COEFF);
        *s = *prev_sample;
    }
}

pub fn one_pole_alpha(sample_rate: usize, cutoff_hz: f32) -> f32 {
    if sample_rate == 0 || !cutoff_hz.is_finite() || cutoff_hz <= 0.0 {
        return 1.0;
    }

    let nyquist_safe_cutoff = cutoff_hz.min(sample_rate as f32 * 0.45);
    let omega = 2.0 * PI * nyquist_safe_cutoff / sample_rate as f32;
    (1.0 - (-omega).exp()).clamp(0.0, 1.0)
}

pub fn one_pole_lowpass_step(state: &mut f32, input: f32, alpha: f32) -> f32 {
    *state += (input - *state) * alpha.clamp(0.0, 1.0);
    *state
}

// repair_spikes: single-sample interpolation for isolated amplitude spikes.
// Kills mouse clicks, digital pops, and cable ticks that appear as one outlier sample
// flanked by much-quieter neighbours.  Stateless — safe to call every frame.
pub fn repair_spikes(samples: &mut [f32]) {
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

fn transient_floor_gains(vad_state: VadSpeechState) -> (f32, f32) {
    match vad_state {
        VadSpeechState::Silence => (
            10.0f32.powf(TRANS_GAIN_LOW_DB / 20.0),
            10.0f32.powf(TRANS_GAIN_HIGH_DB / 20.0),
        ),
        VadSpeechState::Hangover => (
            10.0f32.powf(TRANS_GAIN_HO_LOW_DB / 20.0),
            10.0f32.powf(TRANS_GAIN_HO_HIGH_DB / 20.0),
        ),
        VadSpeechState::Speech => (
            10.0f32.powf(TRANS_GAIN_SP_LOW_DB / 20.0),
            10.0f32.powf(TRANS_GAIN_SP_HIGH_DB / 20.0),
        ),
    }
}

fn transient_lookback_gain(vad_state: VadSpeechState) -> f32 {
    let (floor_low, floor_high) = transient_floor_gains(vad_state);
    floor_low.min(floor_high)
}

fn transient_control_state(vad_state: VadSpeechState, p_smooth: f32) -> VadSpeechState {
    match vad_state {
        VadSpeechState::Speech if p_smooth < TRANSIENT_CONTROL_SPEECH_FLOOR => {
            VadSpeechState::Hangover
        }
        VadSpeechState::Hangover if p_smooth < TRANSIENT_CONTROL_SILENCE_CEIL => {
            VadSpeechState::Silence
        }
        _ => vad_state,
    }
}

fn transient_hold_samples(vad_state: VadSpeechState, sample_rate: f32) -> u32 {
    let hold_ms = if vad_state == VadSpeechState::Speech {
        TRANS_HOLD_MS
    } else {
        TRANS_NON_SPEECH_HOLD_MS
    };

    ((sample_rate * hold_ms as f32) / 1000.0) as u32
}

fn clamp_transient_residual(samples: &mut [f32], peak_limit: f32) {
    if peak_limit <= 0.0 || samples.is_empty() {
        return;
    }

    let post_peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if post_peak > peak_limit {
        let scale = peak_limit / post_peak;
        for sample in samples.iter_mut() {
            *sample *= scale;
        }
    }
}

fn apply_triggered_transient_residual_clamp(
    samples: &mut [f32],
    vad_state: VadSpeechState,
    burst_triggered: bool,
) {
    if vad_state != VadSpeechState::Speech {
        clamp_transient_residual(samples, TRANS_NON_SPEECH_RESIDUAL_PEAK);
    } else if burst_triggered {
        clamp_transient_residual(samples, TRANS_SPEECH_BURST_RESIDUAL_PEAK);
    }
}

// apply_transient_suppressor: crest-factor impulse detector with instant-snap attack.
// Silence/Hangover use the classic impulse rule; Speech uses a stricter keyboard-click
// rule so typing can be attenuated without flattening consonants.
// A clap/thud has crest factor ≥10 post-DFN; steady noise/voice sits at 3–6.
//
// Attack design: crest factor is computed over the whole frame before any sample is
// written, so we have implicit per-frame lookahead.  On trigger we snap gain to the
// attenuation floor immediately — no IIR attack lag — which is the correct behaviour:
// a per-sample IIR attack lets the impulse pass at near-unity gain for the first 1–2 ms
// and then suppresses the empty silence that follows, which is the opposite of what we
// want and makes clicks feel louder by contrast.
pub fn apply_transient_suppressor(
    state: &mut TransientSuppressorState,
    samples: &mut [f32],
    sample_rate: usize,
    vad_state: VadSpeechState,
    noise_floor_rms: f32,
    input_peak: f32,
    input_rms: f32,
    input_prev_rms: f32,
) -> TransientTriggerReport {
    if samples.is_empty() || sample_rate == 0 {
        return TransientTriggerReport::default();
    }

    let sr = sample_rate as f32;
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    let crest = peak / (rms + 1e-6);
    let lp_coeff = (-2.0 * std::f32::consts::PI * TRANS_CROSSOVER_HZ / sr).exp();
    let mut lp_preview = state.lp_state;
    let mut hp_peak = 0.0f32;
    let mut hp_sum_sq = 0.0f32;
    for sample in samples.iter() {
        lp_preview = lp_coeff * lp_preview + (1.0 - lp_coeff) * *sample;
        let hp = *sample - lp_preview;
        hp_peak = hp_peak.max(hp.abs());
        hp_sum_sq += hp * hp;
    }
    let hp_rms = (hp_sum_sq / samples.len() as f32).sqrt();
    let hp_crest = hp_peak / (hp_rms + 1e-6);
    let diff_sum_sq: f32 = samples
        .windows(2)
        .map(|window| {
            let delta = window[1] - window[0];
            delta * delta
        })
        .sum();
    let diff_rms = if samples.len() > 1 {
        (diff_sum_sq / (samples.len() - 1) as f32).sqrt()
    } else {
        0.0
    };
    let diff_ratio = diff_rms / (rms + 1e-6);
    let hp_ratio = hp_rms / (rms + 1e-6);
    let non_speech_key_trigger = hp_crest > TRANS_NON_SPEECH_HP_CREST_THRESHOLD
        && diff_ratio > TRANS_NON_SPEECH_DIFF_RATIO_THRESHOLD
        && hp_ratio > TRANS_NON_SPEECH_HP_RATIO_THRESHOLD
        && rms > noise_floor_rms * TRANS_NON_SPEECH_NOISE_FLOOR_RATIO
        && (state.prev_rms <= 0.0 || rms > state.prev_rms * TRANS_NON_SPEECH_RMS_JUMP_RATIO);
    let pause_noise_has_jump =
        state.prev_rms <= 0.0 || rms > state.prev_rms * PAUSE_NOISE_GATE_RMS_JUMP_RATIO;
    let pause_high_band_trigger = hp_crest > PAUSE_NOISE_GATE_HP_CREST_THRESHOLD
        && diff_ratio > PAUSE_NOISE_GATE_DIFF_RATIO_THRESHOLD
        && hp_ratio > PAUSE_NOISE_GATE_HP_RATIO_THRESHOLD;
    let pause_burst_trigger = crest > PAUSE_NOISE_GATE_CREST_THRESHOLD && pause_noise_has_jump;
    let pause_non_speech_gate_trigger = vad_state != VadSpeechState::Speech
        && rms > noise_floor_rms * PAUSE_NOISE_GATE_NOISE_FLOOR_RATIO
        && pause_noise_has_jump
        && (pause_high_band_trigger || pause_burst_trigger);
    let pause_low_burst_has_jump =
        state.prev_rms <= 0.0 || rms > state.prev_rms * PAUSE_LOW_BURST_RMS_JUMP_RATIO;
    let pause_low_burst_gate_trigger = vad_state != VadSpeechState::Speech
        && rms > noise_floor_rms * PAUSE_NOISE_GATE_NOISE_FLOOR_RATIO
        && pause_low_burst_has_jump
        && crest > PAUSE_LOW_BURST_CREST_THRESHOLD
        && hp_ratio < PAUSE_LOW_BURST_HP_RATIO_CEIL
        && diff_ratio < PAUSE_LOW_BURST_DIFF_RATIO_CEIL;
    let mut burst_triggered = false;
    let score = match vad_state {
        VadSpeechState::Speech => {
            (crest / TRANS_SPEECH_CREST_THRESHOLD).max(hp_crest / TRANS_SPEECH_HP_CREST_THRESHOLD)
                + diff_ratio / TRANS_SPEECH_DIFF_RATIO_THRESHOLD
                + hp_ratio / TRANS_SPEECH_HP_RATIO_THRESHOLD
        }
        VadSpeechState::Hangover => {
            let energy_jump = if state.prev_rms > 0.0 {
                rms / (state.prev_rms * TRANS_ENERGY_JUMP_RATIO)
            } else {
                0.0
            };
            crest / TRANS_CREST_THRESHOLD + energy_jump
        }
        VadSpeechState::Silence => {
            let energy_jump = if state.prev_rms > 0.0 {
                rms / (state.prev_rms * 2.0)
            } else {
                0.0
            };
            let noise_gate = if noise_floor_rms > 0.0 {
                rms / (noise_floor_rms * 2.0)
            } else {
                0.0
            };
            (crest / TRANS_CREST_THRESHOLD).max(energy_jump.min(noise_gate))
        }
    };

    let release_coeff = (-1.0f32 / (sr * TRANS_RELEASE_MS / 1000.0)).exp();
    let pause_non_speech_release_coeff =
        (-1.0f32 / (sr * PAUSE_NOISE_GATE_RELEASE_MS / 1000.0)).exp();
    let pause_low_burst_release_coeff =
        (-1.0f32 / (sr * PAUSE_LOW_BURST_RELEASE_MS / 1000.0)).exp();
    let hold_samples = transient_hold_samples(vad_state, sr);
    let pause_non_speech_hold_samples =
        ((sr * PAUSE_NOISE_GATE_HOLD_MS as f32) / 1000.0) as u32;
    let pause_low_burst_hold_samples =
        ((sr * PAUSE_LOW_BURST_HOLD_MS as f32) / 1000.0) as u32;
    let debounce_samples = ((sr * TRANS_DEBOUNCE_MS as f32) / 1000.0) as u32;

    // Trigger rules (debounce prevents cumulative thinning):
    //   Silence  — crest > threshold for big impulses, or a keyboard-shaped high-band
    //              transient. This avoids treating ordinary word onsets after a pause as
    //              noise just because they rise quickly in RMS.
    //   Hangover — same, but still keep the stronger impulse-jump rule for claps/thuds.
    //   Speech   — only very sharp, high-crest frames trigger. The extra diff-ratio
    //              and high-band guards distinguish key clicks from voiced consonants.
    let triggered = state.debounce_samples_remaining == 0
        && match vad_state {
            VadSpeechState::Silence => crest > TRANS_CREST_THRESHOLD || non_speech_key_trigger,
            VadSpeechState::Hangover => {
                (crest > TRANS_CREST_THRESHOLD
                    && state.prev_rms > 0.0
                    && rms > state.prev_rms * TRANS_ENERGY_JUMP_RATIO)
                    || non_speech_key_trigger
            }
            VadSpeechState::Speech => {
                let speech_click_trigger = (crest > TRANS_SPEECH_CREST_THRESHOLD
                    || hp_crest > TRANS_SPEECH_HP_CREST_THRESHOLD)
                    && diff_ratio > TRANS_SPEECH_DIFF_RATIO_THRESHOLD
                    && hp_rms > rms * TRANS_SPEECH_HP_RATIO_THRESHOLD
                    && rms > noise_floor_rms * 1.5;
                let speech_burst_trigger = (peak > TRANS_SPEECH_BURST_PEAK_THRESHOLD
                    && rms > TRANS_SPEECH_BURST_RMS_THRESHOLD
                    && state.prev_rms > 0.0
                    && rms > state.prev_rms * TRANS_SPEECH_BURST_RMS_JUMP_RATIO
                    && rms > noise_floor_rms * TRANS_SPEECH_BURST_NOISE_FLOOR_RATIO)
                    || (input_peak > TRANS_SPEECH_BURST_PEAK_THRESHOLD
                        && input_rms > TRANS_SPEECH_BURST_RMS_THRESHOLD
                        && input_prev_rms > 0.0
                        && input_rms > input_prev_rms * TRANS_SPEECH_BURST_RMS_JUMP_RATIO
                        && input_rms > noise_floor_rms * TRANS_SPEECH_BURST_NOISE_FLOOR_RATIO);
                burst_triggered = speech_burst_trigger;

                speech_click_trigger || speech_burst_trigger
            }
        };

    if triggered {
        // Band-split floors: lows less attenuated than highs, preserving voice warmth.
        let (floor_low, floor_high) = transient_floor_gains(vad_state);
        state.gain_low = floor_low;
        state.gain_high = floor_high;
        state.hold_samples_remaining = hold_samples.max(1);
        state.debounce_samples_remaining = debounce_samples;
    }

    if pause_non_speech_gate_trigger {
        state.pause_non_speech_gain_high = 0.0;
        state.pause_non_speech_hold_samples_remaining = pause_non_speech_hold_samples.max(1);
    }
    if pause_low_burst_gate_trigger {
        state.pause_low_burst_gain_low = 0.0;
        state.pause_low_burst_hold_samples_remaining = pause_low_burst_hold_samples.max(1);
    }

    // Band-split via one-pole LP / complementary HP.
    // LP + HP = identity at unity gain → zero coloration when not attenuating.
    // LP state runs every frame so the filter is primed for smooth onset/release.
    for s in samples.iter_mut() {
        state.lp_state = lp_coeff * state.lp_state + (1.0 - lp_coeff) * *s;
        let hp = *s - state.lp_state;
        let lp_gain = state.gain_low * state.pause_low_burst_gain_low;
        let hp_gain = state.gain_high * state.pause_non_speech_gain_high;
        *s = state.lp_state * lp_gain + hp * hp_gain;

        if state.hold_samples_remaining > 0 {
            state.hold_samples_remaining -= 1;
        } else {
            state.gain_low = release_coeff * state.gain_low + (1.0 - release_coeff) * 1.0;
            state.gain_high = release_coeff * state.gain_high + (1.0 - release_coeff) * 1.0;
        }

        if state.pause_non_speech_hold_samples_remaining > 0 {
            state.pause_non_speech_hold_samples_remaining -= 1;
        } else {
            state.pause_non_speech_gain_high = pause_non_speech_release_coeff
                * state.pause_non_speech_gain_high
                + (1.0 - pause_non_speech_release_coeff) * 1.0;
        }
        if state.pause_low_burst_hold_samples_remaining > 0 {
            state.pause_low_burst_hold_samples_remaining -= 1;
        } else {
            state.pause_low_burst_gain_low = pause_low_burst_release_coeff
                * state.pause_low_burst_gain_low
                + (1.0 - pause_low_burst_release_coeff) * 1.0;
        }
    }

    if triggered {
        apply_triggered_transient_residual_clamp(samples, vad_state, burst_triggered);
    }

    state.prev_rms = rms;
    state.debounce_samples_remaining = state
        .debounce_samples_remaining
        .saturating_sub(samples.len() as u32);

    TransientTriggerReport {
        triggered,
        triggered_in_speech: triggered && vad_state == VadSpeechState::Speech,
        burst_triggered,
        pause_non_speech_gate_triggered: pause_non_speech_gate_trigger,
        pause_low_burst_gate_triggered: pause_low_burst_gate_trigger,
        vad_state,
        score,
        crest,
        hp_crest,
        diff_ratio,
        hp_ratio,
    }
}

// analyze_vad: energy-based VAD tap.  Call once per 10ms frame on post-dezipper audio.
// Returns smoothed speech probability and current state; updates internal state machine.
// The noise floor estimate adapts only during Silence, preventing speech from corrupting it.
pub fn analyze_vad(vad: &mut VadState, samples: &[f32], sample_rate: usize) -> VadOutput {
    if samples.is_empty() || sample_rate == 0 {
        return VadOutput {
            speech_state: vad.speech_state,
            p_raw: 0.0,
        };
    }

    // Per-frame RMS still feeds noise-floor tracking and transient guards.
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let frame_rms = (sum_sq / samples.len() as f32).sqrt().max(1e-9);
    if vad.startup_noise_calibration_frames_remaining > 0 {
        if vad.startup_noise_calibration_frames_remaining == VAD_STARTUP_NOISE_CALIBRATION_FRAMES {
            vad.noise_floor_rms = frame_rms.max(1e-5);
        } else {
            let target_floor = vad.noise_floor_rms.min(frame_rms);
            vad.noise_floor_rms = 0.75 * vad.noise_floor_rms + 0.25 * target_floor.max(1e-5);
        }
        vad.startup_noise_calibration_frames_remaining -= 1;
    }

    let mut p_raw = predict_model_vad(vad, samples, sample_rate).unwrap_or(0.0);

    // Impulse guard: clap/thud detection used to suppress false speech-onset transitions.
    // Requires both high crest (impulse shape) and a large sudden energy jump (from near-silence).
    // Speech onsets have crest ~3–6 and rise gradually; claps are ≥10 with an abrupt jump.
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let crest = peak / (frame_rms + 1e-6);
    let diff_sum_sq: f32 = samples
        .windows(2)
        .map(|window| {
            let delta = window[1] - window[0];
            delta * delta
        })
        .sum();
    let diff_rms = if samples.len() > 1 {
        (diff_sum_sq / (samples.len() - 1) as f32).sqrt()
    } else {
        0.0
    };
    let diff_ratio = diff_rms / (frame_rms + 1e-6);
    let is_impulse = crest > VAD_IMPULSE_CREST_THRESHOLD
        && vad.prev_frame_rms > 0.0
        && frame_rms > vad.prev_frame_rms * VAD_IMPULSE_ENERGY_JUMP;
    let is_transient_noise = diff_ratio > VAD_TRANSIENT_NOISE_DIFF_RATIO_THRESHOLD
        && crest < VAD_IMPULSE_CREST_THRESHOLD
        && frame_rms > vad.noise_floor_rms * 1.2;

    if is_transient_noise {
        p_raw = (p_raw - VAD_TRANSIENT_NOISE_PENALTY).max(0.0);
    }

    // EWMA smoothing: ~50ms time constant at 10ms frames.
    vad.p_smooth = VAD_ALPHA * vad.p_smooth + (1.0 - VAD_ALPHA) * p_raw;

    // State machine.
    match vad.speech_state {
        VadSpeechState::Silence => {
            if vad.startup_noise_calibration_frames_remaining == 0
                && vad.p_smooth >= VAD_SPEECH_THRESHOLD
                && !is_impulse
                && !is_transient_noise
            {
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
            let speech_release_requested =
                vad.p_smooth < VAD_SILENCE_THRESHOLD || (is_transient_noise && p_raw < 0.6);
            if speech_release_requested {
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
        p_raw,
    }
}

pub fn apply_downward_expander(
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

fn expander_speech_bypass(p_smooth: f32) -> f32 {
    ((p_smooth - EXPANDER_BYPASS_SPEECH_FLOOR)
        / (EXPANDER_BYPASS_SPEECH_FULL - EXPANDER_BYPASS_SPEECH_FLOOR))
        .clamp(0.0, 1.0)
}

pub fn process_voice_filter_frame(
    session: &mut VoiceFilterSession,
    samples: &mut [f32],
    channels: usize,
    capture_time: Instant,
    capture_source_timestamp_ms: Option<f64>,
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
            effective_wet_mix: None,
            dry_recovery_hops: 0,
            vad_p_smooth: None,
            expander_bypass: None,
            expander_gain: None,
            transient_triggered: false,
            transient_triggered_in_speech: false,
            pause_non_speech_gate_triggered: false,
            pause_low_burst_gate_triggered: false,
            transient_score: 0.0,
            transient_crest: 0.0,
            transient_hp_crest: 0.0,
            transient_diff_ratio: 0.0,
            transient_hp_ratio: 0.0,
            transient_vad_state: VadSpeechState::Silence,
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
            effective_wet_mix: None,
            dry_recovery_hops: 0,
            vad_p_smooth: None,
            expander_bypass: None,
            expander_gain: None,
            transient_triggered: false,
            transient_triggered_in_speech: false,
            pause_non_speech_gate_triggered: false,
            pause_low_burst_gate_triggered: false,
            transient_score: 0.0,
            transient_crest: 0.0,
            transient_hp_crest: 0.0,
            transient_diff_ratio: 0.0,
            transient_hp_ratio: 0.0,
            transient_vad_state: VadSpeechState::Silence,
        });
    }

    if samples.len() != frame_count * channels {
        return Err("Voice filter frame sample count mismatch".to_string());
    }

    // High-pass filter: strip DC and sub-80 Hz rumble before the model sees the signal.
    // Only applied when DeepFilterNet is active — passthrough mode should not modify audio.
    let mut expander_bypass_out = None;
    let mut expander_gain_out = None;

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
    let base_effective_wet_mix = ramp_wet_mix_at_frame_start.min(onset_wet_mix);

    // AEC before DFN: remove echo from the mic signal first so DFN sees a cleaner
    // input.  If AEC is disabled this is a no-op and has no performance cost.
    let aec_metrics = match session.echo_cancellation_backend() {
        Some(ECHO_CANCELLATION_BACKEND_WEBRTC) => apply_webrtc_echo_cancellation(session, samples),
        Some(ECHO_CANCELLATION_BACKEND_ADAPTIVE) => apply_adaptive_echo_cancellation(
            session,
            samples,
            capture_time,
            capture_source_timestamp_ms,
        ),
        _ => AdaptiveEchoMetrics::default(),
    };

    let input_peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let input_sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let input_rms = (input_sum_sq / samples.len() as f32).sqrt();
    let input_prev_rms = session.transient_input_prev_rms;
    let input_diff_sum_sq: f32 = samples
        .windows(2)
        .map(|window| {
            let delta = window[1] - window[0];
            delta * delta
        })
        .sum();
    let input_diff_rms = if samples.len() > 1 {
        (input_diff_sum_sq / (samples.len() - 1) as f32).sqrt()
    } else {
        0.0
    };
    let input_crest = input_peak / (input_rms + 1e-6);
    let input_diff_ratio = input_diff_rms / (input_rms + 1e-6);
    let pre_dfn_sidechain_score =
        predict_model_vad_tap(&mut session.pre_dfn_vad_tap, samples, session.sample_rate)
            .unwrap_or(0.0);
    let likely_pre_dfn_speech_attack = matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_))
        && session.vad.speech_state == VadSpeechState::Silence
        && session.vad.onset_protection_frames_remaining == 0
        && session.vad.startup_noise_calibration_frames_remaining == 0
        && pre_dfn_sidechain_score >= PRE_DFN_ONSET_ASSIST_SCORE_THRESHOLD
        && input_rms > session.vad.noise_floor_rms * PRE_DFN_ONSET_ASSIST_NOISE_FLOOR_MULTIPLIER
        && input_crest < PRE_DFN_ONSET_ASSIST_MAX_CREST
        && input_diff_ratio < PRE_DFN_ONSET_ASSIST_MAX_DIFF_RATIO;
    let effective_wet_mix = if likely_pre_dfn_speech_attack {
        base_effective_wet_mix.min(PRE_DFN_ONSET_ASSIST_WET_MIX_FLOOR)
    } else {
        base_effective_wet_mix
    };
    session.transient_input_prev_rms = input_rms;

    let mut dfn_stats = DfnStageStats::default();

    match &mut session.processor {
        VoiceFilterProcessor::DeepFilter(processor) => {
            dfn_stats = processor.process(samples, effective_wet_mix)?;
        }
        VoiceFilterProcessor::Passthrough => {}
    }

    // Output de-zipper: smooth inter-hop DFN amplitude discontinuities and mild
    // musical noise before the slew limit / trim / expander chain processes them.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        apply_output_dezipper(samples, &mut session.dezipper_prev_sample);
    }

    if let Some(dereverb) = session.dereverb.as_mut() {
        dereverb.process(samples, session.sample_rate);
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
            p_raw: 1.0,
        }
    };
    let transient_vad_state = transient_control_state(vad_out.speech_state, session.vad.p_smooth);

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
    let transient_report = if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        apply_transient_suppressor(
            &mut session.transient_suppressor,
            samples,
            session.sample_rate,
            transient_vad_state,
            session.vad.noise_floor_rms,
            input_peak,
            input_rms,
            input_prev_rms,
        )
    } else {
        TransientTriggerReport::default()
    };

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
    let (lsnr_mean, lsnr_min_out, lsnr_max_out) = if dfn_stats.hop_count > 0 {
        (
            Some(dfn_stats.lsnr_sum / dfn_stats.hop_count as f32),
            Some(dfn_stats.lsnr_min),
            Some(dfn_stats.lsnr_max),
        )
    } else {
        (None, None, None)
    };

    // Downward expander: gently attenuate residual noise floor after all processing.
    // LSNR nudges the threshold; VAD controls bypass so speech is never expanded.
    //
    // expander_bypass: 1.0 = fully bypassed (strong speech / onset-protection), 0.0 = full effect.
    // Onset protection forces bypass for the first VAD_ONSET_PROTECTION_FRAMES frames of each
    // new speech segment, protecting soft consonant attacks ("t/k/p") that are below threshold.
    // After onset, a time-based ramp (hangover_frames_remaining / VAD_HANGOVER_FRAMES) drives
    // bypass 1.0→0.0 over the hangover window, independent of signal-level fluctuations.
    //
    // Comfort noise is injected only outside Speech (no need during speech; expander is
    // bypassed anyway and noise at -72 dBFS is inaudible under voice).  Gating keeps the
    // noise bed stable — it never "wobbles" with the speech signal.
    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        // State-driven bypass — onset protection still forces full bypass, but outside
        // that window we let weak/borderline "speech" only partially bypass the expander.
        // This prevents steady room tone from fully opening the gate when VAD drifts high.
        let expander_bypass = if session.vad.onset_protection_frames_remaining > 0 {
            1.0f32 // onset protection: full bypass regardless of state
        } else {
            let speech_bypass = expander_speech_bypass(session.vad.p_smooth);
            match vad_out.speech_state {
                VadSpeechState::Speech => speech_bypass,
                // Hangover keeps the monotonic time ramp, but cannot exceed the current
                // confidence-based speech bypass.
                VadSpeechState::Hangover => {
                    let hangover_bypass =
                        session.vad.hangover_frames_remaining as f32 / VAD_HANGOVER_FRAMES as f32;
                    hangover_bypass.min(speech_bypass)
                }
                VadSpeechState::Silence => speech_bypass,
            }
        };
        expander_bypass_out = Some(expander_bypass);
        // Silence gate: "instant on, slow off".
        // - Any state other than Silence: gate_gain = 1.0 instantly (no onset clipping).
        // - Input energy well above noise floor: gate_gain = 1.0 instantly — catches
        //   speech onset before the VAD state machine confirms, with zero latency.
        // - Silence with low input energy: fades 1.0→0.0 over VAD_SILENCE_GATE_FADE_FRAMES
        //   (~800ms), closing before DFN model adaptation leaks audible ambient (~1-2s).
        let input_above_noise_floor = input_rms > session.vad.noise_floor_rms * 6.0;
        let silence_gate_active = vad_out.speech_state == VadSpeechState::Silence
            && session.vad.onset_protection_frames_remaining == 0
            && !input_above_noise_floor;
        if silence_gate_active {
            session.vad.silence_gate_frames =
                (session.vad.silence_gate_frames + 1).min(VAD_SILENCE_GATE_FADE_FRAMES);
        } else {
            session.vad.silence_gate_frames = 0;
        }
        let gate_gain = 1.0
            - (session.vad.silence_gate_frames as f32 / VAD_SILENCE_GATE_FADE_FRAMES as f32);
        for s in samples.iter_mut() {
            *s *= gate_gain;
        }
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
        expander_gain_out = Some(session.expander_gain);
    }

    if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        let current_frame = samples.to_vec();

        if let Some(mut delayed_frame) = session.transient_lookback_frame.take() {
            if delayed_frame.len() == samples.len() {
                if transient_report.triggered {
                    let lookback_gain = transient_lookback_gain(transient_report.vad_state);
                    for sample in delayed_frame.iter_mut() {
                        *sample *= lookback_gain;
                    }
                    apply_triggered_transient_residual_clamp(
                        &mut delayed_frame,
                        transient_report.vad_state,
                        transient_report.burst_triggered,
                    );
                }
                samples.copy_from_slice(&delayed_frame);
            } else {
                samples.fill(0.0);
            }
        } else {
            // Add one frame of latency so the next hop's transient decision can
            // retroactively clamp this buffered audio if the onset straddles the boundary.
            samples.fill(0.0);
        }

        session.transient_lookback_frame = Some(current_frame);
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
        effective_wet_mix: if dfn_stats.hop_count > 0 {
            Some(dfn_stats.effective_wet_mix_sum / dfn_stats.hop_count as f32)
        } else {
            None
        },
        dry_recovery_hops: dfn_stats.dry_recovery_hops,
        vad_p_smooth: if matches!(&session.processor, VoiceFilterProcessor::DeepFilter(_)) {
            Some(session.vad.p_smooth)
        } else {
            None
        },
        expander_bypass: expander_bypass_out,
        expander_gain: expander_gain_out,
        transient_triggered: transient_report.triggered,
        transient_triggered_in_speech: transient_report.triggered_in_speech,
        pause_non_speech_gate_triggered: transient_report.pause_non_speech_gate_triggered,
        pause_low_burst_gate_triggered: transient_report.pause_low_burst_gate_triggered,
        transient_score: transient_report.score,
        transient_crest: transient_report.crest,
        transient_hp_crest: transient_report.hp_crest,
        transient_diff_ratio: transient_report.diff_ratio,
        transient_hp_ratio: transient_report.hp_ratio,
        transient_vad_state: transient_report.vad_state,
    })
}

pub fn voice_filter_frames_per_buffer(session: &VoiceFilterSession) -> usize {
    match &session.processor {
        VoiceFilterProcessor::DeepFilter(processor) => processor.frames_per_buffer(),
        VoiceFilterProcessor::Passthrough => FRAME_SIZE,
    }
}

pub fn apply_limiter(samples: &mut [f32], gain: &mut f32) {
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

/// Process a voice filter frame in place, including limiter application.
/// This is the single entry point for both the service path and the offline file-test path.
/// On return, `frame.samples` contains the processed (mono) audio and `frame.channels` is 1.
pub fn process_voice_filter_frame_in_place(
    session: &mut VoiceFilterSession,
    frame: &mut AudioFrame,
    capture_time: Instant,
) -> Result<VoiceFilterDiagnostics, String> {
    if frame.channels == 0 {
        return Err("Voice filter frame channel count must be > 0".to_string());
    }

    // Downmix to mono if the incoming frame has more channels than the session.
    if frame.channels > session.channels {
        let mono_frame_count = frame.samples.len() / frame.channels;
        let mut mono = Vec::with_capacity(mono_frame_count);
        for frame_index in 0..mono_frame_count {
            let mut sum = 0.0f32;
            for ch in 0..frame.channels {
                sum += frame.samples[frame_index * frame.channels + ch];
            }
            mono.push(sum / frame.channels as f32);
        }
        frame.samples = mono;
        frame.channels = session.channels;
    } else if frame.channels != session.channels {
        return Err("Voice filter channel count mismatch".to_string());
    }

    let channels = frame.channels;

    let diagnostics = process_voice_filter_frame(
        session,
        &mut frame.samples,
        channels,
        capture_time,
        frame.timestamp_ms,
    )?;

    // Limiter is only needed after DeepFilterNet to guard against model output peaks.
    if matches!(session.processor, VoiceFilterProcessor::DeepFilter(_)) {
        session.voice_polish.process(
            &mut frame.samples,
            frame.channels,
            session.sample_rate,
            session.vad.speech_state,
            Some(session.lsnr_smoothed),
        );
        apply_limiter(&mut frame.samples, &mut session.limiter_gain);
    }

    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_polish_is_disabled_in_silence() {
        let mut polish = VoicePolishProcessor::new(1);
        let mut samples = vec![0.002, -0.001, 0.003, -0.002];
        let original = samples.clone();

        polish.process(
            &mut samples,
            1,
            TARGET_SAMPLE_RATE as usize,
            VadSpeechState::Silence,
            None,
        );

        assert_eq!(samples, original);
    }

    #[test]
    fn voice_polish_stays_bounded_on_speech() {
        let mut polish = VoicePolishProcessor::new(1);
        let mut samples = vec![0.0, 0.08, -0.12, 0.1, -0.07, 0.04];

        polish.process(
            &mut samples,
            1,
            TARGET_SAMPLE_RATE as usize,
            VadSpeechState::Speech,
            Some(6.0),
        );

        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert!(samples.iter().map(|sample| sample.abs()).fold(0.0, f32::max) < 0.25);
    }
}
