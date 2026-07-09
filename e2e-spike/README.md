# WebRTC e2e spike (Playwright)

**Status:** spike / proof-of-concept, kept on its own branch. This whole folder is
deliberately outside the bun workspace (`apps/*`, `packages/*`) with its own `node_modules`,
so it does **not** touch the tracked root lockfile or any workspace `package.json`. It's here
to prove the approach and seed a real `apps/client/e2e/` suite later — not to merge as-is.

## What it demonstrates

Headless, deterministic e2e coverage of the "random WebRTC scenarios" — specifically the
reconnect / remote-media paths reworked in **PR #274** (subscription ledger + transport
restore).

| Spec | Covers | #274 surface |
|------|--------|--------------|
| `tests/reconnect.spec.ts` | 1 peer: join voice → camera live → **Drop WS** → still connected, producer resumes | `use-transports.ts`, `trpc.ts`, `ws-reconnect-gate.ts` |
| `tests/two-peer-media.spec.ts` | 2 peers: A consumes B's camera → A drops WS → **watch intent restored** → B stops → A's slot clears (no stuck failed card) | subscription ledger / `visibleRemoteMedia` |
| `tests/producer-replace.spec.ts` | 2 peers: A watching → B replaces its camera producer → A recovers to live video, no dead consumer | "reset replaced remote producers" commit |
| `tests/offline-defer.spec.ts` | 1 peer: real `context.setOffline` < grace → voice teardown **deferred** → back online recovers | "keep reconnect teardown pending while offline" commit |
| `tests/offline-grace.spec.ts` | 1 peer: offline **> 60s grace** → recovers to a coherent state (slow; run on demand) | grace-window boundary |

## How the hard parts are solved

- **No hardware / no prompts:** Chromium fake-media flags (`--use-fake-device-for-media-stream`,
  `--use-fake-ui-for-media-stream`) — synthetic camera/mic, headless. See `playwright.config.ts`.
- **Uses the cached browser:** points `executablePath` at the already-installed
  `chromium-1208` (Playwright 1.61 otherwise wants to download 1228). Runs fully offline.
- **Proves media actually flows:** `helpers/app.ts` installs an `RTCPeerConnection` wrapper
  (`window.__pcStats`) and asserts on `getStats()` inbound/outbound video **bytes climbing**,
  not on DOM alone (a black/frozen tile can't fake climbing byte counters).
- **Deterministic fault injection:** drives the app's own dev-only **ReconnectLab** panel
  ("Drop WS (<60s)") instead of adding test hooks to tracked source. Its action taxonomy
  (slow restore, failed restore, conflict/kick/ban during restore, offline 70s, rapid flap,
  transport failure) is a ready-made backlog of further scenarios.

## ⚠️ Dev-DB seed (the one non-isolated side effect)

In this dev DB the voice channels are public, but the client's `useCan()` only grants
`JOIN_VOICE_CHANNELS` to **owners** — freshly auto-registered users stay `aria-disabled` on
every voice channel, even after re-login. (Possibly a real product quirk worth a look.) So a
second voice-capable peer must be an owner.

`global-setup.ts` runs `helpers/seed-peer-cli.ts`, which **idempotently inserts one Owner-role
user** (`e2e-peer-b`) into `apps/server/data/db.sqlite`. This is the only thing outside the
spike folder that it touches. It is additive and reversible:

```bash
bun run helpers/seed-peer-cli.ts            # ensure the peer (also runs via globalSetup)
bun run helpers/seed-peer-cli.ts --remove   # delete it
```

Peer A is the bootstrap owner (`sharkord` / `sharkord`).

## Run

```bash
# dev server must be up (from repo root): bun run start:web
cd e2e-spike
PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright npx playwright test
```

## To productionize later

- Move specs to `apps/client/e2e/`, add `@playwright/test` to `apps/client` dev deps, drop the
  hardcoded `executablePath` (install the matching browser in CI).
- Prefer a small dev-only `window.__voiceDebug` hook over driving the ReconnectLab DOM, so the
  full fault taxonomy is scriptable at precise moments.
- Replace the DB seed with a proper test-fixture user (or fix the auto-registration role gap).
