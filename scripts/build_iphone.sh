#!/usr/bin/env bash
set -euo pipefail
IPHONE_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$IPHONE_SCRIPT_DIR/lib/build_apple.sh"
build_apple iphone "$@"
