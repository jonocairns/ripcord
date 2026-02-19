#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/apps/server"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

resolve_default_owner() {
  local remote
  remote="$(git -C "$ROOT_DIR" config --get remote.origin.url || true)"

  if [[ "$remote" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

resolve_image_version() {
  local version
  version="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)"

  if [ -z "$version" ]; then
    echo "Unable to read version from $ROOT_DIR/package.json"
    exit 1
  fi

  echo "$version"
}

require_cmd docker

DEFAULT_OWNER="$(resolve_default_owner || true)"
GHCR_OWNER="${GHCR_OWNER:-$DEFAULT_OWNER}"
IMAGE_NAME="${IMAGE_NAME:-sharkord}"
IMAGE_VERSION="${IMAGE_VERSION:-$(resolve_image_version)}"
DOCKER_PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"
BUILDX_BUILDER="${BUILDX_BUILDER:-sharkord-builder}"
SKIP_BUILD="${SKIP_BUILD:-1}"
SKIP_PUSH="${SKIP_PUSH:-0}"

if [ -z "$GHCR_OWNER" ]; then
  echo "Unable to determine GitHub owner."
  echo "Set GHCR_OWNER, for example: GHCR_OWNER=sharkord ./docker.sh"
  exit 1
fi

GHCR_OWNER="$(echo "$GHCR_OWNER" | tr '[:upper:]' '[:lower:]')"
IMAGE="ghcr.io/$GHCR_OWNER/$IMAGE_NAME"

if [ "$SKIP_BUILD" != "1" ]; then
  require_cmd bun
  echo "Building Sharkord binaries..."
  (cd "$SERVER_DIR" && bun run build)
fi

GHCR_USERNAME="${GHCR_USERNAME:-${GITHUB_USERNAME:-}}"

if [ -z "${GHCR_PAT:-}" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "GHCR_PAT is not set and gh CLI is not installed."
    echo "Install gh and run: gh auth login"
    echo "Or set GHCR_PAT and GHCR_USERNAME explicitly."
    exit 1
  fi

  if ! gh auth status -h github.com >/dev/null 2>&1; then
    echo "GHCR_PAT is not set and gh is not authenticated."
    echo "Run: gh auth login"
    echo "If needed, refresh scopes: gh auth refresh -h github.com -s write:packages,read:packages"
    exit 1
  fi

  if [ -z "$GHCR_USERNAME" ]; then
    GHCR_USERNAME="$(gh api user -q .login 2>/dev/null || true)"
  fi

  GHCR_PAT="$(gh auth token)"
fi

if [ -z "$GHCR_USERNAME" ]; then
  echo "GHCR_USERNAME could not be determined."
  echo "Set GHCR_USERNAME to your GitHub username."
  exit 1
fi

echo "Logging in to ghcr.io as $GHCR_USERNAME..."
echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin

if ! docker buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1; then
  echo "Creating buildx builder: $BUILDX_BUILDER"
  docker buildx create --name "$BUILDX_BUILDER" --use >/dev/null
else
  docker buildx use "$BUILDX_BUILDER" >/dev/null
fi

echo "Building image: $IMAGE"
BUILD_CMD=(
  docker buildx build
  --platform "$DOCKER_PLATFORMS"
  -t "$IMAGE:latest"
  -t "$IMAGE:v$IMAGE_VERSION"
  "$ROOT_DIR"
)

if [ "$SKIP_PUSH" = "1" ]; then
  BUILD_CMD+=(--load)
else
  BUILD_CMD+=(--push)
fi

"${BUILD_CMD[@]}"

echo "Done."
echo "Image tags:"
echo "  $IMAGE:latest"
echo "  $IMAGE:v$IMAGE_VERSION"
