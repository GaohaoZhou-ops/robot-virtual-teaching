# 本地构建与 iPad / iPhone 部署

[文档目录](README.md) · [项目首页](../README.md)

文中的命令均从仓库根目录执行。Vision Pro 的设备配对、签名与模拟器操作见[专用开发指南](../vision/docs/development.md)。

[本地编译](#本地编译) · [模拟器启动、停止与状态](#模拟器启动停止与状态) · [iPad 真机签名与重新部署](#ipad-真机签名与重新部署) · [iPhone 版（与 iPad 共用原生应用）](#iphone-版与-ipad-共用原生应用) · [编译与安装](#编译与安装)

## 本地编译

四个入口均按脚本自身位置定位工程，可从其他工作目录调用；构建结束会打印产物与日志的绝对路径。

| 目标 | 命令 | 默认产物 |
| --- | --- | --- |
| 电脑端 Web | `./scripts/build_local.sh` | `dist/` |
| Vision Pro | `./scripts/build_vision.sh` | `vision/build/device/Build/Products/Release-xros/AtlasVisionTeaching.app` |
| iPad Pro | `./scripts/build_ipad.sh` | `ipad/build/device/Build/Products/Release-iphoneos/AtlasTeaching.app` |
| iPhone Pro | `./scripts/build_iphone.sh` | `iphone/build/device/Build/Products/Release-iphoneos/AtlasTeaching.app` |

电脑端需要 Node.js 和 npm；缺少 Vite 依赖时自动执行 `npm ci`，也可用 `--install` 强制按锁文件重装。日志位于 `build/local/build.log`，运行 `npm run preview` 可访问构建后的电脑端（默认端口 21990，需与开发服务错开使用）。

原生端需要 macOS、完整 Xcode 和对应 SDK，默认构建 **Release、真机架构、未签名** 的 `.app`，不连接或安装到设备。安装真机时在 Xcode 中选择开发团队并签名。三个脚本均支持：

```bash
./scripts/build_vision.sh --simulator --configuration Debug
./scripts/build_ipad.sh --simulator --configuration Debug
./scripts/build_iphone.sh --simulator --configuration Debug
```

模拟器产物位于各自的 `build/simulator/Build/Products/Debug-xrsimulator/` 或 `Debug-iphonesimulator/`，日志位于 `<vision|ipad|iphone>/build/<device|simulator>/build.log`。可用 `--help` 查看参数；这些构建目录均在清理脚本范围内。

## 模拟器启动、停止与状态

每类设备使用一个控制脚本，传入 `start`、`stop` 或 `status`：

| 设备 | 启动 | 停止 | 查询状态 |
| --- | --- | --- | --- |
| iPhone | `./scripts/run-iphone-simulator.sh start` | `./scripts/run-iphone-simulator.sh stop` | `./scripts/run-iphone-simulator.sh status` |
| iPad Pro | `./scripts/run-ipad-simulator.sh start` | `./scripts/run-ipad-simulator.sh stop` | `./scripts/run-ipad-simulator.sh status` |
| Vision Pro | `./scripts/run-vision-simulator.sh start` | `./scripts/run-vision-simulator.sh stop` | `./scripts/run-vision-simulator.sh status` |

- `start` 复用已启动的设备和已安装的应用，首次自动编译安装。修改代码后运行 `start --rebuild`，重新编译、安装并重启应用。
- `stop` 关闭选中的模拟器及其中的应用，保留已安装应用和设备数据；重复停止也成功。不退出共享的 Simulator 程序，不影响其他模拟器或电脑端服务。
- `status` 显示设备名称、UDID、模拟器状态及应用进程状态，不启动设备、不编译、不打开应用。返回码 `0` 表示设备和应用均运行，`3` 表示未运行或尚未就绪，`1` 表示设备选择或查询失败。

无参数仍等同于 `start`，单独传入 `--rebuild` 也兼容。`--rebuild` 只用于启动，参数错误返回 `2`。从其他工作目录调用时使用脚本的绝对路径。

默认优先选择该类型中正在运行的设备，否则选择最高系统版本。可用 `IPHONE_SIMULATOR_ID`、`IPAD_SIMULATOR_ID` 或 `VISION_SIMULATOR_ID` 指定 UDID。多台同类设备运行时，`stop` / `status` 要求明确指定设备；启动仍沿用原有单例规则，切换前先停止当前设备：

```bash
IPHONE_SIMULATOR_ID=<UDID> ./scripts/run-iphone-simulator.sh status
IPHONE_SIMULATOR_ID=<UDID> ./scripts/run-iphone-simulator.sh stop
./scripts/run-iphone-simulator.sh start --rebuild
```

同类设备的启动和停止共用控制锁；任务执行期间再次启动会提示并跳过，再次停止返回 `4`，可稍后重试。状态查询随时可用。无可用模拟器时，`stop` 返回 `0`、`status` 返回 `3`；显式指定无效 UDID 时返回 `1`。

控制脚本回归：`node tests/apple_simulator_control_smoke.mjs`，使用模拟 Apple 命令验证三类设备的启动、停止、状态查询、设备隔离及并发操作，不启动真实模拟器。

## iPad 真机签名与重新部署

用数据线连接 iPad 并解锁，在工程目录执行：

```bash
./scripts/deploy_ipad.sh
```

脚本自动识别唯一有线 iPad 和本机签名团队，通过 Xcode 自动签名更新描述文件，构建 Release 版本，覆盖安装并验证 App 启动。沿用 `com.atlasroute.teaching`，保留原有模型和示教记录。首次使用需在 Xcode Settings → Accounts 登录 Apple 账号，并在 iPad 上信任电脑、开启开发者模式；签名更新需要 Mac 联网。账号登录失效或设备未就绪时，脚本会停止并提示处理方式。

连接多台 iPad 或需要切换开发团队时，可明确指定：

```bash
./scripts/deploy_ipad.sh --device <iPad的UDID> --team <10位TeamID>
./scripts/deploy_ipad.sh --help
```

也可设置 `IPAD_DEVICE_ID`、`IPAD_DEVELOPMENT_TEAM`；命令行参数优先。脚本可从任意工作目录调用，默认复用 `ipad/build/deploy-device/DerivedData/` 加快构建，每次日志单独保存在同目录的 `run-*` 子目录。支持 `--configuration Debug`。

安装前会校验签名、目标设备和描述文件有效期，并打印实际到期时间。免费个人团队描述文件仍受 Apple 的 **7 天**限制；Xcode 可能复用尚未过期的描述文件，执行脚本不保证从当天重新获得完整 7 天。到期后再次连接并运行即可由 Xcode 申请更新；脚本不会删除证书或手工修改描述文件日期。

## iPhone 版（与 iPad 共用原生应用）

支持配备 LiDAR、运行 **iOS 17 或以上**的 iPhone Pro，包括 iPhone 15 Pro Max。iPhone 与 iPad 共用 `ipad/AtlasTeaching.xcodeproj` 和 `com.atlasroute.teaching`；`./scripts/build_iphone.sh` 和 `./scripts/build_ipad.sh` 构建同一款通用应用，分别输出到 `iphone/build/` 与 `ipad/build/`。扫码、Wi-Fi、USB 接收、1:1 AR 放置、记录和编辑 Pose、M70 取景与覆盖、完成同步及 AirDrop 导出沿用同一流程。

调试模拟器时，在仓库根目录运行：

```bash
./scripts/run-iphone-simulator.sh start
# 修改代码后重新编译、安装并重启应用
./scripts/run-iphone-simulator.sh start --rebuild
# 仅编译模拟器版本
./scripts/build_iphone.sh --simulator --configuration Debug
```

启动脚本只选择 iPhone，优先复用已启动的设备，否则选择已安装的最高系统版本；首次自动编译安装，后续默认复用现有应用。可用 `IPHONE_SIMULATOR_ID=<UDID>` 指定设备、`IPHONE_ARTIFACTS=<目录>` 指定产物目录，默认 `iphone/test-artifacts/simulator-dev/`，相对路径以仓库根目录为基准。需要完整 Xcode、iOS Simulator 运行时、Python 3 和已创建的 iPhone 模拟器。iPhone、iPad 与 Vision Pro 分别管理启动锁，可同时调试；同一类型有多台模拟器运行时，会提示先关闭多余设备。启动脚本回归：`node tests/ipad_simulator_launcher_smoke.mjs iphone`。

连接并解锁 iPhone，在「设置 → 隐私与安全性 → 开发者模式」开启开发者模式，重启确认后执行：

```bash
./scripts/deploy_iphone.sh
# 多台 iPhone 时指定目标；同时连接 iPad 不会影响自动选择。
./scripts/deploy_iphone.sh --device <iPhone的UDID> --team <10位TeamID>
```

支持 `IPHONE_DEVICE_ID`、`IPHONE_DEVELOPMENT_TEAM`。原来的 `deploy_ipad.sh` 仍默认只选择 iPad；两种脚本均覆盖安装并保留本机数据。电脑工作台使用 **设备 → iPad / iPhone → 同步与接收**，在 **文件导入 → 需要先把物体传到设备？** 中按设备名称选择接收端。两台设备各自保存本地项目；Wi-Fi 配对码仍绑定单台设备，切换设备时另建传输。

iPhone 保留深色卡片、青色操作按钮及控制分组：首页通过「扫码 / Wi-Fi / 数据线」切换连接方式；竖屏示教面板从底部展开，横屏位于右侧，默认收起以保留取景空间。记录、回看和完成操作在竖屏固定于底部；横屏收起面板时集中到右侧窄操作区，大号圆形记录按钮便于拇指点击，数量与覆盖率一并收纳，底部仅在需要时显示简短提示。Pose 回看保持预览与列表，详情及重命名在可展开的面板内。横竖屏切换和面板收起保留 AR 会话。iPad 沿用原有布局。

旧 iPad 项目、传输协议和 Pose 来源字段保持兼容；新 iPhone 结果记录 `device.platform = "iOS"`，电脑导入后的任务标为 iPhone 示教。模拟器可以验证界面、模型预览和文件流程，AR / LiDAR 定位需在真机验证。原生手机 UI 回归为 `testPhoneLibraryConnectionsAndRotation` 和 `testPhoneTeachingReviewAndCompletion`；后者使用 `node tests/iphone_layout_fixture.mjs <临时目录>` 生成的专用项目，复制到测试设备应用容器的 `Library/Application Support/AtlasTeaching/` 后运行。真机 AR 回归为 `testPhoneLiveLiDARPlacementAndCapture`，使用生成器第三个参数 `UI-iPhone-LiveAR` 创建另一份专用项目；运行时需让镜头朝向明亮、有纹理的表面并缓慢移动。测试项目可用 `testRemoveDisposablePhoneFixtures` 清理，必须通过 `ATLAS_PHONE_CLEANUP_IDS` 明确传入本次生成的项目 UUID（逗号分隔），且只接受名称带 `UI-iPhone-` 的项目。

## 编译与安装

原生工程：[ipad/AtlasTeaching.xcodeproj](../ipad/AtlasTeaching.xcodeproj)。

需要 macOS、Xcode，以及运行 **iPadOS 17 或以上**的 iPad。本机虚拟示教仅支持 **配备 LiDAR 的 iPad Pro**，运行时检测 ARKit scene depth 与 mesh 能力；iPad mini、iPad Air、普通 iPad 及没有 LiDAR 的旧款 iPad Pro 仅支持画面协作，不能接收或打开本机示教模型。模拟器保留模型与已有数据预览，但不能空间示教。

在 Mac 上调试界面时，运行下面的命令。需预先安装完整 Xcode、iOS Simulator 运行时及 Python 3，并在 Xcode 的 Devices and Simulators 中添加 iPad Pro 设备。

```bash
./scripts/run-ipad-simulator.sh start
# 修改代码后重新编译、安装并重启应用
./scripts/run-ipad-simulator.sh start --rebuild
```

脚本只选择 iPad Pro，优先复用已启动的设备，否则选择已安装的最高系统版本；首次未安装「Atlas 示教」时自动编译安装。重复启动会复用现有应用进程，并发启动共用进程锁，失败或退出后自动释放。iPad Pro 与 Vision Pro 各自保持单例；已有多个 iPad Pro 运行时，脚本会提示先关闭多余设备。

脚本也支持 `stop` 和 `status`，可从任意工作目录调用。可通过 `IPAD_SIMULATOR_ID=<UDID>` 指定 iPad Pro（切换前先关闭当前设备），通过 `IPAD_ARTIFACTS=<目录>` 指定产物与日志位置，默认 `ipad/test-artifacts/simulator-dev/`，相对路径以仓库根目录为基准。启动脚本回归：`node tests/ipad_simulator_launcher_smoke.mjs`，使用模拟 Apple 命令验证，不启动真实模拟器。

```bash
# 无需连接设备或签名，先检查真机目标编译
./scripts/build_ipad.sh
# 检查模拟器目标
./scripts/build_ipad.sh --simulator --configuration Debug
# 打开原生工程
open ipad/AtlasTeaching.xcodeproj
```

- 构建产物位于 `ipad/build/device/Build/Products/Release-iphoneos/`，模拟器产物位于 `ipad/build/simulator/Build/Products/Debug-iphonesimulator/`。
- 旧入口 `scripts/build-ipad.sh [device|simulator]` 仍保留，沿用其 Debug 配置和 `ipad/build/Build/Products/` 路径。
- 连接真机后，在 Xcode 的 Signing & Capabilities 选择开发团队与设备，开启 iPad 开发者模式，然后 Run 安装；首次使用允许相机和本地网络访问。
- 无签名编译产物不能直接安装真机。

<details>
<summary>已记录的真机验证范围</summary>

- 已在 11 英寸 iPad Pro（二代）、iPadOS 17.6.1 上完成开发签名安装与真机测试：局域网接收测试物体、重启应用后从本机重新打开、相机画面与 LiDAR 深度启动、未校准时禁止记录 Pose。
- 实际物体的现场校准、逐 Pose 采集、移动时定位稳定性、双指手势与断网实操仍需现场验收。
- 原生 UI 测试中的 `testHardwareLANAndLiDAR` 使用 `ATLAS_HARDWARE_ADDRESS`、`ATLAS_HARDWARE_CODE`、`ATLAS_HARDWARE_MODEL` 环境变量指定已准备的局域网测试物体；未指定时跳过该真机测试。

</details>

---

[文档目录](README.md) · [项目首页](../README.md)
