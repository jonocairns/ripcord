#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

bash "$script_dir/run-all.sh"
python3 "$script_dir/analyze.py" --assert-baseline --baseline "$script_dir/baseline.json"
