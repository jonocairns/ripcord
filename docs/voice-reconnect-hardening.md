# Voice Reconnect Hardening

## Status

- Overall status: PR 5 is complete and verified in local web/client plus desktop dev testing; the remaining open items below are limited to explicit revertibility and a few still-unverified edge-case follow-ups
- Tracking rule: each PR must be independently revertible
- Architecture constraint: keep the current single-instance architecture
- Dev-only reconnect lab is available in local client / desktop dev builds to simulate WS reconnects, delayed or failed `restoreOrJoin`, lost server-side voice session state, transport failure, and desktop quit flush behavior without touching production flows

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

- [x] Add a backward-compatible internal tRPC procedure: `voice.restoreOrJoin`
- [x] Keep API changes backward compatible for older desktop clients
- [x] Implement `voice.restoreOrJoin` input contract:
  - [x] `channelId`
  - [x] `state: { micMuted, soundMuted }`
  - [x] `reconnectAttemptId`
- [x] Return the same bootstrap shape as `voice.join`
- [x] If the same preserved session is already in the requested channel, return bootstrap only with no join, leave, or session-replaced side effects
- [x] If the user is not in voice anywhere, join normally and return bootstrap
- [x] If the user is in a different channel, throw `CONFLICT` with `VOICE_SESSION_WRONG_CHANNEL`
- [x] If the user is in the requested channel on another active session, throw `CONFLICT` with `VOICE_SESSION_OWNED_ELSEWHERE`
- [x] Do not evict another active session during reconnect recovery
- [x] After WS reconnect and `joinServer`, call `voice.restoreOrJoin` if `pendingVoiceReconnect` is still valid, even when `voiceMap` already shows the user in that channel
- [x] On successful restore/join, set local `currentVoiceChannelId`
- [x] On successful restore/join, reconcile channel users from bootstrap
- [x] On successful restore/join, initialize `VoiceProvider` silently with `playJoinSound: false`
- [x] On successful restore/join, create `voiceReconnectSuppression` for 10 seconds
- [x] Ensure only one reconnect attempt may run at a time on the client
- [ ] Keep `voiceSessionReconnectNonce` only as a stale-work guard
- [x] Add a reconnect-specific retry classifier, separate from disconnected-screen helpers
- [x] Treat these cases as retryable:
  - [x] network error / WS unavailable
  - [x] HTTP `429`
  - [x] HTTP `5xx`
  - [x] tRPC `TOO_MANY_REQUESTS`
  - [x] tRPC / server internal errors
  - [x] local timeout sentinel
  - [x] WS close `1013`
  - [x] unknown or untyped errors, capped at 3 consecutive attempts
- [x] Treat these cases as terminal:
  - [x] `BAD_REQUEST`
  - [x] `UNAUTHORIZED`
  - [x] `FORBIDDEN`
  - [x] `NOT_FOUND`
  - [x] unsupported codec / `Device.load()` unsupported errors
  - [x] `CONFLICT` restore outcomes
- [x] Use retry backoff sequence `1s`, `2s`, `4s`, `8s`, `10s`, then `10s` repeat
- [x] Apply `+-20%` jitter to each delay
- [x] Pause retries while `navigator.onLine === false`
- [x] Resume retries immediately when back online
- [ ] Keep offline pause from extending the server-side 60s grace TTL
- [x] Leave `Retry-After` support out of MVP unless existing error plumbing already exposes it cleanly
- [x] Keep existing `opts.reconnecting` sound suppression behavior
- [x] Add peer-scoped suppression for 10 seconds after restore, covering only users in the pre-disconnect peer snapshot
- [x] Ensure new joiners during suppression still produce sounds
- [x] Ensure producer or transport churn alone does not emit membership or started-stream sounds
- [x] Add structured server logs for `restoreOrJoin` attempt and outcome
- [x] Add structured server logs for conflict reason
- [x] Add client logs for reconnect attempt start
- [x] Add client logs for retry classification
- [x] Add client logs for retry delay
- [x] Add client logs for offline pause and resume
- [x] Add client logs for terminal clear reason
- [ ] Verify PR 3 is independently revertible

### PR 4: reconnecting indicator

- [x] Show a reconnecting indicator after 4 seconds disconnected
- [x] Add a short fade-in for the reconnecting indicator
- [x] Hide the reconnecting indicator immediately on reconnect
- [x] Verify PR 4 is independently revertible

### PR 5: desktop quit coordination

- [x] Add a desktop-only quit coordination path across main, preload, and renderer
- [x] On `before-quit`, clear reconnect state first
- [x] On `before-quit`, fire `voice.leave`
- [x] On `before-quit`, wait up to 2 seconds
- [x] Continue quitting regardless after the wait budget expires
- [x] Ensure desktop quit never schedules or triggers auto-rejoin
- [x] If the renderer is unavailable, skip flush, rely on grace expiry, and log that quit flush was skipped
- [x] Add client logs for desktop quit flush skipped and succeeded
- [x] Verify PR 5 is independently revertible

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

- [x] New tRPC procedure: `voice.restoreOrJoin`
- [x] Explicit server error message: `VOICE_SESSION_WRONG_CHANNEL`
- [x] Explicit server error message: `VOICE_SESSION_OWNED_ELSEWHERE`

### Internal client state

- [x] `pendingVoiceReconnect`
- [x] `reconnectingSince`
- [x] `voiceReconnectSuppression`
- [x] `clearVoiceReconnectRecovery(reason)`

## Observability

### Server logs and counters

- [x] `grace scheduled`
- [x] `grace cancelled`
- [x] `grace expired`
- [x] `restoreOrJoin attempt`
- [x] `restoreOrJoin outcome`
- [x] `conflict reason`
- [x] `missing clientInstanceId`
- [x] Include fields:
  - [x] `reconnectAttemptId`
  - [x] `userId`
  - [x] `clientInstanceId`
  - [x] `requestedChannelId`
  - [x] `activeChannelId`
  - [x] `graceAgeMs`
  - [x] `ttlRemainingMs`
  - [x] `wsCloseCode`

### Client logs

- [x] `reconnect attempt start`
- [x] `retry classification`
- [x] `retry delay`
- [x] `offline pause`
- [x] `offline resume`
- [x] `terminal clear reason`
- [x] `desktop quit flush skipped`
- [x] `desktop quit flush succeeded`

## Test Plan

### Server

- [x] Same-session restore returns bootstrap without join, leave, or session-replaced side effects
- [x] Restore/join joins normally when no active voice session exists
- [x] Wrong-channel restore returns `CONFLICT`
- [x] Active other-session ownership returns `CONFLICT` without eviction
- [x] Reconnect cancels only the matching `clientInstanceId` grace entry
- [x] Missing `clientInstanceId` path logs clearly and does not create silent orphan behavior
- [x] Multi-tab conflict coverage lands

### Client

- [x] Pending reconnect survives disconnect cleanup and is not consumed while disconnected
- [x] Post-cleanup reconnect still calls `restoreOrJoin` even when `voiceMap` already shows membership
- [ ] Only one reconnect attempt runs at a time
- [ ] Kick, ban, and subscription-driven terminal events clear reconnect state
- [x] Retry classifier handles terminal 4xx, `429`, `TOO_MANY_REQUESTS`, `5xx`, timeout, `1013`, network errors, unsupported-device errors, and unknown-error cap
- [x] Reconnect suppression is peer-scoped and time-bounded
- [ ] Provider init after restore is silent

### End-to-end recovery

- [x] Add a dev-only reconnect lab for manual fault injection during local testing
- [x] Transient WS or network drop within 60 seconds restores automatically
- [ ] Server restart recovers automatically and quietly after reconnect
- [x] ICE-only failure does not cause a leave or rejoin cycle
- [ ] Producer churn during recovery does not create false sounds
- [x] Desktop quit does not hang beyond 2 seconds and does not leave stale reconnect intent

## Assumptions

- Single-server-instance, in-memory grace remains the deployment model for now
- Older desktop clients may connect to newer servers, so server API changes must stay backward compatible
- Browser reload is not treated as a distinct trustworthy leave signal
- Ghost membership during the 60-second grace window is acceptable
- Full server restart cannot preserve media continuity; only automatic quiet recovery is in scope
