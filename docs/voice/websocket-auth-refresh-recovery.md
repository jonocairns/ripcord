# WebSocket Auth-Refresh Recovery Follow-up

**Status:** Deferred. The general rapid-WebSocket-flap race is fixed, but the
auth-refresh branch still has a narrower reconnect ownership gap.

## Remaining gap

Normal application WebSocket recovery installs a callback with
`armServerRejoin()` in `apps/client/src/features/server/actions.ts`. Each socket
open starts a new silent server rejoin generation, which authenticates the new
server-side WebSocket context before voice recovery continues.

When that rejoin fails with an authentication error on an open socket, the
client refreshes its access token and calls `reconnectTRPC()`. That function
deliberately replaces the tRPC client, but it also clears the registered
reconnect callback. The caller immediately attempts one silent rejoin with the
replacement client.

If the replacement socket drops during that post-refresh handshake or
`joinServer` request, tRPC can open another socket, but no reconnect callback is
registered to authenticate its new context. The inner retry path can therefore
tear the app down or leave the replacement socket unauthenticated instead of
continuing recovery.

This requires both conditions and was not the cause of the reproduced rapid-flap
failure:

1. Silent rejoin reaches the auth-refresh branch while its socket is open.
2. The controlled replacement socket drops before the post-refresh rejoin
   completes.

## Why this remains deferred

The callback cannot simply be retained unconditionally. It must survive a
controlled client replacement while an existing server session is recovering,
but it must be cleared for terminal cleanup, logout, a server change, and
password-required exits. Getting that ownership wrong can create duplicate
rejoin attempts, refresh loops, or reconnect work that resurrects a session
after cleanup.

The current fix is intentionally limited to the proven general race: when the
active socket drops during the normal silent rejoin, recovery remains pending
until the next tRPC socket opens. Auth-refresh client replacement should be
handled as a separate lifecycle change with focused fault injection.

## Required invariants

A follow-up implementation should preserve these rules:

- One server-rejoin owner is registered for the active application session.
- Controlled tRPC replacement transfers that owner before the replacement
  socket can open.
- Terminal cleanup, logout, server changes, and password-required exits revoke
  the owner and cannot be followed by a late rejoin.
- Every socket open gets a new reconnect generation; stale handshake, join, and
  refresh completions cannot mutate the latest session.
- Rejoin and token-refresh work only proceeds on a confirmed open socket.
- A socket drop preserves the reconnect event buffer and voice intent; terminal
  exits clear both.
- Auth refresh is bounded or token-generation scoped so repeated failures cannot
  create an unbounded refresh/reconnect loop.

The voice session machine should remain downstream of this application-session
authentication gate. It may restore voice only after the latest WebSocket
context has successfully completed `joinServer`.

## When the final silent rejoin gives up

If the last silent rejoin attempt fails for a recoverable reason (server error,
transport failure, or a refresh that could not reach the server), the app tears
down to the disconnect screen rather than the connect screen. Credentials and
voice reconnect recovery are kept, so the disconnect screen's automatic retry
rejoins the server and restores voice, the same as the grace-period teardown.
Terminal outcomes (rejected credentials after refresh, kick, ban, logout) keep
their existing behaviour and drop voice recovery. A password-required exit
returns to the connect screen and leaves the voice intent in place, so entering
the password within the reconnect window still restores voice.

## Acceptance coverage

Add a Playwright fault-injection scenario that:

1. Connects to a server and joins voice.
2. Forces the next silent server rejoin to require a successful token refresh.
3. Drops the controlled replacement socket while its handshake or `joinServer`
   request is in flight.
4. Observes a later socket open, authenticate, and converge on the latest server
   and voice session without showing the connect screen.

The scenario should also assert that there is no duplicate server join, no
unbounded refresh loop, and no page error from teardown-time voice activity.
Focused unit coverage should prove callback transfer and revocation across
controlled replacement, terminal cleanup, and stale generations.


## Application disconnect deadline

An authenticated session has one 45-second deadline from its first detected drop,
measured with the recovering phase's monotonic `since`. Repeated closes shrink the
remaining budget; socket opens, stalled rejoins and token-refresh client replacements
preserve the deadline. Replacement also preserves any pending online listener.
Only authenticated readiness clears the recovery timer, except that a rejoin requiring
`mustChangePassword` ends recovery so the forced-password form remains usable.
A join completed on a closing socket without authenticated readiness keeps the timer.

A final recoverable rejoin failure (#408) tears down immediately and keeps voice intent.
Server-password exits, terminal credentials errors, kick, ban and logout retain their
immediate cleanup behavior. Never-authenticated connections retain their separate
20-second grace, restarted by closes and cancelled by an open socket.

Offline expiry keeps the original deadline and defers teardown, installing a one-shot
online listener and a 20-second recheck. Returning online after the deadline tears down
immediately, even after replacement or on an open stalled socket; it does not start an
old rejoin. The recheck covers online changes without an event. Authentication or cleanup
before the online event prevents a later teardown. Deadline teardown keeps voice intent
and recorded disconnect details, so the disconnect screen's immediate retry can recover.
The old leftover-timer teardown of an already authenticated first connect is removed.

The nominal 15-second difference from the 60-second voice windows is not guaranteed:
the intent, server grace and client deadline begin at different moments, and offline
periods and subsequent media setup may outlast them. The separate callback ownership
gap described above remains deferred; replacement no longer loses the disconnect deadline.
