#!/usr/bin/env bash
set -euo pipefail
VISION_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$VISION_SCRIPT_DIR/lib/build_apple.sh"
build_apple vision "$@"
