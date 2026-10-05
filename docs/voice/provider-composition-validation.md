# Stage 7 composition validation

Stage 7 starts from the verified open stage 6 head
`6834c8d43acfcf38d1322fcba6b35880041f594d` (#340, above #339). Latest fetched
`main` is `cfe0f366f0f00ed771692d6d2d4a73f6bd530bde`; stage 6 is not merged.
The isolated implementation worktree is `/tmp/ripcord-voice-stage-7`. The
completed stages 1–5 native stack (1714928) is not extended.

## Composition extraction

`VoiceProvider` is 359 lines, down from 721 at stage 6 and 1,736 before stage 6.
Remote integration now composes the existing authoritative ledger, transport,
stream, event and runner boundaries. Element refs are cached and pruned privately.
Sender metadata samples controller producer getters. The local snapshot hook
retains no producer ref or capture teardown; `init` remains consumed by navigation.

All Bun commands use Nix. Frozen dependency installation succeeded without
changing `bun.lock`. Intentionally changed supported source files were formatted
with `bunx biome check --write`, and resulting diffs were reviewed.

- Root `bun run check-types`: passed across client, server and desktop.
- Root `bun run lint`: passed with no lint warnings.
- Root `bun run knip`: passed with its 11 existing configuration hints.
- Client `bun test ./src/components/voice-provider ./src/features/server/voice`:
  734 passed across 62 files, including 21 new integration/cache/metadata cases.
- Client `CI=true nix develop -c bun run test:e2e
  e2e/tests/screen-share.spec.ts e2e/tests/screen-share-lifecycle.spec.ts`:
  6 passed, with zero retries and unchanged video-only canvas capture.
- `git diff --check`: passed.

The original workspace and stage 6 worktree are preserved. The original
untracked sequencing plan is untouched (SHA-256
`480ad3b7d16213cab640a7b643f8ab5e39f0510b3a215d519df238be3904a5c9`).
Its active role is retired by the tracked architecture record; it is not added,
deleted or overwritten.

## Final lifecycle corrections

The second layer adds six production integration/mount tests and two runtime
cases, and strengthens three existing runtime assertions. The layering suite
retains all original executor import restrictions, construction/registration
bans and React adapter ownership assertions, and extends them to the new remote
integration modules.

- Root `bun run check-types`, `bun run lint` and `bun run knip`: passed after
  formatting, with no lint warnings and the same 11 knip configuration hints.
- Client voice unit command: 742 passed across 62 files.
- The two screen E2E specs: 6 passed again (39.1 seconds), zero retries.
- Client `nix develop -c bun run test:e2e e2e/tests/reconnect.spec.ts
  e2e/tests/remote-media.spec.ts e2e/tests/recovery-faults.spec.ts
  e2e/tests/session-conflict.spec.ts`: 23 passed and 1 failed (4.1 minutes),
  exit 1, zero retries. Only the existing long-offline case failed.

Two added/strengthened disconnect assertions failed on the composition layer
before the runtime fix: transport creation and local republication could return
normally after connectivity loss. They pass when those awaited boundaries reject
superseded work, preventing false `RebuildSucceeded`. State sync already checked
currency and retains coverage. Nonce restart and executor policy are unchanged.

The remote integration now activates in layout, settles pending acknowledgements
on cleanup and checks activation identity after acknowledgement delivery. Cleanup
owns no transport or ledger teardown. Replay replaces its private publication;
old cleanup is inert against the replacement. Tests cover inactive/aborted work,
pending and just-acknowledged cleanup, replay, replacement and stale callbacks.

## Exact starting-commit defect comparison

The focused reconnect case failed on untouched `6834c8d4` in
`/tmp/ripcord-voice-stage-7-start`, after a frozen dependency install:

```sh
# From apps/client, with required ports free:
nix develop -c bun run test:e2e e2e/tests/reconnect.spec.ts \
  --grep 'voice returns to a coherent session after the reconnect grace expires'
```

The unchanged test takes the browser offline for 65 seconds, then expects
`Connected` and resumed camera RTP. Authentication/channel UI returned, but voice
stayed `Connecting...` and line 71's 45-second assertion timed out. No retry or
assertion change was used. This independently confirms the failure on the exact
stage 7 starting head, supplementing the untouched-main reproduction in
[session-runtime-validation.md](./session-runtime-validation.md).

Starting-head trace logs show prepared producer/consumer transports and completed
producer snapshots at 73.28, 87.30 and 101.60 seconds, followed by cancelled
restore detachment at 87.26, 101.28 and 115.58 seconds. Server logs show successful
`voice.restoreOrJoin` requests and committed transport pairs, with no server
error-log entries. The microphone's initial acquisition logs appear, but no new
`Microphone stream obtained` follows the restore attempts. Initialization next
awaits producer synchronization and microphone preparation together. Acquisition,
processing and captured pipeline teardown remain investigation leads; these logs
do not establish which internal await hangs.

The test name also overstates evidence of server grace expiry: in this exact-start
run the server cancelled grace at an age of 22,495 ms and all restore requests
used the existing-session path. A 65-second browser offline interval does not
prove when the server observed socket loss. The existing test and assertions
remain unchanged; deterministic expiry coverage needs separate follow-up.

Final-stack traces show the same pattern: initial microphone acquisition,
prepared transports and completed producer snapshots during three restores, then
cancelled-operation detachment with voice still connecting. The final server
cancelled grace after 22,245 ms and committed the three restore transport pairs.
There is no changed failure to attribute to the extraction or lifecycle layer.

Logs, failure trace/screenshot/video, before-fix unit output and both starting-head
and final server logs are retained under `/tmp/ripcord-voice-stage-7-evidence`.
The requested ownership refactor is implemented. Remaining work is diagnosis and
repair of the long-offline restore hang, deterministic server-grace-expiry
coverage and the unavailable physical/native/packaged runtime validation.

## Environment and evidence limits

The repository Playwright harness starts its isolated server on 4991 and Vite on
5173. The server changes directory to `apps/client/e2e/.runtime` and uses only
`.runtime/data/db.sqlite`. No normal development database is used or reset.
Port/process identity is checked before each run; unrelated processes are not
stopped.

Unit tests import production factories and control timing/owner boundaries.
Browser tests use real application signaling, mediasoup, WebRTC and decoded-media
assertions. Camera/microphone acquisition uses Chromium fake devices; screen
acquisition uses the unchanged video-only canvas fixture. Controlled acquisition
and fault timing do not prove physical capture or native permission flows.

T3 preview status/open initialized a tab, but navigation timed out and snapshot
reported no connected preview automation host. No successful interactive preview
inspection is claimed. Physical devices, display audio, OS picker/permissions,
sidecar/native RTP, renderer worklet with real sidecar and packaged desktop
stop/reconnect coverage were unavailable. No tone was played; no desktop test
took over the user's screen.
