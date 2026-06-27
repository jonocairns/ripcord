# Known Issue: Stop-Watching Races a Reconnect Re-Consume

**Status:** Open / not yet fixed. Captured during PR #251 (voice consumer
recovery hardening) as a pre-existing, out-of-scope race worth fixing
deliberately in its own change.

**Severity:** Low. Narrow timing window, self-correcting, bandwidth-only impact.

## Summary

If a user stops watching a remote video/screen/external stream **during** an
in-session voice reconnect, the reconnect's restore step re-consumes that stream
anyway. The user sees a stream they just stopped, wasting downstream bandwidth
until they stop it again.

## Mechanism

In-session recovery restores watched streams from a **point-in-time snapshot**
taken at the start of the reconnect attempt, not from live watch intent:

1. `captureWatchedRemoteStreams()` (`apps/client/src/components/voice-provider/index.tsx:853`)
   snapshots the live `remoteUserStreamsRef` / `externalStreamsRef`.
2. The snapshot is captured at the top of the recovery attempt
   (`index.tsx:2739`), immediately before the attempt clears live state
   (`clearRemoteUserStreams()` at `index.tsx:2744`) and tears down consumers via
   `cleanupTransports()`.
3. Seconds later (after rejoin + transport rebuild + producer sweeps),
   `restoreWatchTasks` (`index.tsx:2876`) re-`consume`s every entry in that
   snapshot.

During the window between (1) and (3) the live consumer is already gone, so a
`stopWatchingStream` call is effectively a no-op locally — but the **snapshot
still lists the stream**, so restore re-consumes it. The stop is silently
overridden.

## A relevant asymmetry

External streams already maintain a reconnect-surviving watch-intent ref,
`watchedExternalStreamsRef`, updated by:

- `acceptStream` — sets the watched field true (`index.tsx:948`)
- `stopWatchingStream` — sets it false / deletes (`index.tsx:981`)

…but recovery restore **ignores it** and restores from the live snapshot
(`captureWatchedRemoteStreams` reads `externalStreamsRef.current`, not
`watchedExternalStreamsRef`). So external streams hit the race despite the data
to avoid it already existing. Video/screen streams have **no** intent ref at all
— only the cleared-on-reconnect live `remoteUserStreamsRef`.

This asymmetry suggests the intended design was "restore from intent," and the
snapshot path is the accidental gap.

## Why it is not a regression from PR #251

PR #251 hardened consumer recovery on the *consume/close* side (single-flight
sweeps, targeted `closeConsumer` by id). This race is on the *reconnect-restore*
side and predates that work. The `stopWatchingStream` consumer-id change in #251
does not affect it (during reconnect the local consumer is already gone, so no
id is sent regardless).

## Recommended fix

Make recovery restore read **watch intent** rather than the live snapshot:

1. External: restore from `watchedExternalStreamsRef` (already exists, already
   survives reconnect) instead of `watchedStreamsSnapshot.externalStreams`.
2. Video/screen: add a parallel persistent `watchedRemoteStreamsRef`, updated in
   `acceptStream` / `stopWatchingStream`, that survives `cleanupTransports` /
   `clearRemoteUserStreams`, and restore from it.
3. Regression test: a `stopWatchingStream` issued mid-reconnect must not be
   re-consumed by restore.

This touches the hardened recovery path (`runRecovery`, see PR #139), so it
warrants its own change with focused tests rather than a bolt-on.

## Key files

- `apps/client/src/components/voice-provider/index.tsx`
  - `captureWatchedRemoteStreams` (snapshot source)
  - recovery attempt + `restoreWatchTasks` (snapshot consumer)
  - `acceptStream` / `stopWatchingStream` (watch intent for external)
- `apps/client/src/components/voice-provider/hooks/use-transports.ts`
  - `stopWatchingStream` (the consumer teardown + `closeConsumer` RPC)
