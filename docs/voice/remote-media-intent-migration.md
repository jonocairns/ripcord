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
| 2 | `visibleRemoteMedia` selector (keeps desired-but-failed slots renderable) | 1b | ⬜ |
| 3 | Compact failed/retry UI affordances (design "Required UI Affordance") | 2 | ⬜ |
| 4 | Manual retry + consume generations (reintroduces the removed generation state) | 3 | ⬜ |
| 5 | Full command/effect-runner + `streamsToConsume` (design "Longer-Term Direction") | 2 | ⬜ longer-term |

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

## Loose ends

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
- **Dead-in-prod helper (deferred out of PR 1b).** `tracksScreenAudioWatchIntent`
  (in `hooks/screen-audio-watch-intent.ts`) is no longer used by production code —
  only its own test references it. Deliberately **not** folded into PR 1b to keep
  that PR scoped to the external-stream ref; removing it means untangling it from
  sibling tests in `screen-audio-watch-intent.test.ts`. Drop separately.
  `selectWatchedPendingScreenAudioIds` from the same module is still live.
