# Remote Media Subscription Review Follow-Ups

Captured from review feedback after the initial remote-media subscription ledger
implementation. All findings below have been addressed on the
`codex/remote-media-ledger-followups` branch; each entry records how, so the fix
can be audited against the original concern.

Validation reported with the original review:

- Unit tests pass: 7/7 (now 19/19 in the ledger suites after the fixes below).
- Full workspace typecheck is clean.
- Review candidates were checked against the actual code.
- The overall shape matches `docs/voice/remote-media-subscription-state.md`: the
  ledger is the source of truth, pending streams are derived, and the shared
  types change is backward compatible.

## High-Priority Correctness

1. ~~A stale `consumed` status can be stranded.~~ **Fixed.**

   A slot could remain `status: 'consumed'` even after the underlying consumer
   or media track was gone: `markRemoteProducerPresent` preserves `consumed`, a
   mismatched producer-close event is ignored by the producer-id guard, and the
   consumer cleanup path in `use-transports` removed media without updating the
   ledger. In that state the UI showed no card, the derived pending map had no
   entry, and repair had no self-heal path.

   Fix: the consumer cleanup events (`trackended`/`transportclose`/`close`) now
   call `markRemoteConsumerClosed`, which returns a `consumed` slot to a
   repair-eligible pending state. The reducer is guarded by consumer id (stale
   closes are ignored) and only touches `consumed` slots — `consuming` is owned
   by the in-flight consume operation and its retry policy.

2. ~~`refreshRemoteMediaPendingAges` may narrow the repair-loop backoff safety
   net.~~ **Fixed.**

   The refresh skipped `status: 'available'` entries, but repair eligibility is
   decided by kind and watch state rather than status, so an entry stuck in an
   unexpected `available` state could re-arm the repair timer with zero delay.
   The refresh now covers every non-consumed entry with a live producer.

   The related re-render concern (reducers dirtying the ledger during sweeps) is
   covered by item 3.

## Efficiency

3. ~~`markRemoteProducerPresent` never no-ops.~~ **Fixed.**

   Reducers now compare material fields via `applySlotUpdate` and return the
   input map untouched when nothing changed; `updatedAt` bumps only alongside a
   material change. Steady-state snapshot reconciliation returns the same map
   reference, so voice context consumers do not re-render.

## Cleanup

4. ~~Dead or write-only ledger state.~~ **Fixed.** The never-produced `closing`
   and `retrying` statuses and the write-only `consumeGeneration`,
   `retryAttempt`, `nextRetryAt`, and `lastRepairAt` fields are removed.

5. ~~Duplicate external producer presence logic.~~ **Fixed.** The "present
   unless explicitly false" rule lives in `isExternalTrackPresent`
   (use-pending-streams) and is shared by `producerSlotsFromSnapshot`,
   `buildActivePendingStreamKeys`, and the existing-producers sweep.

6. ~~Duplicate user stream kind helper.~~ **Fixed.** The sibling
   `isUserPendingStreamKind` was deleted along with the dead `usePendingStreams`
   hook; only `isUserStreamKind` remains.

7. ~~Duplicate pending-card status union.~~ **Fixed.** `TPendingStreamStatus`
   is derived from the ledger's `TRemoteMediaStatus` (minus `consumed`) and
   shared by `PendingStreamCard` and the stage's `getPendingCardStatus`.

8. ~~Repeated server producer projection.~~ **Fixed.** `getRemoteIds` uses
   `toRemoteProducerRefs`/`toExternalProducerRefs` helpers instead of repeating
   the entries/filter/map pattern per producer kind.

9. ~~Unnecessary alias.~~ **Fixed.** `getSubscriptionKey` is gone; call sites
   use `getPendingStreamKey` directly.

## Review Notes Marked Safe

- Reconnect capture ordering: `captureWatchedRemoteStreams` reads the ledger
  before `cleanupTransports` clears it, and the desired-based capture is a
  strict superset of the old consumed-based capture.
- Producer-id guard: `markRemoteProducerClosed` correctly ignores stale close
  events after producer restart.
- Consume success wiring: `producerId` and `consumerId` passed to
  `markConsumeSucceeded` are the values returned by the server.
