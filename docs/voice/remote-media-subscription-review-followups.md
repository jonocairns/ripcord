# Remote Media Subscription Review Follow-Ups

Captured from review feedback after the initial remote-media subscription ledger
implementation. Do not treat this file as confirmation that the findings have
been fixed; it is a parking lot for later follow-up work.

Validation reported with the review:

- Unit tests pass: 7/7.
- Full workspace typecheck is clean.
- Review candidates were checked against the actual code.
- The overall shape matches `docs/voice/remote-media-subscription-state.md`: the
  ledger is the source of truth, pending streams are derived, and the shared
  types change is backward compatible.

## High-Priority Correctness

1. A stale `consumed` status can be stranded.

   A slot can remain `status: 'consumed'` even after the underlying consumer or
   media track is gone. In that state, the UI shows no card, the derived pending
   map has no entry, and repair has no self-heal path.

   Reported race shape:

   - `markRemoteProducerPresent` preserves `consumed`.
   - A mismatched producer-close event is ignored by the producer-id guard.
   - The consumer cleanup path in `use-transports` removes media without updating
     the ledger.
   - The old sweep path could re-add a pending entry, but the new ledger can
     block that path.

2. `refreshRemoteMediaPendingAges` may narrow the repair-loop backoff safety net.

   The old pending-stream backoff refreshed every pending entry age to avoid
   immediate repeated repair attempts. The new implementation skips
   `status: 'available'` entries, which may allow a zero-delay repair loop if a
   repair-eligible entry is stuck in an unexpected available state.

   Related concern: reducers currently dirty the ledger during sweeps, so this
   can also re-render the voice context tree repeatedly.

## Efficiency

3. `markRemoteProducerPresent` never no-ops.

   It always writes `updatedAt: now`, so every snapshot reconciliation dirties
   the whole ledger and re-renders voice context consumers even when producer
   presence did not materially change.

   Follow-up: make reducers return the input map when no material state changes,
   similar to the old `addPendingStream` / `reconcilePendingStreamMap` behavior.

## Cleanup

4. Dead or write-only ledger state.

   `closing` and `retrying` statuses are never produced. `consumeGeneration`,
   `retryAttempt`, and `lastRepairAt` are written but not read.

5. Duplicate external producer presence logic.

   `producerSlotsFromSnapshot` re-implements the "present unless explicitly
   false" rule already encoded in `buildActivePendingStreamKeys`.

6. Duplicate user stream kind helper.

   `isUserStreamKind` duplicates `isUserPendingStreamKind` in sibling pending
   stream code.

7. Duplicate pending-card status union.

   `getPendingCardStatus` in `channel-view/voice/index.tsx` redeclares the same
   status vocabulary used by `PendingStreamCard`.

8. Repeated server producer projection.

   `apps/server/src/runtimes/voice.ts` repeats the same
   `Object.entries(...).filter(+id !== userId).map(...)` pattern for each remote
   producer kind.

9. Unnecessary alias.

   `getSubscriptionKey` is a pure alias of `getPendingStreamKey`, creating a
   second name for the same key format within one module.

## Review Notes Marked Safe

- Reconnect capture ordering: `captureWatchedRemoteStreams` reads the ledger
  before `cleanupTransports` clears it, and the desired-based capture is a
  strict superset of the old consumed-based capture.
- Producer-id guard: `markRemoteProducerClosed` correctly ignores stale close
  events after producer restart.
- Consume success wiring: `producerId` and `consumerId` passed to
  `markConsumeSucceeded` are the values returned by the server.
