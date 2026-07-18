# WebSocket Auth-Refresh Recovery Follow-up

**Status:** Deferred. The general rapid-WebSocket-flap race is fixed, but the
auth-refresh branch still has a narrower reconnect ownership gap.

## Remaining gap

Normal application WebSocket recovery installs a callback with
`setOnWsReconnect()` in `apps/client/src/features/server/actions.ts`. Each socket
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
