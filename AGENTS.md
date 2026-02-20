# AGENTS.md

This file is for human and AI contributors working in this repository.

## Project at a glance

- Monorepo with Bun workspaces:
  - `apps/client` (Vite + React)
  - `apps/server` (Bun server)
  - `apps/desktop` (Electron app + Rust sidecar)
  - `packages/*` shared libs
- Root helper script: `./start.sh` starts client + server (uses `tmux` when available).

## Recommended workflow

1. Use the Nix dev shell for tool consistency.
2. Install dependencies with `bun install` from repo root.
3. Run dev services with `./start.sh` (or run each app directly).
4. Before submitting changes, run:
   - `bun run check-types`
   - `bun run lint`
   - `bun run format`

## Running with Nix

### One-time setup

1. Install Nix with flakes enabled.
2. Install `direnv`.
3. Install `nix-direnv` (recommended for fast/cached flake activation).
4. In this repo, allow direnv:
   - `direnv allow .`

After this, entering the repo should auto-load the flake environment from `.envrc`.

### Daily usage

- Auto mode (preferred): `cd` into the repo and let `direnv` load the shell.
- Manual mode: run `nix develop` from repo root.
- One-off command mode: `nix develop -c <command>`.

Examples:

- `nix develop -c bun install`
- `nix develop -c ./start.sh`
- `nix develop -c bun run --filter @sharkord/server test`
- `nix develop -c bun run check-types`
- `nix develop -c bun run lint`
- `nix develop -c bun run format`
- `nix develop -c bun run magic`

### What the flake provides

The dev shell includes common project tooling such as:

- `bun`, `nodejs`, `pnpm`
- `tmux`, `gh`
- `rustup`
- MinGW cross toolchain (`x86_64-pc-windows-gnu`) for Windows sidecar builds

Supported flake systems in `flake.nix`:

- `aarch64-darwin`
- `x86_64-linux`

### Troubleshooting Nix/direnv

- `direnv: nix binary not found on PATH; skipping 'use flake'`
  - Nix is not installed (or not available in this shell).
  - Fix: install Nix and restart your terminal, then run `direnv allow .`.
- `.envrc is blocked`
  - Fix: run `direnv allow .` in repo root.
- Need to bypass direnv temporarily
  - Use `nix develop` manually.

## Common commands

- Start client + server: `./start.sh`
- Client only: `cd apps/client && bun dev`
- Server only: `cd apps/server && bun dev`
- Desktop app: `cd apps/desktop && bun dev`
- Repo checks: `bun run magic`

## Commit hygiene

- Keep changes scoped to the task.
- Do not commit unrelated formatting or lockfile changes unless required.
- If you change behavior, add or update tests in the touched package when feasible.

## API compatibility (server + desktop)

- Treat shipped desktop clients as potentially behind the latest server/API version.
- Default policy: API changes must be backward compatible.
- Prefer additive changes:
  - add new fields/endpoints/events instead of changing or removing existing ones.
  - keep existing request/response shapes stable.
- When a breaking change is unavoidable:
  - gate it behind explicit versioning (for example a new route/versioned contract).
  - keep old behavior available during a deprecation window.
  - document the migration path in the same PR.
- For protocol/schema changes, ensure old desktop clients fail gracefully (clear error or fallback) instead of crashing.
- Do not remove deprecated API surface until the current desktop release channel has had time to update.
