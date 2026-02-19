#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but not found in PATH."
  exit 1
fi

if [ ! -d "$ROOT_DIR/apps/desktop/node_modules" ]; then
  echo "Dependencies are missing. Run: bun install"
  exit 1
fi

echo "Preparing optional Rust capture sidecar..."
(cd "$ROOT_DIR/apps/desktop" && bun run build:sidecar:optional) || true

SERVER_CMD='bun run dev'
CLIENT_CMD='bun run dev'
DESKTOP_MAIN_CMD='bun run dev:main'
DESKTOP_ELECTRON_CMD='bun run dev:electron'

if command -v tmux >/dev/null 2>&1; then
  tmux new-session "cd \"$ROOT_DIR/apps/server\" && $SERVER_CMD" \
    \; split-window -h "cd \"$ROOT_DIR/apps/client\" && $CLIENT_CMD" \
    \; split-window -v "cd \"$ROOT_DIR/apps/desktop\" && $DESKTOP_MAIN_CMD" \
    \; split-window -v "cd \"$ROOT_DIR/apps/desktop\" && $DESKTOP_ELECTRON_CMD" \
    \; select-layout tiled \
    \; select-pane -t 1
  exit 0
fi

echo "tmux not found; starting server, client, and Electron in this terminal."

(cd "$ROOT_DIR/apps/server" && $SERVER_CMD) &
server_pid=$!

(cd "$ROOT_DIR/apps/client" && $CLIENT_CMD) &
client_pid=$!

(cd "$ROOT_DIR/apps/desktop" && $DESKTOP_MAIN_CMD) &
desktop_main_pid=$!

cleanup() {
  for pid in "$desktop_main_pid" "$client_pid" "$server_pid"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR/apps/desktop"
$DESKTOP_ELECTRON_CMD
