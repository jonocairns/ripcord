# Voice Recovery Boundary Audit

**Status:** Audited. Remediation is required before the recovery work is ready
to merge. The individual resource controllers are generally bounded, but five
integration gaps still break those bounds or allow local, reconnect, and server
state to disagree.

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

The recurring failure pattern is that a controller or pure policy owns only one
part of the transition. Its adapter then starts asynchronous work without a
result it can commit, reuses a rollback-capable user mutation for a terminal
safety transition, or scopes one retry budget across several independently
changing resources. Isolated policy tests cannot prove those crossings.

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

## Audit findings

### Merge blockers

1. **Terminal raw-microphone exhaustion can roll local mute state back.** The
   controller correctly stops and detaches the exhausted capture before calling
   the adapter, but the adapter sends the terminal mute through the ordinary
   optimistic `setMicMuted` path. If `voice.updateState` fails, that path
   restores the previous unmuted UI state even though no local capture remains.
   Terminal mute needs a locally authoritative transition whose server update
   is best-effort and cannot roll the stopped resource back to active.

2. **Microphone reacquisition has no observable outcome.** Default-device moves
   and raw-track recovery both invoke `startMicStream` without awaiting a
   success or failure result, while `startMicStream` catches and consumes its
   own error. A failed acquisition or publication can therefore remove the old
   capture, leave the UI unmuted, and never advance the controller to bounded
   exhaustion because there is no replacement track to emit another end event.
   The recovery owner must receive a typed outcome and treat failure as part of
   the same bounded operation.

3. **Terminal microphone intent is not merged into an active reconnect.** The
   reconnect machine snapshots `micMuted` when the socket first drops. A later
   terminal mute updates local voice state but does not replace the pending
   reconnect intent, so restore can publish the stale unmuted snapshot after
   local capture has been stopped. Safety-driven mic transitions must use the
   same ordering mechanism as user intent and update the current reconnect
   command when one exists.

4. **Transport stability is measured from the previous failure, not from
   recovery completion.** The rapid-failure circuit resets when two failure
   timestamps are at least 30 seconds apart. A rebuild contains several
   sequential operations, each with its own 12-second timeout, so a slow
   successful rebuild can consume that interval by itself. An immediately
   failing replacement transport can then receive a fresh budget on every
   cycle. Start the stability window when a rebuild succeeds, and let the
   session machine or an explicit accepted result own circuit advancement.

5. **Remote-media repair is not actually producer-scoped.** The runner joins
   every eligible pending stream into one aggregate identity and one retry
   counter. Replacing or adding any producer changes that aggregate and resets
   the budget for every other stuck producer. Churn in one slot can therefore
   keep repair alive indefinitely for another slot. Keep budgets per
   `(channelId, remoteId, kind, producerId)` and bind scheduled or in-flight
   work to that exact identity.

### Confirmed foundations

- Default-device generation checks, duplicate-event suppression, and muted
  teardown are sound once reacquisition reports its outcome.
- The microphone controller owns track and producer cleanup and limits repeated
  raw-track loss for a stable capture generation.
- The voice session machine serializes rebuild commands, rejects stale command
  completions, preempts rebuilds on WebSocket loss, and performs normal terminal
  leave cleanup when its own rebuild attempts exhaust.
- The remote consume controller bounds RPC stages, owns late allocation cleanup,
  and rejects stale transport or producer completions. The remaining defect is
  the global repair scheduler layered above it.

## Remediation order

1. Introduce an explicit microphone transition boundary. Reacquisition must
   return success, failure, or superseded; terminal mute must commit locally,
   update pending reconnect intent, and synchronize to the server without
   rollback.
2. Move transport circuit timing to accepted machine events. Record rebuild
   success as the beginning of the stability interval and count only a later
   accepted failure for the same channel generation.
3. Replace the aggregate remote repair counter with per-producer budgets. A
   producer replacement cancels or invalidates old scheduled work and starts
   exactly one fresh budget for the replacement.
4. Add integration tests at each adapter boundary before broad fault-injection
   coverage. The tests must inject failed acquisition/publication, failed
   `voice.updateState`, mutation during a single reconnect, slow rebuilds, and
   two independently changing remote producer identities.

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
- Failed default-device or raw-loss reacquisition advances the same bounded
  microphone recovery operation instead of leaving an unmuted empty pipeline.
- Ignored transport failures during WebSocket recovery preserve both the failure
  latch and the prior circuit budget.
- Accepted transport failures advance the circuit exactly once and terminal
  exhaustion runs cleanup exactly once.
- A replacement transport that fails immediately after a slow rebuild remains
  in the same rapid-failure sequence.
- Remote repair attempts are cancelled or ignored when channel or producer
  identity changes, and consume/resume work is tracked to success or bounded
  exhaustion.
- Churn in one remote producer slot cannot reset another slot's exhausted repair
  budget.

Playwright fault injection should include server-mutation failure and socket
loss at terminal media transitions. Assertions should cover resource count,
local controls, server convergence after reconnect, retry affordance, and the
absence of duplicate recovery work.

## Completion criteria

Remediation is complete when all five findings have explicit owners and focused
coverage, every recovery adapter reports accepted, ignored, superseded, or
terminal outcomes, and the fault-injection suite proves disconnect,
supersession, identity change, slow recovery, and side-effect failure without
unbounded work or contradictory local state.
