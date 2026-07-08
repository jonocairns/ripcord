# Voice Remote Media Subscription State

**Status:** Design note. Captured while reviewing PR #263 (`fix(voice): stop
stale-stream repair loop caused by watch-on-demand pendings`). The
`SCREEN_AUDIO` intent section describes the narrow follow-up; the central
subscription model remains the longer-term direction.

**Implementation status:** the ledger now owns behavior, and the intent-migration
work is being landed as a stacked PR. See
[`remote-media-intent-migration.md`](./remote-media-intent-migration.md) for
which slice is done and what is open. Screen-audio watch intent has moved into
the ledger (PR 1); external-stream intent (`watchedExternalStreamsRef`) is the
remaining ref holdout.

## Summary

The voice client currently models several different concepts through
`pendingStreams`:

- a remote producer is available to watch
- a consume is in flight
- a consume failed and is waiting for retry or repair
- a stream should be shown as an affordance in the UI

That overload is the recurring source of edge-case holes. The real state machine
is split across `pendingStreams`, live `MediaStream` maps, producer events,
existing-producer sweeps, retry timers, reconnect recovery, and a small amount
of explicit watch intent for external streams only.

The durable direction is one deterministic remote-media control-plane ledger. UI
state, repair work, reconnect restoration, and consume side effects should be
derived from that ledger instead of each owning partial truth.

The ledger separates four concepts for every remote stream slot:

- **Producer presence:** the server currently has a producer for this slot.
- **User intent:** this client wants this slot consumed.
- **Local media:** this client currently has a live consumed `MediaStream`.
- **Failure/retry state:** a consume is pending, retrying, or old enough to
  repair.

Once those are explicit, repair eligibility is simple:

```ts
producerPresent && desired && !consumed && !consuming && oldEnough
```

## Why Now

This should not be treated as a general cleanup or architecture-purity refactor.
The value is strongest because recent reconnect and recovery fixes exposed more
ordering bugs in the same area: user intent, producer presence, consumer
lifetime, retry state, and visual state can drift during reconnect.

The goal is to stop reconnect from guessing what should exist from transient
facts such as live `MediaStream` maps, pending entries, or half-reset transport
state. Reconnect should restore from explicit ledger intent and reconcile
against server-authoritative producer snapshots/events.

This is justified if the implementation stays focused on the current failure
class:

- remote consumed media only
- reconnect/recovery determinism
- producer replacement and stale event handling
- failed/retrying visual state for media the viewer asked to watch
- reducer tests for race-prone ordering cases

It should not expand into a broader voice rewrite.

## Media Scope

This model covers remote consumed media for every voice-channel stream kind:

- normal voice audio: `StreamKind.AUDIO`
- remote webcam video: `StreamKind.VIDEO`
- screen-share video: `StreamKind.SCREEN`
- screen-share audio: `StreamKind.SCREEN_AUDIO`
- external stream audio/video: `StreamKind.EXTERNAL_AUDIO` and
  `StreamKind.EXTERNAL_VIDEO`

Both voice audio and screen share belong in the same remote-media subscription
model. Voice audio is mostly auto-desired once present. Webcam, screen video,
screen audio, and external tracks are watch-on-demand or intent-gated, but they
should still use the same state shape and selectors.

The model does not replace local publishing state for the user's own mic,
camera, screen share, or app-audio capture pipelines. Local producers remain
owned by the local media/control code, but their server-side producer events
feed the same remote subscription model for other clients.

Local publishing should not be folded into this reducer. It has a different
state shape: device permissions, capture prompts, selected devices, OS sidecar
startup, producer transport publishing, local preview state, and server voice
state sync. It likely deserves its own deterministic state machine, but mixing it
with remote subscription state would make both models harder to reason about.

Pinned-card layout, permissions UX, local preview behavior, and local publish
startup/retry are also non-goals for this model. They may observe remote-media
selectors or emit events into the boundary, but they should not become part of
the remote subscription reducer.

The boundary should be event-based:

- Local publishing owns "what am I trying to publish?"
- Remote subscription owns "what remote media should this client consume?"
- The server/pubsub layer bridges them through producer-added, producer-closed,
  voice-state, and restore-or-join snapshots.
- A local publish success should become a server producer event for other
  clients; it should not directly mutate another client's remote-media visual
  state.

## State Ownership Boundary

The subscription state machine should own remote-media **control-plane** state:

- whether a producer is known to exist
- whether the user wants this stream consumed
- whether a consume attempt is active, retrying, failed, or consumed
- which producer id the current state is tied to
- which server consumer id/generation the current attempt is tied to
- timestamps and counters needed for retry/repair scheduling

It should not own media resources or UI objects:

- `MediaStream` instances
- mediasoup `Consumer` instances
- audio/video element refs
- transport objects
- volume settings
- pinned-card state
- server voice-user state
- local producers

The state machine should answer "what should exist?" The transport and stream
layers should remain responsible for creating, attaching, and destroying what
actually exists.

Visual state should be driven by the model, not by incidental presence in a
`MediaStream` map. The stream maps provide media objects to render; they should
not be the authority for whether the user wanted a stream, whether the stream is
retrying, or whether a failed stream should still appear as watched.

## Side-Effect Boundary

The reducer should stay pure. Side effects should be represented as commands
emitted by state transitions:

```ts
event + state -> nextState + commands
```

Examples:

- `consume(remoteId, kind, producerId?, generation)`
- `closeConsumer(remoteId, kind, consumerId?, generation)`
- `scheduleRetry(key, retryAt, generation)`
- `runProducerSweep(reason)`
- `refreshRepairClock(key, now)`

A single effect runner should execute these commands against transports, TRPC,
timers, and media resources. Results must come back into the model as events:

- `consumeSucceeded(...)`
- `consumeFailed(...)`
- `consumerClosed(...)`
- `producerSnapshotReceived(...)`
- `retryTimerElapsed(...)`

This does not make side effects impossible; media apps cannot avoid them. It
prevents side effects from becoming hidden state owners. Transport hooks,
provider effects, and UI components should not independently decide visual
state. They should execute commands and report outcomes back to the ledger.

## Event Identity And Time

Every event that can race with another event should carry enough identity for
the reducer to decide whether it still applies:

- `remoteMediaKey`
- `transportGeneration`
- `consumeGeneration`
- `producerId` when known
- `consumerId` when closing or confirming a known consumer
- `observedAt`
- `serverAt` when the server provides one

Generation and ids are the primary stale-event guard. Time is a supporting guard
for diagnostics and for laggy events that do not carry enough identity.

Rules:

- Ignore command results whose generation no longer matches the slot.
- Ignore producer-close events for older known producer ids.
- Ignore timer events whose `observedAt` is older than the slot transition they
  are trying to affect.
- Never let an older event clear a newer explicit `watchRequested` or
  `watchStopped`.
- Prefer identity/generation over timestamps whenever both are available.

The reducer should receive time from events; it should not call `Date.now()`.
This keeps retry and repair tests deterministic.

## Intent Policy

`desired` means "this client still wants this stream if it is available." It
should survive only for explicit watch intent or auto-policy streams:

- `AUDIO`: desired automatically while the producer is present and the client is
  in the voice channel.
- `VIDEO`: desired only after explicit watch; it survives webcam producer churn
  until the viewer stops watching, the user leaves, or the channel is left.
- `SCREEN`: desired only after explicit watch; the screen-share session ends
  when the screen video producer closes.
- `SCREEN_AUDIO`: desired when the viewer accepted the screen or accepted screen
  audio explicitly; it survives audio producer churn while the screen remains
  desired/present.
- `EXTERNAL_AUDIO` / `EXTERNAL_VIDEO`: desired follows the stable external
  stream identity (`pluginId:key`) and survives track producer churn while the
  external stream still exists.

Producer snapshots must not resurrect explicit opt-outs. If the viewer clicked
stop, a later snapshot that says a producer is present should make the stream
available, not desired.

## Producer-Close Policy

Producer close clears `producerPresent` and clears consumed/consuming media
state. It clears `desired` only when the product session is over:

- `AUDIO`: clear desired when the producer closes; it will become desired again
  automatically if audio reappears.
- `VIDEO`: keep desired through webcam producer churn after explicit watch.
- `SCREEN`: clear desired when the screen video producer closes.
- `SCREEN_AUDIO`: keep desired when only the audio producer closes and screen
  video is still desired/present; clear it when screen desire is cleared or the
  screen producer closes.
- `EXTERNAL_AUDIO` / `EXTERNAL_VIDEO`: keep desired through track producer churn
  while the external stream identity still exists; clear it when the external
  stream is removed or the viewer stops watching.

User leave, channel leave, external stream removal, and explicit stop-watch are
terminal for the relevant desire.

## Retry And Stop Policy

Consume retry is bounded:

- while retry budget remains, keep `desired = true` and move through
  `consuming` / `retrying`
- when retry budget is exhausted, keep `desired = true` and set `status =
  'failed'`
- failed desired streams remain visible and can be manually retried
- producer replacement, reconnect, and repair sweeps may also trigger a retry
- do not retry forever in a tight background loop

Manual retry is an explicit user action. It should increment the consume
generation, set `status = 'consuming'`, clear or archive the current failure
reason, emit a fresh consume command, and ignore any late result from the old
generation.

Stop-watch wins over in-flight consume:

- set `desired = false` immediately
- increment/cancel the relevant consume generation
- close the active consumer when one is known
- ignore late consume success from the old generation
- if a late server consumer is created anyway, close it by `consumerId` when the
  result arrives

## Current Asymmetry

External streams already carry persistent watch intent:

- `watchedExternalStreamsRef` tracks desired external audio/video by stream
  identity.
- `acceptStream(EXTERNAL_*)` sets the relevant field.
- `stopWatchingStream(EXTERNAL_*)` clears it.
- The repair path can ask whether a pending external track is actually watched.
- The external consume effect can re-drive `consume()` when intent is set and a
  pending entry exists.

This is why PR #263 can repair watched external tracks without reviving every
unwatched external stream.

User video/screen streams do not have an equivalent intent model. They mostly
infer "watched" from whether a live `MediaStream` exists. That inference breaks
when the stream was accepted and then the consume failed or the transport was
torn down. Once local media disappears, the client cannot distinguish:

- never opted in
- opted in and consume failed
- opted out and returned to pending

`SCREEN_AUDIO` is the clearest example. It is watch-on-demand, retryable, and can
be accepted with a screen share. If it fails through the full consume retry
window, its pending entry remains. But without a separate watch-intent flag, the
repair path cannot safely include it. Including all `SCREEN_AUDIO` pendings would
re-arm the original unwatched-screen-share repair loop that PR #263 fixed.

**Resolved for screen audio (PR 1):** `SCREEN_AUDIO` now carries ledger intent —
`desired` is coupled to the screen's desire in the reducer (see the updated
Follow-Up section below), so repair can include it without a separate ref. The
asymmetry now applies only to external streams, which still track intent through
`watchedExternalStreamsRef` pending PR 1b.

## Why The Holes Keep Appearing

The code is managing a remote-media subscription state machine, but the state
machine is implicit. As a result, different paths collapse distinct meanings
back into the same pending-entry shape:

- producer-added events add pending entries for watch-on-demand streams
- `consume()` adds pending entries while a consume is in flight
- non-retryable failures remove pending entries, but retryable failures keep them
- `stopWatchingStream()` re-adds pending entries as an availability marker
- existing-producer sweeps add pending entries for available streams
- repair sweeps use pending entry age as a proxy for stuck auto-consume work

Those paths are individually reasonable, but the shared representation loses the
reason the entry exists. The most likely real-world failures are therefore
ordering dependent:

1. The producer exists.
2. The user accepted the stream.
3. Consume fails long enough to exhaust retries, or reconnect/recovery clears
   local media.
4. The producer remains available.
5. The UI has moved past the pending affordance, or repair cannot know this was
   a desired stream.

## Follow-Up: Screen Audio Intent

**Implemented (PR 1) — in the ledger, not a ref.** This section originally
proposed a `useRef<Set<number>>` mirroring the external-stream ref. The landed
design instead makes `SCREEN_AUDIO.desired` a ledger-owned flag **coupled to the
screen's desire in the pure reducer**, which mirrors the already-existing
close-side cascade in `markRemoteProducerClosed(SCREEN)` and keeps the coupling
testable in one place. The behavior below is unchanged; only the mechanism moved.

Intent behavior (now enforced by reducer cascades, no ref bookkeeping):

- Accepting the screen (`markRemoteWatchRequested(SCREEN)`) grants `SCREEN_AUDIO`
  desire; accepting screen audio directly grants it too.
- Stopping the screen (`markRemoteWatchStopped(SCREEN)`) revokes it; so does
  stopping screen audio directly.
- User leave deletes the `SCREEN_AUDIO` slot (`clearRemoteMediaForUser`); channel
  leave resets the ledger.
- The screen producer closing revokes it (`markRemoteProducerClosed(SCREEN)`
  cascade).

Do not clear intent merely because the `SCREEN_AUDIO` producer closes while the
screen is still watched — `shouldKeepDesireOnProducerClose(SCREEN_AUDIO)` keeps
desire while the screen remains desired and present, so a producer replacement or
temporary audio-track loss recovers without the viewer re-watching.

Two mechanisms carry intent across producer timing, both guarded so
intent-ahead-of-producer never fabricates a phantom `producerPresent: true` slot:

- `inheritsScreenAudioDesire` derives `SCREEN_AUDIO.desired` from the screen
  sibling when the audio producer arrives after the screen is already watched.
- the grant cascade in `markRemoteWatchRequested(SCREEN)` covers the case where
  the audio producer already exists at accept time.

Recovery path (unchanged): the provider re-drive effect and repair eligibility
read `SCREEN_AUDIO.desired` from the ledger (via `isScreenAudioDesiredInLedger`)
so accepted screen audio gets the same repair cadence external tracks get,
without making every unwatched screen share arm the repair timer. Overlapping
consume attempts are still deduped by the existing consume-operation state.

## Required UI Affordance

The correctness fix is intent tracking and ledger-owned visual state. A compact
UI affordance is still required so desired media does not silently disappear
after failure:

- if screen video is consumed and `SCREEN_AUDIO` is pending, show a compact
  "screen audio unavailable" / retry control on the screen tile
- if desired webcam or screen video is retrying/failed, keep the tile visible in
  a compact retrying/failed state
- allow manual retry explicitly
- keep stop-watch available from retrying/failed states

This covers both cases:

- the viewer opted in and audio failed after retries
- the viewer never opted in to screen audio, but the producer is available

The important behavior is that desired media remains visible as wanted,
retrying, failed, or closing until the viewer stops watching or the product
session ends.

## Longer-Term Direction

Move from stream-kind-specific effects toward a central remote media
subscription model. Each remote stream slot should have an explicit state
record:

```ts
type RemoteMediaKey = `${number}:${StreamKind}`;

type RemoteMediaStatus =
	| 'available'
	| 'wanted'
	| 'consuming'
	| 'consumed'
	| 'retrying'
	| 'failed'
	| 'closing';

type RemoteMediaSubscription = {
	key: RemoteMediaKey;
	remoteId: number;
	kind: StreamKind;
	// Stable intent identity for streams whose numeric id can churn, e.g.
	// external streams keyed by pluginId:key.
	stableIntentKey?: string;
	producerPresent: boolean;
	// Producer id can be unknown when presence came from a producer snapshot that
	// only contains remote ids. New snapshots should include producer refs so this
	// becomes a backward-compatibility fallback instead of the normal path.
	producerId?: string;
	desired: boolean;
	status: RemoteMediaStatus;
	consumerId?: string;
	consumeGeneration: number;
	transportGeneration: number;
	updatedAt: number;
	pendingSince?: number;
	retryAttempt: number;
	nextRetryAt?: number;
	lastFailureAt?: number;
	lastFailureReason?: string;
	lastRepairAt?: number;
};
```

The UI can render from `producerPresent`, `desired`, and `status`. Retry and
repair can operate on `desired && producerPresent && status !== 'consumed'`.
Producer-close, stop-watch, reconnect cleanup, and
existing-producer sweeps can update separate fields instead of deleting and
recreating ambiguous pending entries.

Important details:

- `producerPresent: true` with `producerId: undefined` means "snapshot says a
  producer exists, but this client does not know its id yet." It must not be
  treated as absent.
- External stream intent must keep the current stable identity behavior
  (`pluginId:key`), not just the numeric stream id.
- A slot should become visually live only after the transport/media layer reports
  the consume/attach path completed. Before that, the UI should show available,
  wanted, retrying, failed, or closing states from the ledger.

### Snapshot API Shape

Producer snapshots should include exact producer ids so snapshot reconciliation
is server-authoritative and deterministic. Keep the existing arrays populated
for older clients, but mark them deprecated with JSDoc and prefer the producer
refs in new code:

```ts
type TRemoteProducerRef = {
	remoteId: number;
	producerId: string;
};

type TExternalProducerRef = {
	streamId: number;
	producerId: string;
};

type TRemoteProducerIds = {
	/**
	 * @deprecated Use remoteAudioProducers instead. Kept for older clients.
	 */
	remoteAudioIds: number[];
	/**
	 * @deprecated Use remoteVideoProducers instead. Kept for older clients.
	 */
	remoteVideoIds: number[];
	/**
	 * @deprecated Use remoteScreenProducers instead. Kept for older clients.
	 */
	remoteScreenIds: number[];
	/**
	 * @deprecated Use remoteScreenAudioProducers instead. Kept for older clients.
	 */
	remoteScreenAudioIds: number[];
	/**
	 * @deprecated Use remoteExternalAudioProducers /
	 * remoteExternalVideoProducers and externalStreamTracks instead. Kept for
	 * older clients.
	 */
	remoteExternalStreamIds: number[];

	externalStreamTracks?: { [streamId: number]: { audio: boolean; video: boolean } };
	remoteAudioProducers?: TRemoteProducerRef[];
	remoteVideoProducers?: TRemoteProducerRef[];
	remoteScreenProducers?: TRemoteProducerRef[];
	remoteScreenAudioProducers?: TRemoteProducerRef[];
	remoteExternalAudioProducers?: TExternalProducerRef[];
	remoteExternalVideoProducers?: TExternalProducerRef[];
};
```

The server should derive old and new fields from the same producer maps so they
cannot disagree. New clients should prefer producer refs and fall back to the
deprecated id arrays only when connected to older servers.

### Events

The model should be updated through explicit events. This keeps the surprising
paths testable without mounting `VoiceProvider`. Events that affect ordering,
retry, repair, or diagnostics should carry `observedAt`; server-sourced events
should also carry `serverAt` when available.

Producer presence:

- `producerSnapshotReceived(producers, externalStreamTracks)`
- `producerAdded(remoteId, kind, producerId)`
- `producerClosed(remoteId, kind, producerId?)`
- `userLeft(remoteId)`
- `externalStreamRemoved(streamId)`
- `channelLeft()`

User intent:

- `watchRequested(remoteId, kind)`
- `watchStopped(remoteId, kind)`
- `watchStoppedForUser(remoteId)`
- `watchStoppedForExternalStream(streamId)`

Consume lifecycle:

- `consumeStarted(remoteId, kind, producerId?)`
- `consumeSucceeded(remoteId, kind, producerId, consumerId)`
- `consumeFailed(remoteId, kind, reason, retryable, now)`
- `consumeRetryScheduled(remoteId, kind, attempt, retryAt)`
- `consumeGaveUp(remoteId, kind, now)`
- `manualRetryRequested(remoteId, kind, now)`
- `consumerClosed(remoteId, kind)`
- `transportGenerationReset()`

Repair:

- `repairSweepScheduled(now)`
- `repairSweepStarted(now)`
- `pendingAgesRefreshed(now)`

### Derived Views

The model should expose derived views instead of making every caller reinterpret
raw state:

- `pendingStreams`: compatibility view for current UI/hooks while migrating.
- `streamsToConsume`: desired, producer-present entries that should call
  `consume()`, excluding entries already consuming.
- `repairCandidates`: desired, producer-present entries old enough for repair.
- `watchAffordances`: available streams that are not desired or not consumed.
- `activeWatchIntent`: streams that should be restored after reconnect.
- `visibleRemoteMedia`: stream slots the UI should render as live, pending,
  retrying, failed, or closing.

Keeping these as selectors prevents the same boolean logic from drifting across
`VoiceProvider`, `useTransports`, and the channel-view UI.

### Invariants

These rules should be enforced in reducer tests:

- A stream can be `consumed` only if `producerPresent` is true.
- `consumeStarted` sets `desired` true for auto-consumed kinds and accepted
  watch-on-demand kinds.
- `watchStopped` clears `desired` but does not have to clear `producerPresent`.
- Producer close clears `producerPresent`; it clears `desired` only when the
  product semantics say the watch session ended.
- `SCREEN_AUDIO` producer close does not clear desire while the corresponding
  screen remains watched.
- `SCREEN` producer close clears `SCREEN_AUDIO` desire for that remote user.
- Retry exhaustion does not erase desire for retryable accepted streams.
- Repair eligibility requires desire; availability-only pending entries must not
  arm repair.
- Existing-producer sweeps update producer presence without overwriting explicit
  user opt-out.
- Transport cleanup clears local consumed/consuming state but preserves watch
  intent that should survive recovery.
- Visual live state follows an explicit successful consume/attach event, not
  just a stale entry in `remoteUserStreams` or `externalStreams`.
- Missing media objects for a `desired` stream produce a retrying/failed/wanted
  state, not silent disappearance from the UI.

### Transition Sketch

| Event | Producer presence | Desire | Status |
| --- | --- | --- | --- |
| snapshot says producer present | true | unchanged | unchanged unless producer id changed |
| snapshot says producer absent | false | stream-kind dependent | available or wanted, by policy |
| watch requested | unchanged | true | wanted or consuming |
| watch stopped | unchanged | false | available or closing |
| consume started | unchanged | true | consuming |
| consume succeeded | true | true | consumed |
| retryable consume failure | unchanged | true | retrying or failed |
| non-retryable consume failure | unchanged | false for watch-on-demand | available or failed, by policy |
| consumer closed unexpectedly | unchanged | unchanged | wanted or retrying |
| transport reset | unchanged | preserved | wanted |
| repair started | unchanged | unchanged | wanted, then selected entries consume |

The table is intentionally high level. Stream-kind-specific policy belongs in a
small policy layer rather than in scattered `if (kind === ...)` branches.

### Migration Plan

1. Extend the shared/server producer snapshot shape with producer refs while
   keeping the deprecated arrays populated.
2. Create a pure `remote-media-subscriptions.ts` model with reducer tests.
3. Run it as a shadow model first: feed it the existing producer snapshots,
   producer events, accept/stop events, consume starts/results, cleanup events,
   and reconnect/transport reset events, but do not let it drive behavior yet.
4. Add logging or development assertions that compare key derived views against
   current state (`pendingStreams`, active streams, repair candidates) so drift
   is visible before the model owns behavior.
5. Preserve the existing external-stream stable identity behavior inside the
   model before removing `watchedExternalStreamsRef`.
6. Add screen-audio watch intent to the model so accepted screen audio can
   recover without making every unwatched screen share repair-eligible.
7. Derive reconnect watch restoration from explicit ledger intent rather than
   live `MediaStream` snapshots.
8. Derive repair eligibility from the new model. This is low-risk because
   it only decides when to run existing repair work.
9. Derive `pendingStreams` from the model for UI compatibility.
10. Add compact retrying/failed UI for desired media that cannot currently be
    consumed.
11. Collapse stream-kind-specific provider effects into a `streamsToConsume`
   selector and one consume-driving effect.
12. Remove obsolete intent refs once the model owns equivalent state.

### Implementation Guardrails

Keep the first implementation focused on remote consumed media and reconnect
determinism. Do not use this work to refactor:

- local publishing/capture state for mic, webcam, screen, or app audio
- device permission prompts or picker UX
- local preview behavior
- pinned-card/stage layout architecture
- unrelated voice activity, volume, or stats plumbing
- server permission semantics
- broad `VoiceProvider` organization outside the paths needed to feed or execute
  the remote-media model

If one of those areas must be touched, keep the edit local to the integration
point and call it out explicitly in the PR.

### First PR Acceptance Criteria

The first implementation PR should be considered complete only if:

- shared/server snapshots include producer-ref fields and keep deprecated arrays
  populated for older clients
- the remote-media reducer/selectors are pure and covered by focused unit tests
- reconnect restoration uses explicit ledger intent rather than live
  `MediaStream` snapshots
- stale command/event results are ignored by generation/id rules
- screen audio intent is represented in the model and is repair-eligible only
  when desired
- desired media that cannot currently be consumed remains visible as wanted,
  retrying, failed, or closing
- manual retry creates a new consume generation and stop-watch wins over in-flight
  consume
- existing resource maps remain resource maps; they are not visual-state
  authorities
- old external stream stable identity behavior (`pluginId:key`) is preserved
- the PR includes enough logging or development assertions to detect ledger vs.
  resource-map drift during manual testing

### Test Matrix

The pure model should have tests for:

- producer snapshots populate producer ids from producer refs and fall back to
  deprecated arrays for older servers
- voice audio is auto-desired and auto-consumed when an audio producer appears
- unwatched video/screen/screen-audio stays available without arming repair
- accepted webcam/screen video remains desired across transport reset
- accepted screen audio arms repair only after intent is set
- accepting screen sets screen-audio intent so audio that appears later is
  consumed
- stopping screen clears screen-audio intent even if audio is only pending
- stopping screen audio does not stop screen video
- screen-audio producer replacement preserves intent
- screen producer close clears screen-audio intent
- external audio/video preserve existing intent behavior
- retry exhaustion preserves desire for retryable accepted streams
- non-retryable watch-on-demand failure returns to availability state
- failure reasons distinguish producer disappearance from transient consume or
  resume failure
- bounded automatic retry ends in `failed` while preserving desire
- manual retry increments consume generation and ignores older command results
- stop-watch cancels in-flight consume and late consume success does not revive
  desire
- transport reset preserves desired streams but clears consumed/consuming state
- existing-producer sweep cannot resurrect an explicit opt-out as desired
- producer snapshot presence without producer ids does not erase a known current
  producer id unless the snapshot says the slot is absent
- visual live state is emitted only after consume success, not merely because a
  pending entry exists
- desired failed/retrying media remains visible until stop-watch or session end
- user leave clears all user-scoped subscriptions
- channel leave clears all subscriptions

That is a larger refactor than PR #263 needs, but it is the direction that
prevents this class of bugs from moving from one stream kind to the next.

## Post-Implementation Validation

Manual QA should focus on reconnect and stale-event surfaces, not just the happy
path:

- join voice, watch a webcam, reconnect the client, and verify the watched camera
  is restored from ledger intent
- join voice, watch a screen share with screen audio, reconnect, and verify video
  and desired audio recover independently
- stop watching while a consume is in flight; verify late consume success does
  not revive the stream
- force or simulate producer replacement; verify stale close events do not remove
  the replacement
- let a desired consume exhaust retries; verify the tile remains visible in a
  compact failed state with manual retry
- retry manually after failure; verify a new consume generation starts and old
  results are ignored
- run a producer snapshot sweep after explicit stop-watch; verify it does not
  resurrect desire
- remove an external stream and verify stable intent is cleared only for that
  stream identity
- cold restart the server while clients are in voice; verify restore-or-join plus
  producer sweeps do not leave users visually rejoined but silent
- leave the voice channel and verify all remote subscriptions, timers, retries,
  and visible remote media are cleared

Useful success signals:

- desired media no longer silently disappears after retry exhaustion
- reconnect restoration does not depend on live `MediaStream` presence
- stale command/event logs are rare, explainable, and ignored
- compact failed/retrying UI appears for requested media that cannot be consumed
- no new broad local publishing or layout changes are needed to make the remote
  model work

## Key Files

- `packages/shared/src/types.ts`
  - `TRemoteProducerIds`
  - deprecated id arrays and new producer-ref snapshot fields
- `apps/server/src/runtimes/voice.ts`
  - `VoiceRuntime.getRemoteIds`
  - source producer maps for old and new snapshot fields
- `apps/server/src/routers/voice/get-producers.ts`
  - snapshot route that exposes producer presence to clients
- `apps/client/src/components/voice-provider/index.tsx`
  - `watchedExternalStreamsRef`
  - `acceptStream` / `stopWatchingStream`
  - external pending consume effect
  - stale pending repair effect
- `apps/client/src/components/voice-provider/remote-media-subscriptions.ts`
  - new reducer, selectors, command definitions, and tests
- `apps/client/src/components/voice-provider/hooks/use-pending-streams.ts`
  - `pendingStreams`
  - `getOldestRepairEligiblePendingCreatedAt`
  - `refreshPendingStreamAges`
- `apps/client/src/components/voice-provider/hooks/use-transports.ts`
  - `consume`
  - consume retry exhaustion behavior
  - existing-producer sweeps
- `apps/client/src/components/channel-view/voice/index.tsx`
  - screen-share pending-card behavior
  - screen-audio watch/stop interactions
