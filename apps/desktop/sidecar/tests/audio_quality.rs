//! Audio quality regression tests.
//!
//! Replaces the former `run-all.sh` + `analyze.py` pipeline with a single
//! `cargo test --test audio_quality` invocation.  Each WAV under `audio-tests/`
//! is processed through `file_test::run_filter`, then analysed for suppression
//! quality and checked against the thresholds in `audio-tests/baseline.json`.

use sharkord_capture_sidecar::file_test::{self, FileTestConfig};
use sharkord_capture_sidecar::voice_filter_core::{
    dbfs_to_linear, VoiceDereverbMode, VoiceFilterDfnTuningParams, VoiceFilterStrength,
    DFN_NOISE_GATE_ATTENUATION, DFN_NOISE_GATE_GAIN_SMOOTH_MS, DFN_NOISE_GATE_KNEE_MULTIPLIER,
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
const HF_BAND_LOW_HZ: f32 = 4000.0;
const HF_BAND_HIGH_HZ: f32 = 8000.0;

// Speech dropout detection: a dropout is a brief dip of >DROPOUT_THRESHOLD_DB
// that recovers within DROPOUT_MAX_FRAMES frames during speech.
const DROPOUT_THRESHOLD_DB: f64 = 12.0;
const DROPOUT_MAX_FRAMES: usize = 5; // 50 ms at 10ms/frame

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
    /// Peak RMS (dBFS) of output frames during detected silence gaps between
    /// speech segments — catches subtle static/artifacts in pauses.
    gap_noise_floor_db: Option<f64>,
    /// Median RMS (dBFS) of output frames during silence gaps — captures the
    /// steady-state noise floor between speech, less sensitive to transient peaks.
    gap_noise_floor_median_db: Option<f64>,
    /// SNR improvement in dB: (output speech RMS / output gap RMS) minus
    /// (input speech RMS / input gap RMS). Higher = better NC performance.
    speech_snr_improvement_db: Option<f64>,
    /// Max onset delay in frames between input speech onset and output speech
    /// onset at the same position. Catches VAD/gate clipping word starts.
    onset_delay_frames_max: Option<f64>,
    /// Ratio of HF energy (4-8 kHz) in output vs input during speech frames.
    /// Values near 1.0 = good preservation; <1.0 = muffled sibilants.
    speech_hf_preservation: Option<f64>,
    /// Number of brief dropouts (>12 dB dip recovering within 50 ms) during
    /// speech segments. Catches pumping and chopped consonants.
    speech_dropout_count: Option<f64>,
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
            "gap_noise_floor_db" => self.gap_noise_floor_db,
            "gap_noise_floor_median_db" => self.gap_noise_floor_median_db,
            "speech_snr_improvement_db" => self.speech_snr_improvement_db,
            "onset_delay_frames_max" => self.onset_delay_frames_max,
            "speech_hf_preservation" => self.speech_hf_preservation,
            "speech_dropout_count" => self.speech_dropout_count,
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

    // Gap noise floor: measure peak and median RMS of output frames during
    // silence gaps between speech segments (after startup skip).
    // Peak catches transient leaks; median captures steady-state static.
    // Uses output-based speech detection so that NC-suppressed backgrounds
    // (fan, AC) correctly show silence gaps rather than being misclassified
    // as continuous speech from the noisy input.
    let (gap_noise_floor_db, gap_noise_floor_median_db) = {
        let out_speech_frames = find_speech_frames(out_slice, n_frames);
        let speech_set: std::collections::HashSet<usize> =
            out_speech_frames.iter().copied().collect();
        let mut gap_rms_values = Vec::new();
        for i in STARTUP_SKIP_FRAMES..n_frames {
            if !speech_set.contains(&i) {
                gap_rms_values.push(frame_rms(out_slice, i));
            }
        }
        if gap_rms_values.len() >= MIN_SILENCE_GAP_FRAMES {
            let peak = gap_rms_values.iter().copied().reduce(f64::max).unwrap();
            gap_rms_values.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let median = gap_rms_values[gap_rms_values.len() / 2];
            (Some(to_dbfs(peak)), Some(to_dbfs(median)))
        } else {
            (None, None)
        }
    };

    // SNR improvement: compare speech-to-gap SNR in output vs input.
    // Uses output-based speech detection for gap measurement (same as gap_noise_floor).
    let speech_snr_improvement_db = {
        let out_speech_set: std::collections::HashSet<usize> =
            find_speech_frames(out_slice, n_frames).into_iter().collect();
        let inp_speech_set: std::collections::HashSet<usize> =
            speech_frames.iter().copied().collect();

        let inp_speech_rms = {
            let vals: Vec<f64> = (STARTUP_SKIP_FRAMES..n_frames)
                .filter(|i| inp_speech_set.contains(i))
                .map(|i| frame_rms(inp_slice, i))
                .collect();
            if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 }
        };
        let inp_gap_rms = {
            let vals: Vec<f64> = (STARTUP_SKIP_FRAMES..n_frames)
                .filter(|i| !inp_speech_set.contains(i))
                .map(|i| frame_rms(inp_slice, i))
                .collect();
            if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 }
        };
        let out_speech_rms = {
            let vals: Vec<f64> = (STARTUP_SKIP_FRAMES..n_frames)
                .filter(|i| out_speech_set.contains(i))
                .map(|i| frame_rms(out_slice, i))
                .collect();
            if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 }
        };
        let out_gap_rms = {
            let vals: Vec<f64> = (STARTUP_SKIP_FRAMES..n_frames)
                .filter(|i| !out_speech_set.contains(i))
                .map(|i| frame_rms(out_slice, i))
                .collect();
            if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 }
        };

        if inp_gap_rms > 1e-10 && out_gap_rms > 1e-10 && inp_speech_rms > 1e-10 && out_speech_rms > 1e-10 {
            let inp_snr = to_dbfs(inp_speech_rms) - to_dbfs(inp_gap_rms);
            let out_snr = to_dbfs(out_speech_rms) - to_dbfs(out_gap_rms);
            Some(out_snr - inp_snr)
        } else {
            None
        }
    };

    // Onset delay: for each input onset, find the first output frame at or after
    // the onset that crosses the speech threshold. The difference is the delay.
    let onset_delay_frames_max = if onsets.is_empty() {
        None
    } else {
        let out_threshold = 10.0f64.powf(SPEECH_ONSET_THRESHOLD_DBFS as f64 / 20.0);
        let max_search = 20; // search up to 200ms after input onset
        let mut max_delay: Option<usize> = None;
        for &onset in &onsets {
            let mut delay = None;
            for d in 0..max_search {
                let fi = onset + d;
                if fi >= n_frames { break; }
                if frame_rms(out_slice, fi) > out_threshold {
                    delay = Some(d);
                    break;
                }
            }
            if let Some(d) = delay {
                max_delay = Some(max_delay.map_or(d, |prev: usize| prev.max(d)));
            }
        }
        max_delay.map(|d| d as f64)
    };

    // HF preservation: ratio of HF energy (4-8 kHz) in output vs input during
    // speech frames. Values near 1.0 = sibilants preserved; <<1.0 = muffled.
    let speech_hf_preservation = if speech_frames.len() >= MIN_SPEECH_METRIC_FRAMES {
        let inp_hf = bandpass_filter(inp_slice, HF_BAND_LOW_HZ as f64, HF_BAND_HIGH_HZ as f64);
        let out_hf = bandpass_filter(out_slice, HF_BAND_LOW_HZ as f64, HF_BAND_HIGH_HZ as f64);

        let mut inp_hf_sum = 0.0f64;
        let mut out_hf_sum = 0.0f64;
        for &fi in &speech_frames {
            inp_hf_sum += frame_rms(&inp_hf, fi);
            out_hf_sum += frame_rms(&out_hf, fi);
        }
        if inp_hf_sum > 1e-10 {
            Some(out_hf_sum / inp_hf_sum)
        } else {
            None
        }
    } else {
        None
    };

    // Speech dropout detection: count brief dips during speech where the output
    // RMS drops >DROPOUT_THRESHOLD_DB below the local speech level and recovers
    // within DROPOUT_MAX_FRAMES. Catches pumping and chopped consonants.
    let speech_dropout_count = if speech_frames.len() >= MIN_SPEECH_METRIC_FRAMES {
        // Build a vec of (frame_idx, rms_db) for speech frames
        let speech_rms_db: Vec<(usize, f64)> = speech_frames
            .iter()
            .map(|&fi| (fi, to_dbfs(frame_rms(out_slice, fi))))
            .collect();

        let mut dropouts = 0u64;
        let mut i = 0;
        while i < speech_rms_db.len() {
            let (_, ref_db) = speech_rms_db[i];
            // Look ahead for a dip
            let mut j = i + 1;
            let mut found_dip = false;
            while j < speech_rms_db.len() && j - i <= DROPOUT_MAX_FRAMES + 1 {
                let (_, cur_db) = speech_rms_db[j];
                if ref_db - cur_db > DROPOUT_THRESHOLD_DB {
                    found_dip = true;
                }
                if found_dip && (ref_db - cur_db) < DROPOUT_THRESHOLD_DB / 2.0 {
                    // Recovered — count as dropout
                    dropouts += 1;
                    i = j;
                    break;
                }
                j += 1;
            }
            i += 1;
        }
        Some(dropouts as f64)
    } else {
        None
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
        gap_noise_floor_db,
        gap_noise_floor_median_db,
        speech_snr_improvement_db,
        onset_delay_frames_max,
        speech_hf_preservation,
        speech_dropout_count,
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

/// Matches the client-side "High" strength defaults from `getStrengthDefaults`.
fn test_config() -> FileTestConfig {
    FileTestConfig {
        suppression_level: VoiceFilterStrength::High,
        noise_suppression: true,
        auto_gain_control: false,
        echo_cancellation: false,
        dereverb_mode: Some(VoiceDereverbMode::Off),
        dfn_tuning: VoiceFilterDfnTuningParams {
            mix: Some(1.0),
            attenuation_limit_db: Some(80.0),
            experimental_aggressive_mode: Some(true),
            noise_gate_floor_dbfs: Some(-58.0),
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
    let fmt_opt = |v: Option<f64>, suffix: &str| -> String {
        v.map(|x| format!("{x:6.1}{suffix}")).unwrap_or_else(|| "   n/a".to_string())
    };
    eprintln!(
        "[pass] {rel_path:35} | inp={:6.1}dB out={:6.1}dB | silent={:5.1}% | onsets={} | gap_pk={} gap_med={} | snr_imp={} onset_dly={} hf_pres={} dropouts={}",
        result.inp_db, result.out_db, result.silence_pct, result.onset_ratio_count,
        fmt_opt(result.gap_noise_floor_db, "dB"),
        fmt_opt(result.gap_noise_floor_median_db, "dB"),
        fmt_opt(result.speech_snr_improvement_db, "dB"),
        fmt_opt(result.onset_delay_frames_max, ""),
        fmt_opt(result.speech_hf_preservation, ""),
        fmt_opt(result.speech_dropout_count, ""),
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

// ─── Anti-cicada noise gate test ─────────────────────────────────────────────
//
// The "cicada" bug: when a signal oscillates around the gate threshold, a
// per-sample gate flips gain between attenuated and unity every cycle, creating
// audible periodic modulation at the signal frequency.  The gain smoother
// prevents this.  This test proves the fix by measuring gain modulation depth
// for a tone at the gate threshold.

/// Simulate the original (unsmoothed) per-sample noise gate.
fn gate_unsmoothed(samples: &mut [f32], floor: f32) {
    let knee = floor * DFN_NOISE_GATE_KNEE_MULTIPLIER;
    for sample in samples.iter_mut() {
        let abs_val = sample.abs();
        let gain = if abs_val <= floor {
            DFN_NOISE_GATE_ATTENUATION
        } else if abs_val >= knee {
            1.0
        } else {
            let t = ((abs_val - floor) / (knee - floor)).clamp(0.0, 1.0);
            DFN_NOISE_GATE_ATTENUATION + (1.0 - DFN_NOISE_GATE_ATTENUATION) * t
        };
        *sample *= gain;
    }
}

/// Simulate the smoothed per-sample noise gate (the actual implementation).
fn gate_smoothed(samples: &mut [f32], floor: f32) {
    let sr = 48_000.0f32;
    let gain_smooth_coeff = (-1.0 / (sr * DFN_NOISE_GATE_GAIN_SMOOTH_MS / 1000.0)).exp();
    let knee = floor * DFN_NOISE_GATE_KNEE_MULTIPLIER;
    let mut gate_gain = 1.0f32;

    for sample in samples.iter_mut() {
        let abs_val = sample.abs();
        let desired_gain = if abs_val <= floor {
            DFN_NOISE_GATE_ATTENUATION
        } else if abs_val >= knee {
            1.0
        } else {
            let t = ((abs_val - floor) / (knee - floor)).clamp(0.0, 1.0);
            DFN_NOISE_GATE_ATTENUATION + (1.0 - DFN_NOISE_GATE_ATTENUATION) * t
        };
        gate_gain = gain_smooth_coeff * gate_gain + (1.0 - gain_smooth_coeff) * desired_gain;
        *sample *= gate_gain;
    }
}

/// Measure the gain modulation depth: ratio of gain variance to mean gain.
/// A pure-gain signal (no modulation) has depth ≈ 0.  The cicada bug produces
/// depth >> 0 because gain tracks each cycle of the waveform.
fn measure_gain_modulation(original: &[f32], processed: &[f32]) -> f64 {
    assert_eq!(original.len(), processed.len());
    let gains: Vec<f64> = original
        .iter()
        .zip(processed.iter())
        .filter(|(&o, _)| o.abs() > 1e-12)
        .map(|(&o, &p)| (p as f64) / (o as f64))
        .collect();
    if gains.len() < 100 {
        return 0.0;
    }
    let mean = gains.iter().sum::<f64>() / gains.len() as f64;
    let variance = gains.iter().map(|g| (g - mean).powi(2)).sum::<f64>() / gains.len() as f64;
    (variance.sqrt()) / mean.abs().max(1e-12)
}

#[test]
fn anti_cicada_noise_gate() {
    use std::f32::consts::PI;

    let sr = 48_000usize;
    let num_samples = sr / 2; // 0.5 seconds
    let freq_hz = 200.0; // typical voice fundamental

    // Gate threshold from test config
    let floor = dbfs_to_linear(-58.0);

    // Generate a tone whose peak amplitude is 2x the gate floor.
    // This means each cycle swings between -2*floor and +2*floor, crossing
    // through the floor threshold twice per cycle — the worst case for cicada.
    let amplitude = floor * 2.0;
    let tone: Vec<f32> = (0..num_samples)
        .map(|i| (2.0 * PI * freq_hz * i as f32 / sr as f32).sin() * amplitude)
        .collect();

    // Run through unsmoothed gate
    let mut unsmoothed = tone.clone();
    gate_unsmoothed(&mut unsmoothed, floor);
    let mod_unsmoothed = measure_gain_modulation(&tone, &unsmoothed);

    // Run through smoothed gate (our fix)
    let mut smoothed = tone.clone();
    gate_smoothed(&mut smoothed, floor);
    let mod_smoothed = measure_gain_modulation(&tone, &smoothed);

    eprintln!(
        "Anti-cicada test: unsmoothed modulation depth = {mod_unsmoothed:.4}, \
         smoothed modulation depth = {mod_smoothed:.4}, \
         reduction = {:.1}x",
        mod_unsmoothed / mod_smoothed.max(1e-12)
    );

    // The unsmoothed gate should have significant modulation (the cicada bug)
    assert!(
        mod_unsmoothed > 0.01,
        "Expected unsmoothed gate to show modulation (cicada bug), got {mod_unsmoothed:.6}"
    );

    // The smoothed gate should have significantly less modulation (>3x reduction)
    assert!(
        mod_smoothed < mod_unsmoothed * 0.35,
        "Smoothed gate modulation ({mod_smoothed:.6}) should be <35% of unsmoothed ({mod_unsmoothed:.6})"
    );
}
