#!/usr/bin/env bash
set -euo pipefail

IPAD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3；请先安装完整 Xcode 并完成首次启动配置。' >&2
  exit 1
fi
exec python3 "$IPAD_SCRIPT_DIR/lib/deploy_ipad.py" "$@"
