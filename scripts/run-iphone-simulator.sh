#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/run-iphone-simulator.sh [start|stop|status] [--rebuild]
# No action defaults to start; --rebuild is only valid for start.
IPHONE_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$IPHONE_SCRIPT_DIR/lib/iphone_simulator.py" "$@"
