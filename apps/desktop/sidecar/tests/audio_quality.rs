//! Audio quality regression tests.
//!
//! Replaces the former `run-all.sh` + `analyze.py` pipeline with a single
//! `cargo test --test audio_quality` invocation.  Each WAV under `audio-tests/`
//! is processed through `file_test::run_filter`, then analysed for suppression
//! quality and checked against the thresholds in `audio-tests/baseline.json`.

use sharkord_capture_sidecar::file_test::{self, FileTestConfig};
use sharkord_capture_sidecar::voice_filter_core::{
    VoiceDereverbMode, VoiceFilterDfnTuningParams, VoiceFilterStrength,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ─── Analysis constants (matching the former analyze.py) ─────────────────────

const SAMPLE_RATE: usize = 48_000;
const FRAME_SAMPLES: usize = 480; // 10 ms at 48 kHz
const SILENCE_THRESHOLD_DBFS: f32 = -80.0;
const SPEECH_ONSET_THRESHOLD_DBFS: f32 = -40.0;
const SPEECH_OFFSET_THRESHOLD_DBFS: f32 = -55.0;
const STARTUP_SKIP_FRAMES: usize = 120; // skip first 1.2 s
const MIN_SILENCE_GAP_FRAMES: usize = 10; // 100 ms
const MIN_SPEECH_METRIC_FRAMES: usize = 20; // 200 ms

const LOW_MID_BAND_LOW_HZ: f32 = 300.0;
const LOW_MID_BAND_HIGH_HZ: f32 = 1500.0;
const PRESENCE_BAND_LOW_HZ: f32 = 2000.0;
const PRESENCE_BAND_HIGH_HZ: f32 = 5000.0;
const RESIDUAL_BAND_LOW_HZ: f32 = 120.0;
const RESIDUAL_BAND_HIGH_HZ: f32 = 1200.0;

// ─── Baseline JSON types ─────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct Baseline {
    files: HashMap<String, HashMap<String, Bounds>>,
}

#[derive(serde::Deserialize)]
struct Bounds {
    min: Option<f64>,
    max: Option<f64>,
}

// ─── Analysis result ─────────────────────────────────────────────────────────

#[derive(Default, Debug)]
struct AnalysisResult {
    inp_db: f64,
    out_db: f64,
    silence_pct: f64,
    onset_ratio_count: usize,
    onset_ratio_min: Option<f64>,
    onset_ratio_max: Option<f64>,
    onset_ratio_avg: Option<f64>,
    speech_presence_ratio: Option<f64>,
    speech_residual_wobble: Option<f64>,
}

impl AnalysisResult {
    fn get(&self, metric: &str) -> Option<f64> {
        match metric {
            "inp_db" => Some(self.inp_db),
            "out_db" => Some(self.out_db),
            "silence_pct" => Some(self.silence_pct),
            "onset_ratio_count" => Some(self.onset_ratio_count as f64),
            "onset_ratio_min" => self.onset_ratio_min,
            "onset_ratio_max" => self.onset_ratio_max,
            "onset_ratio_avg" => self.onset_ratio_avg,
            "speech_presence_ratio" => self.speech_presence_ratio,
            "speech_residual_wobble" => self.speech_residual_wobble,
            _ => None,
        }
    }
}

// ─── DSP helpers ─────────────────────────────────────────────────────────────

fn frame_rms(samples: &[f32], frame_idx: usize) -> f64 {
    let start = frame_idx * FRAME_SAMPLES;
    let end = (start + FRAME_SAMPLES).min(samples.len());
    if end <= start {
        return 0.0;
    }
    let n = (end - start) as f64;
    let sum_sq: f64 = samples[start..end].iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum_sq / n).sqrt()
}

fn to_dbfs(linear: f64) -> f64 {
    20.0 * (linear + 1e-10).log10()
}

fn one_pole_alpha(cutoff_hz: f64) -> f64 {
    let cutoff = cutoff_hz.clamp(0.0, SAMPLE_RATE as f64 * 0.45);
    if cutoff <= 0.0 {
        return 1.0;
    }
    let omega = 2.0 * std::f64::consts::PI * cutoff / SAMPLE_RATE as f64;
    (1.0 - (-omega).exp()).clamp(0.0, 1.0)
}

fn lowpass_filter(samples: &[f32], cutoff_hz: f64) -> Vec<f32> {
    let alpha = one_pole_alpha(cutoff_hz);
    let mut state = 0.0f64;
    samples
        .iter()
        .map(|&s| {
            state += (s as f64 - state) * alpha;
            state as f32
        })
        .collect()
}

fn bandpass_filter(samples: &[f32], low_cut_hz: f64, high_cut_hz: f64) -> Vec<f32> {
    let high = lowpass_filter(samples, high_cut_hz);
    if low_cut_hz <= 0.0 {
        return high;
    }
    let low = lowpass_filter(samples, low_cut_hz);
    high.iter().zip(low.iter()).map(|(&h, &l)| h - l).collect()
}

// ─── Onset & speech detection ────────────────────────────────────────────────

fn find_onsets(samples: &[f32], n_frames: usize) -> Vec<usize> {
    let threshold_speech = 10.0f64.powf(SPEECH_ONSET_THRESHOLD_DBFS as f64 / 20.0);
    let threshold_silence = 10.0f64.powf(SPEECH_OFFSET_THRESHOLD_DBFS as f64 / 20.0);

    let mut in_silence = true;
    let mut silence_start = STARTUP_SKIP_FRAMES;
    let mut onsets = Vec::new();

    for i in STARTUP_SKIP_FRAMES..n_frames {
        let rms = frame_rms(samples, i);
        if in_silence && rms > threshold_speech {
            in_silence = false;
            if i - silence_start >= MIN_SILENCE_GAP_FRAMES {
                onsets.push(i);
            }
        } else if !in_silence && rms < threshold_silence {
            in_silence = true;
            silence_start = i;
        }
    }
    onsets
}

fn find_speech_frames(samples: &[f32], n_frames: usize) -> Vec<usize> {
    let threshold_speech = 10.0f64.powf(SPEECH_ONSET_THRESHOLD_DBFS as f64 / 20.0);
    let threshold_silence = 10.0f64.powf(SPEECH_OFFSET_THRESHOLD_DBFS as f64 / 20.0);

    let mut in_speech = false;
    let mut frames = Vec::new();

    for i in STARTUP_SKIP_FRAMES..n_frames {
        let rms = frame_rms(samples, i);
        if !in_speech && rms > threshold_speech {
            in_speech = true;
        } else if in_speech && rms < threshold_silence {
            in_speech = false;
        }
        if in_speech {
            frames.push(i);
        }
    }
    frames
}

// ─── Full analysis ───────────────────────────────────────────────────────────

fn analyze(inp: &[f32], out: &[f32]) -> AnalysisResult {
    let n_frames = (inp.len() / FRAME_SAMPLES).min(out.len() / FRAME_SAMPLES);

    let inp_slice = &inp[..n_frames * FRAME_SAMPLES];
    let out_slice = &out[..n_frames * FRAME_SAMPLES];

    // Overall RMS
    let inp_rms = {
        let sum_sq: f64 = inp_slice.iter().map(|&s| (s as f64) * (s as f64)).sum();
        (sum_sq / inp_slice.len().max(1) as f64).sqrt()
    };
    let out_rms = {
        let sum_sq: f64 = out_slice.iter().map(|&s| (s as f64) * (s as f64)).sum();
        (sum_sq / out_slice.len().max(1) as f64).sqrt()
    };

    // Silence percentage after startup skip
    let silence_thresh = 10.0f64.powf(SILENCE_THRESHOLD_DBFS as f64 / 20.0);
    let mut silent_frames = 0usize;
    let mut total_frames = 0usize;
    for i in STARTUP_SKIP_FRAMES..n_frames {
        total_frames += 1;
        if frame_rms(out, i) < silence_thresh {
            silent_frames += 1;
        }
    }
    let silence_pct = if total_frames > 0 {
        silent_frames as f64 / total_frames as f64 * 100.0
    } else {
        0.0
    };

    // Onset detection & ratios
    let onsets = find_onsets(inp, n_frames);
    let onset_ratios: Vec<f64> = onsets
        .iter()
        .map(|&onset_frame| {
            let in_rms = frame_rms(inp, onset_frame);
            let out_rms_val = frame_rms(out, onset_frame);
            out_rms_val / (in_rms + 1e-10)
        })
        .collect();

    let onset_ratio_min = onset_ratios.iter().copied().reduce(f64::min);
    let onset_ratio_max = onset_ratios.iter().copied().reduce(f64::max);
    let onset_ratio_avg = if onset_ratios.is_empty() {
        None
    } else {
        Some(onset_ratios.iter().sum::<f64>() / onset_ratios.len() as f64)
    };

    // Speech quality metrics
    let speech_frames = find_speech_frames(inp, n_frames);
    let (speech_presence_ratio, speech_residual_wobble) =
        if speech_frames.len() >= MIN_SPEECH_METRIC_FRAMES {
            let out_low_mid =
                bandpass_filter(out, LOW_MID_BAND_LOW_HZ as f64, LOW_MID_BAND_HIGH_HZ as f64);
            let out_presence =
                bandpass_filter(out, PRESENCE_BAND_LOW_HZ as f64, PRESENCE_BAND_HIGH_HZ as f64);
            let out_residual =
                bandpass_filter(out, RESIDUAL_BAND_LOW_HZ as f64, RESIDUAL_BAND_HIGH_HZ as f64);

            let mut presence_ratios = Vec::with_capacity(speech_frames.len());
            let mut residual_band_rms = Vec::with_capacity(speech_frames.len());
            let mut speech_rms_values = Vec::with_capacity(speech_frames.len());

            for &fi in &speech_frames {
                let low_mid_rms = frame_rms(&out_low_mid, fi);
                let presence_rms = frame_rms(&out_presence, fi);
                let residual_rms = frame_rms(&out_residual, fi);
                let out_frame_rms = frame_rms(out, fi);

                presence_ratios.push(presence_rms / (low_mid_rms + 1e-10));
                residual_band_rms.push(residual_rms);
                speech_rms_values.push(out_frame_rms);
            }

            let mean_speech_rms =
                speech_rms_values.iter().sum::<f64>() / speech_rms_values.len() as f64;
            let residual_mean =
                residual_band_rms.iter().sum::<f64>() / residual_band_rms.len() as f64;
            let residual_var = residual_band_rms
                .iter()
                .map(|&v| (v - residual_mean) * (v - residual_mean))
                .sum::<f64>()
                / residual_band_rms.len() as f64;

            let presence = presence_ratios.iter().sum::<f64>() / presence_ratios.len() as f64;
            let wobble = residual_var.sqrt() / (mean_speech_rms + 1e-10);
            (Some(presence), Some(wobble))
        } else {
            (None, None)
        };

    AnalysisResult {
        inp_db: to_dbfs(inp_rms),
        out_db: to_dbfs(out_rms),
        silence_pct,
        onset_ratio_count: onsets.len(),
        onset_ratio_min,
        onset_ratio_max,
        onset_ratio_avg,
        speech_presence_ratio,
        speech_residual_wobble,
    }
}

// ─── Shared test infrastructure ──────────────────────────────────────────────

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = apps/desktop/sidecar
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("failed to resolve repo root")
}

fn test_config() -> FileTestConfig {
    FileTestConfig {
        suppression_level: VoiceFilterStrength::High,
        noise_suppression: true,
        auto_gain_control: false,
        echo_cancellation: false,
        dereverb_mode: Some(VoiceDereverbMode::Off),
        dfn_tuning: VoiceFilterDfnTuningParams {
            experimental_aggressive_mode: Some(true),
            ..VoiceFilterDfnTuningParams::default()
        },
        debug_diagnostics: true,
    }
}

fn load_baseline() -> Baseline {
    let path = repo_root().join("audio-tests/baseline.json");
    let data = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&data)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

fn run_and_check(rel_path: &str) {
    let root = repo_root();
    let input_root = root.join("audio-tests");
    let input_path = input_root.join(rel_path);
    let out_dir = input_root.join(".outputs");

    assert!(
        input_path.exists(),
        "input WAV not found: {}",
        input_path.display()
    );

    // Read & process
    let (inp_samples, _sample_rate, channels) = file_test::read_wav(&input_path)
        .unwrap_or_else(|e| panic!("failed to read {rel_path}: {e}"));

    let config = test_config();
    let (out_samples, _stats) = file_test::run_filter(&inp_samples, channels as usize, &config)
        .unwrap_or_else(|e| panic!("run_filter failed for {rel_path}: {e}"));

    // Write filtered output for manual inspection
    let stem = rel_path.trim_end_matches(".wav");
    let out_path = out_dir.join(format!("{stem}.filtered.wav"));
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    write_wav_mono_f32(&out_path, &out_samples);

    // Downmix input to mono for analysis (matching analyze.py)
    let inp_mono = if channels > 1 {
        let ch = channels as usize;
        let mut mono = Vec::with_capacity(inp_samples.len() / ch);
        for i in (0..inp_samples.len() - ch + 1).step_by(ch) {
            let sum: f32 = inp_samples[i..i + ch].iter().sum();
            mono.push(sum / ch as f32);
        }
        mono
    } else {
        inp_samples
    };

    // Analyze
    let result = analyze(&inp_mono, &out_samples);

    // Check baseline
    let baseline = load_baseline();
    if let Some(expected) = baseline.files.get(rel_path) {
        let mut failures = Vec::new();
        for (metric_name, bounds) in expected {
            let actual = result.get(metric_name);
            match actual {
                None => {
                    if bounds.min.is_some() || bounds.max.is_some() {
                        failures.push(format!(
                            "{metric_name}: metric unavailable but baseline has bounds"
                        ));
                    }
                }
                Some(val) => {
                    if let Some(min) = bounds.min {
                        if val < min {
                            failures.push(format!(
                                "{metric_name}={val:.4} is below baseline min {min:.4}"
                            ));
                        }
                    }
                    if let Some(max) = bounds.max {
                        if val > max {
                            failures.push(format!(
                                "{metric_name}={val:.4} exceeds baseline max {max:.4}"
                            ));
                        }
                    }
                }
            }
        }

        if !failures.is_empty() {
            // Print full result for debugging
            eprintln!("\n--- {rel_path} analysis ---");
            eprintln!("{result:#?}");
            panic!(
                "Baseline check failed for {rel_path}:\n  {}",
                failures.join("\n  ")
            );
        }
    }

    // Print summary for CI visibility
    eprintln!(
        "[pass] {rel_path:35} | inp={:6.1}dB out={:6.1}dB | silent={:5.1}% | onsets={}",
        result.inp_db, result.out_db, result.silence_pct, result.onset_ratio_count,
    );
}

fn write_wav_mono_f32(path: &Path, samples: &[f32]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE as u32,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .unwrap_or_else(|e| panic!("failed to create {}: {e}", path.display()));
    for &s in samples {
        writer.write_sample(s).unwrap();
    }
    writer.finalize().unwrap();
}

// ─── Test cases (one per WAV file) ───────────────────────────────────────────

macro_rules! audio_test {
    ($name:ident, $path:expr) => {
        #[test]
        fn $name() {
            run_and_check($path);
        }
    };
}

audio_test!(desk_taps, "desk-taps.wav");
audio_test!(loud_reaction, "loud-reaction.wav");
audio_test!(mouse_clicks, "mouse-clicks.wav");
audio_test!(room_tone, "room-tone.wav");
audio_test!(single_key_taps, "single-key-taps.wav");
audio_test!(speech_only, "speech-only.wav");
audio_test!(speech_while_typing, "speech-while-typing.wav");
audio_test!(speed_plus_fan, "speed-plus-fan.wav");
audio_test!(typing_only, "typing-only.wav");
audio_test!(nvidia_sample_naked, "nvidia/sample-naked.wav");
audio_test!(nvidia_sample_nvidia_broadcast, "nvidia/sample-nvidia-broadcast.wav");
