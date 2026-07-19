# Voice Recovery Boundary Audit

**Status:** Closed. All five findings have explicit recovery owners, bounded
adapter outcomes, and focused acceptance coverage. Browser fault injection also
proves terminal microphone behavior across failed server synchronization and
WebSocket recovery.

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
- Successful signaling setup begins transport probation but does not itself
  prove media health or reset prior failure history. The probation interval must
  exceed the complete server-side failure-detector horizon.
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
- Asynchronous health samples and failure events carry transport identity.
  Results for a replaced transport cannot trigger recovery of its successor.

## Recovery matrix

| Flow | Recovery owner | Stable or terminal state | Boundary cases to prove |
| --- | --- | --- | --- |
| Default microphone move | Microphone controller and device-change adapter | Muted capture is stopped until a later unmute; unmuted capture moves once to the new default | Repeated device events, unavailable identities, cleanup overlap, and unmute after teardown |
| Raw microphone loss | Microphone controller, then the local mute adapter | Capture is stopped, local state remains muted, server sync is best-effort, and a later unmute reacquires capture | `voice.updateState` failure, WebSocket reconnect, missing server seat, and overlapping user mute intent |
| Transport failure | Server liveness watchdog, voice session machine, and command executor | Only current, accepted failures consume the rapid-failure budget; rebuild/reconnect success begins probation, and exhaustion leaves voice through normal terminal cleanup | Watchdog-paced failure, failure during WebSocket reconnect, duplicate callbacks, in-flight samples from replaced transports, stale rebuild completion, and channel changes |
| Remote-media repair | Producer-scoped subscription ledger and repair runner | Repair backs off and stops for the same channel/producer identity; replacement identity receives a fresh budget | Producer replacement, channel changes, timeout cleanup, failed consume/resume, and stale completion ordering |

Application WebSocket authentication remains upstream of these media flows. The
separate [WebSocket Auth-Refresh Recovery Follow-up](./websocket-auth-refresh-recovery.md)
defines callback ownership across controlled tRPC client replacement.

## Audit findings

### Remediated findings

1. **Terminal raw-microphone exhaustion is locally authoritative.** Capture is
   stopped first, terminal mute bypasses optimistic rollback, reconnect intent
   is updated, and server synchronization is best-effort.
2. **Microphone reacquisition reports an explicit outcome.** Default-device and
   raw-loss recovery receive `started`, `failed`, or `superseded`; accepted
   failures advance the same bounded operation and exhaustion commits terminal
   mute.
3. **Terminal microphone intent replaces stale reconnect work.** Microphone
   safety transitions use the shared operation ordering and replace an active
   restore command when the pending reconnect snapshot changes.
4. **Transport stability requires surviving the server detector horizon.** The
   session machine reports accepted failure and rebuild outcomes, rebuild or
   WebSocket success begins a shared 90-second probation without erasing prior
   failures, identity-less events from older servers remain bounded, and stale
   identified events for replaced transports are ignored.
5. **Remote-media repair is producer-scoped.** The subscription ledger owns one
   budget per `(channelId, remoteId, kind, producerId)`, while scheduled and
   in-flight work verifies that exact identity before mutating or consuming.

### Confirmed foundations

- Default-device generation checks, duplicate-event suppression, and muted
  teardown remain sound with explicit reacquisition outcomes.
- The microphone controller owns track and producer cleanup and limits repeated
  raw-track loss for a stable capture generation.
- The voice session machine serializes rebuild commands, rejects stale command
  completions, preempts rebuilds on WebSocket loss, and performs normal terminal
  leave cleanup when its own rebuild attempts exhaust.
- The remote consume controller bounds RPC stages, owns late allocation cleanup,
  and rejects stale transport or producer completions. The producer-scoped
  repair scheduler now preserves those boundaries.

## Completed remediation

1. The microphone transition boundary reports explicit outcomes, commits
   terminal mute locally, updates reconnect intent, and synchronizes without
   rollback.
2. Transport circuit timing advances from accepted machine events, records
   successful rebuild completion as the beginning of probation, and preserves
   the prior failure count until that probation outlives the server watchdog.
3. Producer-scoped repair budgets invalidate replaced or channel-stale work and
   give each replacement identity one fresh budget.
4. Focused and browser integration tests inject failed acquisition, failed
   `voice.updateState`, reconnect overlap, slow rebuilds, and independently
   changing remote producer identities.

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

| Acceptance boundary | Focused or browser coverage |
| --- | --- |
| Normal user mute rolls back after server failure | `recovery-faults.spec.ts`: “a failed user microphone mutation rolls back while reconnect converges on that rollback” |
| Terminal raw-capture exhaustion remains muted through failed sync or disconnect, then unmute retries capture | `recovery-faults.spec.ts`: “terminal microphone mute survives failed server sync and reconnect restore” |
| Newer microphone intent wins over stale synchronization or restore completion | `voice-state-operation.test.ts`: “ignores an older async result after a newer operation starts”; `voice-session-machine.test.ts`: “replaces an active restore command when microphone intent changes”; `recovery-faults.spec.ts`: “the latest microphone intent wins across repeated reconnects” |
| Failed default-device or raw-loss reacquisition advances bounded recovery | `default-input-device.test.ts`: default-device decision cases; `microphone-pipeline-controller.test.ts`: “counts failed acquisition or publication outcomes in the same bounded recovery operation”; `recovery-faults.spec.ts`: “failed raw microphone reacquisition exhausts once and a later unmute retries capture” |
| Muted fresh rejoins skip acquisition, and a failed transport-recovery microphone restart continues listen-only | `transport-recovery-microphone.test.ts`: muted fresh-rejoin, failed restart, live capture, and supersession cases; `recovery-faults.spec.ts`: “transport recovery continues listen-only when microphone restart fails” |
| WebSocket-owned transport failures preserve the latch and prior budget | `recover-transport-session.test.ts`: “ignores transport failure while websocket reconnect owns recovery”; `transport-recovery-circuit.test.ts`: “preserves the budget when websocket recovery ignores a proposed failure” and the corresponding exhausted-budget case |
| Accepted failures advance once and terminal exhaustion cleans up once | `transport-recovery-circuit.test.ts`: duplicate and stale-generation coverage; `recover-transport-session.test.ts`: “accepts circuit exhaustion and emits terminal cleanup exactly once” |
| Immediate replacement failure after a slow rebuild remains rapid | `transport-recovery-circuit.test.ts` and `recovery-faults.spec.ts`: “an immediate failure after a slow transport rebuild stays in the rapid circuit” |
| Watchdog-paced failures cannot repeatedly reset the transport budget | `transport-recovery-circuit.test.ts`: “stops watchdog-paced failures that arrive after the old 30-second window”; `recovery-faults.spec.ts`: “server-liveness-paced transport failures exhaust the recovery circuit” |
| Replaced transport health work cannot fail its successor | `media-liveness.test.ts`: “rejects an in-flight sample after its consumer transport is replaced”; `voice-transport-failure-identity.test.ts`: current, replaced, and identity-less event cases |
| Channel- or producer-stale repair is cancelled, and consume/resume is bounded | `remote-media-producer-repair.test.ts`: replacement, concurrent producer, and channel invalidation cases; `remote-media-consume-controller.test.ts`: cancellation, deterministic retries, failed resume cleanup, and resume timeout cases |
| Producer churn cannot reset another slot's exhausted budget | `remote-media-subscriptions.test.ts`: “keeps an exhausted producer isolated from churn in another slot” |

The terminal-microphone Playwright case closes the fault-injection contract. It
forces `voice.updateState` failure by closing the application socket during
terminal exhaustion, then verifies local muted controls, zero live microphone
tracks, no duplicate microphone publication after reconnect, server-confirmed
mute from a second client, and successful capture retry on a later unmute.

## Non-blocking follow-ups

These type and naming improvements do not change the closed audit findings or
the current runtime guarantees:

- Tighten the internal `TransportFailed` and `TransportRecoveryExhausted` event
  contract by requiring `connectedGeneration`, or by unconditionally rejecting
  those events outside the matching connected phase. The production transport
  adapter already supplies the generation; the optional event field remains a
  future-call-site escape hatch.
- Rename the remote-media repair ledger's `completedAttempts` field to reflect
  that an accepted attempt consumes its budget when work starts, before the
  asynchronous repair settles. Charging at start is intentional because it
  prevents overlapping or interrupted work from regaining a retry.

## Completion criteria

All five findings now have explicit owners and focused coverage. Recovery
adapters report accepted, ignored, superseded, or terminal outcomes, and the
fault-injection suite covers disconnect, supersession, identity change, slow
recovery, and side-effect failure without unbounded work or contradictory local
state.
