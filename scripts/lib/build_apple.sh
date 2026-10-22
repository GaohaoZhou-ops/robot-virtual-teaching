#!/usr/bin/env bash

# Shared implementation for the public native build entry points.
build_apple() {
  local target="$1"; shift
  local repo configuration=Release flavor=device scheme platform sdk output log app status=0 project_target="$target"
  repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --simulator) flavor=simulator; shift ;;
      --device) flavor=device; shift ;;
      --configuration)
        if [[ $# -lt 2 || ( "$2" != Debug && "$2" != Release ) ]]; then
          echo '--configuration 必须指定 Debug 或 Release。' >&2
          return 2
        fi
        configuration="$2"; shift 2 ;;
      -h|--help)
        cat <<HELP
用法: ./scripts/build_${target}.sh [--device|--simulator] [--configuration Debug|Release]

默认构建真机架构的未签名 Release .app，无需连接设备或配置开发团队。
--simulator                 改为构建模拟器应用，不启动或安装到模拟器。
--configuration Debug       改为 Debug 构建。
产物：${target}/build/<device|simulator>/Build/Products/<配置>-<SDK>/
日志：${target}/build/<device|simulator>/build.log
真机安装仍需在 Xcode 中选择开发团队并签名；此脚本不导出 IPA。
HELP
        return 0 ;;
      *) printf '未知参数: %s（使用 --help 查看用法）\n' "$1" >&2; return 2 ;;
    esac
  done
  case "$target" in
    vision) scheme=AtlasVisionTeaching; platform=visionOS; sdk=xros ;;
    ipad|iphone) scheme=AtlasTeaching; platform=iOS; sdk=iphoneos; project_target=ipad ;;
    *) echo "未知构建目标：$target" >&2; return 2 ;;
  esac
  if [[ "$flavor" == simulator ]]; then
    platform="$platform Simulator"
    if [[ "$target" == vision ]]; then sdk=xrsimulator; else sdk=iphonesimulator; fi
  fi
  if ! command -v xcodebuild >/dev/null 2>&1 || ! xcodebuild -version >/dev/null 2>&1; then
    echo '请安装并选择完整 Xcode（只有 Command Line Tools 无法构建原生应用）。' >&2
    return 1
  fi
  if ! xcrun --sdk "$sdk" --show-sdk-path >/dev/null 2>&1; then
    echo "当前 Xcode 缺少 $sdk SDK，请在 Xcode Settings → Components 中安装。" >&2
    return 1
  fi
  output="$repo/$target/build/$flavor"
  log="$output/build.log"
  app="$output/Build/Products/$configuration-$sdk/$scheme.app"
  mkdir -p "$output"
  printf '编译 %s（%s / %s）…\n日志：%s\n' "$scheme" "$platform" "$configuration" "$log"
  xcodebuild -project "$repo/$project_target/$scheme.xcodeproj" -scheme "$scheme" \
    -sdk "$sdk" -destination "generic/platform=$platform" -configuration "$configuration" \
    -derivedDataPath "$output" CODE_SIGNING_ALLOWED=NO build > "$log" 2>&1 || status=$?
  if [[ "$status" != 0 ]]; then
    tail -n 60 "$log" >&2
    echo "构建失败，完整日志：$log" >&2
    return "$status"
  fi
  # actool can emit fatal asset errors while incorrectly returning status 0.
  if LC_ALL=C grep -Eq 'Command .* emitted errors but did not return a nonzero exit code' "$log" \
      || [[ ! -f "$app/Info.plist" || ! -f "$app/$scheme" ]]; then
    tail -n 60 "$log" >&2
    echo "构建产物或资源检查失败，完整日志：$log" >&2
    return 1
  fi
  printf '构建完成：%s\n日志：%s\n' "$app" "$log"
  if [[ "$flavor" == device ]]; then
    echo '此 .app 未签名；安装真机时请在 Xcode 中选择开发团队和设备后运行。'
  fi
}
