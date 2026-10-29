# Vision Pro 开发、模拟器与真机

[Vision Pro 首页](../README.md) · [全项目文档](../../docs/README.md)

文中的命令均从仓库根目录执行。最低 visionOS 2.0；原生双手操控使用 visionOS 26 的 ManipulationComponent，M5 联调使用 visionOS 26 或更新版本。iPad / iPhone 的现场采集与逐 Pose 示教流程保持独立。

[在 Mac 上用模拟器调试](#在-mac-上用模拟器调试) · [真机接入](#真机接入) · [构建与验证](#构建与验证) · [构建与工作台验证](#构建与工作台验证)

## 在 Mac 上用模拟器调试

日常 UI 和功能迭代先在 Mac 的 visionOS 模拟器中完成，之后再集中进行真机验证。在仓库根目录执行以下命令，启动模拟器与「Atlas 空间示教」：

```bash
./scripts/run-vision-simulator.sh start
```

脚本优先复用已启动的 visionOS 设备；没有运行中的设备时，选择已安装的最高版本。已安装应用时直接打开，正在运行的应用会保留进程和当前状态；首次未安装应用时才自动编译安装。同一 Mac 用户在不同终端及仓库副本中运行脚本时共用进程锁，并发调用不会重复启动或编译，启动失败或退出后锁会自动释放。

**修改代码后，使用 `--rebuild` 重新编译、安装并重启应用：**

```bash
./scripts/run-vision-simulator.sh start --rebuild
```

终端入口 `./scripts/run-vision-simulator.sh` 支持 `start`、`stop`、`status`，无参数默认为 `start`：

```bash
./scripts/run-vision-simulator.sh start          # 启动模拟器与应用
./scripts/run-vision-simulator.sh status         # 查询设备与应用进程状态
./scripts/run-vision-simulator.sh stop           # 关闭选中的模拟器及应用，保留数据
./scripts/run-vision-simulator.sh start --rebuild # 更新代码后重新编译
```

脚本可从任意工作目录调用，支持 `VISION_SIMULATOR_ID=<UDID>` 指定设备、`VISION_ARTIFACTS=<目录>` 指定编译产物和日志位置（相对路径以仓库根目录为基准，默认 `vision/test-artifacts/simulator-dev/`）。切换设备前先停止当前 visionOS 设备；如果已有多个 visionOS 设备运行，`stop` / `status` 可用上述环境变量指定要操作的设备，`start` 仍要求先关闭多余设备。需要安装完整 Xcode、visionOS Simulator 运行时及 Python 3。状态返回码与并发规则见[模拟器控制说明](../../docs/development.md#模拟器启动停止与状态)。

本机调试时，若电脑服务已启动但模拟器收不到 Node 的服务广播，可在 Mac 终端执行 `dns-sd -R "Atlas Simulator Discovery" _atlas-teach._tcp local. 21990`，通过系统 Bonjour 发布现有服务；端口需与电脑服务一致。保持该命令运行，结束调试后按 `Ctrl+C` 撤销广播。应用仍会验证实际 HTTP 服务，再自动填入解析到的 IPv4 和端口。

演练历史单模型流程时，先在首页进入 **历史示教**，再点击 **打开本地演练 → 进入空间示教 → 放到前方 → 确认摆放**。抓取相机，或用仅模拟器提供的 **演练相机拖动** 改变目标，再记录视点。**移动观察者**只改变合成头显位姿，用来检查相机保持不动。可以调试取景、记录 / 更新、撤销、重新摆放、退出重入、本地保存及完成后的回看。两个演练按钮不会出现在真机中。

需要断点调试时，在 Xcode 选择 `AtlasVisionTeaching` scheme 和 **Apple Vision Pro（visionOS Simulator）**，按 `⌘R`。演练中的头显位置由应用生成；相机目标由独立编辑状态保存。XCTest 的演练按钮验证数据和界面流程，不能代替实际眼动、捏合、转腕及双手接力验证。

| 验证内容 | 使用方式 |
| --- | --- |
| UI、模型显示、演练采样、本地任务和完成状态 | 模拟器中的本地演练；`./scripts/check-vision.sh --ui` 可跑界面流程 |
| 坐标换算、下载、模型校验、同步重试、电脑导入与归档 | `npm run test:vision`，使用临时数据和独立测试服务 |
| 实际水平面识别、定位精度与漂移、双眼效果、佩戴交互、温升和实际权限行为 | 下一轮 Vision Pro 真机联调 |

模拟器演练结果不能同步到正式示教服务。需要验证同步逻辑时运行协议测试；正式模型在模拟器中也不能生成真实头显位姿。

## 真机接入

1. 使用含 visionOS SDK 且支持设备系统版本的 Xcode，打开 `vision/AtlasVisionTeaching.xcodeproj`，选择 `AtlasVisionTeaching` scheme。
2. 在 Target → Signing & Capabilities 中选择现有开发 Team。Bundle ID 默认为 `com.atlasroute.teaching.vision`，如个人账号要求唯一标识，可修改此 ID。
3. 在 Xcode → Window → Devices and Simulators 与 Vision Pro 建立开发配对，在设备设置中启用 Developer Mode，按系统提示确认。选择该设备后运行 App。
4. 首轮用小工件检查自动配对、1:1 放置、捏住移动、转腕旋转与双手接力；检查工件和相机都不会缩放。分别验证「持续对准」开启与关闭时的移动 / 朝向，以及点选表面、三档距离、取景和一步撤销，记录三个视点。
5. 检查退出重入必须重新校准；断网后记录、关闭重开后仍能恢复；重新连接网络完成同步，电脑端显示 **Vision Pro 示教**，采集设备为 **Apple Vision Pro**，各点位置、朝向、名称及校准段数一致。
6. 最后再用正式大模型检查双眼显示、温升、长时间跟踪漂移、摘戴 / 应用切换 / 权限拒绝后的恢复与模型锚点稳定性。这些项目需要真机联调，模拟器通过不等于定位精度已经验收。

## 构建与验证

仅生成编译产物时运行 `./scripts/build_vision.sh`，默认输出未签名 Release 应用到 `vision/build/device/Build/Products/Release-xros/AtlasVisionTeaching.app`，日志在 `vision/build/device/build.log`。使用 `--simulator --configuration Debug` 可构建模拟器应用，产物与日志改在 `vision/build/simulator/` 下。构建脚本不自动安装或启动设备；需要直接调试模拟器时仍使用 `./scripts/run-vision-simulator.sh`。

构建 / 测试结束后，`./scripts/clean_build.sh --dry-run` 可预览清理范围，去掉 `--dry-run` 执行清理。覆盖 `vision/build/`、`vision/DerivedData/` 和 `vision/test-artifacts/`；测试目录中的模型、Pose 和任务快照会保留，完整工程及其引用资源也会保留。

```bash
# 从仓库根目录执行；不访问真实示教任务，网络测试使用临时目录与独立端口。
npm run test:vision
npm run test:vision:scene     # 无损分块、机器人层级、原生/桌面回放一致性、共享撤销与缓存修复
npm run test:vision:scene-ui  # 已启动的 visionOS 模拟器：完整场景接收、播放、时间轴、尺度切换、本地重开
node tests/vision_simulator_launcher_smoke.mjs  # 模拟 Apple 命令，验证启动锁、复用、首次安装及失败恢复
npm run test:vision:pairing-ui  # 已启动的 visionOS 模拟器：本地复用、缩略图、确认/暂缓同步与失败重试
npm run test:vision:autofill    # 配对窗口发布/撤销、有效期、自动填码、电脑切换和手动输入优先
npm run test:vision:autofill -- --ui  # 临时独立模拟器：发现电脑、四格自动填码和手动修改；结束后清理测试设备
./scripts/check-vision.sh        # Swift / LAN / 协议 + Web + visionOS 真机与模拟器编译
./scripts/check-vision.sh --ui   # 增加模拟器界面流程测试

# 可指定模拟器或日志位置
VISION_SIMULATOR_ID=<UDID> VISION_ARTIFACTS=/tmp/atlas-vision-check ./scripts/check-vision.sh --ui
```

检查脚本生成的真机 `.app` **未签名**，安装到硬件时由 Xcode 使用开发 Team 签名。模拟器中的 **打开本地演练** 使用专门的合成模型和位姿，可测试放置、记录、调整、退出重入、离线恢复。模拟器不能为正式配对任务采样，演练数据在客户端与服务端均禁止同步。

测试入口：

- `vision/Tests/VisionCoreTests.swift`：坐标轴、任意旋转回算、禁止缩放 / 镜像 / 非有限矩阵、空间目标对准与移动、距离约束、极点姿态稳定、草稿 / 对准状态往返、撤销、锚点微调、实际三角面命中、Mesh / 点云、预览手势累积与缩放边界、缩略图、下载、本地恢复、实际文件匹配（含改名、损坏与丢失）与同步重试。
- `tests/model_thumbnail_smoke.mjs`：缩略图鉴权、Mesh / 点云预览、图片大小限制、缓存和完整模型保持不变。
- `tests/vision_pairing_ui_smoke.mjs`：启动独立测试服务，验证配对后缩略图、暂不同步、预览和下载重试、本地模型复用及同名不同内容；验证同步 / 复用后的三维预览、水平 / 垂直拖动旋转、双击复位、暂不示教与本地重新打开；记录完整模型下载次数，结束后仅清理本次测试的任务文件。visionOS XCTest 不提供双手捏合 API，缩放计算由原生测试覆盖，双手操作需在头显上验证。
- `tests/vision_teaching_smoke.mjs`：原生 Swift 与实际 LAN 服务往返、设备和轴约定校验、模拟结果拒绝、电脑导入及 ZIP 往返。
- `vision/UITests/AtlasVisionTeachingUITests.swift`：四格配对码、IPv4 分段输入与粘贴、输入格系统主操作选中与禁用保护，以及空间相机取景、观察者与目标解耦、距离切换与撤销、连续记录 / 更新、取消摆放、退出重入、持久化和完成后的只读回看。局域网自动填充测试需向测试运行器提供实际服务的 `ATLAS_DISCOVERY_SERVER_ID` 与 `ATLAS_DISCOVERY_ADDRESS`；可提供 `ATLAS_DISCOVERY_CODE` 检查所选电脑当前配对码的自动填充；可另提供 `ATLAS_DISCOVERY_OTHER_ID` 与 `ATLAS_DISCOVERY_OTHER_ADDRESS` 检查多台电脑切换。

## 构建与工作台验证

Xcode 在应用构建阶段运行 `vision/scripts/build_workbench.mjs`，打包完整页面、Worker、样式及 Vision 专用手部示教适配器到生成目录 `AtlasVisionTeaching/WebWorkbench`。构建前运行 `npm install`；Xcode 可使用 `/opt/homebrew/bin` 或 `/usr/local/bin` 的 Node。只附带仓库的 `xian_map.ply` 示例地图，不打包其他本地地图和 `robots/` 目录；用户的完整资源随工程文件或同步传入。共享的 `scripts/build_vision_workbench.mjs` 仍供旧回归测试使用，不含新适配器；最终安装包应由 Xcode 或上述 Vision 专用脚本构建。双臂手部功能及专用验证见 [双臂手部示教](hand-teaching.md)。

本机服务仅监听 `127.0.0.1:21991`，固定 origin 保留 IndexedDB。导入与空间资源写入使用每次进程生成的凭据，限制同源请求；大文件经临时文件流式传输。选择电脑后只转发 Atlas API 到经 LANClient 校验的局域网地址，原生客户端始终作为需要授权的同步参与端。

```bash
npm run test:vision:workbench
npm run test:vision:scene # 混合地图、双相机取景与裁切、坐标、入口与回放一致性
# Python 环境需要安装 Playwright，并有 Chrome：
VISION_PYTHON=/path/to/python npm run test:vision:workbench-ui
# 模拟器（ATLAS_WORKBENCH_FILE 为测试工程，不使用用户工程）：
node tests/vision_workbench_fixture.mjs /tmp/vision-workbench-fixture.zip
TEST_RUNNER_ATLAS_WORKBENCH_FILE=/tmp/vision-workbench-fixture.zip xcodebuild \
  -project vision/AtlasVisionTeaching.xcodeproj -scheme AtlasVisionTeaching \
  -destination 'platform=visionOS Simulator,name=Apple Vision Pro' \
  -only-testing:AtlasVisionTeachingUITests/AtlasVisionTeachingUITests/testFullWorkbenchProject test
```

`tests/vision_workbench_sync_ui.py` 与隔离的 `tests/vision_scene_web_server.mjs` 验证真实双端授权、完整工程传输及双向任务编辑；`tests/vision_workbench_smoke.mjs --sync-ui` 可在该隔离服务运行时执行。测试使用临时服务目录与新的浏览器上下文，不操作用户工程。

[完整工程操作](project-workspace.md) · [历史单模型演练](virtual-camera.md) · [历史验证记录](validation-history.md)。

---

[Vision Pro 首页](../README.md) · [全项目文档](../../docs/README.md)
