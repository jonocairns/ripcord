//! Offline voice-filter file-test harness.
//!
//! Reads a WAV file, runs it through the same DSP pipeline used by the live sidecar service,
//! and writes a processed mono 48 kHz float WAV to the output path.
//!
//! v1 restrictions:
//! - Input sample rate must be exactly 48 000 Hz.
//! - Supported channel counts: 1 (mono) or 2 (stereo).
//! - Accepted sample formats: PCM i16 and IEEE float f32.
//! - Output: mono 32-bit float WAV at 48 kHz.
//! - No AEC reference input (mic path only).

use crate::voice_filter_core::{
    create_voice_filter_session, process_voice_filter_frame_in_place,
    voice_filter_frames_per_buffer, AudioFrame, VadSpeechState, VoiceDereverbMode,
    VoiceFilterDfnTuningParams, VoiceFilterProcessor, VoiceFilterStrength,
};
use std::io::{Read, Seek};
use std::path::Path;
use std::time::Instant;

// ─── Config ─────────────────────────────────────────────────────────────────

/// Configuration for an offline voice-filter run, mirroring the knobs on the
/// settings-page microphone test panel.
pub struct FileTestConfig {
    pub suppression_level: VoiceFilterStrength,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    pub echo_cancellation: bool,
    /// Effective dereverb mode.  When `None` the harness picks `Tail` if noise
    /// suppression is enabled, `Off` otherwise — mirroring the sidecar default.
    pub dereverb_mode: Option<VoiceDereverbMode>,
    pub dfn_tuning: VoiceFilterDfnTuningParams,
    pub debug_diagnostics: bool,
}

impl Default for FileTestConfig {
    fn default() -> Self {
        Self {
            suppression_level: VoiceFilterStrength::Balanced,
            noise_suppression: true,
            auto_gain_control: false,
            echo_cancellation: false,
            dereverb_mode: None, // resolved at runtime
            dfn_tuning: VoiceFilterDfnTuningParams::default(),
            debug_diagnostics: false,
        }
    }
}

// ─── WAV I/O ────────────────────────────────────────────────────────────────

/// Internal WAV reader that operates on any `Read + Seek` source.
fn read_wav_from_reader<R: Read + Seek>(
    reader: R,
    source_hint: &str,
) -> Result<(Vec<f32>, u32, u16), String> {
    let mut wav = hound::WavReader::new(reader)
        .map_err(|e| format!("Failed to parse WAV from {source_hint}: {e}"))?;
    let spec = wav.spec();

    if spec.sample_rate != 48_000 {
        return Err(format!(
            "expected 48 kHz WAV; convert first (for example with ffmpeg). \
             Got {} Hz in '{source_hint}'",
            spec.sample_rate
        ));
    }

    if spec.channels == 0 || spec.channels > 2 {
        return Err(format!(
            "unsupported channel count {}; expected 1 (mono) or 2 (stereo) in '{source_hint}'",
            spec.channels
        ));
    }

    let samples: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => wav
            .samples::<f32>()
            .map(|s| s.map_err(|e| format!("WAV read error in '{source_hint}': {e}")))
            .collect::<Result<Vec<_>, _>>()?,

        (hound::SampleFormat::Int, 16) => wav
            .samples::<i16>()
            .map(|s| {
                s.map(|v| v as f32 / i16::MAX as f32)
                    .map_err(|e| format!("WAV read error in '{source_hint}': {e}"))
            })
            .collect::<Result<Vec<_>, _>>()?,

        (fmt, bits) => {
            return Err(format!(
                "unsupported WAV format {fmt:?} / {bits}-bit in '{source_hint}'; \
                 only PCM i16 and IEEE float f32 are supported"
            ));
        }
    };

    Ok((samples, spec.sample_rate, spec.channels))
}

/// Read a WAV file from disk and return interleaved f32 samples together with
/// the sample rate and channel count.
pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32, u16), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open WAV file '{}': {e}", path.display()))?;
    read_wav_from_reader(std::io::BufReader::new(file), &path.display().to_string())
}

/// Write a mono 32-bit float WAV to `path`.
fn write_wav_mono_f32(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("Failed to create output WAV '{}': {e}", path.display()))?;
    for &s in samples {
        writer
            .write_sample(s)
            .map_err(|e| format!("WAV write error in '{}': {e}", path.display()))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("WAV finalize error in '{}': {e}", path.display()))?;
    Ok(())
}

// ─── Processing ─────────────────────────────────────────────────────────────

/// Statistics collected during offline processing; used for the printed summary.
pub struct RunStats {
    pub frames_processed: usize,
    pub lsnr_mean: Option<f32>,
    pub lsnr_min: Option<f32>,
    pub lsnr_max: Option<f32>,
    pub agc_gain_mean: Option<f32>,
    pub aec_erle_mean: Option<f32>,
    pub aec_delay_mean: Option<f32>,
    pub effective_wet_mix_mean: Option<f32>,
    pub dry_recovery_frames: usize,
    pub dry_recovery_hops: usize,
    pub vad_p_smooth_mean: Option<f32>,
    pub vad_p_smooth_max: Option<f32>,
    pub expander_bypass_mean: Option<f32>,
    pub expander_gain_mean: Option<f32>,
    pub expander_gain_min: Option<f32>,
    pub transient_triggers: usize,
    pub transient_speech_triggers: usize,
    pub pause_non_speech_gate_triggers: usize,
    pub pause_low_burst_gate_triggers: usize,
    pub top_transient_candidates: Vec<TransientCandidateFrame>,
}

pub struct TransientCandidateFrame {
    pub frame_index: usize,
    pub sample_offset: usize,
    pub vad_state: VadSpeechState,
    pub score: f32,
    pub crest: f32,
    pub hp_crest: f32,
    pub diff_ratio: f32,
    pub hp_ratio: f32,
    pub triggered: bool,
}

fn push_top_transient_candidate(
    top: &mut Vec<TransientCandidateFrame>,
    candidate: TransientCandidateFrame,
) {
    top.push(candidate);
    top.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if top.len() > 10 {
        top.truncate(10);
    }
}

fn vad_state_label(state: VadSpeechState) -> &'static str {
    match state {
        VadSpeechState::Silence => "silence",
        VadSpeechState::Speech => "speech",
        VadSpeechState::Hangover => "hangover",
    }
}

/// Run the voice-filter DSP pipeline over `input_samples` (interleaved, `input_channels`
/// channels at 48 kHz) and return the processed mono output together with run statistics.
///
/// The output length equals `input_samples.len() / input_channels` (i.e. the same
/// frame count as the input) — the final partial block is zero-padded for processing
/// then trimmed so that duration is preserved exactly.
pub fn run_filter(
    input_samples: &[f32],
    input_channels: usize,
    config: &FileTestConfig,
) -> Result<(Vec<f32>, RunStats), String> {
    if input_channels == 0 {
        return Err("input channel count must be > 0".to_string());
    }

    let total_frames = input_samples.len() / input_channels;

    // Resolve dereverb mode: default to Tail when noise suppression is enabled.
    let dereverb_mode = config.dereverb_mode.unwrap_or(if config.noise_suppression {
        VoiceDereverbMode::Tail
    } else {
        VoiceDereverbMode::Off
    });

    let mut session = create_voice_filter_session(
        "offline".to_string(),
        48_000,
        input_channels,
        config.suppression_level,
        config.dfn_tuning,
        config.noise_suppression,
        config.auto_gain_control,
        config.echo_cancellation,
        dereverb_mode,
    )?;

    // The offline harness should skip the long session-start ramp, but still allow
    // VAD/onset state to behave naturally so abrupt speech onsets are testable.
    session.suppression_startup_ramp_ms_remaining = 0;

    let frames_per_buffer = voice_filter_frames_per_buffer(&session);
    let block_input_samples = frames_per_buffer * input_channels;
    let latency_frames = match &session.processor {
        // The transient lookback adds one buffered hop on top of the model latency.
        VoiceFilterProcessor::DeepFilter(stage) => stage._latency_samples + frames_per_buffer,
        VoiceFilterProcessor::Passthrough => 0,
    };
    let flush_input_samples = latency_frames * input_channels;
    let total_input_with_flush = input_samples.len() + flush_input_samples;

    let mut output: Vec<f32> = Vec::with_capacity(total_frames);
    let mut lsnr_sum = 0.0f32;
    let mut lsnr_min = f32::INFINITY;
    let mut lsnr_max = f32::NEG_INFINITY;
    let mut lsnr_count = 0usize;
    let mut agc_sum = 0.0f32;
    let mut agc_count = 0usize;
    let mut aec_erle_sum = 0.0f32;
    let mut aec_erle_count = 0usize;
    let mut aec_delay_sum = 0.0f32;
    let mut aec_delay_count = 0usize;
    let mut effective_wet_mix_sum = 0.0f32;
    let mut effective_wet_mix_count = 0usize;
    let mut dry_recovery_frames = 0usize;
    let mut dry_recovery_hops = 0usize;
    let mut vad_p_smooth_sum = 0.0f32;
    let mut vad_p_smooth_count = 0usize;
    let mut vad_p_smooth_max = f32::NEG_INFINITY;
    let mut expander_bypass_sum = 0.0f32;
    let mut expander_bypass_count = 0usize;
    let mut expander_gain_sum = 0.0f32;
    let mut expander_gain_count = 0usize;
    let mut expander_gain_min = f32::INFINITY;
    let mut transient_triggers = 0usize;
    let mut transient_speech_triggers = 0usize;
    let mut pause_non_speech_gate_triggers = 0usize;
    let mut pause_low_burst_gate_triggers = 0usize;
    let mut top_transient_candidates = Vec::new();
    let mut frames_processed = 0usize;
    let mut sequence: u64 = 0;
    let mut offset = 0usize;

    while offset < total_input_with_flush {
        let chunk_end = (offset + block_input_samples).min(total_input_with_flush);
        let mut block_data = Vec::with_capacity(chunk_end - offset);
        let input_copy_end = chunk_end.min(input_samples.len());
        if offset < input_samples.len() {
            block_data.extend_from_slice(&input_samples[offset..input_copy_end]);
        }
        if chunk_end > input_samples.len() {
            block_data.resize(chunk_end - offset, 0.0);
        }
        let chunk = block_data.as_slice();

        // Zero-pad the final partial block to a full frame when needed.
        let padded_block: Vec<f32>;
        let block: &[f32] = if chunk.len() < block_input_samples {
            padded_block = {
                let mut v = chunk.to_vec();
                v.resize(block_input_samples, 0.0);
                v
            };
            &padded_block
        } else {
            chunk
        };

        let mut frame =
            AudioFrame::new(block.to_vec(), 48_000, input_channels, None, sequence, None)?;

        let capture_time = Instant::now();
        let diag = process_voice_filter_frame_in_place(&mut session, &mut frame, capture_time)?;

        // Collect per-frame diagnostics.
        if let Some(m) = diag.lsnr_mean {
            lsnr_sum += m;
            lsnr_count += 1;
        }
        if let Some(m) = diag.lsnr_min {
            lsnr_min = lsnr_min.min(m);
        }
        if let Some(m) = diag.lsnr_max {
            lsnr_max = lsnr_max.max(m);
        }
        if let Some(g) = diag.agc_gain {
            agc_sum += g;
            agc_count += 1;
        }
        if let Some(e) = diag.aec_erle_db {
            aec_erle_sum += e;
            aec_erle_count += 1;
        }
        if let Some(d) = diag.aec_delay_ms {
            aec_delay_sum += d;
            aec_delay_count += 1;
        }
        if let Some(mix) = diag.effective_wet_mix {
            effective_wet_mix_sum += mix;
            effective_wet_mix_count += 1;
        }
        if diag.dry_recovery_hops > 0 {
            dry_recovery_frames += 1;
            dry_recovery_hops += diag.dry_recovery_hops as usize;
        }
        if let Some(p_smooth) = diag.vad_p_smooth {
            vad_p_smooth_sum += p_smooth;
            vad_p_smooth_count += 1;
            vad_p_smooth_max = vad_p_smooth_max.max(p_smooth);
        }
        if let Some(bypass) = diag.expander_bypass {
            expander_bypass_sum += bypass;
            expander_bypass_count += 1;
        }
        if let Some(gain) = diag.expander_gain {
            expander_gain_sum += gain;
            expander_gain_count += 1;
            expander_gain_min = expander_gain_min.min(gain);
        }
        if diag.transient_triggered {
            transient_triggers += 1;
        }
        if diag.transient_triggered_in_speech {
            transient_speech_triggers += 1;
        }
        if diag.pause_non_speech_gate_triggered {
            pause_non_speech_gate_triggers += 1;
        }
        if diag.pause_low_burst_gate_triggered {
            pause_low_burst_gate_triggers += 1;
        }
        if config.debug_diagnostics {
            push_top_transient_candidate(
                &mut top_transient_candidates,
                TransientCandidateFrame {
                    frame_index: sequence as usize,
                    sample_offset: sequence as usize * frames_per_buffer,
                    vad_state: diag.transient_vad_state,
                    score: diag.transient_score,
                    crest: diag.transient_crest,
                    hp_crest: diag.transient_hp_crest,
                    diff_ratio: diag.transient_diff_ratio,
                    hp_ratio: diag.transient_hp_ratio,
                    triggered: diag.transient_triggered,
                },
            );
        }

        // frame.samples is now mono (1 channel); append to the output buffer.
        output.extend_from_slice(&frame.samples);
        frames_processed += frames_per_buffer;
        sequence = sequence.saturating_add(1);

        offset = chunk_end;
    }

    // DeepFilterNet is internally delayed by its STFT + lookahead. Flush that tail,
    // then crop the leading latency so the output aligns with the source.
    if latency_frames > 0 {
        if output.len() > latency_frames {
            output.drain(..latency_frames);
        } else {
            output.clear();
        }
    }

    // Trim any padded/flush tail so the output length equals the original frame count.
    output.truncate(total_frames);

    let stats = RunStats {
        frames_processed,
        lsnr_mean: if lsnr_count > 0 {
            Some(lsnr_sum / lsnr_count as f32)
        } else {
            None
        },
        lsnr_min: if lsnr_count > 0 && lsnr_min.is_finite() {
            Some(lsnr_min)
        } else {
            None
        },
        lsnr_max: if lsnr_count > 0 && lsnr_max.is_finite() {
            Some(lsnr_max)
        } else {
            None
        },
        agc_gain_mean: if agc_count > 0 {
            Some(agc_sum / agc_count as f32)
        } else {
            None
        },
        aec_erle_mean: if aec_erle_count > 0 {
            Some(aec_erle_sum / aec_erle_count as f32)
        } else {
            None
        },
        aec_delay_mean: if aec_delay_count > 0 {
            Some(aec_delay_sum / aec_delay_count as f32)
        } else {
            None
        },
        effective_wet_mix_mean: if effective_wet_mix_count > 0 {
            Some(effective_wet_mix_sum / effective_wet_mix_count as f32)
        } else {
            None
        },
        dry_recovery_frames,
        dry_recovery_hops,
        vad_p_smooth_mean: if vad_p_smooth_count > 0 {
            Some(vad_p_smooth_sum / vad_p_smooth_count as f32)
        } else {
            None
        },
        vad_p_smooth_max: if vad_p_smooth_count > 0 && vad_p_smooth_max.is_finite() {
            Some(vad_p_smooth_max)
        } else {
            None
        },
        expander_bypass_mean: if expander_bypass_count > 0 {
            Some(expander_bypass_sum / expander_bypass_count as f32)
        } else {
            None
        },
        expander_gain_mean: if expander_gain_count > 0 {
            Some(expander_gain_sum / expander_gain_count as f32)
        } else {
            None
        },
        expander_gain_min: if expander_gain_count > 0 && expander_gain_min.is_finite() {
            Some(expander_gain_min)
        } else {
            None
        },
        transient_triggers,
        transient_speech_triggers,
        pause_non_speech_gate_triggers,
        pause_low_burst_gate_triggers,
        top_transient_candidates,
    };

    Ok((output, stats))
}

/// Top-level entry point called by the `voice-filter-file-test` binary.
pub fn run_file_test(
    input_path: &Path,
    output_path: &Path,
    config: &FileTestConfig,
) -> Result<(), String> {
    let (input_samples, sample_rate, channels) = read_wav(input_path)?;
    let input_frames = input_samples.len() / channels as usize;
    let duration_secs = input_frames as f64 / sample_rate as f64;

    eprintln!("Input:    {}", input_path.display());
    eprintln!(
        "          {channels} ch, {sample_rate} Hz, {input_frames} frames ({:.3} s)",
        duration_secs
    );
    eprintln!("Output:   {}", output_path.display());

    let (output_samples, stats) = run_filter(&input_samples, channels as usize, config)?;

    write_wav_mono_f32(output_path, &output_samples, sample_rate)?;

    eprintln!("Frames processed: {}", stats.frames_processed);
    match (stats.lsnr_mean, stats.lsnr_min, stats.lsnr_max) {
        (Some(mean), Some(min), Some(max)) => {
            eprintln!("LSNR (dB):  mean={mean:.1}  min={min:.1}  max={max:.1}");
        }
        _ => {
            eprintln!("LSNR:       n/a (noise suppression disabled or no speech detected)");
        }
    }
    if let Some(g) = stats.agc_gain_mean {
        eprintln!("AGC gain:   mean={g:.3}");
    } else {
        eprintln!("AGC gain:   n/a (AGC disabled)");
    }
    match (stats.aec_erle_mean, stats.aec_delay_mean) {
        (Some(erle), Some(delay)) => {
            eprintln!("AEC ERLE:   {erle:.1} dB  delay={delay:.1} ms");
        }
        _ => {
            eprintln!("AEC ERLE:   n/a (mic-only offline mode, no reference signal)");
        }
    }
    if config.debug_diagnostics {
        if let Some(mean) = stats.effective_wet_mix_mean {
            eprintln!("DFN wet:    mean={mean:.3}");
        } else {
            eprintln!("DFN wet:    n/a (noise suppression disabled)");
        }
        eprintln!(
            "Dry rescue: frames={} hops={}",
            stats.dry_recovery_frames, stats.dry_recovery_hops
        );
        match (
            stats.vad_p_smooth_mean,
            stats.vad_p_smooth_max,
            stats.expander_bypass_mean,
            stats.expander_gain_mean,
            stats.expander_gain_min,
        ) {
            (Some(p_mean), Some(p_max), Some(bypass), Some(gain_mean), Some(gain_min)) => {
                eprintln!(
                    "Control:    p_smooth mean={p_mean:.3} max={p_max:.3}  exp_bypass mean={bypass:.3}  exp_gain mean={gain_mean:.3} min={gain_min:.3}"
                );
            }
            _ => {
                eprintln!("Control:    n/a (noise suppression disabled)");
            }
        }
        eprintln!(
            "Transient:  total={} speech={}  pause_noise={}  pause_low={}",
            stats.transient_triggers,
            stats.transient_speech_triggers,
            stats.pause_non_speech_gate_triggers,
            stats.pause_low_burst_gate_triggers
        );
        if !stats.top_transient_candidates.is_empty() {
            eprintln!("Top transient candidates:");
            for candidate in &stats.top_transient_candidates {
                eprintln!(
                    "  frame={} sample={} state={} score={:.2} trig={} crest={:.2} hp={:.2} diff={:.2} hp_ratio={:.2}",
                    candidate.frame_index,
                    candidate.sample_offset,
                    vad_state_label(candidate.vad_state),
                    candidate.score,
                    candidate.triggered,
                    candidate.crest,
                    candidate.hp_crest,
                    candidate.diff_ratio,
                    candidate.hp_ratio
                );
            }
        }
    }
    eprintln!(
        "Done. Written {} mono frames → '{}'",
        output_samples.len(),
        output_path.display()
    );

    Ok(())
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Encode a set of i16 samples into an in-memory WAV byte buffer.
    fn make_wav_bytes_i16(samples: &[i16], channels: u16, sample_rate: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let spec = hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::new(cursor, spec).expect("WavWriter::new");
            for &s in samples {
                writer.write_sample(s).expect("write_sample");
            }
            writer.finalize().expect("finalize");
        }
        buf
    }

    /// Encode a set of f32 samples into an in-memory WAV byte buffer.
    fn make_wav_bytes_f32(samples: &[f32], channels: u16, sample_rate: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let spec = hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer = hound::WavWriter::new(cursor, spec).expect("WavWriter::new");
            for &s in samples {
                writer.write_sample(s).expect("write_sample");
            }
            writer.finalize().expect("finalize");
        }
        buf
    }

    fn read_bytes(bytes: Vec<u8>) -> Result<(Vec<f32>, u32, u16), String> {
        read_wav_from_reader(Cursor::new(bytes), "test")
    }

    // ── WAV reader tests ─────────────────────────────────────────────────────

    #[test]
    fn test_read_wav_i16_mono_48k() {
        let input: Vec<i16> = (0..4800_i16).map(|i| i.wrapping_mul(6)).collect();
        let bytes = make_wav_bytes_i16(&input, 1, 48_000);
        let (samples, sr, ch) = read_bytes(bytes).unwrap();
        assert_eq!(sr, 48_000);
        assert_eq!(ch, 1);
        assert_eq!(samples.len(), 4800);
        assert!(
            samples.iter().all(|s| s.is_finite()),
            "all samples must be finite"
        );
    }

    #[test]
    fn test_read_wav_i16_stereo_48k() {
        let input: Vec<i16> = (0..9600_i16).map(|i| i.wrapping_mul(3)).collect();
        let bytes = make_wav_bytes_i16(&input, 2, 48_000);
        let (samples, sr, ch) = read_bytes(bytes).unwrap();
        assert_eq!(sr, 48_000);
        assert_eq!(ch, 2);
        assert_eq!(samples.len(), 9600);
    }

    #[test]
    fn test_read_wav_f32_48k() {
        let input: Vec<f32> = (0..4800).map(|i| (i as f32) / 4800.0 - 0.5).collect();
        let bytes = make_wav_bytes_f32(&input, 1, 48_000);
        let (samples, sr, ch) = read_bytes(bytes).unwrap();
        assert_eq!(sr, 48_000);
        assert_eq!(ch, 1);
        assert_eq!(samples.len(), 4800);
    }

    #[test]
    fn test_read_wav_rejects_non_48khz() {
        let input = vec![0i16; 4410];
        let bytes = make_wav_bytes_i16(&input, 1, 44_100);
        let err = read_bytes(bytes).unwrap_err();
        assert!(
            err.contains("48 kHz"),
            "error should mention 48 kHz, got: {err}"
        );
    }

    #[test]
    fn test_read_wav_rejects_unsupported_channel_count() {
        // Build a 4-channel WAV header manually via hound (channels=4).
        let input: Vec<f32> = vec![0.0f32; 4 * 100];
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let spec = hound::WavSpec {
                channels: 4,
                sample_rate: 48_000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer = hound::WavWriter::new(cursor, spec).unwrap();
            for &s in &input {
                writer.write_sample(s).unwrap();
            }
            writer.finalize().unwrap();
        }
        let err = read_bytes(buf).unwrap_err();
        assert!(
            err.to_lowercase().contains("channel"),
            "error should mention channel count, got: {err}"
        );
    }

    // ── Processing tests ─────────────────────────────────────────────────────

    fn passthrough_config() -> FileTestConfig {
        FileTestConfig {
            noise_suppression: false,
            auto_gain_control: false,
            echo_cancellation: false,
            dereverb_mode: Some(VoiceDereverbMode::Off),
            ..FileTestConfig::default()
        }
    }

    #[test]
    fn test_passthrough_preserves_sample_count_mono() {
        // Non-power-of-2 length exercises the zero-pad + trim path.
        let total_frames = 5_003usize;
        let input: Vec<f32> = (0..total_frames)
            .map(|i| 0.01 * (i as f32 * 0.01).sin())
            .collect();
        let (output, _stats) = run_filter(&input, 1, &passthrough_config()).unwrap();
        assert_eq!(
            output.len(),
            total_frames,
            "output frame count must equal input"
        );
        assert!(
            output.iter().all(|s| s.is_finite()),
            "all output samples must be finite"
        );
    }

    #[test]
    fn test_zero_pad_and_trim() {
        // 961 is exactly one sample more than one DFN hop (960), so the second block
        // will be a single-sample partial that gets padded to a full frame.
        let total_frames = 961usize;
        let input = vec![0.05f32; total_frames];
        let (output, _stats) = run_filter(&input, 1, &passthrough_config()).unwrap();
        assert_eq!(
            output.len(),
            total_frames,
            "trimmed output must match original frame count"
        );
    }

    #[test]
    fn test_passthrough_stereo_produces_mono_output() {
        // Stereo input → downmixed mono output.
        let total_frames = 4800usize;
        let input: Vec<f32> = (0..total_frames * 2)
            .map(|i| 0.02 * (i as f32 * 0.005).sin())
            .collect();
        let (output, _stats) = run_filter(&input, 2, &passthrough_config()).unwrap();
        // Output should have total_frames mono samples.
        assert_eq!(output.len(), total_frames);
        assert!(output.iter().all(|s| s.is_finite()));
    }
}
