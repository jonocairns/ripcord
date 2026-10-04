# Video ownership (provider refactor stage 5)

Stage 5 extends native stack 1714928 above stage 4 at `c6943784`.
Session runtime extraction (stage 6) is outside this work.

## Webcam extraction

`webcam-controller.ts` owns acquisition, stream and producer identity, publication,
track-ended cleanup, stop, detach and republish. `useWebcam` supplies browser,
settings and server adapters and mounts cleanup in a layout effect. Construction
acquires no media. The existing control hook still publishes successful starts.
Webcam codec, bitrate, motion hint and `stopTracks: false` configuration are retained.

The owner alone publishes the webcam snapshot. `useLocalStreams` no longer holds
its producer or tears down its capture. Recovery delegates detach and republish;
failed republish retains live capture. Settings comparison and explicit restart
live beside the webcam owner; the combined listener remains in the provider until
the settings integration layer.

Stop and recovery read the immediately current owner stream instead of a rendered
stream or a passive-effect mirror. Publication reads committed current settings
instead of the callback's render-captured codec/resolution/frame rate. Acquisition
still snapshots constraints when it starts. These getter changes are intentional:
stop reaches capture published before a React render, and restart uses the current
settings. Production-factory tests exercise immediate stop, changed constraints,
transport replacement, native track end after republish and failed republish.
Deferred-start cancellation and stale callback fencing belong to a separate fix
layer, rather than being described as mechanical extraction.

## Screen-video extraction

`screen-share-controller.ts` owns picker integration, display/video publication,
track-ended handling, detach/republish, capture stop and quality-guard mounting.
`useScreenShare` supplies browser/dialog/desktop/timer adapters and the existing
tracing span. Selection normalization, sidecar capability gating, loopback
fallback acquisition and early video notification remain explicit. Optional
audio starts through the share-audio API after video publication.

Composition injects `isScreenVideoLive` into audio. Video calls audio operations;
audio imports no video controller and writes no video state. Video stop targets
video tracks; audio stop remains with its owner for mixed display streams.
Session cleanup calls the owners directly, while `useLocalStreams` retains only
React snapshots/setters. Stats and the quality guard use producer getters.
The framework-free guard preserves its sampling/floor/cooldown policy and its
producer identity check after awaited stats.

Screen stop/republish and the audio-liveness getter now read immediately current
owner state. Picker/audio/capture settings are snapshotted at invocation; video
publication reads committed current codec/resolution/frame rate. Production tests
cover optional-audio ordering, mixed-track delegation, failed republish, transport
replacement, retained track-ended handling and desktop adapter routing with
mocked bridge dependencies. They do not prove native capture or permissions.

## Combined media settings integration

`mountMediaSettingsIntegration` subscribes to committed input changes and owns
the previous-device comparison. `useMediaSettings` mounts it and supplies React
notifications. Tests import this production mount, covering mic-before-webcam
order, failed-mic continuation, individual-media changes, channel absence,
disabled webcam, independent overlaps and unsubscribe.

The mount retains the original effect's independent, uncancelled invocations.
Each invocation decides which media to restart before its microphone await;
webcam restart then reads current committed settings. Cleanup unsubscribes but
does not cancel an invocation already awaiting microphone restart. Any owner
fencing of overlapping webcam acquisition is in the separate lifecycle fix.

## Separate lifecycle fix layer

The three extraction commits are followed by `fix: fence video capture lifecycle
completions`. This layer deliberately changes races instead of hiding them in
mechanical moves:

| Boundary | Previous race | New behavior and production test evidence |
| --- | --- | --- |
| Deferred capture/publication | Stop, a later start or layout cleanup could be followed by an older acquisition/publication installing resources. | Lifecycle activation and operation generations fence acquisition, publication and sender-configuration completion. A late attempt closes only its allocation and capture. Both owners have a stop/supersession/cleanup matrix and lifecycle-replay tests. |
| Overlapping webcam restarts | Settings starts could finish in the opposite order and overwrite current capture. | The latest invoked webcam start owns completion. Acquisition is not serialized; stale work is rejected and cleaned. The production settings mount plus webcam factory verifies mic-before-webcam order and late restart completion; superseded work does not show a failure toast. |
| Track-ended identity | A callback retained an old producer, and an old screen callback could clear replacement video/audio. | Capture-scoped listeners survive detach, successful republish and failed republish, closing the current producer. Replaced-capture callbacks cannot mutate the successor or notify its controls. Tests invoke retained old callbacks directly. |
| Control-hook supersession | A superseded start rejection could make the existing catch handler stop preserved or replacement capture. | Video controls ignore explicit owner supersession while retaining successful-start state publication and ordinary failure cleanup. Expired recovery commands reject before detaching a current producer; production factory tests cover that boundary and the full browser suites validate the control wiring. |
| Late server allocations | A superseded producer could close before its server-close listener was installed. | Register allocation cleanup before awaiting sender configuration. Stale transport/sender completions close the allocated server producer by its immutable ID. |
| Screen startup and optional audio | Stop during picker preparation, acquisition or audio setup could be followed by early/final success or global cleanup of a successor. | Check the video attempt after every await and after early video notification. A stale picker selection returns null. Scoped audio discard delegates late mixed-stream audio tracks to their sole owner without stopping replacement audio. Tests hold teardown, preparation, capabilities and optional-audio completion, and exercise both real controller owners together. |
| Quality guard | A sender adjustment completing after disposal/replacement could still update guard bookkeeping. | Recheck producer identity and disposal after `setParameters`, including rejection, in addition to the existing stats check. Tests hold stats and sender adjustment across disposal/replacement. |

Detaching a producer invalidates pending publication but preserves capture and
its loss listener. Republish failure never stops preserved video. Terminal stop
revokes capture before clearing its React snapshot. Layout cleanup fences work
before passive session cleanup; mount cleanup is idempotent during replay.
The guard is mounted after screen publication, retained through producer detachment,
and disposed when capture stops. Idle owners install no polling interval. Its floor
thresholds, cooldown and codec/degradation policy are unchanged.
Session cleanup now delegates audio terminal stop once through screen stop;
recovery still detaches video and audio separately and calls their existing
republish/recovery operations. No session machine or retry policy was extracted.

The settings mount itself still starts independent invocations and preserves its
original mic-before-webcam decisions. It does not serialize them or cancel an
invocation waiting for microphone restart. Webcam lifecycle fencing governs
acquisition/publication, and reports supersession to that integration.

## Review follow-up

Superseded screen starts now settle only the current control transition's UI.
Composition injects the screen owner's current `isLive` getter: surviving capture
finishes the starting indicator without restoring the pinned view; absent capture
restores the stage. Neither path stops capture or invalidates its track-ended
callback. An older transition cannot settle a newer transition's UI. Tests import
the production settlement function and screen controller, holding acquisition and
publication through stop, replacement, successful republish and failed republish.
This getter is deliberately current owner state, not a render-captured snapshot.

Quality polling now starts with successful screen publication and stops with
capture, while producer detach retains the same guard for recovery. Mounting an
idle provider installs no interval. The production controller test verifies timer
ownership across pending publication, detach, republish, stop and native track end.

Failed desktop-audio recovery now releases retained loopback that did not transfer
to a published audio stream. This audio-only failure cleanup differs from video
republish failure, which continues preserving video capture.

Follow-up validation passed root type/lint/Knip checks, 670 voice unit tests in
58 files, the four unchanged screen-baseline E2E tests, one new acquisition/leave/
rejoin E2E test, and all 24 reconnect/remote-media/recovery-fault/session-conflict
tests. Browser retries remain zero. The new regression initially failed because
the baseline helper required one acquisition after this scenario's expected second
acquisition (expected 1, observed 2). Its scenario-specific assertion now requires
exactly two tracks, the abandoned one ended and the second live, then both ended
after stop. Existing baseline assertions and capture mechanism remain unchanged.

A fresh Linux desktop build and isolated, bounded packaged startup also passed:
the production renderer and bundled sidecar loaded. The smoke's own 20-second
timeout exited 124; it does not establish normal-close, capture or stop/reconnect
coverage. The native-device, permission/display-audio and macOS/Windows runtime
limits below still apply. T3 preview inspected the running isolated app again.

## Validation and evidence

Dependencies installed in `/tmp/ripcord-video-stage-5` through
`nix develop -c bun install --frozen-lockfile`. Existing worktrees and the untracked
plan were preserved. Biome `check --write` was scoped to the intentionally changed
TypeScript files; the formatted diff and `git diff --check` were reviewed. No root
`magic` command, development database reset or unrelated process termination was
used. No server/API, desktop bridge, codec policy, E2E fixture or lockfile changed.

- `nix develop -c bun run check-types`: passed across all workspaces.
- `nix develop -c bun run lint`: passed without lint warnings.
- `nix develop -c bun run knip`: passed; the existing 11 configuration hints remain.
- From `apps/client`, `nix develop -c bun test ./src/components/voice-provider ./src/features/server/voice`: 661 passed, 0 failed, 57 files (87 added tests).
- `CI=true nix develop -c bun run test:e2e e2e/tests/screen-share.spec.ts`: 4 passed, 0 failed, 28.6 seconds, zero retries.
- `nix develop -c bun run test:e2e e2e/tests/reconnect.spec.ts e2e/tests/remote-media.spec.ts e2e/tests/recovery-faults.spec.ts e2e/tests/session-conflict.spec.ts`: 24 passed, 0 failed, 3.5 minutes, zero retries.
- From `apps/desktop`, `nix develop -c bun run build`: passed, producing a fresh Linux package, client production bundle, main/preload and release sidecar.

The final control-boundary review added explicit supersession handling and a
pre-detach recovery lease check, followed by a new full check/unit/browser run.
Initial checks found an unused test-helper export, an overly broad audio-discard
signature, and a missing required RTP payload type in the new getter fixture.
These were corrected and rechecked; no assertion was removed or relaxed. No unit
or requested E2E assertion failed. The first direct sidecar health probe used an
unsupported `ping` method; reading the production dispatch identified `health.ping`,
which returned status `ok` and protocol version 1. This was a smoke-harness error.

Unit tests import production factories/mounts and mock browser tracks, acquisition,
transport, bridge and reporting dependencies. The combined video/audio suite uses
both production owners with injected browser resources/signaling. These tests prove
ownership and race handling, not native capture or encoded media.

The screen baseline's video-only `canvas.captureStream(30)` acquisition is unchanged.
E2E start/watch/stop and recovery use real application signaling, mediasoup, WebRTC,
RTP and decoded remote media. Camera/microphone acquisition remains Chromium fake
media; screen acquisition is the explicit canvas fixture. Neither proves physical
camera/microphone, OS picker permissions or actual tab/window/monitor capture, and
the screen fixture supplies no audio. Display-audio ownership is controller-tested.
The existing isolated E2E runner recreated only this worktree's `e2e/.runtime`.
Both required ports were free before each run; no existing process was killed.

T3 preview navigated to the running isolated app and successfully inspected its
rendered connection screen, semantic inputs/buttons and console. This supplements
the automated integration evidence without claiming preview capture coverage.

A fresh packaged Linux Electron 42.3.0 run used an isolated `XDG_CONFIG_HOME` under
`/tmp/ripcord-stage5-desktop-smoke`. Logs show the production `file://.../app.asar`
renderer loading and its bundled sidecar starting binary audio egress. The bounded
20-second smoke exited via its own timeout (124), with no remaining package/sidecar
process; it did not exercise normal window-close flushing or capture. Direct bundled
sidecar capability probing reported native audio unavailable because `libpulse.so`
could not load; X11 integration could not load `libX11.so`; and the session bus had
no desktop portal. These are environment coverage limits. Actual picker permission,
physical-device/display-audio capture, native RTP/worklet capture and packaged
stop/reconnect remain unverified. macOS/Windows packaged runtime was unavailable.
The old March package in the original workspace was left untouched and is not used
as evidence for this change.
