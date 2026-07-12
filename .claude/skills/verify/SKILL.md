---
name: verify
description: Drive the running Ripcord web client with Playwright to verify changes end-to-end (login, voice join/leave, reconnect lab faults, multi-client observer checks, screenshare watch). Use when verifying client/server changes at runtime instead of via tests.
---

# Verifying Ripcord at runtime (web client + Playwright)

## Launch the stack

- Dev stack: `nix develop -c bun run start:web` from the repo root (concurrently runs client + server). Client: `http://127.0.0.1:5173`. Server logs go to wherever you redirected stdout; grep for `[voice-reconnect]` scope lines (`voice_disconnect_grace`, `voice_restore_or_join`) — they are the authoritative trace of reconnect behavior.
- Accounts: `claude`/`claude` (display name "SharkordUser"), observer `e2e-peer-b`/`claude` (display name "E2E Peer B"). Voice channels seeded: Lounge, Gaming Room, Work Mode.

## Playwright setup (no repo dep)

- `require('/home/jonoc/rt/node_modules/playwright')` (1.58.0) + cached `~/.cache/ms-playwright/chromium-1208`.
- **Must use `channel: 'chromium'`** for anything touching media — the default headless shell's fake devices are broken (mic `NotSupportedError`, camera `NotFoundError`).
- Args: `--use-fake-ui-for-media-capture --use-fake-device-for-media-capture --auto-select-desktop-capture-source=Entire screen`. Context: `permissions: ['microphone','camera']`.
- Works: fake mic (real audio producer), getDisplayMedia screenshare. Does NOT work: webcam (`NotFoundError` — assert rollback-to-off only).
- Multi-client = one context per client (same or different account). Capture `page.on('console')` + `pageerror` per client; the voice provider logs richly (`[VOICE-PROVIDER]`).

## Selectors that work

- Login: first non-password `input` = Identity, `input[type=password]`, then `getByRole('button', { name: 'Connect', exact: true })` (non-exact also matches the reconnect-lab flask button).
- Join voice: click the channel-name span with `{ force: true }` (dnd-kit puts `aria-disabled` on rows for users without MANAGE_CHANNELS).
- Sidebar controls are icon buttons named by `title`: `Mute microphone`/`Unmute microphone`, `Deafen`/`Undeafen`, `Start video`/`Stop video`, `Share screen`/`Stop sharing`, `Leave voice`. Connection text: `Connected`/`Connecting...`/`Reconnecting voice...`.
- Participants under a channel (works on any client, incl. observers):
  `//span[normalize-space()="<Channel>"]/../following-sibling::div[contains(@class,"ml-6")]//span[contains(@class,"truncate")]`
- Participant status icons by lucide class inside the row: `.lucide-mic-off`, `.lucide-headphone-off`, `.lucide-video`, `.lucide-monitor`.
- Watch a share: click the row's `button:has(.lucide-monitor)` (opens stage + watches); stage tile buttons: `Watch`, `Stop Watching` (hover the `video` element to reveal overlay controls).

## Reconnect Lab (dev-only fault injection)

Bottom-right flask button `aria-label="Open reconnect lab"`. Key buttons: `Drop WS (<60s)`, `Slow restore + drop WS` (5s delay — widens the reconnect window for racing manual actions), `Fail next restore + drop WS` (one failure, retry loop should recover), `Force restore conflict` (terminal give-up path), `Forget session + drop WS`. Status line shows `Socket connected · voice #<id>`.

## Gotchas

- A quick claude-account probe: users table column is `identity`, not `username`; DB at `apps/server/data/db.sqlite` (WAL — read with `bun:sqlite`).
- Toasts (sonner): `[data-sonner-toast]`; they expire in ~4s, poll fast if you need to catch one.
- Scenario contamination: a leftover pending-grace entry or resident seat from a previous test (same account) makes the next `restoreOrJoin` conflict instantly — reconnect-lab delays are then skipped, so "manual action during reconnect" tests silently test the wrong thing. Leave voice cleanly between scenarios and watch the `[voice-reconnect]` server log for `conflict` events you didn't script.
