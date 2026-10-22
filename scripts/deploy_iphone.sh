#!/usr/bin/env bash
set -euo pipefail
IPHONE_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$IPHONE_SCRIPT_DIR/lib/deploy_ipad.py" --device-family iPhone "$@"
