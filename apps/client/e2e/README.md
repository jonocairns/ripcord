# End-to-end tests

These Playwright tests drive the web client in Chromium with synthetic microphone, camera and audio output devices. The
runner starts its own client and server, recreates `e2e/.runtime/` for every run, and never reads or modifies the
normal development database. Most specs cover voice and WebRTC recovery; `text-chat.spec.ts` covers messages and
attachments.

`--disable-audio-output` replaces the OS output stream while preserving Chromium's audio processing and WebRTC.
Muting alone still opens the host audio backend. The long-offline microphone acquisition investigation and its
fail–pass–fail comparison are recorded in [reconnect-validation.md](../../../docs/voice/reconnect-validation.md).
These tests do not prove physical playback or native device behavior.

From the repository root:

```bash
nix develop -c bun run test:e2e
```

Run one spec from `apps/client`:

```bash
nix develop -c bun run test:e2e e2e/tests/text-chat.spec.ts
```

Install the matching browser once when needed:

```bash
nix develop -c bun run --filter client test:e2e:install
```

The suite is intentionally serial because it shares one server and its fixed WebRTC port. Every test creates unique
users and must leave voice or close its browser contexts during teardown. Do not add retries to hide shared-state or
timing failures; use the retained trace, screenshot, and video to diagnose them.

Assertions use `RTCPeerConnection.getStats()` and live sender/receiver tracks. A visible card alone is not proof that
media recovered. Faults are driven by Playwright browser instrumentation or real product operations; do not add E2E
switches or control routes to shipped client/server code.

The reconnect suite checks microphone RTP and non-concealed received samples attached to the app's audio player.
Its grace-expiry case closes the real server WebSocket while the browser is offline, verifies the isolated server's
60-second grace expiry and fresh restore path, then checks replacement microphone media and camera RTP. Browser
offline duration by itself is not evidence that the server's grace timer expired.

The text-chat suite sends, edits and deletes messages between members, uploads attachments, and checks that the
browser decodes the real image bytes and that file links download, survive a history load, and stop working once their
message is deleted. Its private-channel case checks that attachment links need the channel token and that the open
client re-signs them after a token rotation. Setup that a user would do through admin UI, such as creating a private
channel, calls the app's own tRPC client through `helpers/trpc.ts` with that user's session.
