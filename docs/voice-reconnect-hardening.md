# Voice Reconnect Hardening

## Status

- Overall status: PR 2 complete
- Tracking rule: each PR must be independently revertible
- Architecture constraint: keep the current single-instance architecture

## Summary

Harden voice reconnect around an explicit client-side recovery flow plus a server `restoreOrJoin` API.

This aims to improve transient reconnects and server-restart recovery without broad app-teardown changes, and without weakening correctness for real joins and leaves. The design does not use browser unload beacons or client-asserted reconnect flags to mutate server truth.

## Delivery Order

### PR 1: server grace, logging, and transport audit

- [x] Increase `VOICE_DISCONNECT_GRACE_MS` from `5_000` to `60_000` in the WS layer
- [x] Keep pending voice disconnects keyed by `clientInstanceId`
- [x] Ensure reconnect cancels only the matching grace entry
- [x] Treat missing `clientInstanceId` as an explicit hard edge case
- [x] Log missing `clientInstanceId` clearly
- [x] Use the safest existing fallback behavior when `clientInstanceId` is missing
- [x] Add structured server logs for grace scheduled, cancelled, and expired
- [x] Add server counters for grace scheduled, cancelled, and expired
- [x] Audit ICE-only failure vs WS reconnect behavior
- [x] Audit outcome: no ICE-path fix required; the existing transport-rebuild path stays in-session and does not force a leave/rejoin cycle
- [x] Verify PR 1 is independently revertible

### PR 2: reconnect coordinator and client recovery state

- [x] Add a dedicated reconnect coordinator
- [x] Make the reconnect coordinator the single owner of `pendingVoiceReconnect`
- [x] Make the reconnect coordinator the single owner of `reconnectingSince`
- [x] Make the reconnect coordinator the single owner of `voiceReconnectSuppression`
- [x] Add one clear path only: `clearVoiceReconnectRecovery(reason)`
- [x] Keep global app teardown grace at `5_000`
- [x] Persist reconnect intent through normal disconnect cleanup
- [x] Store `pendingVoiceReconnect = { channelId, micMuted, soundMuted, peerUserIds, expiresAt }`
- [x] Store `reconnectingSince = timestamp`
- [x] Store `voiceReconnectSuppression = { channelId, peerUserIds, expiresAt }`
- [x] Snapshot `peerUserIds` by value, not by reference
- [x] Extract a behavior-preserving restore/bootstrap init path for later reuse
- [x] Verify PR 2 is independently revertible

### PR 3: `voice.restoreOrJoin`, retry loop, and quiet recovery

- [ ] Add a backward-compatible internal tRPC procedure: `voice.restoreOrJoin`
- [ ] Keep API changes backward compatible for older desktop clients
- [ ] Implement `voice.restoreOrJoin` input contract:
  - [ ] `channelId`
  - [ ] `state: { micMuted, soundMuted }`
  - [ ] `reconnectAttemptId`
- [ ] Return the same bootstrap shape as `voice.join`
- [ ] If the same preserved session is already in the requested channel, return bootstrap only with no join, leave, or session-replaced side effects
- [ ] If the user is not in voice anywhere, join normally and return bootstrap
- [ ] If the user is in a different channel, throw `CONFLICT` with `VOICE_SESSION_WRONG_CHANNEL`
- [ ] If the user is in the requested channel on another active session, throw `CONFLICT` with `VOICE_SESSION_OWNED_ELSEWHERE`
- [ ] Do not evict another active session during reconnect recovery
- [ ] After WS reconnect and `joinServer`, call `voice.restoreOrJoin` if `pendingVoiceReconnect` is still valid, even when `voiceMap` already shows the user in that channel
- [ ] On successful restore/join, set local `currentVoiceChannelId`
- [ ] On successful restore/join, reconcile channel users from bootstrap
- [ ] On successful restore/join, initialize `VoiceProvider` silently with `playJoinSound: false`
- [ ] On successful restore/join, create `voiceReconnectSuppression` for 10 seconds
- [ ] Ensure only one reconnect attempt may run at a time on the client
- [ ] Keep `voiceSessionReconnectNonce` only as a stale-work guard
- [ ] Add a reconnect-specific retry classifier, separate from disconnected-screen helpers
- [ ] Treat these cases as retryable:
  - [ ] network error / WS unavailable
  - [ ] HTTP `429`
  - [ ] HTTP `5xx`
  - [ ] tRPC `TOO_MANY_REQUESTS`
  - [ ] tRPC / server internal errors
  - [ ] local timeout sentinel
  - [ ] WS close `1013`
  - [ ] unknown or untyped errors, capped at 3 consecutive attempts
- [ ] Treat these cases as terminal:
  - [ ] `BAD_REQUEST`
  - [ ] `UNAUTHORIZED`
  - [ ] `FORBIDDEN`
  - [ ] `NOT_FOUND`
  - [ ] unsupported codec / `Device.load()` unsupported errors
  - [ ] `CONFLICT` restore outcomes
- [ ] Use retry backoff sequence `1s`, `2s`, `4s`, `8s`, `10s`, then `10s` repeat
- [ ] Apply `+-20%` jitter to each delay
- [ ] Pause retries while `navigator.onLine === false`
- [ ] Resume retries immediately when back online
- [ ] Keep offline pause from extending the server-side 60s grace TTL
- [ ] Leave `Retry-After` support out of MVP unless existing error plumbing already exposes it cleanly
- [ ] Keep existing `opts.reconnecting` sound suppression behavior
- [ ] Add peer-scoped suppression for 10 seconds after restore, covering only users in the pre-disconnect peer snapshot
- [ ] Ensure new joiners during suppression still produce sounds
- [ ] Ensure producer or transport churn alone does not emit membership or started-stream sounds
- [ ] Add structured server logs for `restoreOrJoin` attempt and outcome
- [ ] Add structured server logs for conflict reason
- [ ] Add client logs for reconnect attempt start
- [ ] Add client logs for retry classification
- [ ] Add client logs for retry delay
- [ ] Add client logs for offline pause and resume
- [ ] Add client logs for terminal clear reason
- [ ] Verify PR 3 is independently revertible

### PR 4: reconnecting indicator

- [ ] Show a reconnecting indicator after 4 seconds disconnected
- [ ] Add a short fade-in for the reconnecting indicator
- [ ] Hide the reconnecting indicator immediately on reconnect
- [ ] Verify PR 4 is independently revertible

### PR 5: desktop quit coordination

- [ ] Add a desktop-only quit coordination path across main, preload, and renderer
- [ ] On `before-quit`, clear reconnect state first
- [ ] On `before-quit`, fire `voice.leave`
- [ ] On `before-quit`, wait up to 2 seconds
- [ ] Continue quitting regardless after the wait budget expires
- [ ] Ensure desktop quit never schedules or triggers auto-rejoin
- [ ] If the renderer is unavailable, skip flush, rely on grace expiry, and log that quit flush was skipped
- [ ] Add client logs for desktop quit flush skipped and succeeded
- [ ] Verify PR 5 is independently revertible

## Behavior and Contract Notes

### Server behavior

- Increase WS-layer voice disconnect grace to `60_000`
- Keep pending disconnects keyed by `clientInstanceId`
- Reconnect may cancel only the matching grace entry
- Missing `clientInstanceId` must not create a silent uncancellable 60-second orphaned grace

### Client recovery flow

- Keep global app teardown grace at `5_000`
- Recovery state lives under the reconnect coordinator only
- `pendingVoiceReconnect` must survive ordinary disconnect cleanup
- Post-cleanup reconnect still attempts `voice.restoreOrJoin` when the reconnect intent is valid

### Sound and UI behavior

- Recovery target is automatic, quiet recovery
- Full server restart may rebuild media; literal no-drop transport continuity is not required
- Peer-scoped suppression is additive to existing reconnect sound suppression
- Membership changes should be distinguished from producer and transport churn

### Desktop quit path

- Quit path is desktop-only
- Quit flush budget is capped at 2 seconds
- Renderer-unavailable quit must fall back cleanly to grace expiry

### Explicit non-goals

- No browser unload beacon endpoint
- No new client-supplied reconnecting flag on `voice.join`

## Interfaces and Types

### Public or shared additions

- [ ] New tRPC procedure: `voice.restoreOrJoin`
- [ ] Explicit server error message: `VOICE_SESSION_WRONG_CHANNEL`
- [ ] Explicit server error message: `VOICE_SESSION_OWNED_ELSEWHERE`

### Internal client state

- [ ] `pendingVoiceReconnect`
- [ ] `reconnectingSince`
- [ ] `voiceReconnectSuppression`
- [ ] `clearVoiceReconnectRecovery(reason)`

## Observability

### Server logs and counters

- [ ] `grace scheduled`
- [ ] `grace cancelled`
- [ ] `grace expired`
- [ ] `restoreOrJoin attempt`
- [ ] `restoreOrJoin outcome`
- [ ] `conflict reason`
- [ ] `missing clientInstanceId`
- [ ] Include fields:
  - [ ] `reconnectAttemptId`
  - [ ] `userId`
  - [ ] `clientInstanceId`
  - [ ] `requestedChannelId`
  - [ ] `activeChannelId`
  - [ ] `graceAgeMs`
  - [ ] `ttlRemainingMs`
  - [ ] `wsCloseCode`

### Client logs

- [ ] `reconnect attempt start`
- [ ] `retry classification`
- [ ] `retry delay`
- [ ] `offline pause`
- [ ] `offline resume`
- [ ] `terminal clear reason`
- [ ] `desktop quit flush skipped`
- [ ] `desktop quit flush succeeded`

## Test Plan

### Server

- [ ] Same-session restore returns bootstrap without join, leave, or session-replaced side effects
- [ ] Wrong-channel restore returns `CONFLICT`
- [ ] Active other-session ownership returns `CONFLICT` without eviction
- [ ] Reconnect cancels only the matching `clientInstanceId` grace entry
- [ ] Missing `clientInstanceId` path logs clearly and does not create silent orphan behavior
- [ ] Multi-tab conflict coverage lands

### Client

- [ ] Pending reconnect survives disconnect cleanup and is not consumed while disconnected
- [ ] Post-cleanup reconnect still calls `restoreOrJoin` even when `voiceMap` already shows membership
- [ ] Only one reconnect attempt runs at a time
- [ ] Kick, ban, and subscription-driven terminal events clear reconnect state
- [ ] Retry classifier handles `429`, `TOO_MANY_REQUESTS`, unknown-error cap, and offline pause/resume
- [ ] Reconnect suppression is peer-scoped and time-bounded
- [ ] Provider init after restore is silent

### End-to-end recovery

- [ ] Transient WS or network drop within 60 seconds restores automatically
- [ ] Server restart recovers automatically and quietly after reconnect
- [ ] ICE-only failure does not cause a leave or rejoin cycle
- [ ] Producer churn during recovery does not create false sounds
- [ ] Desktop quit does not hang beyond 2 seconds and does not leave stale reconnect intent

## Assumptions

- Single-server-instance, in-memory grace remains the deployment model for now
- Older desktop clients may connect to newer servers, so server API changes must stay backward compatible
- Browser reload is not treated as a distinct trustworthy leave signal
- Ghost membership during the 60-second grace window is acceptable
- Full server restart cannot preserve media continuity; only automatic quiet recovery is in scope
