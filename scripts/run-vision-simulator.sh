#!/usr/bin/env bash
set -euo pipefail

VISION_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$VISION_SCRIPT_DIR/lib/vision_simulator.py" "$@"
