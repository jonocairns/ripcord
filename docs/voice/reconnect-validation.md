# Automated voice audio isolation

This follow-up starts from stage 7 head
`052332b67a90f6d667746813e80269e2be02187e`, above open PRs #339, #340, #342 and
#343. It changes the browser test harness, with application and server behavior
unchanged. The isolated worktree is `/tmp/ripcord-voice-recovery-coverage`.

## Long-offline investigation

The existing reconnect test takes the browser offline for 65 seconds and expects
`Connected` within 45 seconds after returning online. On the original harness it
remains `Connecting`, even though authentication and channels recover. The same
failure was reproduced on untouched main `cfe0f366` and the exact stage 7 starting
head `6834c8d4`; the earlier validation records retain those failures.

Temporary timing logs on stage 7 head identify the pending await as native
microphone acquisition: `microphone-pipeline-controller.ts` awaits
`ports.getUserMedia`, which calls `navigator.mediaDevices.getUserMedia`. Cleanup
and remote producer synchronization complete. The microphone uses volume 100
with WASM processing disabled, so neither gain nor WASM pipeline teardown can
account for the hang. Server logs show successful restore requests.

A direct browser reproduction, without joining voice or creating peer
connections, also hangs after 65 seconds offline. It acquires the fake microphone
and camera, waits offline, returns online, stops the microphone and acquires it
again. Microphone constraints retain echo cancellation, automatic gain and noise
suppression with a 48 kHz sample rate. The native promise remains pending after
10 seconds; the online control completes in 2.9 ms.

| Output configuration | Direct offline acquisition | Original reconnect test |
| --- | --- | --- |
| Original host output | Pending after 10 seconds | Failed at unchanged Connected assertion |
| Fake output stream | Completed in 2.9 ms | Passed; microphone acquired in 26 ms and camera RTP resumed |
| Host output restored | Pending after 10 seconds again | Earlier failure retained |

HMR suppression is the same in the fake-output and final host-output controls.
All runs use zero retries. The WSLg environment points PulseAudio at
`unix:/mnt/wslg/PulseServer`; browser stderr reports large audio delays and a
PulseAudio-to-ALSA fallback in the online control. The comparison implicates the
Chromium/host output path, but does not identify its exact blocked native call or
establish a specific upstream defect.

## Harness change and limits

The existing fake microphone/camera and permission flags remain. The harness
adds `--disable-audio-output`. Chromium's
[audio manager implementation](https://github.com/chromium/chromium/blob/149.0.7827.55/media/audio/audio_manager_base.cc)
selects a fake output stream for this switch; muting alone still uses OS output.
The application continues to acquire, process, publish, signal and consume
media through its production paths. No capture promise is mocked to succeed,
microphone setting changed, timeout extended or reconnect assertion weakened.

The original three reconnect tests remain the regression coverage for this
layer. Direct reproduction artifacts and timing logs are retained under
`/tmp/ripcord-reconnect-evidence`. Physical devices, OS permissions, native capture
and packaged desktop behavior are not covered. No test tone or desktop takeover
is used. The screen baseline's video-only canvas capture is unchanged.

The old test title also overstates server grace coverage: observed server grace
ages are approximately 24–25 seconds, below the 60-second limit, and restores use
the existing-session path. Browser offline duration does not establish when the
server observed socket loss. A separate coverage layer must verify actual server
grace expiry and microphone media, retaining the existing long-offline assertions.

## Validation

The output-isolation layer passes root `check-types`, `lint` (no warnings) and
`knip` (the same 11 configuration hints). Scoped Biome formatting and
`git diff --check` pass. The frozen install leaves the lockfile unchanged.

- Voice unit command: 742 passed across 62 files, 2,300 assertions.
- Original `reconnect.spec.ts`, unchanged: 3 passed (1.5 minutes), zero retries.

The prior stage 7 record remains 6 screen E2E passes and 23 recovery passes with
one long-offline failure under the original output configuration. Full-suite
validation follows the separate server-grace/microphone coverage layer.
