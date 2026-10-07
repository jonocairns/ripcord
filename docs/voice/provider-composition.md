# Voice provider composition

The voice-provider ownership refactor is implemented. This record is the durable
architecture contract. Implementation sequencing and validation evidence live
in the pull requests.

`VoiceProvider` constructs and connects owners, controls and event adapters,
publishes context, and renders children and the floating card. It does not
implement acquisition, publication, recovery policy or capture teardown. This is
composition across focused modules, rather than one replacement provider hook.

## Module layout

Paths below are relative to `apps/client/src/components/voice-provider/`. A
module used by one media owner lives beside that owner's controller, React
adapter, configuration and tests. Shared modules stay at the root; `hooks/` is
dissolved. Tests live in their subject's adjacent `__tests__/` directory.

| Folder | Contents |
| --- | --- |
| Root | Provider/context/types, voice controls, local stream snapshots, combined media settings, activity and transport stats, shared audio context/config, execution ownership, operation ordering, volume and floating-card UI. |
| `microphone/` | Microphone integration and pipeline controller, lifecycle hook, capture/default-device configuration, processing/gain/WASM workers and worklets, raw-loss recovery, local activity and push-to-talk. |
| `video/` | Webcam and screen-video controllers and hooks, screen stage/control lifecycle, quality guard, video configuration/bitrate policy and sender metadata. |
| `share-audio/` | Share-audio controller and hook, desktop app-audio capture/worklet, recovery, PCM and queue policies. |
| `session/` | Runtime, environment, executor adapter, command observer, transport recovery and prewarm. |
| `remote-media/` | Remote integration, subscription ledger, transport/stream hooks, consume/repair controllers and runners, producer sweeps/event identity, and element-ref cache. |

`session-execution-ownership.ts` stays at the root because session, video,
share-audio, controls and combined settings all use its fence. Audio context and
producer config are shared by microphone and share audio. The shared video test
fixture stays in root `__tests__/` because combined-settings tests also use it.

## Lifecycle glossary

| Term | Meaning |
| --- | --- |
| Currency | Whether an operation still has authority to act: its owner is active and its lifecycle, operation, command and resource identities still match. Check it again after awaited work before publishing shared state. |
| Fence | An identity or activation check that rejects obsolete work. Cleanup or supersession invalidates the old authority, so late results can release their own allocations without overwriting a successor. |
| Lease | A captured grant of authority with an `isCurrent()` check, such as a lifecycle, execution or producer-publication lease. Holding it across an await does not guarantee that it remains current. |
| Generation | A monotonic counter that identifies one activation, capture, publication or session attempt. Each counter belongs to its own owner; a generation from one boundary does not confer authority at another. |

## Ownership and operations

| Boundary | Authority and operations |
| --- | --- |
| Microphone | The pipeline controller and microphone integration own raw/processed capture, publication, activity and cleanup. Runtime retains early `prepare` and later `publish`; controls use ordered `start` and `setMuted`. |
| Webcam | The webcam controller owns capture and producer identity: `start`, `restart`, `stop`, `detachProducer`, `republish`, `getStream`, `getProducer`. |
| Screen video | The screen controller owns selection, video capture, producer identity, capture-ended callbacks and quality-guard mounting: `requestSelection`, `start`, `stop`, `detachProducer`, `republish`, `isLive`, `getProducer`. |
| Share audio | The audio controller owns every display-audio/native/worklet path and teardown: adoption/discard, `start`, `stop`, `detachProducer`, `republish`, `recover`, `awaitTeardown`. Video calls audio; audio receives a video-liveness getter and calls no video lifecycle operation. |
| Session runtime | `init`, restore, rejoin and rebuild effects, terminal/recovery cleanup and server-session establishment integration. It invokes public owner operations. |
| Session machine and executor | Phases, command identity, retry/timeout policy, scheduling, cancellation and bounded draining remain in the existing machine, store, executor and runners. |
| Remote media | `useRemoteMedia` composes the existing ledger, stream maps, transports, consume/repair runners and event subscriptions. `createRemoteMediaIntegration` connects identity checks, consume-start acknowledgement, external-track reconciliation and watched-intent snapshots; it owns no ledger state, transport resources or retry policy. |
| Element refs | `useMediaElementRefs` retains a private `createMediaElementRefCache`, initializes six null refs per remote id, prunes absent user/external ids and clears on leave or explicit terminal cleanup. |
| Activity and stats | Existing subscribed stores remain separate from the voice context. Sender metadata samples webcam/screen owner getters at collection time; quality guards also use the screen owner getter. |
| Local stream snapshots | `useLocalStreams` contains React snapshots/setters only. The corresponding controller alone publishes its stream and owns producer/capture teardown. |

Construction performs no media acquisition, signaling, subscriptions or timers.
Committed current-value getters and layout-effect owner activation precede passive
executor work, including Strict Mode replay. Awaited operations retain lifecycle
and operation currency checks before shared writes.

## Microphone layers

[`microphone/microphone-pipeline-controller.ts`](../../apps/client/src/components/voice-provider/microphone/microphone-pipeline-controller.ts)
is the resource owner. It owns raw capture, processing and gain pipelines,
prepared output, producer identity, activity-monitor lifetime and teardown. It
fences asynchronous publication and bounds raw-track-loss recovery through
injected ports.

[`microphone/microphone-integration.ts`](../../apps/client/src/components/voice-provider/microphone/microphone-integration.ts)
connects that controller to application settings, browser devices, mediasoup,
volume events and activity reporting. It serializes microphone mutations and
owns default-input change subscriptions and recovery decisions. Its operations
delegate resource ownership to the pipeline controller.

[`microphone/use-microphone.ts`](../../apps/client/src/components/voice-provider/microphone/use-microphone.ts)
retains the integration and supplies committed React inputs and production
adapters. The adjacent pipeline lifecycle hook mounts activation and cleanup;
it does not add another resource owner.

## Public context

The consumed `useVoice` API remains intact: `init`, microphone/mute/deafen and
video controls, `acceptStream`, `retryRemoteMedia`, `stopWatchingStream`,
`getOrCreateRefs`, connection/own-state projections, local/remote streams and
ledger projections. `init` is still used by voice-channel navigation.

`loading` and public `audioVideoRefsMap` remain absent. The private cache is
retained. Surviving ids retain the same ref objects, including across recovery
while channel membership remains. Pruning or terminal clearing makes later
lookup create new refs; it does not mutate detached element refs or stop tracks.

Remote consume-start acknowledgement waits for the committed ledger before
transport work proceeds. The integration mounts in a layout effect. Cleanup
settles pending acknowledgements and fences inactive mutations without clearing
ledger state or tearing down resources owned by transports/stream maps. Each
activation has its own publication generation; Strict Mode replay uses a fresh
publication, and an old cleanup cannot dispose its replacement. Currency is
rechecked when the acknowledgement promise settles. Exact producer/channel identity protects repair, while
id-only producer compatibility remains supported. Reconnect snapshots describe
watch intent, and restore rehydrates the authoritative ledger rather than
consuming privately. An explicit stop during recovery stays authoritative.

The extraction uses committed getters for accept/retry external metadata, replacing
render-captured metadata. Event resynchronization retains its existing
subscription dependencies, auth gate and transport sweeper. No retry budget,
codec, settings, server/API or desktop bridge contract changes are included.

Terminal cleanup stops local capture through its owners; recovery preserves the
appropriate capture and remote watch intent. Prepared transport parallelism,
recovery-specific microphone decisions, immediate/delayed producer refresh and
stale terminal-leave protection remain documented in
[session-runtime.md](./session-runtime.md), including automated recovery coverage
and its unresolved clock-divergence limitation.

## Lifecycle corrections

A separate layer adds the acknowledgement lifecycle fencing above. Construction
remains inactive and effect-free. A disposed publication is never reused during
replay. The corresponding factory/mount tests cover activation replacement,
cleanup after acknowledgement but before promise delivery, inactive callbacks
and preservation of transport/ledger cleanup ownership.

The same layer corrects rebuild completion at awaited boundaries: losing runtime
or command currency, or confirmed server connectivity, throws a supersession
error instead of returning normally. The executor therefore cannot interpret
that incomplete effect as `RebuildSucceeded`. Nonce restart still belongs to the
executor, and existing failure/retry/draining policy stays unchanged. Disconnect
after transport creation and after republishing reproduced false success before
the correction. State synchronization already checked currency and retains that
regression coverage. This does not repair the long-offline restore hang.
