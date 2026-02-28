#!/usr/bin/env python3
"""Analyze voice-filter output quality: onset timing, silence suppression, and levels.

Compares each input WAV in audio-tests/ with its filtered counterpart in
audio-tests/.outputs/ and prints a summary table plus optional per-file detail.

Usage:
  ./audio-tests/analyze.py                  # summary table
  ./audio-tests/analyze.py --detail         # summary + per-file onset breakdown
  ./audio-tests/analyze.py --detail speech-only  # detail for matching files only
  ./audio-tests/analyze.py --assert-baseline     # fail if current output misses baseline
"""

import argparse
import glob
import json
import math
import os
import struct
import sys

SAMPLE_RATE = 48000
FRAME_SAMPLES = 480  # 10ms at 48kHz

# Thresholds for analysis
SILENCE_THRESHOLD_DBFS = -80.0
SPEECH_ONSET_THRESHOLD_DBFS = -40.0
SPEECH_OFFSET_THRESHOLD_DBFS = -55.0
STARTUP_SKIP_FRAMES = 120  # skip first 1.2s (startup ramp)
MIN_SILENCE_GAP_FRAMES = 10  # 100ms minimum silence before counting as onset


def read_wav(path):
    """Read a WAV file (PCM i16, i32, or float32; mono or stereo) and return mono samples."""
    with open(path, "rb") as f:
        data = f.read()

    fmt_idx = data.find(b"fmt ")
    if fmt_idx < 0:
        return None

    audio_fmt = struct.unpack_from("<H", data, fmt_idx + 8)[0]
    nch = struct.unpack_from("<H", data, fmt_idx + 10)[0]
    sr = struct.unpack_from("<I", data, fmt_idx + 12)[0]
    bps = struct.unpack_from("<H", data, fmt_idx + 22)[0]

    data_idx = data.find(b"data")
    if data_idx < 0:
        return None
    data_size = struct.unpack_from("<I", data, data_idx + 4)[0]
    raw = data[data_idx + 8 : data_idx + 8 + data_size]

    is_float = (audio_fmt == 3) or (audio_fmt == 0xFFFE and bps == 32)

    if bps == 16:
        n = len(raw) // 2
        samples = [s / 32768.0 for s in struct.unpack("<" + "h" * n, raw)]
    elif bps == 32 and is_float:
        n = len(raw) // 4
        samples = list(struct.unpack("<" + "f" * n, raw))
    elif bps == 32:
        n = len(raw) // 4
        samples = [s / 2147483648.0 for s in struct.unpack("<" + "i" * n, raw)]
    else:
        return None

    # Downmix to mono
    if nch >= 2:
        mono = []
        for i in range(0, len(samples) - nch + 1, nch):
            mono.append(sum(samples[i : i + nch]) / nch)
        return mono

    return samples


def frame_rms(samples, frame_idx):
    """Compute RMS of a single 10ms frame."""
    start = frame_idx * FRAME_SAMPLES
    end = start + FRAME_SAMPLES
    chunk = samples[start:end]
    if not chunk:
        return 0.0
    return math.sqrt(sum(s * s for s in chunk) / len(chunk))


def to_dbfs(linear):
    return 20 * math.log10(linear + 1e-10)


def find_onsets(samples, n_frames):
    """Find silence->speech transitions after the startup skip."""
    threshold_speech = 10 ** (SPEECH_ONSET_THRESHOLD_DBFS / 20)
    threshold_silence = 10 ** (SPEECH_OFFSET_THRESHOLD_DBFS / 20)

    in_silence = True
    silence_start = STARTUP_SKIP_FRAMES
    onsets = []

    for i in range(STARTUP_SKIP_FRAMES, n_frames):
        rms = frame_rms(samples, i)
        if in_silence and rms > threshold_speech:
            in_silence = False
            if i - silence_start >= MIN_SILENCE_GAP_FRAMES:
                onsets.append(i)
        elif not in_silence and rms < threshold_silence:
            in_silence = True
            silence_start = i

    return onsets


def summarize_onset_ratios(onset_ratios):
    """Return aggregate onset metrics for threshold-based assertions."""
    values = [ratio for _, ratio in onset_ratios]
    if not values:
        return {
            "onset_ratio_count": 0,
            "onset_ratio_min": None,
            "onset_ratio_max": None,
            "onset_ratio_avg": None,
        }

    return {
        "onset_ratio_count": len(values),
        "onset_ratio_min": min(values),
        "onset_ratio_max": max(values),
        "onset_ratio_avg": sum(values) / len(values),
    }


def analyze_file(inp_path, out_path, show_detail=False):
    """Analyze a single input/output pair. Returns summary dict."""
    inp = read_wav(inp_path)
    out = read_wav(out_path)

    if inp is None or out is None:
        return None

    n_frames = min(len(inp) // FRAME_SAMPLES, len(out) // FRAME_SAMPLES)

    # Overall RMS
    inp_total = len(inp[: n_frames * FRAME_SAMPLES])
    out_total = len(out[: n_frames * FRAME_SAMPLES])
    inp_rms = math.sqrt(
        sum(s * s for s in inp[: n_frames * FRAME_SAMPLES]) / max(inp_total, 1)
    )
    out_rms = math.sqrt(
        sum(s * s for s in out[: n_frames * FRAME_SAMPLES]) / max(out_total, 1)
    )

    # Count silent output frames (after startup)
    silence_thresh = 10 ** (SILENCE_THRESHOLD_DBFS / 20)
    silent_frames = 0
    total_frames = 0
    for i in range(STARTUP_SKIP_FRAMES, n_frames):
        total_frames += 1
        if frame_rms(out, i) < silence_thresh:
            silent_frames += 1

    silence_pct = (silent_frames / total_frames * 100) if total_frames > 0 else 0

    # Find onsets and compute ratios
    onsets = find_onsets(inp, n_frames)
    onset_ratios = []
    for onset_frame in onsets:
        in_rms = frame_rms(inp, onset_frame)
        out_rms_val = frame_rms(out, onset_frame)
        ratio = out_rms_val / (in_rms + 1e-10)
        onset_ratios.append((onset_frame, ratio))

    result = {
        "inp_db": to_dbfs(inp_rms),
        "out_db": to_dbfs(out_rms),
        "silence_pct": silence_pct,
        "onset_ratios": onset_ratios,
    }
    result.update(summarize_onset_ratios(onset_ratios))

    if show_detail and onset_ratios:
        print(f"\n  Onset detail:")
        for onset_frame, _ in onset_ratios[:6]:
            start = max(0, onset_frame - 3)
            end = min(n_frames, onset_frame + 12)
            print(
                f"    {'Frame':>5} {'Time':>7} | {'IN RMS':>10} {'IN dB':>7} | {'OUT RMS':>10} {'OUT dB':>7} | {'Ratio':>7}"
            )
            for i in range(start, end):
                ir = frame_rms(inp, i)
                orv = frame_rms(out, i)
                marker = " <--" if i == onset_frame else ""
                print(
                    f"    {i:5d} {i*10:5d}ms | {ir:10.6f} {to_dbfs(ir):7.1f} | {orv:10.6f} {to_dbfs(orv):7.1f} | {orv/(ir+1e-10):7.3f}{marker}"
                )
            print()

    return result


def load_baseline(path):
    """Load a baseline JSON file containing per-file min/max thresholds."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        raise ValueError("baseline file must be a JSON object with a top-level 'files' map")

    return data["files"]


def check_metric_bounds(rel_path, metric_name, actual_value, bounds):
    """Validate a single metric against min/max bounds."""
    failures = []

    if not isinstance(bounds, dict):
        failures.append(
            f"{rel_path}: baseline for '{metric_name}' must be an object with optional 'min'/'max'"
        )
        return failures

    for bound_name in ("min", "max"):
        if bound_name not in bounds:
            continue

        expected = bounds[bound_name]
        if actual_value is None:
            failures.append(
                f"{rel_path}: {metric_name} is unavailable but baseline requires {bound_name} {expected}"
            )
            continue

        if bound_name == "min" and actual_value < expected:
            failures.append(
                f"{rel_path}: {metric_name}={actual_value:.3f} is below baseline min {expected:.3f}"
            )
        elif bound_name == "max" and actual_value > expected:
            failures.append(
                f"{rel_path}: {metric_name}={actual_value:.3f} exceeds baseline max {expected:.3f}"
            )

    return failures


def evaluate_baseline(results_by_file, baseline_by_file):
    """Compare current analysis results to the configured baseline."""
    failures = []

    for rel_path, expected_metrics in baseline_by_file.items():
        result = results_by_file.get(rel_path)
        if result is None:
            failures.append(f"{rel_path}: no analysis result found")
            continue

        if not isinstance(expected_metrics, dict):
            failures.append(f"{rel_path}: file baseline must be an object of metric bounds")
            continue

        for metric_name, bounds in expected_metrics.items():
            if metric_name not in result:
                failures.append(f"{rel_path}: unsupported baseline metric '{metric_name}'")
                continue
            failures.extend(
                check_metric_bounds(rel_path, metric_name, result.get(metric_name), bounds)
            )

    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--detail",
        nargs="?",
        const="",
        default=None,
        metavar="FILTER",
        help="Show per-file onset detail. Optional filter string to match filenames.",
    )
    parser.add_argument(
        "--input-root",
        default=None,
        help="Input WAV root directory (default: audio-tests/)",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Filtered output directory (default: audio-tests/.outputs/)",
    )
    parser.add_argument(
        "--baseline",
        default=None,
        help="Path to a JSON baseline file with per-file metric thresholds.",
    )
    parser.add_argument(
        "--assert-baseline",
        action="store_true",
        help="Fail with exit code 1 if results fall outside the configured baseline.",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)

    input_root = args.input_root or os.path.join(repo_root, "audio-tests")
    out_dir = args.out_dir or os.path.join(input_root, ".outputs")
    baseline_path = args.baseline

    if args.assert_baseline and baseline_path is None:
        baseline_path = os.path.join(script_dir, "baseline.json")

    baseline_by_file = None
    if baseline_path is not None:
        try:
            baseline_by_file = load_baseline(baseline_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"Failed to load baseline {baseline_path}: {exc}", file=sys.stderr)
            sys.exit(1)

    if not os.path.isdir(out_dir):
        print(f"Output directory not found: {out_dir}", file=sys.stderr)
        print("Run ./audio-tests/run-all.sh first.", file=sys.stderr)
        sys.exit(1)

    inputs = sorted(glob.glob(os.path.join(input_root, "**", "*.wav"), recursive=True))
    inputs = [p for p in inputs if "/.outputs/" not in p and "\\.outputs\\" not in p]

    if not inputs:
        print(f"No .wav files found under {input_root}", file=sys.stderr)
        sys.exit(1)

    header = f"{'File':35s} | {'IN':>7} {'OUT':>7} | {'Silent':>7} | Onset ratios (OUT/IN at transition)"
    print(header)
    print("-" * len(header) + "-" * 30)

    results_by_file = {}

    for inp_path in inputs:
        rel = os.path.relpath(inp_path, input_root)
        stem = rel.replace(".wav", "")
        out_path = os.path.join(out_dir, f"{stem}.filtered.wav")

        if not os.path.exists(out_path):
            if baseline_by_file is not None:
                results_by_file[rel] = None
            continue

        show_detail = args.detail is not None and (
            args.detail == "" or args.detail.lower() in rel.lower()
        )

        print(f"{rel:35s}", end=" | ")

        result = analyze_file(inp_path, out_path, show_detail=show_detail)
        if result is None:
            print("SKIP (unsupported format)")
            if baseline_by_file is not None:
                results_by_file[rel] = None
            continue

        if baseline_by_file is not None:
            results_by_file[rel] = result

        onset_str = (
            ", ".join(
                [f"f{f}={r:.2f}" for f, r in result["onset_ratios"][:4]]
            )
            or "none"
        )

        print(
            f"{result['inp_db']:6.1f}dB {result['out_db']:6.1f}dB | {result['silence_pct']:5.1f}%  | {onset_str}"
        )

    if baseline_by_file is None:
        return

    failures = evaluate_baseline(results_by_file, baseline_by_file)
    if failures:
        print("\nBaseline check: FAIL", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        if args.assert_baseline:
            sys.exit(1)
        return

    print("\nBaseline check: PASS")


if __name__ == "__main__":
    main()
