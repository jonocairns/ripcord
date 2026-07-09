# Remote Media Intent Migration — PR Tracker

**Status:** Living tracker for the stacked-PR migration that moves remote-media
**watch intent** out of imperative refs in `VoiceProvider` and into the
subscription ledger. Delete this file once the stack has landed.

**Design record:** [`remote-media-subscription-state.md`](./remote-media-subscription-state.md)
is the durable design; this file only tracks *which slice is done and what is
open*. Prior review round: [`remote-media-subscription-review-followups.md`](./remote-media-subscription-review-followups.md).

Branch: `codex/remote-media-ledger-followups`.

## Why a stack

The remaining migration work (steps 5, 6, 10, 11, 12 of the design's Migration
Plan) is one keystone plus a feature arc. The keystone — the ledger owning watch
intent — delivers value on its own (deletes duplicate ref state, single source
of truth) even if nothing after it ships. So the slices are ordered keystone →
feature arc → optional cleanup, each an independently reviewable PR.

| PR | Scope | Depends on | Status |
| --- | --- | --- | --- |
| **1** | Ledger owns watch intent — **screen-audio half** | — | ✅ **done** (unmerged) |
| **1b** | Ledger owns watch intent — **external-stream half** | 1 | ✅ **done** (unmerged) |
| **2** | `visibleRemoteMedia` selector (keeps desired-but-failed slots renderable) | 1b | ✅ **done** ([PR #267](https://github.com/jonocairns/ripcord/pull/267), unmerged) |
| **3** | Compact failed/retry UI affordances (design "Required UI Affordance") | 2 | ✅ **done** ([PR #268](https://github.com/jonocairns/ripcord/pull/268), unmerged) |
| **4** | Manual retry + consume generations (reintroduces the removed generation state) | 3 | ✅ **done** (unmerged) |
| **5** | Ledger-derived consume command runner + `streamsToConsume` (design "Longer-Term Direction") | 4 | ✅ **done** (unmerged) |
| **6** | Extract consume runner hook + delete dead screen-audio watch-intent helper | 5 | ✅ **done** (unmerged) |
| **7** | Extract stale-pending repair runner hook (behavior-identical) | 6 | ✅ **done** (unmerged) |
| **8** | Command envelope for consume, close-consumer, and repair scheduling | 7 | ✅ **done** (unmerged) |

**Split rationale (1 vs 1b):** the screen-audio ref (`watchedScreenAudioRef`, a
`Set<number>`) and the external-stream ref (`watchedExternalStreamsRef`, then
keyed by stable `pluginId:key` identity) were independent, with independent
read-sites. The external half also carried a keying judgment call (resolved in
PR 1b below in favour of `streamId` keying), so it got its own focused review
rather than riding along with mechanical deletion.

**Deliberately not done:** the shadow-model rollout (design steps 3–4) was
skipped — the ledger went straight to owning behavior. Moot unless the drift
assertions are wanted. Manual retry / consume generations (PR 4) are held until
the feature actually lands; do not reintroduce that state early.

## PR 1 — screen-audio half (done)

Moved screen-audio watch intent into the ledger as `SCREEN_AUDIO.desired`,
**coupled to the screen's desire**, and deleted `watchedScreenAudioRef`. Note the
implementation differs from the design's original "Follow-Up: Screen Audio
Intent" sketch (a `useRef<Set>`): intent lives in the pure reducer instead, which
mirrors the already-existing close-side cascade in `markRemoteProducerClosed`.

| Step | What | Commit |
| --- | --- | --- |
| A | Couple `SCREEN_AUDIO.desired` to the screen in the reducer | `b44a3277` |
| B | Read screen-audio repair intent from the ledger, not the ref | `42fc09c3` |
| C | Delete `watchedScreenAudioRef` + `clearScreenAudioWatchIntent` plumbing | `c0e2e183` |

The coupling lives in three reducer spots (all guarded so intent-ahead-of-
producer never fabricates a phantom `producerPresent: true` slot — `makeSubscription`
defaults that field to `true`, which is the trap):

- `inheritsScreenAudioDesire` — derives desire when the audio producer arrives
  after the screen is already watched (only fires on a real producer).
- `markRemoteWatchRequested(SCREEN)` / `markRemoteWatchStopped(SCREEN)` — cascade
  grant/revoke to an existing `SCREEN_AUDIO` slot (audio-pre-exists-accept case).
- `markRemoteProducerClosed(SCREEN)` — pre-existing revoke cascade, now fed by
  grant.

Verification at landing: reducer suite 18/18; full voice-provider suite 143 pass
(the 5 `video-bitrate-policy` fails are pre-existing, confirmed on clean tree);
client typecheck PASS; lint clean on touched files.

## PR 1b — external-stream half (done)

Deleted `watchedExternalStreamsRef` and its `getExternalStreamWatchIdentity` /
`getTrackedExternalWatchField` / `isExternalStreamKind` helpers; the ledger's
`desired` (keyed by `streamId`) is now the sole external watch-intent source.
`TTrackedExternalWatchState` survived — it is the `{audio,video}` shape the
reconnect snapshot (`captureWatchedRemoteStreams` → restore loop) genuinely
needs, so it was **renamed** to `TWatchedExternalStreamKinds` to shed the "ref"
connotation rather than deleted.

Unlike screen audio, there was **no step-A reducer gap**: external audio and
video are independent kinds, each accepted/stopped on its own, so
`acceptStream`/`stopWatchingStream` already recorded intent faithfully via
`markWatchRequested`/`markWatchStopped`. The PR was pure B+C — repoint the two
read-sites to `isExternalStreamDesiredInLedger`, then delete the ref and its
write blocks.

**Decision taken — remoteId (streamId) keying.** No `streamId`-churn repro
exists: the bundled plugins load from a runtime path (not in-repo), and the
identity keying dates to the original IPTV feature (`51f998b9`), not a churn fix.
`captureWatchedRemoteStreams` already keys external intent by `streamId`, so the
reconnect path already relies on remoteId keying. The identity indirection was
**not** preserved on spec. Consequence: if a plugin ever tears down and
recreates a logical stream under a new `streamId` while a viewer watches, the
viewer must re-accept — same as the reconnect path already behaves. Revisit only
if a real churn repro surfaces (add `desired` carry-over across a re-key in the
reconcile step; both repair and reconnect would benefit).

**Audit result (write-sites all mirrored):** `acceptStream`/`stopWatchingStream`
→ `markWatchRequested`/`markWatchStopped`. Channel-leave reset → redundant with
`clearAllPendingStreams` (transport cleanup empties the ledger; both read-sites
early-return while `currentVoiceChannelId` is undefined). Full-stream removal
(`onRemoveExternalStream`) → wired to `removeExternalStreamAndSubscription`,
whose `clearRemoteMediaForExternalStream` **deletes** the streamId's ledger
entries, so no `desired` strands. Per-track producer close strands
`{desired:true, producerPresent:false}` under the *same* streamId — which is
exactly what re-consumes the track when it returns, identical to the old ref
carry-over.

Verification at landing: reducer + pending-streams 26/26; full voice-provider
suite 143 pass (the 5 `video-bitrate-policy` fails are pre-existing); client
typecheck PASS; lint clean on touched file (the lone `vite-env.d.ts` warning is
pre-existing).

## PR 2 — visibleRemoteMedia selector (done)

Added `remoteMediaSubscriptionsToVisibleRemoteMedia` in
`apps/client/src/components/voice-provider/hooks/remote-media-subscriptions.ts`
and exposed its memoized result as `visibleRemoteMedia` from `useVoice()`.
`apps/client/src/components/channel-view/voice/index.tsx` now keys stage
pending-card decisions from that selector instead of reinterpreting raw ledger
slots in JSX, and threads the `SCREEN_AUDIO` visible slot into live screen-share
cards so PR 3 can add the compact audio affordance without re-reading raw
ledger state.

**Status vocabulary chosen:** the selector returns `live | pending | retrying |
failed | closing`. Current ledger states only emit `live`, `pending`, and
`failed`: `consumed` → `live`, `available` / `wanted` / `consuming` →
`pending`, and `failed` → `failed`. `retrying` and `closing` are reserved for
later PRs that add those ledger states; PR 2 keeps retrying/failed visually
collapsed into the existing `PendingStreamCard` treatment.

**Scope decision:** `visibleRemoteMedia` answers "should this slot render?" but
does not fake attachability. `remoteUserStreams` and consumed external stream
maps still gate live playback cards; a visible failed/pending slot has no
`MediaStream`. Screen-audio under a live screen is carried as screen-card
metadata for PR 3; standalone failed/pending slots render the existing pending
card until PR 3 adds compact failed/retry affordances.

**Audit result:**

- `remoteMediaSubscriptionsToPendingStreams` drops every
  `{ desired: true, status: 'failed', producerPresent: false }` slot because it
  requires `producerPresent`. `visibleRemoteMedia` keeps those slots renderable.
- Reducer-reachable examples covered by tests: retry exhaustion followed by
  producer close for a desired webcam, and `SCREEN_AUDIO` producer churn while
  its screen remains watched.
- A desired failed screen-shaped slot is selector-supported and unit-tested, but
  current reducer semantics revoke `SCREEN.desired` on `SCREEN` producer close.
  Changing that product semantic was left out of PR 2 because this PR is the
  selector + wiring slice.

Verification at landing: reducer/selector suite 21/21; client typecheck PASS;
client lint PASS with only the pre-existing `src/vite-env.d.ts` unused
`ImportMetaEnv` warning.

## PR 3 — compact failed/retry affordances (done)

Built PR 3 on top of the PR 2 branch (`codex/visible-remote-media-selector`,
[PR #267](https://github.com/jonocairns/ripcord/pull/267)) as
`codex/remote-media-affordances` /
[PR #268](https://github.com/jonocairns/ripcord/pull/268). This slice stayed
UI-only on top of `visibleRemoteMedia`:

- `PendingStreamCard` now renders distinct pending/retrying/failed/closing
  copy and keeps a stop-watch button visible for desired non-live slots.
- Failed/retrying cards show the compact retry affordance, but the retry button
  is disabled until PR 4 adds a real manual retry command and generation guard.
- Live `ScreenShareCard` now uses its `screenAudioSlot?: TVisibleRemoteMedia`
  prop for a compact screen-audio unavailable/connecting control. It does not
  read raw ledger state and does not create fake media objects.
- Screen-audio stop on a live screen card is scoped to `SCREEN_AUDIO`; the
  existing full screen-card stop button still stops the screen and any desired
  screen audio together.
- Stage wiring passes existing `acceptStream` / `stopWatchingStream` callbacks
  into the compact states; no new effect runner, retry generations, or manual
  retry behavior was added.

Verification at landing: reducer/selector suite 22/22; client typecheck PASS;
client lint PASS with only the pre-existing `src/vite-env.d.ts` unused
`ImportMetaEnv` warning.

## PR 4 — manual retry + consume generations (done)

Built PR 4 on top of the PR 3 branch (`codex/remote-media-affordances`,
[PR #268](https://github.com/jonocairns/ripcord/pull/268)) as
`codex/remote-media-manual-retry`. This slice made the retry affordances real
without taking on the longer-term command/effect runner:

- `TRemoteMediaSubscription` now carries an optional `consumeGeneration`, and
  consume success/failure reducer events ignore stale generations.
- Manual retry marks the slot as `retrying`, clears the archived failure, and
  restarts only that slot's transport consume operation.
- The transport consume loop checks the operation token before attaching local
  streams and before committing success, so a superseded attempt cannot install
  playback after a newer retry starts.
- `PendingStreamCard` and live `ScreenShareCard` retry buttons now call the
  real provider retry action while live playback remains sourced only from
  `remoteUserStreams` / active external stream maps.
- Stream-kind-specific provider effects stayed in place; the central
  `streamsToConsume` runner remains PR 5.
- Reducer coverage includes stale consume failure/success, manual retry
  transition, and screen-audio retry while screen video remains live.

Verification at landing: reducer suite 26/26; client typecheck PASS.

## PR 5 — command/effect runner (done)

Built PR 5 on top of the PR 4 branch (`codex/remote-media-manual-retry`) as
`codex/remote-media-consume-runner`. This slice added the first centralized,
ledger-derived consume command path without changing server/API behavior:

- `remoteMediaSubscriptionsToStreamsToConsume` derives consume commands for
  producer-present, desired, not-yet-consuming slots in the `wanted` state.
- The selector gates external stream commands on current track metadata and
  gates `SCREEN_AUDIO` on the parent screen still being desired and producer-
  present.
- `VoiceProvider` now runs one consume effect from that selector and sends
  results back through the existing generation-aware
  `markConsumeStarted`/`markConsumeSucceeded`/`markConsumeFailed` transport
  path.
- New-producer events and watch-accept actions now feed the ledger first; the
  runner performs the consume instead of stream-kind-specific direct calls.
- The old external-stream and watched-pending-screen-audio re-drive effects were
  removed. Existing repair/reconnect sweeps still reconcile producer snapshots
  and preserve their current recovery behavior.

Verification at landing: reducer/selector suite 31/31; client typecheck PASS.

## PR 6 — consume runner cleanup/extraction (done)

Built PR 6 on top of the PR 5 branch (`codex/remote-media-consume-runner`) as
`codex/remote-media-runner-cleanup`. This slice made no intended behavior
change:

- Extracted the PR 5 ledger-derived consume effect from `VoiceProvider` into
  `useRemoteMediaConsumeRunner`.
- Kept `remoteMediaSubscriptionsToStreamsToConsume` pure and in
  `remote-media-subscriptions.ts`.
- Deleted the dead `screen-audio-watch-intent.ts` helper and its obsolete
  helper-only test. Screen-audio intent remains ledger-owned via
  `SCREEN_AUDIO.desired`, coupled to the screen slot.

## PR 7 — repair runner extraction (done)

Built PR 7 on top of the PR 6 branch (`codex/remote-media-runner-cleanup`) as
`codex/remote-media-runner-followup`. This slice made no intended behavior
change — it is the repair-side mirror of PR 6's consume-runner extraction:

- Extracted the stale-pending repair effect from `VoiceProvider` into
  `useRemoteMediaRepairRunner`. The pending-age threshold
  (`PENDING_STREAM_REPAIR_AGE_MS`), ledger desire checks
  (`getOldestRepairEligiblePendingCreatedAt` gated on
  `isExternalStreamDesiredInLedger` / `isScreenAudioDesiredInLedger`), the
  reconnect/channel-stale guard (`currentVoiceChannelIdRef` re-check inside the
  timeout), the `refreshPendingStreamAges` age reset, and the
  `consumeExistingProducers` sweep are all preserved verbatim.
- Moved the two repair-only ledger-desire helpers
  (`isScreenAudioDesiredInLedger`, `isExternalStreamDesiredInLedger`) into the
  hook file — they had no other callers in `VoiceProvider`.
- The reducer stays pure; no command-envelope work started. Screen
  producer-close semantics are untouched.

Verification at landing: reducer/selector suite 31/31; client typecheck PASS;
client lint PASS with only the pre-existing `src/vite-env.d.ts` unused
`ImportMetaEnv` warning.

## PR 8 — command envelope (done)

Built PR 8 on top of the PR 7 branch (`codex/remote-media-runner-followup`) as
`codex/remote-media-command-envelope`. This is the terminal architecture slice:
the reducer transitions now return `{ state, commands }`, and the runner drains
plain command data instead of re-deriving consume work from the whole ledger.

- Added a `TRemoteMediaCommand` envelope with `consume`, `closeConsumer`, and
  `scheduleRetry` command families.
- Consume commands are emitted from producer-present, watch-requested,
  consumer-closed, and snapshot reconciliation transitions, while preserving
  the external-track and screen-audio-under-screen guards.
- Stop-watch, producer-close, and consumer-supersede transitions emit
  `closeConsumer` commands with the observed `consumerId` when available; the
  transport layer executes the close and reports local cleanup back through
  `markRemoteConsumerClosed`.
- The stale-pending repair runner now asks the ledger helper for a
  `scheduleRetry` command and uses that command's `retryAt` for its timer,
  preserving the existing repair age, channel-stale guard, age refresh, and
  `consumeExistingProducers` sweep.
- Screen producer-close semantics remain unchanged: a `SCREEN` producer close
  still ends screen desire.

Verification at landing: reducer/command suite 38/38; client check-types PASS;
client lint PASS with only the pre-existing `src/vite-env.d.ts` unused
`ImportMetaEnv` warning.

## Loose ends

- **Screen producer-close semantics need a product call before changing.**
  Webcam/external desired slots survive producer close, and screen-audio desire
  survives its own producer churn while the screen remains watched. A direct
  `SCREEN` producer close currently ends screen desire; revisit only if the UI
  should keep a failed screen tile after a screen producer disappears while the
  voice user still appears to be sharing.
- **Runtime `/verify` owed for PR 1 and PR 1b.** Both changed real paths — the
  re-drive and repair effects now read the ledger for screen-audio (PR 1) and
  external streams (PR 1b). Unit tests don't exercise those effects (they need a
  live screen-share peer / IPTV plugin stream). Watch for reconnect
  **double-consume**: `captureWatchedRemoteStreams` sees `desired` for both
  kinds, so reconnect and the re-drive effect both re-drive; consume-operation
  state should dedupe, but eyeball it. For PR 1b, also confirm auto-consume of a
  watched external stream survives a per-track producer bounce (track drops then
  returns under the same `streamId`).
  - **Priority note:** external streams come only from plugins, which the repo
    owner rarely uses, so PR 1b's live path sees little real traffic — the drive
    is low-value relative to reducer coverage + typecheck. PR 1's screen-audio
    path is the one that matters; prioritise verifying that if driving either.
