# Voice Session Execution Extraction and Transactional Restore Plan

**Status:** In progress. C0/C1 landed in PR #278, C2/C3 landed in PR #279, C4
landed in PR #280, C5 landed in PR #281, C6 landed in PR #282, and C7 landed in
PR #283. The remaining slices are planned. Completed slices carry a **Landed**
note recording what was built and what later slices should inherit.

**Supersedes:** The Slice 4 seam decision in
[`voice-session-fsm.md`](./voice-session-fsm.md), which accepted an embedded
`VoiceProvider` runner until a useful test seam emerged. Production review of
PRs #274 and #277 found that the seam now exists and is worth extracting.

**Companions:**

- [`voice-session-fsm.md`](./voice-session-fsm.md) — reducer and session-store
  design.
- [`remote-media-subscription-state.md`](./remote-media-subscription-state.md) —
  remote-media intent ledger.
- [`remote-media-intent-migration-qa-plan.md`](./remote-media-intent-migration-qa-plan.md)
  — manual media/reconnect coverage.

## Goal

Make voice recovery execution independently testable without weakening the
generation, cancellation, and resource-ownership guarantees already established
by the FSM and media ledger.

The finished architecture has four explicit layers:

1. **Pure machine** — owns phases, policy decisions, retry classification, and
   commands.
2. **Session store/outbox** — owns state, dispatch, subscriptions, buffered final
   commands, and command delivery.
3. **Command executor** — owns asynchronous command lifecycle, cancellation,
   waits, timeouts, serialization, and result-event dispatch.
4. **Resource controllers** — own mediasoup transports/consumers, microphone
   resources, desktop audio, and cleanup mechanics.

On the server, make restore/join transactional: a request owns uncommitted
transport resources; `VoiceRuntime` owns them only after one synchronous commit
boundary. The provisional-seat claim mechanism (`acquireRestoreSeat` /
`commitProvisionalRestoreSeat` / `rollbackProvisionalRestoreSeat`) already gives
a cancelled bootstrap a defined cleanup owner, but membership still commits and
`USER_JOIN_VOICE` still publishes before any fallible transport preparation has
run. The goal is to eliminate that provisional seat entirely: no membership,
context, or presence side effect exists until the commit point.

## Non-goals

- Do not replace the hand-written FSM with XState or another state-machine
  library.
- Do not move the whole `VoiceProvider` into another large module.
- Do not redesign the remote-media ledger or reconnect policy.
- Do not combine the client extraction and server transaction into one PR.
- Do not remove the reconnect debug lab or manual WebRTC validation paths.
- Do not make public API changes that break shipped desktop clients.

## Invariants

Every slice must preserve these contracts:

- The reducer is the only component that chooses retry versus terminal failure.
- Commands and result events retain command id and generation checks.
- Reconnect and rebuild remain mutually exclusive machine phases.
- A stale executor operation cannot mutate transports, media, session state, or
  shared cleanup resources.
- Cancelling an operation never waits without a bound.
- Final commands survive a provider remount, but never cross session generations.
- Stop Watching wins over queued and in-flight consume work.
- Microphone teardown/build ownership is start-ordered; stale work only disposes
  resources it owns.
- Store projections are never a prerequisite for command correctness.
- Server membership, context, transport installation, and join publication have
  one documented commit owner.
- Each commit is green and reviewable. A behavior fix discovered during an
  extraction lands separately from the mechanical move.

## Target client shape

```text
world events
    |
    v
voice-session-machine.ts   (pure decisions)
    |
    v
voice-session-store.ts     (state + durable final-command outbox)
    |
    v
voice-session-command-executor.ts
    |              |                |
    v              v                v
recovery ports   clock/network    result events -> store
    |
    v
VoiceProvider adapters -> transport / consume / mic / desktop controllers
```

The executor must not import React, Zustand, mediasoup, browser globals, or the
legacy reconnect facade. Those are supplied through ports.

### Proposed executor contract

Names may change during implementation, but the boundary should remain this
small:

```ts
type TVoiceSessionCommandContext = {
	signal: AbortSignal;
	isCurrent: () => boolean;
};

type TVoiceSessionRestoreContext = TVoiceSessionCommandContext & {
	withTimeout: <T>(operation: Promise<T>) => Promise<T>;
	markServerSessionEstablished: () => void;
};

type TVoiceSessionExecutorPorts = {
	now: () => number;
	random: () => number;
	delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	isOnline: () => boolean;

	captureRecoverySnapshot: () => TWatchedRemoteStreamsSnapshot;
	rebuildTransports: (command: TRebuildTransportsCommand, context: TVoiceSessionCommandContext) => Promise<void>;
	restoreVoiceSession: (
		command: TRestoreVoiceSessionCommand,
		context: TVoiceSessionRestoreContext,
	) => Promise<{ serverSessionEstablished: boolean }>;
	restoreWatchIntent: (snapshot: TWatchedRemoteStreamsSnapshot) => void;
	recoverDesktopAppAudio: () => Promise<void>;
	leaveVoiceSession: (channelId?: number) => Promise<void>;
	clearFailedSession: (command: TClearFailedSessionCommand) => Promise<void>;
};

type TVoiceSessionCommandExecutor = {
	execute: (commands: TVoiceSessionCommand[]) => void;
	dispose: () => void;
};
```

The executor reads authentication and command currency directly from the voice
session store. It does not read the Zustand reconnect projection.

## Slice map

| Slice | PR | Workstream | Depends on | Outcome |
| --- | --- | --- | --- | --- |
| C0 | client 1 (#278) | Client | current PR #277 state | Executable contract and deterministic test harness |
| C1 | client 1 (#278) | Client | C0 | Direct machine observation; no projection dependency |
| C2 | client 2 (#279) | Client | C1 | Executor foundation and simple/final commands |
| C3 | client 2 (#279) | Client | C2 | Online, auth, and retry-delay commands extracted |
| C4 | client 3 (#280) | Client | C3 | WS restore command extracted |
| C5 | client 4 (#281) | Client | C2 | Transport rebuild command extracted |
| C6 | client 5 (#282) | Client | C4 + C5 | React adapter cutover; embedded runner removed |
| C7 | client 6 (#283) | Client | C6 | Mutable Zustand projection retired or UI-only |
| C8 | client 7 | Client | C6 | Remote consume resource controller extracted |
| C9 | client 8 | Client | C6 | Microphone pipeline resource controller extracted |
| S0 | server 1 | Server | current PR #277 state | Restore service seam and explicit ownership contract |
| S1 | server 1 | Server | S0 | Prepared transport-pair primitive, unwired |
| S2 | server 2 | Server | S1 | Fresh restore/join uses prepare-then-commit |
| S3 | server 3 | Server | S2 | Existing-session restore swaps transport pairs atomically |
| S4 | server 4 | Server | S3 | Legacy mutation path removed (including `join.ts`); cancellation matrix complete |
| V0 | gate | Both | client and server workstreams | E2E, observability, docs, and rollout gate |

The client and server workstreams may proceed independently. Within the client
workstream, C4 and C5 may be developed in parallel after C2/C3 where their
shared executor primitives are stable. C8 and C9 are follow-on resource seams;
they are required to finish the testability goal, but are not prerequisites for
removing the recovery runner from `VoiceProvider`.

## PR map

Slices are commit boundaries; PRs batch adjacent slices where both are
behavior-preserving and additive, so review effort concentrates on the risky
changes. Each slice still lands as its own green commit (using its suggested
commit message) inside its PR. Slices that change production transaction
behavior or carry the trickiest cancellation semantics (C4, C5, C6, S2, S3) get
a PR to themselves. If a batched PR grows past comfortable review size, split it
back to one slice per PR — the slice boundaries already support that.

| PR | Slices | Suggested title |
| --- | --- | --- |
| client 1 (#278) | C0 + C1 | Add voice session executor boundary and store selectors |
| client 2 (#279) | C2 + C3 | Execute voice session final and wait commands outside provider |
| client 3 (#280) | C4 | Extract voice restore command execution |
| client 4 (#281) | C5 | Extract voice transport rebuild execution |
| client 5 (#282) | C6 | Cut voice provider over to command executor |
| client 6 (#283) | C7 | Remove voice reconnect state projection |
| client 7 (follow-on) | C8 | Extract remote media consume controller |
| client 8 (follow-on) | C9 | Extract microphone pipeline controller |
| server 1 | S0 + S1 | Add voice restore service seam and prepared transport pairs |
| server 2 | S2 | Commit fresh voice restores transactionally |
| server 3 | S3 | Replace restored voice transports atomically |
| server 4 | S4 | Remove legacy voice restore rollback path |

V0 is not a PR: its observability and E2E items land incrementally with
client 5 and server 2–4, and its rollout checklist gates marking this plan
implemented.

## Client slices

### C0 — Executor contract and deterministic harness

**Objective:** Establish an unwired, framework-free executor boundary and fake
dependencies without changing runtime behavior.

**Files:**

- Add `apps/client/src/features/server/voice/voice-session-command-executor.ts`.
- Add `apps/client/src/features/server/voice/__tests__/voice-session-command-executor.test.ts`.
- Optionally add a focused fake scheduler beside the test if Bun fake timers do
  not model abortable waits clearly.

**Work:**

- Define the executor ports, command context, lifecycle, and error/result
  conventions.
- Add an exported store-level command-currency selector instead of duplicating
  the `phase/generation/activeCommandId` predicate.
- Implement executor registration, disposal, per-command `AbortController`s,
  and stale-command rejection, but leave production registration on the current
  provider runner.
- Use injected `now`, `random`, `delay`, and `isOnline`; no direct `Date.now`,
  `Math.random`, `setTimeout`, `navigator`, or `window` access.

**Tests:**

- Dispose aborts all active command signals.
- A stale command is not started.
- A superseding command aborts the older command before starting its effect.
- A late result from an aborted command is ignored.
- No real timers, browser globals, React renderer, RPC client, or mediasoup mock.

**Exit criteria:** The unwired executor and test harness are green; production
behavior is unchanged.

**Suggested commit:** `refactor: add voice session command executor boundary`

**Landed** (PR #278) as specified, with the proposed contract names. Notes for
later slices:

- The machine exports the pure currency predicate
  `isCurrentVoiceSessionCommand(state, command)`; the store binds it as
  `isVoiceSessionCommandCurrent(command)`. The provider still carries its own
  duplicate until C6.
- The executor distinguishes recovery-step commands (currency-tracked:
  stale-rejection and `context.isCurrent` read live machine currency) from
  final commands (`RecoverDesktopAppAudio`, `LeaveVoiceSession`,
  `ClearFailedSession`), which the machine never marks current. Final validity
  belongs to the store's buffered-flush filter and C2's generation checks;
  their `isCurrent` reflects only abort/disposal, and they are never
  stale-rejected.
- Supersession cancellation rides the store subscription: listeners run before
  command delivery, so the superseded operation's signal aborts before the
  superseding command's effect starts.
- `WaitOnline`/`WaitAuth`/`RetryDelay` are explicit no-ops in the executor
  until C3 implements them — safe only while the executor stays unwired.
- Final-operation ports receive no command context (matching the contract), so
  a cancelled final is not observable by its port, and the C0 executor
  swallows final-port rejections after bookkeeping cleanup. C2 must decide
  whether leave/clear need a context or an error-reporting port to satisfy its
  "failures are reported" test.
- No fake scheduler was needed: deferred promises plus the real machine/store
  were sufficient. Revisit when C3 introduces delay/online polling.
- Harness note: once the executor is the registered command runner, a trigger
  event runs the snapshot round trip synchronously (`CaptureRecoverySnapshot`
  → `RecoveryStarted` → next command). Tests must capture live commands from
  port invocations; manually replaying a result event afterwards is stale.

### C1 — Direct machine observation and selector hook

**Objective:** Make the session store sufficient for executor waits and React
rendering so Zustand synchronization order cannot affect correctness.

**Files:**

- `voice-session-store.ts`
- `features/server/voice/hooks.ts` or a new
  `features/server/voice/voice-session-hooks.ts`
- `reconnect-coordinator.ts`
- Store/coordinator tests.

**Work:**

- Add a state-only subscription API whose callback does not expose commands.
- Add `useVoiceSessionSelector` using `useSyncExternalStore`.
- Add direct selectors for pending reconnect, reconnect timestamp,
  authentication, suppression, and command currency.
- Make new executor code use only the session store.
- Keep the Zustand facade temporarily for compatibility, but document it as a
  UI projection rather than an execution dependency.

**Tests:**

- Selectors update from dispatch without a Zustand listener.
- State listeners run before command delivery.
- Auth waits cannot observe pre-dispatch state.
- Store reset keeps intended long-lived listeners and clears the command outbox.

**Exit criteria:** Removing or reordering the Zustand projection listener cannot
change executor/store test results.

**Suggested commit:** `refactor: expose direct voice session store selectors`

**Landed** (PR #278) as specified. Notes for later slices:

- The direct selectors are pure functions in `voice-session-machine.ts`
  (`selectPendingVoiceReconnect`, `selectReconnectingSince`,
  `selectReconnectAuthenticated`, `selectVoiceReconnectSuppression`); the
  coordinator's `getMachine*` wrappers and its projection sync delegate to
  them, so the phase-versus-mirror fallback logic exists once.
- `subscribeVoiceSessionState` notifies state-only listeners before the legacy
  full listeners, and both run before command delivery; state listeners
  survive `resetVoiceSessionState` while the command outbox clears.
- `resetVoiceSessionState` preserves the monotonic generation/command counters
  (PR #278 review finding). Reset notifies retained state-only listeners, so the
  executor aborts pending recovery-step operations immediately; the monotonic
  identities additionally prevent any other long-lived operation that misses
  reset from matching and advancing a later session.
- `useVoiceSessionSelector` lives in `voice-session-hooks.ts` and requires
  selectors that return stable references for unchanged state (the machine
  selectors do). `voice-control.tsx` reads `reconnectingSince` through it as
  the first consumer; C7 migrates the remaining `useVoiceReconnectStore`
  consumers (`use-voice-events.ts` and the provider's imperative reads).
- The executor's supersession sweep subscribes through the state-only API.
- The exit criterion holds structurally: the store/executor test files never
  import `reconnect-coordinator`, so its module-eval projection listener does
  not exist in those runs.

### C2 — Executor foundation and final/simple commands

**Objective:** Put low-concurrency commands through the real executor first.

**Commands:**

- `CaptureRecoverySnapshot`
- `RestoreWatchIntent`
- `RecoverDesktopAppAudio`
- `LeaveVoiceSession`
- `ClearFailedSession`

**Work:**

- Implement command handlers as mechanical adapters.
- Dispatch result events only where the machine defines one.
- Preserve buffered final-command generation validation.
- Keep final cleanup idempotent and ensure leave uses command/session context,
  not an unrelated current-channel mirror.
- Register the executor for these commands while leaving complex commands on a
  temporary legacy delegate. Make routing exhaustive so a command is owned by
  exactly one runner.

**Tests:**

- Snapshot capture dispatches `RecoveryStarted` with the same command identity.
- Restore-watch ordering is rehydrate then `WatchIntentRehydrated`.
- Buffered final commands execute once after remount.
- Final commands from an older generation do not execute.
- Leave/clear failures are reported but cannot strand executor bookkeeping.

**Exit criteria:** These commands no longer have implementations inside
`VoiceProvider`; no command can be handled by both runners.

**Suggested commit:** `refactor: execute voice session final commands outside provider`

**Landed** (PR #279) as specified. Notes for later slices:

- `VoiceProvider` registers one composite command runner. The executor owns the
  simple and final commands while an exhaustive temporary delegate retains only
  the complex commands not yet extracted.
- Final commands are validated against their session generation and buffered by
  the store across provider remount gaps. Recovery-step commands remain
  currency-checked against the live machine state.
- Restore-watch intent is applied before `WatchIntentRehydrated` is dispatched.
  Leave uses the command's channel context, and final-command port failures are
  reported without stranding executor bookkeeping.

### C3 — WaitOnline, WaitAuth, and RetryDelay

**Objective:** Move all time and connectivity orchestration into deterministic
executor code.

**Work:**

- Implement abortable online polling through injected delay/online ports.
- Implement authentication waiting by reading/subscribing directly to the
  session store.
- Preserve sliding reconnect deadlines by reading the live machine deadline,
  not the command's original copy.
- Implement retry jitter using injected `random`.
- Dispatch the existing `Online*`, `Auth*`, and `RetryDelay*` events.
- Delete executor-path reads of `useVoiceReconnectStore.getState()`.

**Tests:**

- Offline wait pauses and resumes.
- Repeated WS drops extend the live deadline.
- Auth changing between initial read and subscription is not missed.
- Clear/dispose resolves auth wait without terminal failure.
- Retry delay pauses while offline and remains expiry-bounded.
- Aborted waits leave no timers or subscriptions.

**Exit criteria:** Wait behavior is covered without real time and has no Zustand
or browser dependency.

**Suggested commit:** `refactor: extract voice reconnect wait execution`

**Landed** (PR #279) as specified. Notes for later slices:

- Online polling, authentication observation, and retry jitter use injected
  time, randomness, delay, and connectivity ports plus direct session-store
  selectors; the executor does not read the Zustand reconnect projection.
- Reconnect deadlines are read live so repeated WS drops extend the active
  window. Legacy expiry semantics remain strict: expiry is `now > expiresAt`,
  not equality.
- Auth waits close their store subscription and all waits cancel their pending
  injected delay when superseded, cleared, or disposed.

### C4 — WS restore execution

**Objective:** Move `RestoreVoiceSession` single-flight, timeout, cancellation,
and result reporting out of `VoiceProvider`.

**Work:**

- Executor owns the active restore operation and queued current command.
- Port owns the concrete `restoreOrJoin` + provider initialization mechanics.
- Preserve request `AbortSignal`, sticky `serverSessionEstablished`, bounded
  cancellation drain, and stale-operation cleanup.
- Separate the orchestration result from media implementation details:
  `restoreVoiceSession` returns a typed success result or throws the raw error;
  the executor dispatches `RestoreSucceeded` / `RestoreFailed`.
- Preserve cleanup guards after every awaited media/RPC boundary.

**Tests:**

- Permanently pending restore detaches after the bounded drain and releases the
  queued retry.
- Timeout before a response conservatively reports server ownership.
- Timeout after server success retains ownership through later failures.
- A newer restore aborts the older request and ignores its late completion.
- Disposal/remount cannot lose a final command.
- Errors remain raw; the executor does not classify retry versus terminal.

**Exit criteria:** `VoiceProvider` contains only the concrete restore port
implementation, not restore scheduling or command bookkeeping.

**Suggested commit:** `refactor: extract voice restore command execution`

**Landed** (PR #280). Notes for C5/C6:

- The executor owns the active restore slot, the queued current restore
  command, per-boundary 12-second timeouts, request cancellation, and the
  two-second bounded drain. All timing uses the injected delay port.
- `TVoiceSessionRestoreContext.withTimeout` exposes executor-owned timeout and
  drain tracking to the concrete port.
  `markServerSessionEstablished` makes server ownership sticky immediately
  after `restoreOrJoin` responds, without wrapping or classifying later errors.
- A timeout conservatively dispatches possible server ownership even before a
  response. Ownership remains true when media initialization or local-state
  synchronization fails after a successful response.
- `VoiceProvider` retains only the concrete restore/media adapter. It checks
  command currency after each awaited RPC/media boundary and before shared
  writes. C5 removed its wait for the legacy transport-rebuild promise; a WS
  reconnect now preempts rebuild work through executor-owned currency and
  cancellation.
- `isVoiceSessionExecutorCommand` remains the exhaustive temporary routing
  boundary. After C5 every command belongs to the executor, while the empty
  composite legacy adapter stays in place for the C6 cutover.
- Disposal aborts the old restore without dispatching `RestoreFailed`, leaving
  the current step available for the next provider's `Resumed` replay. Genuine
  executor timeouts still dispatch raw `RestoreFailed` events.

### C5 — Transport rebuild execution

**Objective:** Move `RebuildTransports` single-flight, backoff, nonce restart,
and result reporting out of `VoiceProvider`.

**Work:**

- Executor owns active/queued rebuild command bookkeeping.
- Port performs the existing transport/media rebuild against a command context.
- Preserve command/generation checks after every await and the current nonce
  handoff back to the machine.
- Keep the reducer responsible for attempt caps and failure classification.
- Preserve local-resource-first cleanup and remote intent preservation.

**Tests:**

- Duplicate transport failures produce one active rebuild.
- WS reconnect preempts rebuild and aborts stale work.
- Nonce changes restart through the reducer without stale success.
- Backoff is deterministic under the fake scheduler.
- Exhaustion emits the existing terminal command once.

**Exit criteria:** Rebuild scheduling and command bookkeeping are absent from
`VoiceProvider`; the provider retains only a concrete rebuild operation port.

**Suggested commit:** `refactor: extract voice transport rebuild execution`

**Landed** (PR #281). Notes for C6:

- The executor owns the active rebuild slot, the latest queued current rebuild,
  fixed one- and two-second retry backoff, supersession cancellation, a
  two-second bounded drain, and raw result-event dispatch. Backoff and draining
  both use the injected delay port.
- `TVoiceSessionRebuildContext.restartIfNonceChanged` keeps the live provider
  nonce read in the concrete port while making the executor currency-check and
  dispatch `NonceChanged`. The reducer still resets attempts, caps nonce
  restarts, classifies failures, caps attempts, and emits terminal cleanup.
- `VoiceProvider` retains only the concrete transport/media rebuild operation.
  It preserves local-resource-first teardown, remote watch intent, session
  execution ownership, and currency checks after awaited media/RPC boundaries
  and before shared writes.
- A WS reconnect aborts a stale rebuild before reconnect commands are delivered.
  Restore no longer waits for a provider-owned rebuild promise, and a detached
  rebuild cannot dispatch stale success or failure.
- Rebuild terminal-error reporting observes the reducer's resulting failed
  phase after dispatch; it does not classify errors or choose policy in the
  executor.
- All commands now route exclusively through the executor and
  `TLegacyVoiceSessionCommand` is `never`. The composite provider registration,
  ref-backed ports, mount-time executor construction, and empty legacy adapter
  intentionally remain for C6 to remove together.
- Disposal aborts rebuild work without dispatching a failure. `Resumed` replays
  the current recovery step under a new generation on remount, while the store
  continues to buffer generation-valid final commands across runner gaps.

### C6 — React adapter cutover and embedded-runner deletion

**Objective:** Make `VoiceProvider` an adapter that supplies live capabilities,
not the command orchestrator.

**Files:**

- Add `components/voice-provider/hooks/use-voice-session-executor.ts` or an
  equivalently narrow adapter.
- Remove embedded command runners and their single-flight refs from
  `components/voice-provider/index.tsx`.
- Update `voice-session-runner-boundary.test.ts`.

**Work:**

- Construct one executor per mounted provider.
- Supply ref-backed ports so executor identity is stable while React callbacks
  stay fresh.
- Register/unregister through `registerVoiceSessionCommandRunner`.
- On unmount, abort executor work; leave final-command replay to the store and
  recovery-step replay to `Resumed`.
- Delete the old command switch and duplicated cancellation bookkeeping.

**Tests:**

- Adapter mounts one executor and disposes it once.
- Dependency changes do not recreate the executor or duplicate work.
- Remount gap tests cover recovery-step replay and final-command buffering.
- The boundary test becomes an import/layering guard only; it is not cited as
  behavioral coverage.

**Exit criteria:** No recovery command implementation remains in
`VoiceProvider`; executor behavior is covered by real imported code.

**Suggested commit:** `refactor: cut voice provider over to command executor`

**Scope note:** Executor-wide structured command spans remain deferred to the V0
observability gate. C6 keeps the adapter cutover behavior-preserving and does
not expand the executor port contract for generic tracing.

**Landed** (PR #282). Notes for later slices:

- `useVoiceSessionExecutor` owns one mount-scoped executor, direct store runner
  registration, mount-time `Resumed` replay, and idempotent unregister/disposal.
- One ref-backed port set keeps the executor and runner stable across provider
  dependency changes while invoking the latest concrete callbacks.
- `VoiceProvider` retains the concrete restore, rebuild, transport, media, and
  final-cleanup mechanics; C6 removes only its embedded executor/composite
  lifecycle wiring.
- The empty legacy delegate, `TLegacyVoiceSessionCommand`, and
  `isVoiceSessionExecutorCommand` temporary routing boundary are removed. Every
  command now has one direct execution path through the executor.
- Adapter tests exercise the real adapter, executor, machine, and store for
  rebuild/restore remount replay, disposal fencing, fresh ref-backed ports, and
  generation-valid final-command buffering. The runner boundary test now
  enforces import/layering constraints only.
- Final-command replay remains store-owned. Recovery-step commands remain
  unbuffered and are reissued under a new generation by mount-time `Resumed`.

### C7 — Retire the mutable reconnect projection

**Objective:** Remove the module-initialization ordering that previously caused
the reconnect projection race.

**Work:**

- Inventory every `useVoiceReconnectStore` hook and `.getState()` consumer.
- Move React consumers to `useVoiceSessionSelector`.
- Move imperative reads to direct session-store selectors.
- Keep action-shaped compatibility exports in `reconnect-coordinator.ts` if they
  improve call-site clarity, but make them dispatch-only functions rather than
  Zustand setters.
- Delete the module-evaluation projection subscription when no consumer depends
  on it.

**Tests:**

- UI reconnect indicator selectors.
- Intent capture, suppression, auth, and clear behavior through the machine.
- A command emitted synchronously by dispatch observes current state without any
  projection synchronization.

**Exit criteria:** Runtime correctness is independent of import order; ideally
the Zustand reconnect store no longer exists.

**Suggested commit:** `refactor: remove voice reconnect state projection`

**Landed** (PR #283). Notes for later slices:

- `useVoiceEvents` reads reconnect timestamp and authentication through
  `useVoiceSessionSelector` and the direct machine selectors. Protected voice
  subscriptions remain deferred until the reconnected socket authenticates,
  and eager existing-producer sync remains limited to steady state.
- The mutable Zustand reconnect store, its setters, projection synchronization,
  and the module-evaluation session-store listener are removed. Coordinator
  actions dispatch machine events directly, and imperative queries use direct
  session-store selectors.
- The machine's top-level reconnect fields remain as facade state outside the
  reconnecting phase; C7 does not redesign the FSM or relocate its compatibility
  state.
- Coordinator and voice-action tests now reset through
  `resetVoiceSessionState`, arrange state with coordinator actions or explicit
  machine events, and assert direct selectors. The reset contract retains
  monotonic identities, long-lived listeners, and command-outbox clearing.
- Store, executor, adapter, buffering, and remount behavior no longer depends on
  importing `reconnect-coordinator` or registering a projection listener first.

### C8 — Remote consume resource controller

**Objective:** Test the real queued/in-flight consume lifecycle that reducer-only
tests cannot cover.

**Work:**

- Extract per-slot operation reservation, cancellation, retry, server consumer
  cleanup, local attach/resume, and completion into a framework-free controller.
- Keep React responsible for feeding ledger commands and publishing stream state.
- Preserve producer identity, consumer identity, and transport generation
  checks.

**Tests:**

- Stop Watching while consume RPC is pending closes the later server consumer.
- Stop Watching between local attach and resume closes local and server state.
- Stop screen cascades cancellation to screen audio.
- Re-watch after cancellation is not cleared by stale completion.
- Transport generation replacement aborts all old consumes.
- Producer replacement cannot attach the superseded producer.

**Exit criteria:** The original Stop-Watching P1 is covered through the real
resource controller at operation level, not only through ledger reducer tests.

**Suggested commit:** `refactor: extract remote media consume controller`

**Implementation decision:** Keep the extraction mechanically reviewable, then
isolate the correctness changes exposed by the real controller tests in a
separate `fix:` commit in the same C8 PR. The controller owns one current
operation per remote-media slot plus any superseded attempts that still owe
late-result cleanup; ledger commands remain React-owned and manual retry or a
known producer replacement starts its successor immediately rather than waiting
for the stale attempt to drain. Transport replacement synchronously invalidates
all old operations and local consumers before installing the new transport.

The isolated fixes are limited to the guarantees already required by C8:

- observe a consume RPC after cancellation or timeout so a late server
  allocation is still closed by consumer identity;
- fence producer identity before local attachment and let a command for a known
  replacement producer supersede the older in-flight operation.

Retry and boundary timing use an injected abortable delay. Consume RPCs, local
consumer creation, resume, and targeted server cleanup are bounded, and late
local creation is closed without attachment. Explicit close stays separate from
operation cancellation because a close command may target a predecessor after
its successor has started; consumer identity, not the ledger close-command
generation, is authoritative for that cleanup.

### C9 — Microphone pipeline resource controller

**Objective:** Put microphone ownership, preparation, installation, publishing,
and teardown behind one testable owner.

**Work:**

- Move the ownership epoch and shared resource refs into a controller instance.
- Expose `prepare`, `publish`, `cleanup`, and `owns` operations.
- Inject getUserMedia, processing/gain pipeline factories, producer publication,
  activity monitoring, and diagnostics.
- Preserve synchronous teardown snapshot/clear before any await.
- Preserve build-start ordering: revoke/claim in the same tick, then await old
  resource destruction.

**Tests:**

- Deferred old getUserMedia cannot install after a successor.
- Older cleanup resolving last cannot reclaim ownership.
- Falsey or rejecting processing/gain creation cannot clear successor refs.
- Stale publish failure cannot tear down successor resources.
- Cleanup destroys only resources captured by that invocation.

**Exit criteria:** Source inspection is no longer the primary proof of ownership
ordering; the real controller is tested with deferred dependencies.

**Suggested commit:** `refactor: extract microphone pipeline controller`

## Server ownership decision

**Current state (post PR #277):** the restore path already bounds the
pre-transport window with provisional-seat claims. `acquireRestoreSeat` adds the
user and mints a claim symbol; rollback is claim-gated so a superseded attempt
cannot remove a successor's seat. This defines the cleanup owner but does not
remove the window — other clients observe a join (and, on failure, a leave) for
a user who never had transports, and membership mutates before fallible
preparation. The slices below replace the provisional seat with
prepare-then-commit; they do not add a missing rollback.

`joinVoiceRoute` (`apps/server/src/routers/voice/join.ts`, the user-initiated
join) shares the same add-user-then-bootstrap pattern and additionally binds
context/WS *before* bootstrap, relying on an incarnation-gated `onError`
rollback. It is in scope: S1–S3 build and prove the primitive on the restore
path, and S4 converts `joinVoiceRoute` when the legacy mutation path is removed.

The server contract must be explicit:

- **Before commit:** the restore attempt owns prepared transports. Cancellation,
  supersession, or failure disposes them and changes no membership/context.
- **At commit:** currency is checked once, then transport installation,
  membership, WS/context channel, and join publication happen synchronously.
- **After commit:** `VoiceRuntime` owns the session. Explicit leave or disconnect
  grace owns eventual cleanup. The client conservatively treats a timed-out
  response as possibly committed and sends a terminal leave when necessary.

Do not use `VoiceRestoreAttemptSupersededError` alone to infer ownership. It can
mean either a real successor or an abort with no successor.

## Server slices

### S0 — Restore service seam and cancellation characterization

**Objective:** Make route orchestration directly testable without changing its
behavior.

**Files:**

- Add `apps/server/src/routers/voice/restore-or-join-service.ts` or an equivalent
  domain helper.
- Keep `restore-or-join.ts` as validation/rate-limit/context wiring.
- Extend `voice-restore-or-join.test.ts` with service-level deferred dependencies.

**Work:**

- Extract attempt ownership, target resolution, conflict evaluation, and
  bootstrap orchestration behind injected/runtime dependencies.
- Represent cancellation and supersession separately in the internal result or
  error type, even if behavior remains unchanged in this slice.
- Document the existing provisional-seat window (add user and publish join
  before bootstrap, claim-gated rollback) as temporary.

**Tests:**

- Current fresh join, same-session restore, other-client conflict, wrong-channel
  conflict, and latest-attempt fencing remain identical.
- Abort and supersede can be triggered deterministically at named barriers.

**Exit criteria:** Tests can pause immediately before and after transport
preparation/commit without reconnect-lab sleeps.

**Suggested commit:** `refactor: extract voice restore orchestration service`

### S1 — Prepared transport-pair primitive

**Objective:** Allocate a producer/consumer transport pair without mutating the
active runtime maps.

**Files:**

- `apps/server/src/runtimes/voice.ts`
- `apps/server/src/routers/voice/bootstrap.ts`
- Runtime/server tests.

**Proposed contract:**

```ts
type TPreparedVoiceTransportPair = {
	producerParams: TTransportParams;
	consumerParams: TTransportParams;
	commit: () => void;
	dispose: () => Promise<void>;
};
```

**Work:**

- Allocate both transports privately.
- Attach handlers so disposing an uncommitted pair cannot delete active maps or
  consumers.
- Commit swaps both active transports synchronously and idempotently.
- Dispose closes only the prepared pair.
- Keep existing `createProducerTransport` / `createConsumerTransport` behavior
  as wrappers until route cutover, preserving backward compatibility.

**Tests:**

- Preparation does not change active transport maps.
- One-side failure disposes both prepared resources.
- Supersession before commit leaves the existing pair untouched.
- Commit replaces both sides together.
- Closing an old pair cannot delete the newly committed pair.

**Exit criteria:** Primitive is fully tested but unused by production routes.

**Suggested commit:** `refactor: add prepared voice transport pairs`

### S2 — Fresh restore/join prepare-then-commit

**Objective:** Eliminate the `runtime.addUser()`-before-bootstrap cancellation
window for a missing session.

**Work:**

1. Resolve permissions/target/conflicts.
2. Prepare the transport pair without adding the user.
3. Await all fallible asynchronous preparation.
4. Assert attempt currency.
5. Commit the pair, add the user, set context/WS channel, and publish join in one
   synchronous block.
6. Build `channelUsers` after membership commit.
7. Dispose the pair on every pre-commit failure/abort.

**Tests:**

- Abort while either transport is pending leaves no runtime user, transports,
  context channel, join event, or leave event.
- Supersede A with B: A disposes, B commits, exactly one user and one join event.
- Permission/target failures allocate nothing.
- Response contains the committed user in `channelUsers`.

**Exit criteria:** Fresh restore/join has no provisional seat and no rollback
callback that calls `runtime.removeUser()` after cancellation.

**Suggested commit:** `fix: commit fresh voice restores transactionally`

### S3 — Existing-session atomic transport replacement

**Objective:** Prevent partial replacement of an existing session's transport
pair.

**Work:**

- Use the same prepared-pair primitive for `runtimeWithUser` restores.
- Do not remove either active transport until both replacements are prepared and
  the attempt is current.
- Commit the pair synchronously, then update the reconnecting WS/context owner.
- Preserve membership and presence events; restoring the same session emits no
  join/leave/session-replaced event.

**Tests:**

- Producer preparation failure preserves both old transports.
- Consumer preparation failure preserves both old transports.
- Superseded attempt cannot replace either side.
- Successful restore swaps both and closes the old pair afterward.
- Two overlapping attempts leave the newest pair installed.

**Exit criteria:** No route path can install half of a transport pair.

**Suggested commit:** `fix: replace restored voice transports atomically`

### S4 — Remove legacy mutation path and complete cancellation matrix

**Objective:** Leave one ownership model and close the original server coverage
gap.

**Work:**

- Remove the old add-user-then-bootstrap rollback path and any superseded-error
  exception that existed only to preserve its provisional seat.
- Convert `joinVoiceRoute` (`apps/server/src/routers/voice/join.ts`) to the same
  prepare-then-commit primitive. It shares the add-user-then-bootstrap pattern
  and additionally binds context/WS before bootstrap; after conversion, delete
  its incarnation-gated `onError` rollback along with the rest of the legacy
  path.
- Remove wrapper APIs that allow independent transport replacement if no
  production route needs them; otherwise retain them only for explicitly
  non-transactional operations.
- Document post-commit ownership by explicit leave/disconnect grace.
- Ensure logs distinguish prepared, disposed, committed, superseded, and aborted
  outcomes without including sensitive connection data.

**Cancellation matrix tests:**

- Abort before preparation.
- Abort while producer preparation is pending.
- Abort while consumer preparation is pending.
- Abort after both prepare but before commit.
- Supersede at each of the same points.
- Abort after commit/response race: committed seat remains server-owned and is
  removable through leave/grace.
- Server/runtime destruction disposes uncommitted prepared pairs.
- The abort/supersede points above also run against `joinVoiceRoute`.

**Exit criteria:** The exact `runtime.addUser` cancellation-point test is either
impossible by construction or passes under the documented post-commit owner.

**Suggested commit:** `refactor: remove legacy voice restore rollback path`

## V0 — Integrated validation and rollout

**Objective:** Prove the extracted layers behave together and leave useful
production diagnostics.

V0 is a gate, not a standalone work item. The transport-pair and restore-outcome
logs land with server 2–4; executor-wide structured command spans remain
deferred to this gate rather than expanding the behavior-preserving client 5
adapter cutover. The E2E scenarios are run as part of the client 5 and server 4
exit criteria. This section is the consolidated checklist for declaring the
plan implemented.

**Automated validation:**

- Package-specific client and server suites from their expected directories.
- `nix develop -c bunx biome check --write <changed paths>` on intentionally
  changed files, then the non-mutating CI checks: `nix develop -c bun run
  check-types`, `nix develop -c bun run lint`, and `nix develop -c bun run knip`
  when imports or exports changed. Do not use the root `magic` script for
  validation; it rewrites the entire repository.
- Fake-clock executor suite.
- Resource-controller deferred-operation suites.
- Server cancellation/transaction matrix.
- Existing reconnect, remote-media ledger, app-audio, and voice action suites.

**E2E scenarios:**

- In-session transport rebuild.
- WS drop and authenticated restore.
- Offline pause beyond one original TTL with refreshed intent.
- Rapid WS flap while restore is pending.
- Server restart with fresh restore/join.
- Stop Watching while consume is pending, then re-watch.
- Provider remount during rebuild, restore, terminal failure, and rebuild success.
- Two-tab conflict and same-client reconnect.
- Desktop app/system audio recovery after rebuild.

**Observability:**

- One structured span per executor command with command type, attempt, phase,
  generation, duration, and outcome. Do not log snapshots or media identifiers
  unnecessarily.
- Explicit outcomes for cancelled, superseded, detached, expired, failed, and
  succeeded.
- Server logs for prepared/disposed/committed transport pairs and restore
  outcomes, keyed by reconnect attempt id and safe session metadata.
- Report bounded-drain detachment and terminal cleanup failure to Sentry with
  enough phase/generation context to correlate, but no auth or private media
  data.

**Rollout gate:**

- All existing reconnect-lab and Playwright recovery scenarios pass.
- No source-inspection test is cited as correctness coverage.
- No executor command implementation remains in `VoiceProvider`.
- No command executor reads the Zustand reconnect projection.
- No server restore path mutates membership before all fallible preparation has
  completed.
- Update this document to **Implemented** and update the superseded seam section
  in `voice-session-fsm.md`.

## Review checklist per slice

- Is this commit behavior-preserving, or is its behavior change isolated and
  named `fix:`?
- Does every async operation have a bounded wait or an abort path?
- Is command/session/resource currency checked after every await and before
  every shared write?
- Does cleanup act only on captured or token-owned resources?
- Can a provider remount lose or duplicate this work?
- Does the test import the real implementation rather than copy its control
  flow?
- Is the command executor making a policy decision that belongs in the reducer?
- Is any runtime behavior dependent on module import/listener order?
- On the server, who owns the resource before and after the commit boundary?
- Are shipped client/API compatibility and reconnect grace semantics preserved?

## Completion definition

This plan is complete when:

1. `VoiceProvider` supplies capabilities but contains no session-command
   orchestration.
2. Executor behavior is deterministically tested with injected time, network,
   RPC/media operations, cancellation, and cleanup.
3. Remote consume and microphone resource races are covered through their real
   controllers, not just pure tokens or source inspection.
4. FSM/store execution has no correctness dependency on a Zustand projection.
5. Server transport preparation is private and pairwise; membership and
   transport installation commit only after the final currency check.
6. Cancellation before commit leaves no seat, transport, context, or presence
   side effect; cancellation after commit has a documented cleanup owner.
7. The integrated reconnect/rebuild/server-restart scenarios pass in automation
   and the debug lab.
