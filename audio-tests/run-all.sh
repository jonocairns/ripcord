#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Run every WAV under audio-tests through voice-filter-file-test in parallel.

Usage:
  ./audio-tests/run-all.sh [--jobs N] [--input-root DIR] [--out-dir DIR] [--] [extra voice-filter-file-test args...]

Defaults:
  input root: ./audio-tests
  output dir: ./audio-tests/.outputs
  jobs:       logical CPU count (fallback: 4)

Default voice-filter-file-test args:
  --noise-suppression
  --suppression-level high
  --experimental-aggressive-mode
  --dereverb-mode off
  --debug-diag

Any args after '--' are forwarded to every voice-filter-file-test invocation.
EOF
}

detect_jobs() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
    return
  fi

  if command -v getconf >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN
    return
  fi

  printf '4\n'
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)

jobs="${JOBS:-$(detect_jobs)}"
input_root="$repo_root/audio-tests"
out_dir="$input_root/.outputs"
extra_args=()

while (($#)); do
  case "$1" in
    --jobs)
      if (($# < 2)); then
        echo "missing value for --jobs" >&2
        exit 1
      fi
      jobs="$2"
      shift 2
      ;;
    --input-root)
      if (($# < 2)); then
        echo "missing value for --input-root" >&2
        exit 1
      fi
      input_root="$2"
      shift 2
      ;;
    --out-dir)
      if (($# < 2)); then
        echo "missing value for --out-dir" >&2
        exit 1
      fi
      out_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      extra_args=("$@")
      break
      ;;
    *)
      extra_args+=("$1")
      shift
      ;;
  esac
done

if [[ "$input_root" != /* ]]; then
  input_root="$repo_root/$input_root"
fi

if [[ "$out_dir" != /* ]]; then
  out_dir="$repo_root/$out_dir"
fi

if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "--jobs must be a positive integer" >&2
  exit 1
fi

if [[ ! -d "$input_root" ]]; then
  echo "input root not found: $input_root" >&2
  exit 1
fi

mapfile -d '' files < <(find "$input_root" -type f -name '*.wav' ! -path "$out_dir/*" -print0 | sort -z)

if ((${#files[@]} == 0)); then
  echo "no .wav files found under $input_root" >&2
  exit 1
fi

mkdir -p "$out_dir"

manifest_path="$repo_root/apps/desktop/sidecar/Cargo.toml"
binary="$repo_root/apps/desktop/sidecar/target/debug/voice-filter-file-test"
default_args=(
  --noise-suppression
  --suppression-level high
  --experimental-aggressive-mode
  --dereverb-mode off
  --debug-diag
)

echo "Building voice-filter-file-test..."
cargo build --manifest-path "$manifest_path" --bin voice-filter-file-test

process_one() {
  local input="$1"
  local rel_path="${input#$input_root/}"
  local stem="${rel_path%.wav}"
  local output="$out_dir/${stem}.filtered.wav"
  local log_file="$out_dir/${stem}.log"

  mkdir -p "$(dirname "$output")"

  if "$binary" \
    --input "$input" \
    --output "$output" \
    "${default_args[@]}" \
    "${extra_args[@]}" \
    >"$log_file" 2>&1; then
    printf '[ok]   %s -> %s\n' "$rel_path" "${output#$repo_root/}"
  else
    printf '[fail] %s (see %s)\n' "$rel_path" "${log_file#$repo_root/}" >&2
    return 1
  fi
}

echo "Running ${#files[@]} audio tests with $jobs concurrent job(s)..."

failures=0

for file in "${files[@]}"; do
  process_one "$file" &

  while (( $(jobs -pr | wc -l) >= jobs )); do
    if ! wait -n; then
      failures=1
    fi
  done
done

while [[ -n "$(jobs -pr)" ]]; do
  if ! wait -n; then
    failures=1
  fi
done

echo "Filtered files: ${out_dir#$repo_root/}"

if ((failures != 0)); then
  echo "One or more runs failed. Check the .log files in ${out_dir#$repo_root/}." >&2
  exit 1
fi

echo "All runs completed."
