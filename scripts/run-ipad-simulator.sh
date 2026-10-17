#!/usr/bin/env bash
set -euo pipefail

IPAD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$IPAD_SCRIPT_DIR/lib/ipad_simulator.py" "$@"
