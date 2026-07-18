# Voice Recovery Boundary Audit

**Status:** Planned. Individual recovery policies are bounded, but the adapters
that connect browser resources, local UI state, server mutations, and the voice
session machine need a shared invariant pass.

## Why this audit is needed

Pure recovery policies and resource controllers can be correct in isolation
while their integration still produces contradictory state. A browser resource
may already be stopped while a failed server mutation rolls the UI back to
active, or a recovery policy may consume a retry budget before the session
machine accepts the proposed transition.

These are ownership problems rather than retry-policy problems. Each recovery
flow must distinguish:

- the browser resource state that is already true;
- the latest local user intent;
- optimistic UI state that may normally be rolled back;
- server-confirmed state, which may be unavailable during reconnect;
- proposed recovery work from work accepted by the current session owner; and
- terminal cleanup from reconnect bookkeeping that must preserve intent.

## Shared invariants

- One layer owns each in-flight recovery operation and can determine whether its
  completion is still current.
- A retry counter, circuit state, or one-shot latch advances only when the layer
  responsible for executing that recovery accepts the action.
- Ignored, disconnected, superseded, or cleanup-time events do not consume
  recovery budget or strand one-shot state.
- Terminal local resource loss stops or detaches the local resource before the
  UI reports it inactive.
- User-requested mutations may optimistically roll back after server failure.
  Safety-driven terminal state is locally authoritative and must not be rolled
  back merely because best-effort server synchronization failed.
- Safety-driven state changes participate in the same operation ordering as
  user intent so stale confirmations and failures cannot overwrite a newer
  mute, push-to-talk, camera, or screen-share decision.
- Reconnect recovery preserves intent and live resources where recovery is
  expected. Terminal exits revoke them and cannot be followed by late recovery
  work.
- Retry identity includes every value that makes an attempt materially new,
  such as channel and producer identity. A real identity change resets the
  budget; a rerender or repeated report of the same failure does not.

## Recovery matrix

| Flow | Recovery owner | Stable or terminal state | Boundary cases to prove |
| --- | --- | --- | --- |
| Default microphone move | Microphone controller and device-change adapter | Muted capture is stopped until a later unmute; unmuted capture moves once to the new default | Repeated device events, unavailable identities, cleanup overlap, and unmute after teardown |
| Raw microphone loss | Microphone controller, then the local mute adapter | Capture is stopped, local state remains muted, server sync is best-effort, and a later unmute reacquires capture | `voice.updateState` failure, WebSocket reconnect, missing server seat, and overlapping user mute intent |
| Transport failure | Voice session machine and command executor | Only accepted failures consume the rapid-failure budget; exhaustion leaves voice through normal terminal cleanup | Failure during WebSocket reconnect, duplicate transport callbacks, stale rebuild completion, and channel changes |
| Remote-media repair | Producer-scoped subscription ledger and repair runner | Repair backs off and stops for the same channel/producer identity; replacement identity receives a fresh budget | Producer replacement, channel changes, timeout cleanup, failed consume/resume, and stale completion ordering |

Application WebSocket authentication remains upstream of these media flows. The
separate [WebSocket Auth-Refresh Recovery Follow-up](./websocket-auth-refresh-recovery.md)
defines callback ownership across controlled tRPC client replacement.

## Implementation direction

- Make adapter outcomes explicit where policy decisions cross into state
  machines or side effects. An adapter should be able to report that an action
  was accepted, ignored, superseded, or terminal before policy state is
  committed.
- Keep normal user-toggle rollback semantics separate from terminal local safety
  transitions. A terminal microphone mute may reuse shared operation sequencing,
  but a failed server update must not claim that stopped capture is active.
- Keep resource cleanup, local state publication, and best-effort server
  synchronization in an intentional order. Do not infer resource state from a
  mutation result.
- Prefer extracting small side-effect-free transition helpers or controllers
  from the voice provider when that makes the complete boundary testable. Avoid
  duplicating partial state machines across React refs, stores, and callbacks.

## Acceptance coverage

Focused tests should cover the integration boundaries, not only each pure
policy:

- A normal user mute mutation rolls back when its server update fails.
- Terminal raw-capture exhaustion remains locally muted when the same update
  fails or the socket is disconnected, and a later unmute retries capture.
- A newer mic intent wins over stale success or failure from terminal mute
  synchronization.
- Ignored transport failures during WebSocket recovery preserve both the failure
  latch and the prior circuit budget.
- Accepted transport failures advance the circuit exactly once and terminal
  exhaustion runs cleanup exactly once.
- Remote repair attempts are cancelled or ignored when channel or producer
  identity changes, and consume/resume work is tracked to success or bounded
  exhaustion.

Playwright fault injection should include server-mutation failure and socket
loss at terminal media transitions. Assertions should cover resource count,
local controls, server convergence after reconnect, retry affordance, and the
absence of duplicate recovery work.

## Completion criteria

The audit is complete when every row in the recovery matrix has an explicit
owner, accepted/ignored outcome semantics, terminal local and server behavior,
and focused coverage for disconnect, supersession, and side-effect failure.
