# WebRTC end-to-end tests

These Playwright tests run Chromium with synthetic microphone and camera devices. The runner starts its own client and
server, recreates `e2e/.runtime/` for every run, and never reads or modifies the normal development database.

From the repository root:

```bash
nix develop -c bun run test:e2e
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
