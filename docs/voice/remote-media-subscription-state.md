# Voice Remote Media Subscription State

**Status:** Implemented. The subscription ledger and reducer command envelope
landed in PR #274. This record describes the durable ownership and recovery
contracts; implementation sequencing and merge-time QA notes are intentionally
kept out of the repository.

## Purpose

Remote media has four distinct concerns:

- whether a producer exists on the server
- whether this client wants to consume it
- whether a local consumer and `MediaStream` are attached
- whether a consume is pending, retrying, or failed

`pendingStreams` previously overloaded all four. The client now keeps one
deterministic remote-media subscription ledger and derives UI state, consume
commands, repair scheduling, and reconnect restoration from it.

The ledger answers “what should exist?” Transport and stream layers still own
the mediasoup `Consumer`, `MediaStream`, and teardown side effects.

## Scope and ownership

The ledger covers every remotely consumed voice-channel stream kind:

- `AUDIO`
- `VIDEO`
- `SCREEN`
- `SCREEN_AUDIO`
- `EXTERNAL_AUDIO`
- `EXTERNAL_VIDEO`

It does not own local microphone, webcam, screen-share, or app-audio publishing.
Those paths have different permission, device, capture, and producer lifecycle
requirements. The server connects the two domains through producer events and
restore/join snapshots.

The ledger owns:

- producer presence and identity
- user or automatic consume intent
- consume lifecycle status
- consumer identity and consume generation
- timestamps used by retry and repair scheduling

It does not own:

- mediasoup transports, producers, or consumers
- `MediaStream` instances or element refs
- local capture resources
- volume or layout state
- server voice membership

The implementation lives in
`apps/client/src/components/voice-provider/hooks/remote-media-subscriptions.ts`.

## State model

Each slot is keyed by remote id and `StreamKind` and records:

```ts
type TRemoteMediaSubscription = {
	key: string;
	remoteId: number;
	kind: StreamKind;
	producerPresent: boolean;
	producerId?: string;
	desired: boolean;
	status: 'available' | 'wanted' | 'consuming' | 'retrying' | 'consumed' | 'failed';
	consumerId?: string;
	consumeGeneration?: number;
	updatedAt: number;
	pendingSince?: number;
	lastFailureAt?: number;
	lastFailureReason?: string;
};
```

`producerPresent` and `desired` are independent. A producer snapshot must not
resurrect an explicit stop-watch, and temporary producer loss must not erase
intent that is meant to survive producer replacement.

The UI renders from `visibleRemoteMedia`, which is derived from the ledger. Live
stream maps supply media objects only; they are not the authority for whether a
slot is watched, retrying, failed, or closing.

## Intent policy

- `AUDIO` is automatically desired while its producer is present.
- `VIDEO` becomes desired after an explicit watch and keeps that intent through
  webcam producer replacement until the viewer stops or the user/channel leaves.
- `SCREEN` is explicitly watched. A terminal screen-share stop clears its
  intent.
- `SCREEN_AUDIO` follows screen intent. Temporary audio-producer loss preserves
  desire while the screen is still desired and present; stopping the screen
  clears both intents.
- External audio and video keep intent through track producer churn while the
  external stream identity exists. Removing the external stream is terminal.

Producer close events distinguish recoverable replacement from terminal media
stops. Stale closes are ignored when their producer id no longer matches the
slot’s current producer.

## Reducer and command boundary

State transitions are pure and return a state/command envelope:

```ts
event + state -> nextState + commands
```

Commands are limited to concrete effects:

- `consume`
- `closeConsumer`
- `scheduleRetry`

`useRemoteMediaConsumeRunner` and `useRemoteMediaRepairRunner` execute transport,
RPC, and timer work and report results back through ledger transitions. The
subscription map and command queue are updated atomically so React Strict Mode
cannot duplicate commands by replaying a functional updater.

Consume generations prevent stale results from overwriting newer intent:

- stop-watch clears `desired` immediately and invalidates an in-flight consume
- a late consume success is ignored and its server consumer is closed
- manual retry advances the generation and cannot be cleared by the prior
  attempt’s completion
- producer replacement cannot be undone by a close event for the old producer

Retry is bounded. Exhaustion leaves a desired slot in `failed`, visible with a
manual retry affordance; it does not spin forever or silently become unwatched.

## Snapshot and compatibility contract

`TRemoteProducerIds` in `packages/shared/src/types.ts` includes producer-ref
arrays for every stream kind. Exact producer ids make snapshot reconciliation
deterministic and provide the identity needed to reject stale close events.

The older id-only arrays remain populated and optional producer-ref fields remain
safe for shipped older clients and servers. New code should prefer producer refs
and `externalStreamTracks`; compatibility fallbacks must never turn producer
presence into user intent.

Snapshot reconciliation follows these rules:

- present in the snapshot: mark the producer present and update its id
- absent from an authoritative snapshot: clear producer presence for that slot
- preserve explicit desire according to the intent policy above
- never resurrect an explicit stop-watch
- mint consume work only when producer presence, desire, and kind-specific
  preconditions all hold

## Reconnect contract

Voice-session recovery captures watched intent before transport cleanup. Cleanup
can clear producer and consumer state while preserving desire. The session
machine later emits `RestoreWatchIntent`; the ledger rehydrates intent, and its
own command runner consumes after producer reconciliation.

The session executor must not call `consume` directly during restore. Keeping
restore ledger-driven means an ordinary stop-watch during recovery wins without
a second cancellation model.

## Invariants to preserve

- There is at most one slot per remote id and stream kind.
- Only the current producer id and consume generation may update a slot.
- Explicit stop-watch wins over snapshots, retries, and late async results.
- `SCREEN` stop cascades to `SCREEN_AUDIO`; temporary screen-audio loss does not
  end the screen session.
- Desired failed media remains renderable and manually retryable.
- Reducer transitions do not perform transport, timer, or React side effects.
- No-op reconciliation preserves the existing map reference.
- Channel leave clears the ledger and command queue; reconnect cleanup preserves
  intent only when recovery is expected.

## Verification

Keep focused coverage in:

- `apps/client/src/components/voice-provider/__tests__/remote-media-subscriptions.test.ts`
- `apps/client/src/components/voice-provider/hooks/__tests__/remote-media-consume-controller.test.ts`
- `apps/client/src/components/voice-provider/__tests__/voice-reconnect-restore.test.ts`
- the consume and repair runner hook tests

Tests should cover stop-vs-consume races, producer replacement, screen-audio
cascades, snapshot compatibility, reconnect rehydration, bounded retry, manual
retry generations, external stream removal, and no-op referential stability.
