#!/usr/bin/env bash
set -euo pipefail

# Double-click in Finder, or run from any working directory in Terminal.
# Reuse the singleton launcher; pass --rebuild to apply application changes.
VISION_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$VISION_SCRIPT_DIR/run-vision-simulator.sh" "$@"
