---
name: verify
description: Verify Ripcord web client and server behavior in a running local stack with the repository-owned Playwright harness. Use for runtime checks of voice join and mute, WebSocket reconnect recovery, multi-client screenshare, media acquisition rollback, and related client/server changes that need browser evidence beyond unit tests.
---

# Verify Ripcord at runtime

Start the local stack from the repository root:

```bash
nix develop -c bun run start:web
```

In another shell, run the relevant checked-in scenario:

```bash
nix develop -c bun run verify:web --scenario voice
nix develop -c bun run verify:web --scenario reconnect
nix develop -c bun run verify:web --scenario screenshare
```

Use `--headed`, `--channel <name>`, or `--base-url <url>` when needed. Run `nix develop -c bun run verify:web --help` for account environment variables and all options. The Nix shell supplies the Playwright browser; do not depend on a personal installation or cache.

## Interpret scenarios

- `voice`: join, mute, unmute, then leave cleanly.
- `reconnect`: join, trigger the reconnect lab's short WebSocket drop, wait for the voice session to recover, then leave.
- `screenshare`: join two isolated browser contexts, publish and watch a share, stop the local share first, then leave both clients.

Capture the harness console and page errors with the result. For reconnect failures, also inspect server events with scopes `voice_disconnect_grace` and `voice_restore_or_join`.

## Targeted manual checks

Use the reconnect lab for cases not yet automated: slow restore races, one-shot restore failure, forced conflict, forgotten session, and desktop quit. Do not reuse a contaminated session: leave voice cleanly between scenarios and check for unexpected conflict events.

Fake microphone and display capture are supported. If webcam acquisition is unavailable under the local browser, verify rollback-to-off behavior rather than treating device absence as a product failure.
