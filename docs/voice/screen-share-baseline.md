# Screen-share regression baseline

This is the screen-share prerequisite for stages 4–5 of the voice-provider
refactor. It is based directly on `main` (`a720cefd`), independently of the
declarations/configuration/keybind/microphone stack ending at PR #325. Production
capture, resource ownership, recovery policy, microphone integration, and the
subsequent extraction stages are unchanged.

## Capture spike

Observed on Linux with Playwright 1.61.1 and Chromium 149.0.7827.55, using the
repository's serial Playwright configuration, Vite on `127.0.0.1:5173`, and the
isolated test server on `127.0.0.1:4991`. The runner recreates `e2e/.runtime/`;
it does not use the development database. The default headless launch uses
Playwright's `chromium_headless_shell-1243`.

The spike invoked the native `navigator.mediaDevices.getDisplayMedia` from a
clicked button on the localhost origin, requested video and audio, played the
returned stream, and sampled its decoded center pixel. The page background was
`rgb(17, 35, 201)` so a generated test pattern could not be mistaken for actual
page capture. Each candidate used a fresh browser and a five-second acquisition
deadline, with no API replacement.

| Launch setup | Observed result |
| --- | --- |
| Existing flags below | Live `screen:-3:0`, `displaySurface: monitor`, 1280×720 at 30 fps; an audio track labeled `Fake audio`; decoded pixel `[74, 255, 22, 255]`, rather than the page background. Chromium generated synthetic display media. |
| Existing flags plus `--auto-select-desktop-capture-source=Entire screen` | Same synthetic screen and fake audio, including the same sampled pixel. This flag did not establish native desktop capture. |
| Default headless shell without fake-device/UI flags, with `--auto-select-tab-capture-source-by-title=Ripcord capture spike` and the autoplay flag | `NotSupportedError: Not supported`. |
| Full headless Chromium (`channel: chromium`) without fake-device/UI flags, with the tab-title/autoplay flags plus `--enable-usermedia-screen-capturing` and `--allow-http-screen-capture` | Acquisition did not settle before the five-second deadline. |

Existing explicit launch flags:

```text
--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream
--autoplay-policy=no-user-gesture-required
--disable-features=WebRtcHideLocalIpsWithMdns
```

Playwright adds its normal launch defaults. These observations do not establish
reliable real display capture in headless CI. No headed/Xvfb setup was proven,
and no native hosted CI capture result is claimed. The PR workflow runs the four
screen cases in a dedicated `Screen-share E2E` job, alongside unit tests and
quality checks. It installs the matching Chromium browser and Linux dependencies,
keeps the existing serial runner and zero retries, and uploads the HTML report
and retained failure traces, screenshots, and video for seven days. The job also
uses the verified immutable source when called by release automation. Other
Playwright suites remain local validation commands.

## Chosen integration boundary

Only `screen-share.spec.ts` installs the explicit `getDisplayMedia` replacement
in the producer page. It returns a live 640×360 `canvas.captureStream(30)` video
track, with a blue center and a moving white marker. The existing global browser
flags and other specs are unchanged. The camera and microphone still use the
existing Chromium fake-device harness.

The mock replaces display acquisition alone. Screen start, watch, and stop go
through the application UI. Publication, signaling, mediasoup, remote
consumption/resume, React wiring, and video playback use production code and the
real test server. This proves application integration with an acquired display
stream. It does **not** prove native picker behavior, user permission, capture of
an actual tab/window/monitor, or OS capture semantics.

Outbound assertions select the sender whose track ID belongs to the recorded
display capture. Inbound assertions identify the blue marker in decoded app
video, then inspect that receiver's track-specific RTP bytes and decoded frames
alongside advancing playback frames. The first test also runs a webcam and
leaves it flowing after screen stop, so camera RTP cannot satisfy the screen
assertions. There are no fixed sleeps in the new tests: polling waits for media,
transport, and session observations.

## Acceptance coverage

| Boundary | Evidence in `screen-share.spec.ts` |
| --- | --- |
| Start and remote watch | UI start/watch, exact captured sender identity, advancing screen RTP/encoded frames, decoded blue screen frames and playback at a second peer. |
| Explicit stop and cleanup | Captured track ends, screen sender disappears, every previously observed screen receiver track ends, screen playback disappears; concurrent webcam traffic remains. |
| Producer WebSocket reconnect | Existing WebSocket fault helper; replacement transports send the same still-live capture track with exactly one acquisition; the watcher decodes a replacement receiver without another watch click. |
| Watcher WebSocket reconnect | Replacement watcher transports and receiver track, advancing decoded screen media without another watch click, and producer capture remains live. |
| Stop during recovery | Reuses the existing connected-peer-connection failure injection. Holds the real `voice.createProducerTransport` request after cleanup and before replacement transport creation. While the session is observably `rebuilding`, UI stop ends capture. Releasing signaling lets recovery finish with no screen capture, sender, receiver, or playback resurrected. |

The stop race covers the pre-publication transport-creation boundary. It does not
claim coverage of every deferred publication/audio-start boundary. Those finer
ownership races belong to the later controller stages.

## Audio and desktop coverage limits

The fixture deliberately returns no audio track. Although the native spike
returned `Fake audio`, this is generated device audio and supplies no evidence
of actual browser tab/system loopback capture. Browser display-audio acquisition,
publication/republishing, and playback are not covered by this video baseline.

Existing controller and subscription tests are retained, including
`desktop-app-audio-recovery-controller.test.ts` lifecycle leases, queued
cancellation and fallback fencing, and `remote-media-subscriptions.test.ts` /
`voice-reconnect-restore.test.ts` screen-audio watch coupling and restoration.
The current browser display-audio publisher remains inside the provider and
has no isolated production controller test. The existing native ingest suite
also contains mirrored provider logic; this prerequisite does not convert it
or treat it as native integration evidence. Stage 4 must retain these suites
and add direct production share-audio controller coverage as planned.

Packaged Electron selection, OS permission, native RTP ingest, worklet/sidecar
capture, and Linux/macOS/Windows desktop smoke tests were unavailable in this
browser-only run. They remain necessary supplements for the relevant ownership
extractions.

## Validation

Completed locally through Nix:

- Scoped Biome formatting and `git diff --check`: passed; resulting source diff
  reviewed.
- CI automation follow-up changes only YAML and Markdown, which Biome does not
  format. Reviewed that diff, passed `git diff --check`, and validated the
  updated workflow with `actionlint` through Nix.
- `check-types`: passed across all workspaces.
- `lint`: passed without warnings.
- `knip`: passed; the existing 11 configuration hints remain.
- Requested voice-provider/server-voice unit tests: 440 passed, 0 failed.
- Screen-share Playwright suite: 4 passed, 0 failed (30 seconds), including a
  follow-up run with `CI=true` to exercise the CI report configuration.
- Reconnect/remote-media/recovery-faults/session-conflict Playwright suites:
  24 passed, 0 failed (3.9 minutes).

Run formatting only on the intentionally changed TypeScript files and review
the resulting diff. From the repository root:

```sh
nix develop -c bun run check-types
nix develop -c bun run lint
nix develop -c bun run knip
```

From `apps/client`:

```sh
nix develop -c bun test ./src/components/voice-provider ./src/features/server/voice
nix develop -c bun run test:e2e e2e/tests/screen-share.spec.ts
nix develop -c bun run test:e2e e2e/tests/reconnect.spec.ts e2e/tests/remote-media.spec.ts e2e/tests/recovery-faults.spec.ts e2e/tests/session-conflict.spec.ts
```

Land this baseline independently on `main` before starting stages 4–5, and keep
it passing during those extractions. Stop this prerequisite at regression
coverage; any production defect found requires a separate fix and validation
rationale.
