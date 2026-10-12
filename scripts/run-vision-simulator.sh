#!/usr/bin/env bash
set -euo pipefail

VISION_REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  "") ;;
  -h|--help)
    echo "Usage: ./scripts/run-vision-simulator.sh"
    echo "Optional: VISION_SIMULATOR_ID=<UDID> VISION_ARTIFACTS=<directory>"
    exit 0 ;;
  *) echo "Usage: ./scripts/run-vision-simulator.sh" >&2; exit 2 ;;
esac
cd "$VISION_REPO"
VISION_ARTIFACTS="${VISION_ARTIFACTS:-$VISION_REPO/vision/test-artifacts/simulator-dev}"

if [[ -z "${VISION_SIMULATOR_ID:-}" ]]; then
  VISION_SIMULATOR_ID="$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
devices = json.load(sys.stdin)["devices"]
candidates = []
for runtime, entries in devices.items():
    version = re.search(r"(?:xrOS|visionOS)-(\d+(?:-\d+)*)$", runtime)
    if not version:
        continue
    for device in entries:
        if device.get("isAvailable"):
            candidates.append((tuple(map(int, version[1].split("-"))), device.get("state") == "Booted", device["udid"]))
print(max(candidates)[2] if candidates else "")
')"
fi
if [[ -z "$VISION_SIMULATOR_ID" ]]; then
  echo "请先在 Xcode Settings → Components 中安装 visionOS Simulator。" >&2
  exit 1
fi

mkdir -p "$VISION_ARTIFACTS"
VISION_BUILD_LOG="$VISION_ARTIFACTS/build.log"
VISION_APP="$VISION_ARTIFACTS/DerivedData/Build/Products/Debug-xrsimulator/AtlasVisionTeaching.app"

echo "启动 visionOS 模拟器…"
xcrun simctl bootstatus "$VISION_SIMULATOR_ID" -b
open -a "$(xcode-select -p)/Applications/Simulator.app" --args -CurrentDeviceUDID "$VISION_SIMULATOR_ID"

echo "编译 Atlas 空间示教…"
if ! xcodebuild -project vision/AtlasVisionTeaching.xcodeproj -scheme AtlasVisionTeaching \
  -configuration Debug -destination "platform=visionOS Simulator,id=$VISION_SIMULATOR_ID" \
  -derivedDataPath "$VISION_ARTIFACTS/DerivedData" CODE_SIGNING_ALLOWED=NO build > "$VISION_BUILD_LOG" 2>&1; then
  tail -n 60 "$VISION_BUILD_LOG"
  echo "编译失败，日志：$VISION_BUILD_LOG" >&2
  exit 1
fi
if rg -q 'Command .* emitted errors but did not return a nonzero exit code' "$VISION_BUILD_LOG"; then
  tail -n 60 "$VISION_BUILD_LOG"
  echo "编译日志包含资源错误：$VISION_BUILD_LOG" >&2
  exit 1
fi

xcrun simctl install "$VISION_SIMULATOR_ID" "$VISION_APP"
xcrun simctl launch --terminate-running-process "$VISION_SIMULATOR_ID" com.atlasroute.teaching.vision
echo "已启动。在应用中点击「打开本地演练」开始调试。"
echo "演练流程：进入空间示教 → 放到前方 → 确认校准 → 记录 Pose。"
echo "点击「模拟向右移动 20 cm」后可继续记录；演练结果仅保存在模拟器中。"
echo "编译日志：$VISION_BUILD_LOG"
