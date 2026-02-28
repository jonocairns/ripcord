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

## Guidance

Future experiments should stay narrow and must be validated with the same
workflow above. Do not update `baseline.json` for exploratory regressions.
