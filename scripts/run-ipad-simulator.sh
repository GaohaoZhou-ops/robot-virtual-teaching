#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/run-ipad-simulator.sh [start|stop|status] [--rebuild]
# No action defaults to start; --rebuild is only valid for start.
IPAD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$IPAD_SCRIPT_DIR/lib/ipad_simulator.py" "$@"
