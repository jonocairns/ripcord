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

## Remaining validation and known defect

Full reconnect/remote-media/recovery-faults/session-conflict validation is recorded
below when completed. The stage 6 validation record documents the existing
65-second offline reconnect failure on untouched `main`; it remains unresolved.
An isolated exact starting-commit comparison uses `/tmp/ripcord-voice-stage-7-start`.

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
