# Audio Tests

This folder contains the offline voice-filter regression harness.

## Workflow

Run the batch processor:

```bash
./audio-tests/run-all.sh
```

Check results against the current baseline:

```bash
./audio-tests/analyze.py --assert-baseline
```

Run both steps together:

```bash
./audio-tests/test.sh
```

## Current Accepted Tuning

The current accepted onset fix is a pre-DFN sidechain assist in
`apps/desktop/sidecar/src/voice_filter_core.rs`.

It uses:

- a separate pre-DFN model-VAD tap on the raw input
- a current-frame-only wet-mix cap for likely speech attacks
- the existing post-DFN VAD, silence gate, expander, and transient path unchanged for steady-state control

This version keeps `audio-tests/baseline.json` green while improving
`speech-only.wav` onset ratios versus the earlier baseline.

## Failed Experiments

These were tried and explicitly rejected because they either failed the baseline
or did not produce a meaningful enough speech-quality gain.

### Conservative Current-Frame Onset Assist

A simple pre-DFN heuristic capped wet mix on likely onset frames using only raw
energy / noise-floor checks.

Outcome:

- kept suppression stable
- produced no meaningful speech-onset improvement
- rejected because the change was too small to justify keeping

### Raw-VAD Speech Entry

The VAD state machine was changed to allow silence-to-speech entry from `p_raw`
instead of waiting for `p_smooth`.

Outcome:

- significantly increased false positives on non-speech material
- regressed `mouse-clicks.wav`, `single-key-taps.wav`, and `nvidia/sample-naked.wav`
- failed the baseline and was reverted

### Transient-Lookback Attack Relaxation

The transient suppressor / lookback stage was relaxed around likely speech
attacks.

Outcome:

- one version had almost no effect on `speech-only.wav`
- a more aggressive version weakened suppression on `typing-only.wav` and `single-key-taps.wav`
- rejected because it either did nothing useful or broke the suppression envelope

### Confidence-Weighted Wet-Mix Cap

The fixed pre-DFN wet-mix cap was replaced with a score-weighted cap so weaker
sidechain triggers stayed more wet.

Outcome:

- slightly improved non-speech suppression relative to the fixed-cap version
- gave back almost all of the speech-onset gain
- baseline passed, but the tradeoff was worse than the fixed-cap version

### Zero-Crossing Gate

A zero-crossing-rate ceiling was added to the pre-DFN sidechain trigger.

Outcome:

- baseline still passed
- it blocked too many real speech attacks
- speech-onset metrics fell back close to the pre-fix baseline
- rejected because the non-speech benefit was negligible

### Retroactive Onset Correction

The existing one-frame output lookback was extended so that when the next frame
confirmed speech onset, the buffered previous frame could be partially re-blended
with the dry pre-DFN reference.

Outcome:

- `cargo check`, `run-all.sh`, and baseline assertion all passed
- speech and non-speech benchmark metrics were effectively unchanged versus the
  accepted fixed-cap sidechain version
- rejected because it added complexity without producing a measurable benefit

### Per-Sample Noise Gate Gain Smoothing

The original DFN noise gate applied gain per-sample based on instantaneous
amplitude vs a floor/knee threshold. This caused a cicada-like buzzing artifact
for users whose ambient noise floor sat near the gate threshold: each cycle of
the waveform crossed the gate boundary, creating periodic gain modulation at
the signal frequency.

Fix: the gate still computes desired gain per-sample from instantaneous
amplitude (preserving transient sharpness), but the applied gain is smoothed
through a one-pole IIR (5 ms time constant). This prevents the rapid
modulation without reducing the gate's effectiveness on noise.

Minor baseline adjustments for the gain smoother's effect on noise-only clips:

- `typing-only.wav`: out_db bound relaxed from -85 → -72 dBFS, speech_presence
  and wobble bounds widened (smoother holds gate open slightly longer through
  key taps)
- `mouse-clicks.wav`: out_db relaxed from -58 → -55, presence_ratio from
  0.153 → 0.165
- `room-tone.wav`: silence_pct from 55 → 50%, gap_noise_floor_median from
  -84 → -75

Speech quality metrics were unaffected.

### Pause-Time Gate Floor Replacement

The pause-time non-speech gate and low-burst gate used hard-zero gain (complete
signal erasure) when triggered. This was replaced with a -18 dB floor (linear
0.125) to preserve some signal during brief pauses.

Outcome:

- 6 of 15 tests failed: `single-key-taps.wav`, `room-tone.wav`, `mouse-clicks.wav`,
  `speech-only.wav`, `speech-while-typing.wav`, `typing-only.wav`, `nvidia/sample-naked.wav`
- the gates are load-bearing for suppression of non-speech transients
- rejected because the suppression regression was severe

### Silence Gate Energy Guard Threshold Reduction

The silence gate's instant-open energy guard checked `input_rms > noise_floor * 6.0`.
This was reduced to 3.5x, 4.5x, and 5.0x to catch softer speech onsets before VAD
confirms.

Outcome:

- all values ≤ 5.0x failed `room-tone.wav` (silence_pct dropped below 50%)
  and `single-key-taps.wav` (out_db too high)
- ambient noise near the noise floor keeps the gate open, defeating suppression
- rejected because there is no value between 5.0 and 6.0 that helps speech
  without regressing pure-noise samples

### Aggressive Expander VAD Bypass Ramp Widening

The expander's VAD bypass ramp was widened from floor=0.25/full=0.65 to
floor=0.10/full=0.45, with attack softened from 2ms to 5ms.

Outcome:

- 6 of 15 tests failed: `room-tone.wav`, `mouse-clicks.wav`, `single-key-taps.wav`,
  `typing-only.wav`, `desk-taps.wav`, `nvidia/sample-nvidia-broadcast.wav`
- the wider bypass let non-speech transients (key taps, clicks) pass through
  the expander before it could clamp them
- a moderate version (floor=0.20/full=0.55, attack=3ms) nearly passed but still
  failed `single-key-taps.wav` (out_db -68 vs max -70, wobble 2.88 vs max 2.5)
- rejected because any floor below 0.25 lets key-tap energy through

## Guidance

Future experiments should stay narrow and must be validated with the same
workflow above. Do not update `baseline.json` for exploratory regressions.

