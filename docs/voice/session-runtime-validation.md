# Stage 6 validation

Stage 6 is implemented in a new stack based on `main` at
`cfe0f366f0f00ed771692d6d2d4a73f6bd530bde`. The extraction and currency fixes are
separate layers. Stage 7 is unstarted. `VoiceProvider` is 721 lines, down from
1,736. The original worktree and untracked sequencing plan are preserved.

## Checks

All commands use Nix. Dependencies were installed with
`nix develop -c bun install --frozen-lockfile`; the lockfile is unchanged.

- Scoped `bunx biome check --write` on intentionally modified TypeScript files,
  reviewed source diffs and `git diff --check`: passed.
- Root `bun run check-types`: passed across client, server and desktop.
- Root `bun run lint`: passed with no lint warnings.
- Root `bun run knip`: passed, retaining its 11 existing configuration hints.
- From `apps/client`, `bun test ./src/components/voice-provider
  ./src/features/server/voice`: 713 passed across 59 files, including 43
  production-runtime factory/mount tests. The extraction layer alone had 694
  passed, including 24 runtime tests.
- From `apps/client`, `CI=true nix develop -c bun run test:e2e
  e2e/tests/screen-share.spec.ts e2e/tests/screen-share-lifecycle.spec.ts`:
  6 passed on both extraction and final code.
- From `apps/client`, `nix develop -c bun run test:e2e
  e2e/tests/reconnect.spec.ts e2e/tests/remote-media.spec.ts
  e2e/tests/recovery-faults.spec.ts e2e/tests/session-conflict.spec.ts`:
  23 passed and 1 failed on both extraction and final code. No retries or
  assertion changes were used to turn that failure into a pass.

Existing microphone, share-audio, webcam, screen-video, settings, session-machine,
store, executor, runner-boundary, PCM, queue and pipeline tests remain present.
The screen baseline's canvas capture remains video-only and unchanged.

## Reproduced baseline failure

`reconnect.spec.ts:57`, “voice returns to a coherent session after the reconnect
grace expires”, fails at the unchanged `Connected` assertion on line 71.

Reproduction on untouched `main` in `/tmp/ripcord-voice-stage-6-baseline`:

```sh
# After a frozen dependency install, from apps/client:
nix develop -c bun run test:e2e e2e/tests/reconnect.spec.ts \
  --grep 'voice returns to a coherent session after the reconnect grace expires'
```

The test starts a camera, takes the browser offline for 65 seconds, returns
online, and expects voice to become connected and camera RTP to resume. Observed:
application authentication/channel UI returns, voice remains “Connecting...”,
and the 45-second `Connected` assertion expires. Traces on untouched `cfe0f366`,
the extraction layer, and final code show repeated restore attempts with loaded
devices, created prepared transports and completed producer-snapshot queries,
followed by “Voice reconnect detached a hung cancelled operation”.

The next awaited init boundary includes microphone preparation. These traces
point to reacquisition/processing or its teardown path, rather than proving
which internal microphone boundary hangs. No physical-device conclusion follows
from the fake-device harness. This remains an unresolved baseline defect; the
runtime extraction and currency fixes do not claim to repair it. Failure traces,
screenshots, command output and server logs are retained in the task's temporary
validation evidence, including the independent untouched-main comparison.

## Behavioral fixes and evidence

Nineteen additional runtime tests cover stale entry, device-factory completion,
server response, local cleanup before passive disposal, detached restore,
republish completion, partial init/rebuild failure, disconnected boundaries,
timeout detachment and obsolete finalization callbacks. The first deferred set
reproduced eleven failures before the fixes. These tests import the production
factory and mount; they do not copy session effect implementations.

A failed attempt revokes its publication currency before pending work settles.
It cleans transport resources only while it still owns the runtime. Capture and
watch intent survive recovery and failed video republishing. Restore retains one
lease through its RPC and initialization, while the existing executor still
records server establishment and owns command/timeout/retry/drain policy.

## Environment and limits

Each Playwright runner starts its own Vite client on port 5173 and isolated server
on port 4991. The server changes directory to that worktree's
`apps/client/e2e/.runtime` and writes only `.runtime/data/db.sqlite`. The normal
development database was never used or reset. Port/process ownership was checked;
no unrelated process was killed. The native browser preview was opened through
T3 tools and inspected the rendered app.

Unit tests control device, signaling, transport and media-owner timing. Browser
fault helpers control acquisition/disconnect/rebuild timing; the application,
server signaling, mediasoup, WebRTC and decoded-media assertions run production
paths. Camera/microphone use Chromium fake devices, and screen acquisition uses
the unchanged video-only canvas fixture. This does not prove real display audio,
physical devices, native pickers/permissions, OS capture, sidecar/native RTP or
packaged desktop stop/reconnect. Those platform checks were unavailable. No test
tone was played and no desktop test took over the user's screen.
