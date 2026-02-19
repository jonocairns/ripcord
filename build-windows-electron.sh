#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
CLIENT_DIR="$ROOT_DIR/apps/client"
RUST_TARGET="x86_64-pc-windows-gnu"
SIDECAR_BINARY="sharkord-capture-sidecar.exe"
SIDECAR_SOURCE="$DESKTOP_DIR/sidecar/target/$RUST_TARGET/release/$SIDECAR_BINARY"
SIDECAR_TARGET_DIR="$DESKTOP_DIR/sidecar/bin/win32"
SIDECAR_TARGET="$SIDECAR_TARGET_DIR/$SIDECAR_BINARY"
WINDOWS_BUILD_DIR="$DESKTOP_DIR/build/out/win-unpacked"
DESKTOP_OUTPUT_DIR="$HOME/Desktop/sharkord-win-unpacked"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

require_cmd bun
require_cmd cargo
require_cmd rustup

resolve_desktop_dir() {
  if [ -n "${SHARKORD_DESKTOP_DIR:-}" ] && [ -d "${SHARKORD_DESKTOP_DIR}" ]; then
    echo "${SHARKORD_DESKTOP_DIR}"
    return 0
  fi

  local candidates=("$HOME/Desktop")

  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    if command -v cmd.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
      local windows_userprofile=""
      local wsl_userprofile=""
      windows_userprofile="$(cmd.exe /C "echo %USERPROFILE%" 2>/dev/null | tr -d '\r' | tail -n 1)"
      if [ -n "$windows_userprofile" ]; then
        wsl_userprofile="$(wslpath -u "$windows_userprofile" 2>/dev/null || true)"
        if [ -n "$wsl_userprofile" ]; then
          candidates+=("$wsl_userprofile/Desktop")
        fi
      fi
    fi

    candidates+=("/mnt/c/Users/$USER/Desktop")
  fi

  for candidate in "${candidates[@]}"; do
    if [ -d "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

if [ ! -d "$DESKTOP_DIR/node_modules" ] || [ ! -d "$CLIENT_DIR/node_modules" ]; then
  echo "Dependencies are missing. Run: bun install"
  exit 1
fi

if ! rustup target list --installed | grep -qx "$RUST_TARGET"; then
  echo "Installing Rust target: $RUST_TARGET"
  rustup target add "$RUST_TARGET"
fi

echo "Building client renderer..."
(cd "$CLIENT_DIR" && bun run build)

echo "Preparing desktop renderer assets..."
(cd "$DESKTOP_DIR" && bun run prepare:renderer)

echo "Building Windows sidecar ($RUST_TARGET)..."
(cd "$DESKTOP_DIR" && cargo build --manifest-path sidecar/Cargo.toml --release --target "$RUST_TARGET")

if [ ! -f "$SIDECAR_SOURCE" ]; then
  echo "Expected sidecar output not found: $SIDECAR_SOURCE"
  exit 1
fi

mkdir -p "$SIDECAR_TARGET_DIR"
cp "$SIDECAR_SOURCE" "$SIDECAR_TARGET"
echo "Sidecar copied to: $SIDECAR_TARGET"

echo "Building Electron main/preload bundle..."
(cd "$DESKTOP_DIR" && bun run build:main)

echo "Packaging Windows desktop app (dir target)..."
(cd "$DESKTOP_DIR" && bunx electron-builder --win --x64 --dir)

if [ ! -d "$WINDOWS_BUILD_DIR" ]; then
  echo "Expected packaged output not found: $WINDOWS_BUILD_DIR"
  exit 1
fi

desktop_parent_dir="$(resolve_desktop_dir || true)"
if [ -n "$desktop_parent_dir" ]; then
  DESKTOP_OUTPUT_DIR="$desktop_parent_dir/sharkord-win-unpacked"
  echo "Copying packaged app to Desktop..."
  rm -rf "$DESKTOP_OUTPUT_DIR"
  cp -a "$WINDOWS_BUILD_DIR" "$DESKTOP_OUTPUT_DIR"
else
  echo "Warning: desktop directory not found. Skipping desktop copy."
  echo "Tip: set SHARKORD_DESKTOP_DIR to your preferred destination parent directory."
fi

echo "Windows build complete."
echo "Output: $WINDOWS_BUILD_DIR"
if [ -n "${desktop_parent_dir:-}" ]; then
  echo "Desktop copy: $DESKTOP_OUTPUT_DIR"
fi
