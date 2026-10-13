#!/usr/bin/env bash
set -euo pipefail

LOCAL_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOCAL_INSTALL=0
for argument in "$@"; do
  case "$argument" in
    --install) LOCAL_INSTALL=1 ;;
    -h|--help)
      cat <<'HELP'
用法: ./scripts/build_local.sh [--install]

编译电脑端 Web 应用，产物在 dist/，日志在 build/local/build.log。
缺少依赖时自动执行 npm ci；--install 强制按 package-lock.json 重装依赖。
编译完成后可运行 npm run preview 查看产物，默认端口为 21990。
HELP
      exit 0 ;;
    *) printf '未知参数: %s（使用 --help 查看用法）\n' "$argument" >&2; exit 2 ;;
  esac
done
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo '请先安装 Node.js 和 npm。' >&2
  exit 1
fi
cd "$LOCAL_REPO"
mkdir -p build/local
LOCAL_LOG="$LOCAL_REPO/build/local/build.log"
: > "$LOCAL_LOG"
if [[ "$LOCAL_INSTALL" == 1 || ! -x node_modules/.bin/vite ]]; then
  echo '按锁文件安装依赖…'
  npm ci 2>&1 | tee -a "$LOCAL_LOG"
fi
echo '编译电脑端 Web 应用…'
npm run build 2>&1 | tee -a "$LOCAL_LOG"
if [[ ! -f dist/index.html ]]; then
  echo "构建未生成 dist/index.html，请检查日志：$LOCAL_LOG" >&2
  exit 1
fi
printf '构建完成：%s/dist/\n日志：%s\n预览：在工程目录运行 npm run preview\n' "$LOCAL_REPO" "$LOCAL_LOG"
