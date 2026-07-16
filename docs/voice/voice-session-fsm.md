# Voice Session FSM — Design Record

**Status:** Implemented — the machine (`voice-session-machine.ts` +
`voice-session-store.ts`) is wired into `VoiceProvider` and both recovery paths
run through it. Kept as the durable record of *what we built and why*; fold into
the code's own docs and delete when convenient.

**Companion:** [`remote-media-subscription-state.md`](./remote-media-subscription-state.md)
is the durable design for the #274 remote-media ledger. This machine **drives**
that ledger; it does not refold it.

## Problem

The reconnect / transport-recovery orchestration lives as **two large imperative
async loops inside the 4,500-line `VoiceProvider`**, plus a defer handler:

- **In-session transport rebuild** — formerly the inline transport recovery loop
  in `apps/client/src/components/voice-provider/index.tsx`. Triggered
  by ICE/DTLS transport failure; keeps the server session (rejoins only if
  missing); guards staleness with `voiceSessionReconnectNonce`.
- **WS-level reconnect** — the effect at ~3927–4225. Triggered by a socket drop;
  waits online → waits auth → `restoreOrJoin` → `init` → restore-watch; guards
  with `reconnectingSince` / pending / auth.
- **Transport-failure defer handler** (~856–928) — makes a transport failure
  stand down when a WS reconnect is already in flight, so the two don't race into
  a double teardown.

Policies are already extracted and pure (`reconnect-policy.ts`,
`reconnect-coordinator.ts`). **The orchestration
control-flow is not.** Both paths are only covered by *structural mirror* tests
(`recover-transport-session.test.ts`, `voice-reconnect-restore.test.ts`) that
**hand-copy the control flow into the test file** — they import nothing real, so
the real code can silently diverge from them. The two loops also duplicate a
~45-line snapshot + restore-watch block.

## Decision

Model the voice **session lifecycle** as a single finite state machine, following
the #274 precedent (pure reducer + `{ state, commands }` envelope + runner),
**hand-rolled, no FSM library**.

### Why no library (XState etc.)

- No FSM library exists in the repo today; it would be a net-new paradigm.
- #274 just landed (21 commits, 40 reducer tests, production-verified) and
  deliberately hand-rolled its reducer. Adopting a library only for reconnect
  creates a **third** pattern and silently overrules that choice; it only pays
  off if we also rewrite the freshly-hardened #274 onto it — expensive, risky,
  zero behavior benefit.
- We want the FSM *modelling* (enumerable states, pure transitions, real tests),
  not a vendor lock-in. The state model is designed FSM-shaped so a **future**
  library migration stays mechanical (states→states, events→events). The
  irreversible decision (dependency + paradigm) is deferred until there are two
  real consumers proving the shape.

### One machine, recovery as sub-states (Model "A1")

Connection status *is* session state. Today it is split across a `ConnectionStatus`
`useState` and the separate `reconnect-coordinator` zustand store, mutated
imperatively from three places — which is exactly why status drifts from reality.
So the machine is the **single source of truth**:

- It **subsumes `reconnect-coordinator`** — `reconnectingSince` /
  `pendingVoiceReconnect` / `reconnectAuthenticated` / suppression become fields /
  sub-states inside it.
- It **owns `ConnectionStatus` as derived output** (`DISCONNECTED / CONNECTING /
  CONNECTED / FAILED` is a projection of the phase).

State is a **single-instance discriminated union** (unlike #274's keyed collection
of per-slot lifecycles — same *envelope convention*, different *state shape*
because the domains differ):

```ts
type TVoiceSessionState =
  | { phase: 'idle' }
  | { phase: 'joining'; channelId: number }
  | { phase: 'connected'; channelId: number }
  | { phase: 'rebuilding'; channelId: number; nonce: number; attempt: number;
      nonceRestarts: number; snapshot: WatchedStreams }
  | { phase: 'reconnecting'; step: 'waitingOnline' | 'waitingAuth' | 'restoring' | 'restoreWatch';
      reconnectingSince: number; authenticated: boolean;
      pending: PendingVoiceReconnect;         // { channelId, micMuted, soundMuted, peerUserIds, expiresAt }
      retryAttempt: number; consecutiveUnknownErrors: number;
      snapshot: WatchedStreams }
  | { phase: 'failed'; reason: TClearReason; channelId?: number };
```

**This union must carry everything `reconnect-coordinator` holds *plus* the
loop-local counters** — otherwise the store-subsume commit (Slice 1) is not
mechanical. Explicit inventory to preserve:

| Concern | Today | Machine home |
| --- | --- | --- |
| in-reconnect marker | `reconnectingSince` | `reconnecting.reconnectingSince` |
| pending intent + expiry | `pendingVoiceReconnect` (incl. `expiresAt`) | `reconnecting.pending` |
| auth gate | `reconnectAuthenticated` | `reconnecting.authenticated` / `waitingAuth` step |
| peer suppression | `voiceReconnectSuppression` | machine field, set on success (out-of-phase) |
| clear reasons | `TClearReason` union | `Terminated` event payload → `failed.reason` |
| WS retry attempt | loop-local `retryAttempt` | `reconnecting.retryAttempt` |
| unknown-error cap | loop-local `consecutiveUnknownErrors` | `reconnecting.consecutiveUnknownErrors` |
| nonce staleness | `voiceSessionReconnectNonce` + loop-local `nonceRestarts` | `rebuilding.nonce` / `.nonceRestarts` |
| failure surface | `ConnectionStatus.FAILED` (no detail) | `failed.reason` / `.channelId` |

`suppression` is deliberately *not* a phase field — it outlives recovery (it
gates peer re-join events after success), so it stays a top-level machine field.

`rebuilding` and `reconnecting` are **mutually exclusive phases**, which makes the
double-teardown race *structurally unrepresentable*.

**Both preemption races are first-class transitions**, not just the one:

- `TransportFailed` while `phase === 'reconnecting'` → **ignored** (folds the
  old transport-failure defer helper).
- `WsDropped` while `phase === 'rebuilding'` → **`rebuilding → reconnecting`
  preemption** (replaces the `index.tsx:888` handoff). The reducer transition is
  clean, but the runner's in-flight rebuild is still awaiting, so this **requires
  a runner cancellation token**: a superseded `rebuilding` command must not write
  transports/consumers into the now-`reconnecting` session. Same guard class as
  the existing nonce — make it explicit rather than implicit.

Runner cancellation also crosses the RPC boundary. A reconnect timeout aborts the
client request, and `restoreOrJoin` fences concurrent attempts by client instance;
server transport creation checks that fence before replacing the active transport.
This prevents a request that finishes after its client-side timeout from replacing
the transports created by a newer attempt. Because a timed-out mutation may have
committed before cancellation arrived, server-session ownership is sticky for the
whole reconnect generation and every later terminal/expiry path leaves it.

**Snapshot capture stays out of the reducer.** `snapshot` lives *in* the phase
object, but the reducer never captures it — `captureWatchedRemoteStreams()` is an
impure read of the ledger / stream maps. Instead the **runner** captures it at
phase-entry and hands it to the machine as an event payload
(`RecoveryStarted { snapshot }`), so the reducer stays pure and the snapshot is
still captured exactly once, before `init` / `cleanupTransports` wipes the ledger.

- **Defer = a pure reducer guard.** A `TransportFailed` event while
  `phase === 'reconnecting'` is ignored (no transition). This folds the old
  transport-failure defer helper into the reducer as a one-line,
  trivially-testable transition.
- **Nonce-restart** stays inside `rebuilding`: a `NonceChanged` event restarts the
  attempt (capped), as an explicit transition.
- **`restoreWatch` is shared behavior, not shared state** — both phases end by
  emitting the *same* restore command, killing the ~45-line duplication without
  merging the phases. See "Restore goes through the ledger" for what that command
  is.

### Placement: module-level reducer and extracted command executor

The store is written **from outside the React tree** — `lib/trpc.ts` (socket
close → start reconnect; kick/ban → clear), `features/server/actions.ts`
(joinServer re-auth → authenticated; logout/teardown → clear),
`features/server/voice/actions.ts` (leave / session-replaced / desktop-quit).
So:

- **Reducer + state live at module scope** (evolve `reconnect-coordinator`),
  reachable by those non-React modules. Pure; unit-tested with zero mocks.
- **External call-sites dispatch events** into the machine instead of hand-driving
  the store — e.g. `trpc.ts` socket close → `dispatch({ type: 'WsDropped' })`;
  joinServer success → `dispatch({ type: 'SocketAuthenticated' })`; kick →
  `dispatch({ type: 'Terminated', reason: 'kicked' })`. The machine decides what
  each event *means*.
- **The command implementation lives outside `VoiceProvider`** in
  `voice-session-command-executor.ts`. The thin
  `use-voice-session-executor.ts` adapter subscribes to machine commands and
  supplies the live React-scoped ports (transport creation, `consume`, `init`,
  and `restoreOrJoin`). `VoiceProvider` only assembles those ports.

**Desktop app-audio recovery is a runner-side command, not a machine phase.**
`runDesktopAppAudioRecovery` (`index.tsx` ~2843), which rides along inside
the transport rebuild path, becomes a fire-and-forget `RecoverDesktopAppAudio`
command emitted on the recovery tail. It is native-only and self-healing, so it
stays out of the phase model — the machine emits the command; the runner runs it
without awaiting a result back into a transition.

### Relationship to #274

Directional: the session machine, in `reconnecting.restoreWatch` (and the
`rebuilding` tail), **emits a command that drives the ledger to rehydrate watch
intent; the ledger then mints its own consume commands.** The session machine
never consumes directly and the ledger never drives the session machine. #274 is
a **done FSM this machine commands** — not refolded.

### Events: triggers vs runner results

An async FSM needs **result events**, not just trigger events — otherwise attempt
counters, classification, and terminal transitions end up living in the runner
again, defeating the extraction. The reducer owns *all* of that; the runner only
performs a command and reports back what happened.

**Trigger events (world → machine):** `JoinRequested`, `WsDropped`,
`TransportFailed`, `SocketAuthenticated`, `NonceChanged`, `Terminated { reason }`,
`RecoveryStarted { snapshot }` (runner-captured snapshot injected as payload).

**Result events (runner → machine)** — each command the runner runs dispatches its
outcome back:

| Command run by runner | Result events it dispatches |
| --- | --- |
| rebuild transports (in-session) | `RebuildSucceeded` · `RebuildFailed { error }` |
| `restoreOrJoin` + `init` (WS) | `RestoreSucceeded` · `RestoreFailed { error }` |
| wait-online | `OnlineReady` · `OnlineExpired` |
| wait-auth | `AuthReady` · `AuthExpired` · `AuthCleared` |
| retry delay | `RetryDelayElapsed` · `RetryDelayExpired` |
| `RestoreWatchIntent` (ledger rehydrate) | `WatchIntentRehydrated` |

Failure result events carry the **raw error**. The reducer calls the existing
pure classifier (`classifyVoiceReconnectError(error, { consecutiveUnknownErrors:
state.consecutiveUnknownErrors })`) while reducing `RebuildFailed` /
`RestoreFailed`, so the retry/terminal decision and the count-dependent
`unknown-error-cap` verdict stay entirely **in the reducer**. The runner never
reads machine state to classify. Attempt counters (`retryAttempt`,
`nonceRestarts`) advance on these result events, not in the runner loop.

### Enforce the reducer / runner boundary in code

This must be a code boundary, not a convention. The reducer owns decisions; the
runner owns effects; the store owns dispatch.

Implementation shape:

- `voice-session-machine.ts` exports the state, trigger-event, result-event,
  event, command, reducer, and selectors. It exports no mutable store.
- `voice-session-store.ts` owns the module-level state and exports
  `dispatchVoiceSession(event)` plus read/select helpers. It does **not** export
  raw `setState` or phase mutators.
- `voice-session-command-executor.ts` accepts commands through injected ports
  and returns/dispatches only result events. It forwards raw errors on failure
  events; it may not classify them, read reducer-owned counters, increment
  counters, choose retry vs terminal, clear recovery, or mutate
  reconnect/session state directly. `use-voice-session-executor.ts` owns only
  mount/unmount and ref-backed port freshness.
- Commands carry an id/generation; result events echo it. The reducer drops stale
  results, so superseded runner work cannot write into a newer phase.
- The legacy `reconnect-coordinator` facade remains during migration, but its
  bodies dispatch/select through the machine. New runner code must not import
  facade mutators.

Guardrails to add with the cutover:

- Unit-test reducer transitions for retry counters, unknown-error cap, terminal
  reasons, stale command ids/generations, and both preemption races.
- Unit-test runner command handlers as effect adapters: command in → result event
  out, with no direct store mutation.
- Add a narrow lint/import restriction once the runner exists: the runner may
  import `dispatchVoiceSession`, but not policy classifiers,
  `clearVoiceReconnectRecovery`, `ensureVoiceReconnectStarted`,
  `markVoiceReconnectSessionAuthenticated`,
  `markVoiceReconnectSessionUnauthenticated`, or raw machine/store mutators.

### Restore goes through the ledger — no parallel consume path

The current code snapshots `desired` streams before `cleanupTransports()` clears
the ledger (`use-transports.ts` ~860), then **calls `consume()` manually** for
each — a side path that bypasses ledger invariants. It needs a *second* intent
ledger, `cancelledWatchedRestoreKeysRef`, so a stop-watch during recovery can veto
a manual restore (`index.tsx:1075` writes both `markWatchStopped` **and**
`cancelWatchedRestore`). That whole triad is scaffolding for not using the ledger.

Target: the session machine emits **`RestoreWatchIntent(snapshot, generation)`**;
the **ledger** rehydrates/validates `desired` from it, and the ledger's **own**
command runner does the consuming. Consequences:

- **No manual `consume()` restore loop** in the session runner — the ~45-line
  duplicated block disappears entirely rather than moving.
- **`cancelledWatchedRestoreKeysRef` is deleted.** A stop-watch during recovery
  becomes an ordinary `markWatchStopped` (`desired=false`) on a rehydrated ledger
  slot — restore commands are minted from ledger state, so the veto is just
  normal ledger flow. No second intent store kept by accident.

**Restore-slice resolution:** recovery cleanup preserves remote-media intent in
the ledger, then rehydrates snapshot intent immediately as
`desired:true, producerPresent:false` for missing slots. Later producer
reconciliation mints the consume commands. A stop-watch during recovery therefore
lands on a live ledger slot (`desired:false`), and retry cleanup preserves that
stopped intent instead of resurrecting it from the old snapshot.

## Execution plan

Lands **atomically** — one PR, or a stacked-but-collapsed PR like #274 (bisectable
commits, merged together). It does **not** ship in pieces, so there is no
intermediate production window to protect. Ordering is therefore **store-first**
(no throwaway read-old-store adapter):

0. **Pure machine, unwired.** State union + event union + reducer +
   `{ state, commands }` + full unit tests. Dead-but-tested; zero behavior change.
   The event union covers **both trigger and result events** (see "Events:
   triggers vs runner results") — the result events are what keep attempt
   counters, error classification, and terminal transitions in the reducer rather
   than the runner. The command union includes `RestoreWatchIntent { snapshot,
   generation }` (drives the ledger; see "Restore goes through the ledger") and
   `RecoverDesktopAppAudio` (fire-and-forget, runner-side). Tests cover both
   preemption races, the nonce cap, stale command ids/generations, and each
   result-event transition. Define the module boundary here: pure machine module
   has no store writes; store module exposes dispatch/select only.
1. **Subsume the store — behind the existing facade.** Change the *bodies* of the
   exported `reconnect-coordinator` functions (`ensureVoiceReconnectStarted`,
   `clearVoiceReconnectRecovery`, `markVoiceReconnectSession(Un)authenticated`,
   `captureVoiceReconnectIntentForCurrentSession`, `getValidPendingVoiceReconnect`,
   selectors) to `dispatch` / select against the machine — **keep the names**. The
   `trpc.ts` / `actions.ts` call-sites stay untouched, so this commit's diff is
   "facade internals + store shape," not an enormous cross-cutting rewrite.
   Mechanical, green, no behavior change. (Per-call-site migration to raw
   `dispatch` is optional and later — the facade is a reviewability boundary, not
   throwaway architecture.)
2. **Cut over `rebuilding`.** Replace the inline transport recovery loop
   with dispatch → machine → runner, including the `WsDropped`-preemption
   cancellation token. The runner command handlers return/dispatch only result
   events (`RebuildSucceeded` / `RebuildFailed { error }` etc.); the reducer
   classifies failures and owns retry, failure, and terminal decisions. Convert
   `recover-transport-session.test.ts`
   mirror → real (imports the machine), and add runner-adapter tests proving the
   runner does not call reconnect/session mutators directly.
3. **Cut over `reconnecting` + ledger-driven restore.** Same for the WS loop;
   replace the manual snapshot-consume side path with `RestoreWatchIntent` →
   ledger rehydrate → ledger runner consumes; delete `cancelledWatchedRestoreKeysRef`
   (resolve the rehydration-window sub-question here). Reconnect wait/restore
   handlers dispatch `Online*`, `Auth*`, `Restore*`, `RetryDelay*`, and
   `WatchIntentRehydrated` result events only; the reducer owns retry scheduling
   and terminal cleanup commands. Convert `voice-reconnect-restore.test.ts`
   mirror → real. When adding reconnect runner precondition guards, do not map
   "stop now" conditions to generic retryable failures; use explicit terminal /
   expired result events so defensive branches do not burn retries with backoff.
4. **Delete dead state / mirror remnants;** `ConnectionStatus` fully derived.
   Add/enable the narrow lint restriction that prevents the session runner from
   importing legacy facade mutators or raw state mutation APIs. Delete the
   now-orphaned transport-failure policy helper/test and stale transport
   recovery comments once both recovery paths are machine-run.
   **Post-slice extraction:** the earlier embedded-runner seam decision is
   superseded. `voice-session-command-executor.ts` now owns command execution,
   `use-voice-session-executor.ts` is the narrow React adapter, and focused
   executor/adapter/boundary tests cover command results, lifecycle replay, and
   the prohibition on legacy reconnect mutation imports.

   **Follow-ups intentionally left out of Slice 4:**

   - Consider a reducer-owned completion event for terminal transport rebuild
     cleanup, such as `LeaveAfterFailureCompleted`, if we want the stronger
     invariant that clearing `currentVoiceChannelId` also returns the session
     machine from `failed` to `idle`. Do not add an ad hoc runner dispatch for
     this; keep phase cleanup as a reducer transition with a machine test.
   - Consider moving retry delay calculation into the reducer command payload
     (`RetryDelay { delayMs }`) if we want the runner to become fully mechanical.
     The current runner still makes no retry-vs-terminal decision; it only
     computes timing from the reducer-supplied attempt.

Each *commit* is individually green and reviewable (bisect works), but no commit
needs to be independently shippable.

**Behavior-preserving, with quarantine.** Extraction commits change no behavior.
Any latent bug found during extraction gets its **own** commit — never folded into
a "refactor" commit, so `git bisect` can always separate a move from a fix.

## Verification

Per-slice gate:

1. Converted mirror → real tests pass (they now exercise the actual machine).
2. Pure reducer unit tests (defer guard, nonce-restart cap, terminal
   classification from raw errors, unknown-error cap, stale command
   ids/generations, phase exclusivity).
3. Runner adapter tests prove command handlers emit result events and do not
   classify errors or mutate reconnect/session state directly.
4. ReconnectLab manual scenarios (`reconnect-lab-debug.ts` panel).
5. The #275 Playwright WebRTC scenarios: WS drop <60s, two-peer watch-intent
   restore, producer-replaced-while-watched, offline < grace vs > grace.
