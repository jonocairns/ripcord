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

- [ ] **1.1 Watch webcam** — A enables webcam → B clicks **Watch**: video appears; card flips pending → live; no duplicate consumers in console.
- [ ] **1.2 Watch screen share** — A shares screen → B **Watch**: screen appears live.
- [ ] **1.3 Screen + screen-audio together** — A shares screen **with audio** → B **Watch**: both video and screen-audio consume; audio audible; only one card.
- [ ] **1.4 Auto-audio** — A joins with mic on: B consumes A's mic automatically (AUDIO is auto-desired), no Watch needed.
- [ ] **1.5 External stream** — start an external stream (plugin) with audio+video → B **Watch**: external card consumes both tracks.
- [ ] **1.6 Multi-watcher** — A shares; B and C both **Watch**: both watch independently; A's watcher count reflects 2.

## 2. Stop-watching & re-watch (intent now lives in the ledger, not refs)

- [ ] **2.1 Stop watching webcam** — **Stop Watching** revokes desire; consumer closes server-side; card returns to "available" Watch state.
- [ ] **2.2 Stop watching screen cascades to screen-audio** — stopping SCREEN also stops SCREEN_AUDIO (verify the audio consumer closes, not just video) — the ref→ledger cascade.
- [ ] **2.3 Re-watch after stop** — after 2.1/2.2, **Watch** again re-consumes cleanly, no stranded slot.
- [ ] **2.4 Stop external audio/video** — both external kinds stop independently and together.

## 3. Retry affordances (new manual-retry path)

- [ ] **3.1 Failed → Retry** — force a consume failure (throttle B's network during consume, or block the consume RPC briefly). Card shows **"Stream unavailable" + Retry**; click Retry → fresh consume attempt (`restartExisting`), succeeds when network restored.
- [ ] **3.2 Retry while retrying** — card shows "Retrying connection"; Retry remains; clicking again does not spawn duplicate consumers (token supersession).
- [ ] **3.3 Screen-audio-specific retry** — on the live screen-share card, screen-audio compact affordance shows "Screen audio unavailable/connecting" with its own Retry / Stop (screen video already live).
- [ ] **3.4 Retry before init** — trigger retry immediately on join before RTP caps ready → guarded no-op (logs "Cannot retry remote media before voice is initialized"), no crash.

## 4. Self-healing & repair (the stranded-consumed fix)

- [ ] **4.1 Consumer track dies** — while B watches A's screen, kill the track (A stops+restarts encoder, or force `trackended`/`transportclose`). B's slot must **not** strand on "consumed" — it returns to pending and a repair pass re-consumes (watch console for "Repairing stale pending voice streams").
- [ ] **4.2 Producer replaced w/o close** — A reconnects/repairs so producerId changes with no close event. B tears down the dead consumer and consumes the new producer (not silently suppressed).
- [ ] **4.3 Stale-pending repair timer** — leave a pending stream unconsumed; after `PENDING_STREAM_REPAIR_AGE_MS` the repair runner fires `consumeExistingProducers`. Confirm it fires **once** per window, not a zero-delay loop (the `refreshPendingStreamAges` reset).

## 5. Reconnect (highest-risk — reducer now drives reconnect snapshots)

- [ ] **5.1 WS reconnect while watching** — B watches A's webcam + screen+audio; drop B's WS (Reconnect Lab / network blip). On restore, **all previously-watched streams re-consume automatically** — no manual re-Watch. *(Regressed and fixed in this PR: init() wipes the ledger, so the WS-reconnect path now snapshots watch intent before init and restores it after consumeExistingProducers.)*
- [ ] **5.2 External-stream reconnect** — same as 5.1 for external audio/video (streamId-keyed intent).
- [ ] **5.3 Reconnect during transport failure** — trigger a transport failure that hands off to WS reconnect → no double recovery, session restored, watched streams reappear.
- [ ] **5.4 Screen-audio intent across reconnect** — screen-audio (subordinate to screen) re-consumes after reconnect without the old `watchedScreenAudioRef`.

## 6. Presence churn & teardown

- [ ] **6.1 Sharer stops mid-watch** — A stops screen while B watches: B's card clears; screen-audio sibling desire revoked; no ghost card.
- [ ] **6.2 Sharer leaves channel** — A leaves: `clearRemoteMediaForUser` removes all A's slots on B; no leftover pending cards.
- [ ] **6.3 B leaves channel** — B leaves voice: ledger fully cleared (`clearAllPendingStreams`); rejoining starts clean.
- [ ] **6.4 External stream ends** — external stream stops: card + subscription removed.

## 7. StrictMode / double-invoke (dev-mode correctness)

- [ ] **7.1 Single consume per action** — run the client in dev (StrictMode on). Watch a stream and confirm **exactly one** consume RPC per action in the Network tab (the slice-10 fix). No duplicate consumers, no duplicate close calls.

## 8. Rendering / perf sanity

- [ ] **8.1 No-op snapshot does not re-render** — with several users sharing and a producer snapshot arriving that changes nothing material, confirm VoiceChannel does **not** re-render in a loop (React DevTools Profiler) — the `isMateriallyEqual` no-op should hold the map reference stable.

## 9. Desktop app-audio (only if in scope)

- [ ] **9.1 App/system audio still works** — per-app and system audio capture + the native RTP ingest path (`voice.nativeAppAudio`) still publish and are consumable by B, given this PR touches the screen-audio intent coupling. Re-run the app-audio smoke path.

---

**Priority:** Focus on §5 (reconnect), §4 (self-heal / producer-replacement),
§2.2 (screen-audio cascade), and §3 (retry) — the paths that changed most and
have the least automated coverage. §1 is regression insurance. If §5 and §4
hold up live, the PR is comfortable to merge.

**Automated coverage note:** the reducer is unit-tested
(`remote-media-subscriptions.test.ts`), and the WS-reconnect watch-restore
regression from §5.1 is locked in by `voice-reconnect-restore.test.ts`. The
remaining scenarios above are manual-only.
