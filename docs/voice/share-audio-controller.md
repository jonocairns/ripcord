# Share-audio ownership (provider refactor stage 4)

Stage 4 is based on `main` at `50b1c74b474659ef5e39034827496991503ae9ae`.
The original untracked provider-refactor plan remains in `/home/jonoc/ripcord`.
Stage 5 (webcam and screen-video controller extraction) is outside this change.

## Production boundary

`share-audio-controller.ts` is the framework-free owner of browser display
audio, native RTP ingest, renderer worklet capture, the published audio stream,
producer identity, desktop publish intent, subscriptions, startup timeout,
fallback, recovery and teardown. Construction acquires no media. Dependencies
supply the bridge, signaling, transport getter, pipeline factory, stream factory
and publication, timers, reporting and `isScreenVideoLive()`.

`use-share-audio.ts` retains one instance, supplies committed current inputs and
production adapters, and mounts it in a layout effect. The existing desktop
recovery controller still owns its serialized recovery queue and lifecycle
leases. Its mount helper now lives beside that framework-free controller; the
unused React recovery wrapper is removed. No session/retry policy is introduced.

The provider retains screen selection, display acquisition, screen-video
publication, the early video-start notification and screen-video cleanup.
Immediately after acquisition it hands audio ownership to `adoptDisplayAudio`;
that also covers video publication failure before audio startup. It then calls
`start` for optional audio. Explicit stop, screen-video ending and terminal
session cleanup call `stop`. Reconnect cleanup calls `detachProducer`, retaining
capture and desktop intent. The republish plan delegates audio to `republish`,
and existing session recovery call sites delegate to `recover`.

Audio calls no screen lifecycle operation. Composition supplies video liveness
from the installed video producer or the preserved screen stream. All screen
audio producer and stream writes are private to its owner; `useLocalStreams`
retains the React snapshot/setter and no audio teardown or producer ref. Video
cleanup targets video tracks; audio cleanup targets audio tracks, even for a
mixed display stream. The never-populated standby display-audio refs are gone.

Native startup still returns publication, abandonment or operational fallback.
Authorization denial rejects without another publication path. Session and
transport IDs belong to individual attempts. Worklet startup preserves stable
queue mode, dropped-frame silence insertion, the three-second first-frame gate,
capability guidance and live system-loopback fallback. Opus settings, capture
mechanisms, server/API contracts, desktop bridge contracts and the consumed
`useVoice` API are unchanged.

## Mechanical extraction versus deliberate race changes

The native/worklet algorithms, status messages, settings, fallback decisions
and recovery serialization move together. The final stack separately fixes native
teardown completion and display-fallback ownership during recovery. The following
ownership changes have
separate regression assertions; they are not claims of a purely mechanical move:

| Boundary | Previous behavior / potential race | Deliberate behavior and test evidence |
| --- | --- | --- |
| Stream reads | Stop captured rendered streams; cleanup/republish read passive-effect stream refs. | Operations read the owner's immediately current stream. The browser stop test stops freshly published audio before a React snapshot could update. Failed republish retains live capture. |
| Native setting | Native rollout read a value captured by the provider callback. | The native entry reads the latest committed rollout setting after pending teardown. A setting changed while teardown is held switches the successor to worklet. LocalStorage/build overrides keep their precedence. |
| Video liveness | Recovery read the passive screen-stream ref. | The injected getter checks the current installed video track, falling back to preserved capture during reconnect. Startup and recovery check liveness without waiting for a stream-state render. The recovery test supplies changing liveness. |
| Browser publication | Deferred browser publication and old track callbacks lacked capture-generation fencing. | Stop, supersession and layout cleanup fence publication. Callback identity prevents an old handler from clearing a republished stream. Track cleanup survives expiry of the completed session command's publication lease. |
| Pending cleanup | Queued cleanup detached shared resources only after waiting for its predecessor. | Cleanup detaches its own resource snapshot synchronously, then queues destruction. A new start waits for committed-resource teardown. Attempt-local late teardown uses its own session and transport IDs. |

Lifecycle cleanup fences startup and recovery before passive session effects can
run. Obsolete work cleans its own session/ingest/pipeline. `awaitTeardown` drains
the committed-resource cleanup queue; it does not make an unresolved bridge
acquisition cancellable. Its eventual result is rejected by the attempt's lease
and cleaned with attempt-owned IDs.

## Unit and integration evidence

`native-app-audio-ingest.test.ts` now imports the production controller through a
controlled dependency fixture. The copied native setup/commit functions and
`makeSerializedRecovery` are deleted. Its header accurately distinguishes the
real machine tests in `recover-transport-session.test.ts`.

Both serialization assertions now use the real recovery controller with
`mountDesktopAppAudioRecoveryController` active until assertions finish.
Existing queued-cancellation coverage remains. New production-controller tests
cover stop/supersede/layout cleanup during native capture, ingest allocation,
RTP start and native publication, and during worklet capture, pipeline creation,
publication and failure-capability lookup. They also cover auth denial,
no-first-media fallback, worklet failure with live/ended loopback, old frame/status
callbacks, startup expiry, lifecycle replay with queued recovery, old teardown
completion and browser publication/republish/cleanup. PCM, queue, pipeline,
subscription and recovery coverage is retained.

Controller tests mock acquisition, bridge calls, transport/signaling, pipeline
creation and browser track/stream objects. They prove production ownership and
branching; they do not prove physical capture, SRTP encoding, UDP ingress or real
WebRTC media flow.

The four screen E2E tests retain the exact video-only canvas acquisition fixture.
They exercise production signaling, mediasoup, WebRTC, remote decoded screen
video, explicit cleanup, producer/watcher reconnect and stop during a held
transport rebuild. They provide no browser display-audio acquisition evidence.
The existing isolated `e2e/start-server.ts` harness recreates only this worktree's
`e2e/.runtime`; the normal development database is untouched.

## Validation and coverage limits

Commands run through Nix with frozen-lockfile dependency installation. Biome
`check --write` was scoped to intentionally changed TypeScript paths; its diff
was reviewed and `git diff --check` passed. No root `magic` command was used.

- `bun run check-types`: passed across all workspaces.
- `bun run lint`: passed without lint warnings.
- `bun run knip`: passed, with the existing 11 configuration hints.
- Client voice-provider/server-voice unit suites: 571 passed, 0 failed, 51 files.
- `CI=true bun run test:e2e e2e/tests/screen-share.spec.ts`: 4 passed, 0 failed,
  26.0 seconds, zero retries.
- Reconnect/remote-media/recovery-faults/session-conflict E2E: 24 passed, 0 failed,
  3.9 minutes, zero retries.

Initial type validation found widened literal types in test mocks; explicit
literal inference corrected them. Initial Knip validation found the obsolete
React recovery adapter; removal retained the real mount function and tests.
These were corrected and rechecked without changing assertions or recovery
policy. No unit or requested E2E assertion failed.

T3 preview opened the real isolated Vite app and read its rendered connection
screen. Snapshot calls returned generic preview automation errors, including
after explicit navigation; evaluation worked intermittently. A supplemental
production `createDesktopAppAudioPipeline` smoke used synthetic 48 kHz stereo
440 Hz PCM, the real renderer AudioWorklet and two browser peer connections.
It observed 20,058 received RTP bytes / 249 packets over five seconds and an
ended output track after pipeline destroy. The first harness omitted a remote
playback sink: decoded samples and audio energy were zero, so it establishes
RTP transmission and teardown only. Adding a muted audio sink was attempted,
but subsequent preview evaluation failed and its decoding result is unavailable.
This is separate from application/server signaling evidence and does not prove
native capture or audible/decoded audio. It did not modify the screen fixture.

No packaged desktop artifact is available in the worktrees (the original
workspace has development main/preload bundles only). Packaged Electron,
sidecar/native RTP, OS capture permissions, actual tab/window/monitor and system
loopback acquisition, physical audio devices, and Linux/macOS/Windows desktop
stop/reconnect smoke coverage remain unavailable. A visible preview or synthetic
PCM is not evidence for those integrations.
