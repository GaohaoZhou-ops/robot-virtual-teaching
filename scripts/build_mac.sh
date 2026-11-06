#!/usr/bin/env bash
set -euo pipefail

ATLAS_MAC_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo '打包电脑需要 Node.js 22.12 或更新版本；收件人的 Mac 不需要安装 Node.js。' >&2
  exit 1
fi
exec node "$ATLAS_MAC_ROOT/scripts/lib/build_macos.mjs" "$@"
