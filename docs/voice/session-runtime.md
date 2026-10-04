# Voice session runtime

Stage 6 extracts concrete session effects from `VoiceProvider`. Stage 7 has not
started. The provider still composes resource owners, controls, remote ledger
integration, media-element refs, events, and context publication.

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
