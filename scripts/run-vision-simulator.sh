#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/run-vision-simulator.sh [start|stop|status] [--rebuild]
# No action defaults to start; --rebuild is only valid for start.
VISION_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$VISION_SCRIPT_DIR/lib/vision_simulator.py" "$@"
