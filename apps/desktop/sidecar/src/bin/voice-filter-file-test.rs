//! Offline voice-filter file-test binary.
//!
//! Runs the sidecar voice-filter DSP pipeline against a local WAV file without
//! starting Electron or the JSON/stdin sidecar service.
//!
//! # Usage
//!
//! ```sh
//! cargo run --manifest-path apps/desktop/sidecar/Cargo.toml \
//!           --bin voice-filter-file-test -- \
//!   --input ./sample.wav \
//!   --output ./sample.filtered.wav \
//!   --suppression-level balanced \
//!   --noise-suppression \
//!   --no-auto-gain-control \
//!   --no-echo-cancellation \
//!   --mix 1.0 \
//!   --dereverb-mode tail
//! ```
//!
//! Input must be a 48 kHz WAV (PCM i16 or IEEE float f32, mono or stereo).
//! Output is a mono 48 kHz 32-bit float WAV.  Duration matches the input exactly.

use clap::{ArgAction, Parser, ValueEnum};
use sharkord_capture_sidecar::file_test::{run_file_test, FileTestConfig};
use sharkord_capture_sidecar::voice_filter_core::{
    VoiceDereverbMode, VoiceFilterDfnTuningParams, VoiceFilterStrength,
};
use std::path::PathBuf;
use std::process;

// ─── CLI ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum CliSuppressionLevel {
    Low,
    Balanced,
    High,
    Aggressive,
}

impl From<CliSuppressionLevel> for VoiceFilterStrength {
    fn from(level: CliSuppressionLevel) -> Self {
        match level {
            CliSuppressionLevel::Low => VoiceFilterStrength::Low,
            CliSuppressionLevel::Balanced => VoiceFilterStrength::Balanced,
            CliSuppressionLevel::High => VoiceFilterStrength::High,
            CliSuppressionLevel::Aggressive => VoiceFilterStrength::Aggressive,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum CliDereverbMode {
    Off,
    Tail,
}

impl From<CliDereverbMode> for VoiceDereverbMode {
    fn from(mode: CliDereverbMode) -> Self {
        match mode {
            CliDereverbMode::Off => VoiceDereverbMode::Off,
            CliDereverbMode::Tail => VoiceDereverbMode::Tail,
        }
    }
}

/// Offline voice-filter pipeline test harness.
///
/// Processes a 48 kHz WAV file through the same DSP used by the live sidecar
/// and writes a processed mono 48 kHz 32-bit float WAV to the output path.
#[derive(Debug, Parser)]
#[command(name = "voice-filter-file-test")]
struct Args {
    /// Path to the input WAV file (48 kHz, PCM i16 or float f32, mono or stereo).
    #[arg(short, long)]
    input: PathBuf,

    /// Path to write the processed output WAV.
    #[arg(short, long)]
    output: PathBuf,

    /// DeepFilterNet suppression strength.
    #[arg(long, value_enum, default_value = "balanced")]
    suppression_level: CliSuppressionLevel,

    /// Enable noise suppression (DeepFilterNet).
    #[arg(long, action = ArgAction::SetTrue, default_value = "true")]
    noise_suppression: bool,

    /// Disable noise suppression.
    #[arg(long, action = ArgAction::SetFalse, overrides_with = "noise_suppression")]
    no_noise_suppression: bool,

    /// Enable post-DFN slow trim (AGC).
    #[arg(long, action = ArgAction::SetTrue, default_value = "false")]
    auto_gain_control: bool,

    /// Disable post-DFN slow trim (AGC).
    #[arg(long, action = ArgAction::SetFalse, overrides_with = "auto_gain_control")]
    no_auto_gain_control: bool,

    /// Enable echo cancellation.
    #[arg(long, action = ArgAction::SetTrue, default_value = "false")]
    echo_cancellation: bool,

    /// Disable echo cancellation.
    #[arg(long, action = ArgAction::SetFalse, overrides_with = "echo_cancellation")]
    no_echo_cancellation: bool,

    /// Tail dereverb mode.  When omitted, `tail` is used with noise suppression and `off` without.
    #[arg(long, value_enum)]
    dereverb_mode: Option<CliDereverbMode>,

    /// DFN wet/dry mix in [0.0, 1.0] (1.0 = fully processed).
    #[arg(long)]
    mix: Option<f32>,

    /// Maximum per-band attenuation limit in dB [0..60].
    #[arg(long)]
    attenuation_limit_db: Option<f32>,

    /// Enable experimental aggressive suppression mode.
    #[arg(long, action = ArgAction::SetTrue)]
    experimental_aggressive_mode: bool,

    /// Noise-gate floor in dBFS [-80..-36].
    #[arg(long)]
    noise_gate_floor_dbfs: Option<f32>,

    /// Print extra per-run diagnostics for DFN wet mix and transient trigger counts.
    #[arg(long, action = ArgAction::SetTrue)]
    debug_diag: bool,
}

// ─── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    let args = Args::parse();

    let dfn_tuning = VoiceFilterDfnTuningParams {
        attenuation_limit_db: args.attenuation_limit_db,
        mix: args.mix,
        experimental_aggressive_mode: if args.experimental_aggressive_mode {
            Some(true)
        } else {
            None
        },
        noise_gate_floor_dbfs: args.noise_gate_floor_dbfs,
    };

    let config = FileTestConfig {
        suppression_level: args.suppression_level.into(),
        noise_suppression: args.noise_suppression,
        auto_gain_control: args.auto_gain_control,
        echo_cancellation: args.echo_cancellation,
        dereverb_mode: args.dereverb_mode.map(Into::into),
        dfn_tuning,
        debug_diagnostics: args.debug_diag,
    };

    if let Err(error) = run_file_test(&args.input, &args.output, &config) {
        eprintln!("error: {error}");
        process::exit(1);
    }
}
