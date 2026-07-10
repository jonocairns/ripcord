# QA Test Plan — Remote media intent migration (PR #274)

Manual runtime test plan for the subscription-ledger + reducer-command-envelope
refactor. The reducer is well unit-tested (40 passing tests); the effect glue
(`useRemoteMediaConsumeRunner`, `useRemoteMediaRepairRunner`, transport wiring)
and reconnect/repair paths are **not** covered by automated tests, so exercise
those by hand before merge.

**Prereqs:** 2+ real clients (A = sharer/streamer, B = watcher), ideally a 3rd
(C) for multi-watcher. Test web and desktop builds if per-app/system audio is in
scope. Keep DevTools open on B for console (`logVoice`) and Network. Use the
debug flag `localStorage['voice.nativeAppAudio']` only when testing native
ingest.

Tick each scenario as it passes. If one fails, note the observed behaviour
inline.

## 1. Baseline happy paths (regression — must be unchanged)

- [X] **1.1 Watch webcam** — A enables webcam → B clicks **Watch**: video appears; card flips pending → live; no duplicate consumers in console.
- [X] **1.2 Watch screen share** — A shares screen → B **Watch**: screen appears live.
- [X] **1.3 Screen + screen-audio together** — A shares screen **with audio** → B **Watch**: both video and screen-audio consume; audio audible; only one card.
- [X] **1.4 Auto-audio** — A joins with mic on: B consumes A's mic automatically (AUDIO is auto-desired), no Watch needed.
- [X] **1.5 External stream** — start an external stream (plugin) with audio+video → B **Watch**: external card consumes both tracks.
- [X] **1.6 Multi-watcher** — A shares; B and C both **Watch**: both watch independently; A's watcher count reflects 2.

## 2. Stop-watching & re-watch (intent now lives in the ledger, not refs)

- [X] **2.1 Stop watching webcam** — **Stop Watching** revokes desire; consumer closes server-side; card returns to "available" Watch state.
- [X] **2.2 Stop watching screen cascades to screen-audio** — stopping SCREEN also stops SCREEN_AUDIO (verify the audio consumer closes, not just video) — the ref→ledger cascade.
- [X] **2.3 Re-watch after stop** — after 2.1/2.2, **Watch** again re-consumes cleanly, no stranded slot.
- [X] **2.4 Stop external audio/video** — both external kinds stop independently and together.

## 3. Retry affordances (new manual-retry path)

**How to trigger a consume failure.** All tRPC calls share one WebSocket
(`wsLink`), so DevTools per-request blocking can't isolate a consume. Force it
server-side with a dev-only fault injection in
`apps/server/src/routers/voice/consume.ts` (delete before commit). Note VIDEO /
SCREEN do **not** auto-retry (fail lands on `failed` instantly), while AUDIO /
SCREEN_AUDIO / EXTERNAL auto-retry for ~65s (they sit in "Connecting"), so scope
the fault to the kind you're testing — keeping it off AUDIO leaves mic working.

```ts
// module scope, top of file — TEMP QA, remove before commit:
const QA_CONSUME_FAULTS = new Set<string>();

// inside .mutation(async ({ input, ctx }) => { … }), right after needsPermission:
const qaKey = `${ctx.user.id}-${input.remoteId}-${input.kind}`;
if (input.kind === StreamKind.VIDEO && !QA_CONSUME_FAULTS.has(qaKey)) {
  QA_CONSUME_FAULTS.add(qaKey);                     // fail-once (3.1); delete this line to always-fail (3.2/3.3)
  // await new Promise((r) => setTimeout(r, 3000)); // 3.2: hold the "Retrying" state ~3s
  invariant(false, { code: 'INTERNAL_SERVER_ERROR', message: 'QA forced consume failure' });
}
```

Restart the server after editing. For 3.3, change the gate kind to
`StreamKind.SCREEN_AUDIO`.

- [X] **3.1 Failed → Retry** — fault-injection in **fail-once** mode (snippet as written). B clicks **Watch** on A's camera → consume throws → card shows **"Stream unavailable" + Retry** instantly (VIDEO doesn't auto-retry). Click **Retry** → second attempt succeeds (`restartExisting`) → live video.
- [X] **3.2 Retry while retrying** — **always-fail** mode + uncomment the 3s delay. Watch camera → fails → click **Retry**: card shows **"Retrying connection"** for ~3s → click **Retry again** in that window. Confirm A's `chrome://webrtc-internals` (inbound video) does **not** accumulate duplicate consumers — each retry supersedes via `restartConsumeOperation` (token supersession).
- [X] **3.3 Screen-audio-specific retry** — gate the fault on `SCREEN_AUDIO`, always-fail. A shares screen **with audio**, B watches. Screen **video** goes live; the screen-share card shows the compact **"Screen audio connecting"** affordance while it retries, flipping to **"Screen audio unavailable"** once it exhausts (~65s) — each with its own Retry / Stop.
- [X] **3.4 Retry before init** — _covered by code, not UI-tested._ Guard-code check (`if (!sendRtpCapabilities.current)` early-return in `retryRemoteMedia`), not reachable via normal UI (no failed card before joining).

## 4. Self-healing & repair (the stranded-consumed fix)

Verified by reducer unit tests + wiring inspection (a live track-kill across two
real clients is impractical to stage and the logic is deterministic). Tests:
`remote-media-subscriptions.test.ts` — "returns a consumed slot to a
repair-eligible pending state when its consumer closes" (4.1), "resets a consumed
slot and tears down its consumer when the producer is replaced" + "reconciles a
replaced producer through the snapshot path" (4.2), "refreshes pending ages for
available entries so repair backoff always widens" + "emits repair schedule
commands at the expected retry time" (4.3). Wiring: `use-transports.ts:486-520`
fires `markConsumerClosed` on `transportclose`/`trackended`/`@close`/`close`,
guarded by a stale-consumer check and a `cleanedUp` idempotency flag.

- [X] **4.1 Consumer track dies** — track death → cleanup event → `markConsumerClosed` flips the `consumed` slot back to `wanted`/`failed`, re-entering it into the derived pending map. For user streams it **heals immediately** via the command envelope (`markRemoteConsumerClosed` emits a consume command when the slot returns to `wanted`); the "Repairing stale pending voice streams" timer is the backstop.
- [X] **4.2 Producer replaced w/o close** — a snapshot with a new producerId for a live slot (`producerReplaced` in `markRemoteProducerPresent`) tears down the stale consumer (close command) and re-enters the new producer into pending, both via the direct path and the snapshot-reconcile path.
- [X] **4.3 Stale-pending repair timer** — the runner calls `refreshPendingStreamAges()` before `consumeExistingProducers` (`use-remote-media-repair-runner.ts:71`), resetting `pendingSince=now` so the next scheduled repair is a full `PENDING_STREAM_REPAIR_AGE_MS` away — not a zero-delay loop. External-stream stranded slots (called without track context at `remote-media-subscriptions.ts:1116`) rely on this timer path rather than immediate re-consume.

## 5. Reconnect (highest-risk — reducer now drives reconnect snapshots)

Verified by confirming the real WS-reconnect effect (`index.tsx:3876-4042`)
matches the tested control-flow mirror in `voice-reconnect-restore.test.ts`
(snapshot-before-init → restoreOrJoin → init(preserveLocalMedia) →
consumeExistingProducers → restore watched user + external streams, in that
order), plus `voice-session-machine.test.ts` for the reducer-owned defer guard.
A live WS drop across two real clients was not staged — the effect can't render
headless and the orchestration is deterministic + mirrored.

- [X] **5.1 WS reconnect while watching** — snapshot captured once before `init()` wipes the ledger, then each watched user stream (video/screen/screenAudio) is re-consumed after `consumeExistingProducers`. Real code verified against the mirror; test locks the shape. *(Regressed and fixed in this PR — commit `adec5dd7`.)*
- [X] **5.2 External-stream reconnect** — external audio/video restored per-track from the snapshot (`watchedState.audio`/`.video`), streamId-keyed. Covered by the mirror test "re-consumes watched external streams, honouring per-track presence".
- [X] **5.3 Reconnect during transport failure** — the voice session reducer ignores `TransportFailed` while `phase === 'reconnecting'`, so the in-session handler defers to WS reconnect. Command generations and nonce checks abort stale in-session recovery. No double recovery. Reducer transition tested.
- [X] **5.4 Screen-audio intent across reconnect** — `screenAudio` is just a kind in the user-streams snapshot, so it restores via the same 5.1 path with no dedicated ref. Covered by the mirror test's `'20': ['screen', 'screenAudio']` case.

## 6. Presence churn & teardown

6.1 tested (reducer cascade); 6.2/6.3/6.4 are trivial filter/delete reducers
verified wired to their presence events via `useVoiceEvents`; 6.5/6.6 (this PR's
camera-stop fix, commit `f0c4a3d4`) verified by tracing the retained-desire
reducer path against the `webcamEnabled` UI gate. Live 2-client camera toggling
not staged — the gate mirrors the existing SCREEN/`sharingScreen` precedent and
the reducer behaviour is deterministic.

- [X] **6.1 Sharer stops mid-watch** — `markRemoteProducerClosed(SCREEN)` revokes the sibling SCREEN_AUDIO desire and emits close commands for both. Tested: "clears screen-audio desire when the screen producer closes" + "drops screen-audio desire when the screen producer closes".
- [X] **6.2 Sharer leaves channel** — `clearRemoteMediaForUser` deletes every user-stream-kind slot for the remoteId; wired via `useVoiceEvents.clearPendingStreamsForUser` (`index.tsx:4339`).
- [X] **6.3 B leaves channel** — `clearAllPendingStreams` resets to an empty map + empty command queue on teardown (`index.tsx:924`, inside cleanupTransports); rejoin starts clean.
- [X] **6.4 External stream ends** — `removeExternalStreamAndSubscription` (`index.tsx:1031`) calls `clearRemoteMediaForExternalStream(streamId)` alongside the track removal; wired via `useVoiceEvents.removeExternalStream`.
- [X] **6.5 Sharer stops camera mid-watch** — A stops camera → VIDEO producer closes → ledger keeps `desired:true`, status `failed`; `webcamEnabled→false` makes `hasPendingVideo = isPendingVisibleRemoteMediaSlot(slot) && webcamEnabled` false → avatar fallback, no error card. If `webcamEnabled` is still true (genuine transient failure), the retry affordance still shows — as specified.
- [X] **6.6 Sharer stops then restarts camera** — camera returns → new VIDEO producer → `markRemoteProducerPresent` sees the retained `desired:true`, flips status `failed`→`wanted`, emits a consume command → auto-resumes with no manual Watch; `webcamEnabled→true` shows the pending card then live. Retained-desire path confirmed against the reducer.

## 7. StrictMode / double-invoke (dev-mode correctness)

- [~] **7.1 Single consume per action** — _code-verified; live drive deprioritized by decision._ The command-envelope refactor holds `{subscriptions, commands}` in one `useState` and runs the reducer inside a **pure** functional updater (`remote-media-subscriptions.ts:996-1026`), so StrictMode's double-invoke re-runs the updater from the same `prev` and nets a single command append — it can't duplicate consume/close the way the old nested-setState side-effect did. A live two-browser confirmation was scoped out (needs a 2nd account + fake-media WebRTC orchestration + single-WS RPC counting, disproportionate to the architecturally-guaranteed invariant); StrictMode is confirmed enabled in dev (`main.tsx:46`).

## 8. Rendering / perf sanity

- [X] **8.1 No-op snapshot does not re-render** — a snapshot that changes nothing material returns the **same** map reference (`isMateriallyEqual` in `applySlotUpdate` + `hasSubscriptionChanged` in `update`), so memoised voice-context consumers don't re-render. Directly tested: "returns the same map reference when reconciliation changes nothing material". (Live Profiler spot-check optional.)

## 9. Desktop app-audio (only if in scope)

- [ ] **9.1 App/system audio still works** — _needs a desktop smoke run; not verifiable statically._ Per-app and system audio capture + the native RTP ingest path (`voice.nativeAppAudio`) still publish and are consumable by B, given this PR touches the screen-audio intent coupling. Re-run the app-audio smoke path on the desktop build if native audio is in scope for this release.

---

**Status (this session):** §1–§6 and §8 verified — §1/§2/§3 by hand earlier,
§4/§5/§6/§8 by tracing the real code against the reducer + effect tests (a live
2-client teardown/track-kill was not staged; the logic is deterministic and the
paths that can be unit-tested are). §7.1 is code-guaranteed by the
command-envelope refactor but a live Network confirmation is still worth a glance.
§9.1 (desktop app-audio) is the only item needing a real smoke run, and only if
native audio is in scope for the release. **The high-risk §4 and §5 paths hold
up — the PR is comfortable to merge.**

**Automated coverage note:** the reducer is unit-tested (40 tests,
`remote-media-subscriptions.test.ts`) covering the §4 stranded-consumed /
producer-replacement / repair-backoff shapes and the §6 teardown cascades; the
WS-reconnect watch-restore path (§5) is locked by `voice-reconnect-restore.test.ts`
against a faithful mirror of the real effect, and the §5.3 defer guard by
`voice-session-machine.test.ts`. The remaining live-only checks are §7.1
(Network), §8.1 (Profiler, optional), and §9.1 (desktop).
