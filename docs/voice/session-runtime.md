# Voice session runtime

`VoiceProvider` composes resource owners, controls, the remote-media adapter,
media-element refs and context publication. The seven-stage extraction is
implemented; [provider-composition.md](./provider-composition.md) describes the
final ownership and public operations. Stage 6 extracted the runtime effects
described here.

`createVoiceSessionRuntime` is a framework-free factory with injected current
value getters, resource APIs, signaling, device creation, state publication,
tracing and timing. It owns the mediasoup device and RTP-capability integration,
initialization, rejoin, transport rebuild effects, reconnect restore effects,
local media republish coordination and terminal cleanup. Construction acquires
no media, creates no transports and calls no server API.

`useVoiceSessionRuntime` retains the runtime, supplies committed inputs, mounts
activation in a layout effect ahead of passive executor work, and supplies its
effects to the existing `useVoiceSessionExecutor`. The environment module keeps
production server/browser adapters, reporting and the existing 12-second
rebuild boundary timeout and 350-ms post-rejoin producer refresh delay.

The session machine still owns phases, retry and terminal decisions, command
identity and accepted transport-recovery transitions. The executor still owns
command scheduling, cancellation, restore timeouts and bounded draining.
The runtime invokes existing circuit helpers and commits their bookkeeping only
for accepted machine transitions; it introduces no recovery policy.

Microphone, webcam, screen video and share audio remain the sole owners of their
resources. Runtime effects call their public APIs and never mutate controller
state. Microphone preparation still starts before device loading finishes, and
producer/consumer transport creation remains parallel. Rebuild retains the
recovery-specific microphone decision helper; WebSocket restore cleans and
reacquires the microphone while preserving video/audio capture for republishing.

`terminalCleanup` stops capture through the resource owners, clears remote
streams, transport state, stats, activity, media-element refs and capabilities.
`recoveryCleanup` detaches video/audio producers, retains capture and remote watch
intent, and clears the microphone for reconnect reacquisition. In-session rebuild
retains its narrower transport cleanup so a live microphone can be republished.
Screen terminal stop reaches share-audio teardown through the screen owner's
existing contract. Failed preserved-media republishing does not stop capture.

Watch intent is captured from the existing subscription ledger and restored
through its rehydration operation. Remote-producer reconciliation and immediate
and delayed rejoin refreshes still use the transport owner's existing sweep.
The executor records server-session establishment immediately after restore
returns; later initialization failure does not erase that generation's ownership.
Terminal failure sends the existing server leave request when a server seat was
established, performs local cleanup before awaiting it, and performs no resource
cleanup after that leave completes.

Unit coverage imports the production factory and mount seam and controls device,
server, transport and media-owner boundaries. It proves orchestration and
ownership, not physical acquisition or encoded media. Browser coverage retains
real signaling, mediasoup, WebRTC and decoded-media assertions with fake camera
and microphone and the unchanged video-only canvas screen fixture. Browser
screen audio, physical devices, native picker permissions, OS capture, sidecar
capture and packaged desktop cleanup/reconnect need separate platform validation.

## Currency hardening

The mechanical extraction is a separate stack layer from these deliberate
behavior changes. Deferred-operation tests reproduced eleven missing-currency
failures before the fixes. The fixes add effect fencing rather than changing
retry, timeout, phase or command-identity policy.

- An already stale init or rebuild rejects before claiming execution or cleaning
  shared state. Device construction, rejoin signaling and local republication
  each recheck currency before the next effect.
- Restore claims one concrete execution lease before its server request and
  retains that lease through initialization. Runtime deactivation, cleanup or a
  successor init fences a response even before passive executor disposal runs.
  Server establishment is still recorded before rejecting a stale response.
- Failed init/rebuild effects revoke their attempt's publication currency before
  awaiting other work. They detach and clean transport resources only while they
  still own the runtime, retaining capture for recovery. A pending half of a
  failed transport pair cannot publish after the other half rejects.
- Recovery publication and finalization require confirmed connectivity. Inactive
  runtime callbacks cannot restore watch intent, recover desktop audio or run
  terminal server/local finalization against a replacement provider.

These checks supplement the existing executor and media-controller leases; they
neither mint commands nor retry work. `useVoice` and server/desktop contracts are
unchanged. Tests also cover timeout detachment, late microphone publication,
partial rebuild failure, lifecycle replay, disconnected boundaries and terminal
leave completion after a successor is initialized.
