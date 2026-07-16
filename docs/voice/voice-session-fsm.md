# Voice Session FSM Design Record

**Status:** Implemented. The session machine foundation landed in PR #277, the
executor and transactional restore work landed through PR #292, and lifecycle
hardening followed in PRs #293 and #294.

**Companion:** [`remote-media-subscription-state.md`](./remote-media-subscription-state.md)
describes remote consume intent and recovery.

## Decision

Voice session lifecycle is modeled as one hand-written finite state machine with
a pure reducer, a command envelope, and an extracted asynchronous executor. The
machine is the single source of truth for connection phase, recovery progress,
retry policy, command currency, and terminal failure.

The implementation is split across:

- `voice-session-machine.ts`: state, events, commands, reducer, and selectors
- `voice-session-store.ts`: module-level state, dispatch, subscriptions, and
  buffered command delivery
- `voice-session-command-executor.ts`: asynchronous command lifecycle and
  result-event dispatch
- `use-voice-session-executor.ts`: thin React adapter with fresh provider ports

These files live under `apps/client/src/features/server/voice/` and
`apps/client/src/components/voice-provider/hooks/`.

## Why one machine

WebSocket reconnect and in-session transport rebuild used to be separate loops
that could both tear down and rebuild the same media session. Connection status,
retry counters, authentication gates, reconnect intent, and peer suppression
also lived in different mutable stores or local variables.

One discriminated state makes the important exclusivity structural:

- `idle`
- `joining`
- `connected`
- `rebuilding`
- `reconnecting`
- `failed`

`rebuilding` and `reconnecting` cannot be active together. Connection status is
a projection of the phase rather than a second mutable truth.

The project uses a hand-written reducer because the repository already uses this
state/command pattern for remote media, and the required value is explicit state
and deterministic transitions rather than a new runtime dependency.

## State and identity

Recovery phases carry the data needed to make decisions without runner-owned
bookkeeping:

- channel and reconnect intent
- recovery generation and active command id
- transport nonce and nonce-restart count for rebuilds
- retry attempt and consecutive unknown-error count
- authentication and online-wait progress
- the captured watched-media snapshot
- whether a reconnect attempt established a server session

Command ids and generations are monotonic. Result events echo both, and the
reducer ignores stale results. Finalization commands are also generation-bound so
a buffered cleanup from an old session cannot run against a later rejoin of the
same channel.

Peer reconnect suppression is top-level machine state because it intentionally
outlives the recovery phase that created it. The compatibility
`reconnect-coordinator.ts` facade selects and dispatches through the machine; new
execution code must not use it as a second mutable state owner.

## Events, commands, and policy

World events trigger transitions, including:

- join requested/succeeded/failed
- WebSocket dropped or authenticated
- transport failed or nonce changed
- reconnect intent captured or cleared
- terminal session exit

The machine emits effect commands such as:

- capture the recovery snapshot
- rebuild transports
- wait for network or authentication
- restore the server voice session
- wait before retrying
- restore remote watch intent
- recover desktop app audio
- leave or clear a failed session

The executor reports explicit result events for success, failure, expiry, delay
completion, and watch-intent rehydration. Raw errors return to the reducer, where
`classifyVoiceReconnectError` owns retry-vs-terminal policy and the unknown-error
cap. The executor performs effects; it does not classify errors or mutate session
state directly.

## Recovery transitions

Transport failure while WebSocket recovery is active is ignored. A WebSocket
drop during an in-session rebuild preempts that rebuild and starts reconnect
recovery. Superseded executor work is aborted and must re-check command currency
after every awaited boundary before mutating shared resources.

Recovery is connectivity-gated:

- offline reconnect waits without consuming retry budget
- authentication is confirmed before restore proceeds
- retry delays and reconnect deadlines are explicit machine steps
- one-shot recovery state is not consumed during disconnect or cleanup

The executor owns per-command `AbortController`s, bounded cancellation drain,
and queuing of successor rebuild or restore commands. Hung cancelled operations
may be detached after the bounded drain, but their ports must stop shared writes
once command currency is lost.

## Remote media restoration

Snapshot capture is an injected executor port because it reads live ledger state.
The executor captures it once before cleanup and sends it back as a
`RecoveryStarted` result so the reducer remains pure.

Recovery never consumes watched media through a private side path. The session
machine emits `RestoreWatchIntent`; the remote-media ledger rehydrates desire and
mints its own consume commands after producer reconciliation. An explicit
stop-watch during recovery therefore remains authoritative.

See [`remote-media-subscription-state.md`](./remote-media-subscription-state.md)
for the ledger’s identity, retry, and producer-replacement rules.

## Local media restoration

Local media pipelines remain separate resource controllers commanded by the
session lifecycle:

- microphone recovery is ordered and reusable across React Strict Mode replay
- desktop app-audio recovery is a connected-session finalization command
- lifecycle leases prevent queued or in-flight work from publishing after the
  provider that owns it unmounts
- terminal exits stop local resources; expected recovery preserves intent and
  rebuilds the resources under the new session generation

These controllers do not become additional session state machines and cannot
decide reconnect policy.

## Server restore ownership

Client cancellation alone cannot undo a restore request that has already
committed on the server. Server join/restore therefore uses prepared transport
pairs and a synchronous commit boundary:

- fallible transport preparation happens before membership or active transport
  ownership changes
- current incarnation and mutation-token checks fence stale requests
- a prepared pair is either committed once or disposed
- existing-session replacement swaps the pair atomically
- after a reconnect command establishes a server session, ownership is sticky
  for that generation and terminal cleanup explicitly leaves it

This prevents a timed-out older request from replacing resources created by a
newer attempt and prevents partial restore state from becoming visible.

## Invariants to preserve

- The reducer is pure and owns all retry and terminal decisions.
- At most one recovery phase and one active step exist at a time.
- Commands and results are generation/id checked.
- Executor ports re-check currency after awaited boundaries and before writes.
- Recovery starts only with confirmed connectivity and authentication.
- WebSocket recovery preempts transport rebuild; transport failure defers to an
  active WebSocket recovery.
- Remote watch restoration goes through the subscription ledger.
- Local media mutations cannot publish after lifecycle ownership is lost.
- Server restore preparation is private until one atomic commit.
- Terminal failure cleans up both client resources and any server session already
  established during that recovery generation.

## Verification

Keep deterministic coverage at each boundary:

- reducer transition and stale-result tests in
  `apps/client/src/features/server/voice/__tests__/voice-session-machine.test.ts`
- store buffering and generation tests in the voice session store tests
- executor cancellation, retry, timeout, detach, and finalization tests in
  `voice-session-command-executor.test.ts`
- React adapter remount/replay tests in `use-voice-session-executor.test.ts`
- provider-level transport and watch restoration tests
- server prepared-pair, join, restore, mutation-token, and cancellation tests

Integrated validation should continue to cover WebSocket drops, offline deferral,
rapid reconnects, transport rebuilds, server restarts, producer replacement,
stop-watch races, provider remount, and desktop app-audio recovery where hardware
is available.
