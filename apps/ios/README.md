# Ripcord native iOS POC

SwiftUI client for the existing Ripcord server: sign in, read/send text, join
voice, mute/deafen, select speaker output, and watch one remote screen with its
audio. No WebView or JavaScript runtime ships in the app. Media uses the pinned
Mediasoup/WebRTC binary package from VLprojects.

Deafen silences both received audio and the microphone, preserving the resting
microphone preference for Undeafen. Members without SPEAK in a private channel
can join to listen and watch without microphone capture or production; their
microphone controls show “Listen only”. Public channels retain normal speaking
access without requiring explicit per-channel grants.

This is a development POC, not a production-ready mobile client. No existing
server, desktop, or web behavior is changed.

## Build

Requires macOS, Xcode with an iOS simulator, XcodeGen, and Nix for repo Bun tools.
The deployment target is iOS 17. The initial Swift package resolution downloads
the native media frameworks.

From the repository root:

```sh
xcodegen generate --spec apps/ios/project.yml
open apps/ios/Ripcord.xcodeproj
```

Select the Ripcord scheme and an iPhone simulator, then Run. Signing is disabled
for simulator development; a physical-device build needs your own signing setup.
The generated Xcode project is ignored; the package resolution is retained.

## SwiftUI components and appearance

The root view owns navigation and the shared session. Sign-in, channel browsing,
chat, voice and diagnostics are separate screens; screen-local input and scroll
state stay with the screen that uses them. Media and authentication stay in
their existing clients rather than moving into presentation components.

`RipcordTheme` owns the semantic palette and follows the system's light/dark and
Increase Contrast settings. Foreground tokens for accent, destructive and
selected controls are separate from surface colors. Keep video backgrounds black
and avatar initials white independently of the app appearance.

Sign-in and voice-control previews exercise appearance and larger text without
connecting to a backend or acquiring media. Voice controls receive explicit
appearance and accessibility state; test identifiers do not decide behavior.
Theme unit tests check resolved foreground/background contrast in each trait
combination. Live UI tests still require the isolated services below.

## Repository checks and CI

The private `@sharkord/ios` Bun workspace owns only the development fixtures in
`Tools/`. Its dependencies reuse the web/server tooling versions in `bun.lock`;
no JavaScript dependencies ship in the native app. The workspace is unversioned
and does not participate in the server/desktop Release Please version train.
The server Docker context includes its workspace manifest for frozen installs,
but excludes the native source, fixtures, Xcode output and `.amp/in/` data.

The normal repository checks include fixture TypeScript, Biome lint and Knip:

```sh
nix develop -c bun run check-types
nix develop -c bun run lint
nix develop -c bun run knip
```

Swift uses Xcode's bundled `swift-format`, not Biome. From the repository root:

```sh
xcrun swift-format lint --strict --recursive apps/ios/Ripcord apps/ios/RipcordTests apps/ios/RipcordUITests
# To apply formatting:
xcrun swift-format format --in-place --recursive apps/ios/Ripcord apps/ios/RipcordTests apps/ios/RipcordUITests
```

The `iOS` GitHub Actions workflow runs on relevant pull requests and `main`
changes, or manually. It uses `macos-26`, Xcode 26.6 and an iPhone 17 Pro / iOS
26.5 simulator, lints Swift, generates the project, builds all app/test targets,
and runs `MessageTests`, `RPCClientTests` and `RipcordThemeTests` without a backend
or signing secrets.
It uploads the unit-test result bundle. It does **not** run the live media,
session-failure or UI suites; those still require the isolated services below.
Because the workflow is path-filtered, do not require its check on every PR
without an always-running gate for unrelated changes.

PR change selection skips JavaScript quality, web E2E and desktop build jobs for
native-only or documentation-only changes. Changes to `Tools/` or the iOS Bun
manifest still run JavaScript quality checks, but not web E2E or desktop builds.
Shared/global changes such as `bun.lock` retain all existing product checks.
The Swift job watches native sources, tests, assets, package resolution, the
XcodeGen spec and its own workflow, not the JavaScript fixtures. iOS-only pushes
do not publish a desktop beta. Stable release/recovery checks remain unfiltered.

## Isolated local backend and browser peer

Install the repo dependencies and the iOS fixture's pinned test browser:

```sh
nix develop -c bun install --frozen-lockfile
# Run this command from apps/ios:
nix develop -c bunx playwright install chromium
```

Start `Tools/start-local-server.ts` through the local service supervisor, running
from the repository root. It uses a **separate** SQLite database in
`.amp/in/ios-server/data`, signaling port 4993 and loopback WebRTC port 40003.
Never point this fixture at a real deployment. Ensure `/.amp/in/` is in the
repository-local Git exclude before running it.

```sh
amp orb service list
# Only create services if they do not already exist:
amp orb service start ripcord-ios-server --port 4993 --command 'nix develop -c bun apps/ios/Tools/start-local-server.ts'
amp orb service start ripcord-ios-peer --port 5193 --command 'nix develop -c bun apps/ios/Tools/start-peer.ts'
```

The peer is headless Chromium using real tRPC and mediasoup transports. It sends
synthetic 330 Hz voice, 660 Hz screen audio, and a moving 640×360 VP8 canvas,
without accessing the Mac microphone or capturing its screen. Its fixture API
binds only to loopback and is for local tests, not deployment. Start it after
the backend is ready (`http://127.0.0.1:4993/healthz`).

Wait for `/healthz` and the peer's `/fixture` to return successfully before
testing; the supervisor finding an open port does not mean the peer has joined.
The isolated server resets in-process rate-limit budgets for rapid lifecycle
tests. Production server code/configuration and its rate-limit tests are unchanged.

In the iOS Simulator, connect to `http://localhost:4993`, identity
`ios-simulator-poc`, password `local-poc-only`. Local open registration creates
the account on first login. The browser peer uses a separate test identity so
it does not evict the phone's voice session.

`GET http://127.0.0.1:5193/fixture` reports peer RTP counters and received messages.
The `action=message&value=...` and `action=codec&value=video/VP9` query parameters
send a message or switch the synthetic video producer. These controls mutate
only the isolated fixture. H264 codec selection uses the browser's first H264
capability; inspect its actual profile before drawing compatibility conclusions.

## Tests

Grant microphone permission and run with both local services ready:

```sh
xcodebuild test \
  -project apps/ios/Ripcord.xcodeproj -scheme Ripcord \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .amp/in/ios-build \
  -clonedSourcePackagesDirPath .amp/in/ios-packages \
  -parallel-testing-enabled NO
```

Unit tests cover tRPC wire payloads and safe HTML-to-text conversion. The live
UI test signs in, exchanges messages with the browser peer, checks incoming
audio RTP and native audio received by the peer, toggles mute/deafen, watches
advancing screen frames plus screen audio, stops watching, and leaves voice.
It also probes VP9 and the browser's software H264 profile separately.
Keyboard checks assert that the latest sent message stays above the composer
with empty, wrapped, three-line and six-line drafts, including during a call.
They also exercise reading older history without being pulled to the bottom,
returning with Jump to latest, and muting without losing the draft. A second
UI flow exercises chat, channels, voice and screen viewing at AX3 and AX5 text
sizes, including a known loaded message and browsing/returning through history.
Captures document layout, not a VoiceOver or physical-device certification.

`SessionFailureTests` also requires both services. The peer's loopback-only
`/failure` HTTP/WebSocket proxy delays or rejects selected replies from the real
backend. These tests cover terminal sign-out during login/history/refresh,
replacement refresh-token revocation, failed reconnect and retrying server join
after successful authentication. Voice regressions measure decoded microphone
silence across Deafen, microphone toggles and rejoining; exercise listen-only
audio/screen receiving; and inspect server membership after reconnect, terminal
failure and takeover by another client. Two-factor responses/expiry are scripted at
this boundary; this is not a test of real TOTP generation or backend validation.
The failure UI flows exercise restartable 2FA, failed screen consume/resume,
cancel/retry with late replies, current/stale/legacy transport-failure events,
and actual remote audio becoming silent while a DTLS reply is held. They do not
add automatic media recovery. The proxy/control code ships only as Tools, not in
the app. Its `POST /failure/control` accepts `reset`, `hold`, `fail`, `release`,
`twoFactor`, `expired`, `listenOnly` and `event` (`stale`, `current`, `producer`,
`legacy`). `listenOnly` scripts private-channel grants in the join response;
combine it with rejecting `voice.produce` to catch unintended microphone use.

The UI test explicitly sets `RIPCORD_SYNTHETIC_AUDIO=1`: in Debug simulator
builds only, a custom WebRTC audio device generates 440 Hz PCM and drains
received PCM without accessing host audio. This works around a reproduced
Core Audio `AURemoteIO::Initialize` RPC-timeout abort on this Mac. Diagnostics
clearly label this mode. Native codecs, encryption, transports, signaling and
video rendering are real; **physical microphone and speaker behavior are not
verified**. Normal launches use the system microphone/output. Release and
physical-device builds do not contain the synthetic device.

Local validation used an iPhone 17 Pro / iOS 26.5 simulator and the isolated
backend/peer above. All 23 unit/integration tests passed; seven live UI scenarios
passed across the full run and targeted reruns. Two earlier core-flow runs failed
opening diagnostics from the server menu. After adding a stable action identifier
and checking hittability, core-flow reruns passed in light and dark appearance;
the exact source of the original menu failure remains unproven. Listen-only UI
checks also passed in both appearances. Coverage includes remote decoded audio
energy dropping while muted and returning after
unmute, silence throughout Deafen/rejoin, and local mute/leave while a receive-DTLS
reply remained held. A separate real private-channel grant check, with simulator
microphone permission denied, confirmed listen-only audio and screen receiving;
the isolated grants and permission were restored afterward. Message bounds
passed through keyboard changes, multiline drafts and returning from screen
viewing while in a call; AX3 and AX5 controls remained reachable. VP8, VP9 profile
0 and H264 Constrained Baseline (`42e01f`) video decoded successfully. This does
not cover hardware-encoded H264 High (`640034`). Repository type, lint and knip
checks also passed, alongside scoped Swift formatting/lint and Tools checks.
Two-factor expiry/success and server-join rejection were exercised through the
fault proxy, not a real TOTP-enabled account or password-protected server.

## Deliberate limits

- One server; credentials/tokens stay in memory, not persisted to disk. Only the
  server address is saved. Existing login, 2FA and server-password contracts are
  supported. Invite-only registration and mandatory password changes need the
  existing web app. Reconnect is manual; rejoin voice explicitly afterward.
  Reconnect clears any adopted old voice seat, and terminal media failure leaves
  voice rather than retaining silent server membership.
- Text is rendered as plain text, with basic/numeric entity decoding and emoji
  image placeholders. No rich formatting, uploads, reactions, edits or typing UI.
  Existing message edits/deletions are reflected. History is paginated in batches
  of 40. Loaded rows are measured together to avoid lazy-height anchoring loops;
  very long manually loaded histories still need performance profiling.
- One voice seat per account, matching the server. No webcam or phone screen
  broadcast, CallKit, push notifications, or automatic transport repair.
- Default native codec capabilities are used honestly. A desktop H264 **High**
  share may not match the native decoder's Constrained High/Baseline profiles.
  VP8 success alone does not prove H264 or VP9 interoperability.
- Background audio mode is declared, but simulator tests cannot prove locked
  phone audio, Bluetooth routing, interruptions, battery use or cellular handoff.
  All need a physical-device spike before treating this as a usable beta.
- Real deployments need HTTPS/WSS and reachable media candidates. The fixture
  intentionally advertises loopback and cannot be used from a physical phone.
  No global ATS bypass or certificate-validation bypass is included.
