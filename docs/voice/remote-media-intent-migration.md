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
| **1b** | Ledger owns watch intent — **external-stream half** | 1 | ⬜ not started |
| 2 | `visibleRemoteMedia` selector (keeps desired-but-failed slots renderable) | 1b | ⬜ |
| 3 | Compact failed/retry UI affordances (design "Required UI Affordance") | 2 | ⬜ |
| 4 | Manual retry + consume generations (reintroduces the removed generation state) | 3 | ⬜ |
| 5 | Full command/effect-runner + `streamsToConsume` (design "Longer-Term Direction") | 2 | ⬜ longer-term |

**Split rationale (1 vs 1b):** the screen-audio ref (`watchedScreenAudioRef`, a
`Set<number>`) and the external-stream ref (`watchedExternalStreamsRef`, keyed by
stable `pluginId:key` identity) are independent, with independent read-sites. The
external half also carries a keying judgment call (below), so it gets its own
focused review rather than riding along with mechanical deletion.

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

## PR 1b — external-stream half (next)

Goal: delete `watchedExternalStreamsRef` and its `TTrackedExternalWatchState` /
`getExternalStreamWatchIdentity` / `getTrackedExternalWatchField` helpers; the
ledger's `desired` becomes the sole external watch-intent source. Same A/B/C
shape: close any intent gap in the reducer, repoint the read-sites, delete the
ref.

**Open decision — remoteId vs identity keying.** The external ref keys intent by
the stable `pluginId:key` identity because an external stream's numeric
`streamId` can be reassigned while the logical stream persists. The ledger keys
by `remoteId:kind`. `captureWatchedRemoteStreams` (reconnect capture) **already**
derives external intent from `desired` keyed by `remoteId`, so remoteId keying is
the de-facto model and reconnect already relies on it. Decision to make before
starting:

- If `streamId` does not actually churn while a share is live → remoteId keying
  is fine, delete `getExternalStreamWatchIdentity` outright.
- If it does → the gap is one reconnect capture already shares; fix it once in
  the reconcile step by carrying `desired` across a re-key by matching identity,
  and both repair and reconnect benefit.
- Lean: assume remoteId keying (match the reconnect precedent); only add identity
  carry-over if a real `streamId`-churn repro exists. Don't preserve the
  indirection on spec.

**Audit method (repeat what worked for screen audio):** enumerate every
`watchedExternalStreamsRef` write-site and read-site, then check each against the
ledger mutation that already fires at the same event. For screen audio this found
6 of 9 sites already faithfully mirrored — the gap was only the SCREEN→SCREEN_AUDIO
grant coupling. Write-sites: `acceptStream`/`stopWatchingStream` external blocks,
`removeExternalStreamAndSubscription`, channel-leave reset. Read-sites: the
external re-drive effect and `getOldestRepairEligiblePendingCreatedAt`'s external
predicate.

## Loose ends

- **Runtime `/verify` owed for PR 1.** B/C changed a real path — the two effects
  now read the ledger. Unit tests don't exercise those effects (they need a live
  screen-share peer). Watch for reconnect **double-consume**: `captureWatchedRemoteStreams`
  now sees `SCREEN_AUDIO.desired`, so reconnect and (pre-Step-C) the ref path both
  re-drove screen audio; consume-operation-state should dedupe, but eyeball it.
- **Dead-in-prod helper.** `tracksScreenAudioWatchIntent` (in
  `hooks/screen-audio-watch-intent.ts`) is no longer used by production code —
  only its own test references it. Left in place because removing it means
  untangling it from sibling tests; fold into PR 1b cleanup or drop separately.
  `selectWatchedPendingScreenAudioIds` from the same module is still live.
