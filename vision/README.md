# Vision Pro 空间示教

原生 visionOS App「Atlas 空间示教」，工程入口为 [AtlasVisionTeaching.xcodeproj](AtlasVisionTeaching.xcodeproj)。支持 Apple Vision Pro，包括 M5 设备；最低部署版本 visionOS 2.0。使用 SwiftUI、RealityKit 与 ARKit，不依赖第三方 Swift 包。

## 使用流程

1. 在电脑运行 `./scripts/start.sh`，打开独立示教物体，点击 **设备 → Vision Pro → 同步与接收 → 配对 Vision Pro**，弹窗自动准备模型并显示 4 位配对码。此入口只显示 Vision Pro 的示教来源和传输记录，不复用 iPad 的传输；两类设备的原有结果仍保存在同一工程中。
2. Vision Pro 与电脑接入同一局域网，打开 App，允许本地网络。点击 **搜索局域网电脑**，首个验证成功的服务会自动填入 IPv4 地址和端口；找到多台时可点选切换。也可手动填写四段 IPv4（每段 `0–255`，支持整条地址粘贴）和端口（默认 `21990`），输入四位配对码，点击 **配对并检查模型**。搜索期间若开始手动编辑地址或端口，将保留手动输入。配对后先校验本地模型的实际 SHA-256 和文件大小：有一致文件时直接使用并显示文件信息；没有时弹窗展示新文件名、缩略图、大小、顶点数和尺寸，由用户选择 **同步模型** 或 **暂不同步**。预览仅传输缩略图，确认前不会下载完整模型。暂不同步后可点 **查看文件并同步** 继续；预览或下载失败可单独重试。同名但内容不同的文件不会复用，不同传输任务也不会混用已有 Pose。
3. 本地模型就绪后自动进入 **三维模型预览**，新同步和本地复用的模型都可先查看。使用大按钮左右 / 上下旋转、放大、缩小或重置视角，再选择 **进入空间示教**；选择 **暂不示教** 会返回任务列表，模型仍保存在本机，可离线再次打开。已有 Pose 的任务也可直接 **查看记录**。预览不启动空间定位，旋转和缩放仅作用于预览副本，不改变原始模型、校准或 Pose。进入空间后允许空间感知，观察到青色水平面后，注视该区域并捏合放置；也可沿头部朝向放到已识别水平面，或使用 **放到前方** 手动放置。
4. 模型以底部中心作为放置基准，始终保持 **1:1**。通过每次 1 cm 的平移、偏航、俯仰和翻滚调整位置，确认与现场对齐后点击 **确认校准**。
5. 将任务窗口移到侧面，使用空间控制板。移动到需要的观察位置，调整头部朝向，点击 **记录 Pose**。控制板在走远或转身后会移回附近，也可手动移到面前。小于上一点 10 cm 时需要确认；确认保存的是首次点击时冻结的位姿。支持重命名、删除、调整模型后新建校准段，以及 Mesh / 点云与显示精度切换。
6. 下载后可离线示教。每次采样自动保存，退出任务后可从本地任务恢复。**退出空间、切换任务或定位会话中断后需重新放置校准**，已有 Pose 保留。
7. **完成并保存在本机** 会冻结结果；回到局域网后填写当前电脑地址并同步。也可直接 **完成并同步**。同步先比较设备和电脑的实际模型文件 SHA-256，再上传结果；网络失败可重试同一结果。电脑端点击 **检查完成状态 → 接收示教结果**。

## 位姿含义

- 模型与保存结果采用 `virtual_origin`，米，右手系 Z 向上，与 iPad / 电脑一致。
- Vision Pro 通过 `WorldTrackingProvider.queryDeviceAnchor(atTimestamp:)` 获取头显参考位置与朝向，保存为 `visionpro_head_optical_frame`，虚拟光学轴为 X 向右、Y 向下、Z 向前。
- 换算为 `modelFromHeadOptical = inverse(worldFromModel) × worldFromDevice × diag(1, -1, -1, 1)`。
- 这是**头显参考位姿**，不读取眼球注视方向，不代表透视相机光心，也未包含头显到实际 Zivid / 机器人相机的外参标定。`device.platform=visionOS`、`poseSource=deviceAnchor`、`lidar=false` 表明采样没有使用 iPad 的原始 LiDAR 深度帧。
- M70 视锥是共点、同轴的虚拟观察辅助，范围 0.3–1.3 m；真正用于机器人前仍须完成实际工具 / 相机的外参标定与关节求解。电脑的机器人导出会继续拦截尚未求解的移动设备 Pose。
- 确认后使用本次会话的 WorldAnchor 更新模型位置。不会用上次会话的 AR 世界坐标直接恢复校准，也不会自动声称已完成物体识别或高精度配准。

## 在 Mac 上用模拟器调试

日常 UI 和功能迭代先在 Mac 的 visionOS 模拟器中完成，之后再集中进行真机验证。仓库根目录执行：

```bash
./scripts/run-vision-simulator.sh
```

脚本选择已安装的最高版本 visionOS 模拟器，编译、安装并启动应用；重复执行会更新并重新启动模拟器中的应用。也可通过 `VISION_SIMULATOR_ID=<UDID>` 指定设备，`VISION_ARTIFACTS=<目录>` 指定编译产物和日志位置。

本机调试时，若电脑服务已启动但模拟器收不到 Node 的服务广播，可在 Mac 终端执行 `dns-sd -R "Atlas Simulator Discovery" _atlas-teach._tcp local. 21990`，通过系统 Bonjour 发布现有服务；端口需与电脑服务一致。保持该命令运行，结束调试后按 `Ctrl+C` 撤销广播。应用仍会验证实际 HTTP 服务，再自动填入解析到的 IPv4 和端口。

在应用中点击 **打开本地演练**，先旋转、缩放预览模型，再选择 **进入空间示教 → 放到前方 → 确认校准 → 记录 Pose**。使用 **模拟向右移动 20 cm** 改变合成头显位置，再记录下一个点。可以调试模型显示、窗口与空间控制板、校准微调、Pose 编辑、退出重入、本地保存及完成后的回看。离开空间后仍需重新校准，已记录的点保留；在任务界面点击 **预览模型** 可再次查看模型。

需要断点调试时，在 Xcode 选择 `AtlasVisionTeaching` scheme 和 **Apple Vision Pro（visionOS Simulator）**，按 `⌘R`。演练中的头显位置由应用生成；在模拟器里移动观察视角不会自动改变采样位姿。

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
4. 首轮用较小的工件检查网络配对、1:1 尺寸、地面 / 桌面放置、三轴朝向和手动微调，记录至少三个相距超过 10 cm 的 Pose。
5. 检查退出重入必须重新校准；断网后记录、关闭重开后仍能恢复；重新连接网络完成同步，电脑端显示 **Vision Pro 示教**，采集设备为 **Apple Vision Pro**，各点位置、朝向、名称及校准段数一致。
6. 最后再用正式大模型检查双眼显示、温升、长时间跟踪漂移、摘戴 / 应用切换 / 权限拒绝后的恢复与模型锚点稳定性。这些项目需要真机联调，模拟器通过不等于定位精度已经验收。

## 构建与验证

仅生成编译产物时运行 `./scripts/build_vision.sh`，默认输出未签名 Release 应用到 `vision/build/device/Build/Products/Release-xros/AtlasVisionTeaching.app`，日志在 `vision/build/device/build.log`。使用 `--simulator --configuration Debug` 可构建模拟器应用，产物与日志改在 `vision/build/simulator/` 下。构建脚本不自动安装或启动设备；需要直接调试模拟器时仍使用 `./scripts/run-vision-simulator.sh`。

构建 / 测试结束后，`./scripts/clean_build.sh --dry-run` 可预览清理范围，去掉 `--dry-run` 执行清理。覆盖 `vision/build/`、`vision/DerivedData/` 和 `vision/test-artifacts/`；测试目录中的模型、Pose 和任务快照会保留，完整工程及其引用资源也会保留。

```bash
# 从仓库根目录执行；不访问真实示教任务，网络测试使用临时目录与独立端口。
npm run test:vision
npm run test:vision:pairing-ui  # 已启动的 visionOS 模拟器：本地复用、缩略图、确认/暂缓同步与失败重试
./scripts/check-vision.sh        # Swift / LAN / 协议 + Web + visionOS 真机与模拟器编译
./scripts/check-vision.sh --ui   # 增加模拟器界面流程测试

# 可指定模拟器或日志位置
VISION_SIMULATOR_ID=<UDID> VISION_ARTIFACTS=/tmp/atlas-vision-check ./scripts/check-vision.sh --ui
```

检查脚本生成的真机 `.app` **未签名**，安装到硬件时由 Xcode 使用开发 Team 签名。模拟器中的 **打开本地演练** 使用专门的合成模型和位姿，可测试放置、记录、调整、退出重入、离线恢复。模拟器不能为正式配对任务采样，演练数据在客户端与服务端均禁止同步。

测试入口：

- `vision/Tests/VisionCoreTests.swift`：坐标轴、任意旋转回算、禁止缩放 / 镜像 / 非有限矩阵、锚点微调、实际三角面命中、Mesh / 点云、缩略图、下载、本地恢复、实际文件匹配（含改名、损坏与丢失）与同步重试。
- `tests/model_thumbnail_smoke.mjs`：缩略图鉴权、Mesh / 点云预览、图片大小限制、缓存和完整模型保持不变。
- `tests/vision_pairing_ui_smoke.mjs`：启动独立测试服务，验证配对后缩略图、暂不同步、预览和下载重试、本地模型复用及同名不同内容；验证同步 / 复用后的三维预览、旋转、缩放边界、重置、暂不示教与本地重新打开；记录完整模型下载次数，结束后仅清理本次测试的任务文件。
- `tests/vision_teaching_smoke.mjs`：原生 Swift 与实际 LAN 服务往返、设备和轴约定校验、模拟结果拒绝、电脑导入及 ZIP 往返。
- `vision/UITests/AtlasVisionTeachingUITests.swift`：四格配对码、IPv4 分段输入与粘贴、模拟器放置校准、连续记录、取消调整、退出重入和本地恢复。局域网自动填充测试需向测试运行器提供实际服务的 `ATLAS_DISCOVERY_SERVER_ID` 与 `ATLAS_DISCOVERY_ADDRESS`；可另提供 `ATLAS_DISCOVERY_OTHER_ID` 与 `ATLAS_DISCOVERY_OTHER_ADDRESS` 检查多台电脑切换。

## 实现范围

与 iPad 工程共享 `TeachingModels`、`TeachingSession`、`ProjectStore`、`LANClient`、Bonjour 发现和 ATLS 模型验证源码。独立的 visionOS Target 使用 RealityKit 渲染，不加载 iPad 的 ARSCNView。旧协议名称和 `/__atlas/ipad/` 路由保留，以兼容已有 iPad App；服务端依据明确的平台及位姿来源校验坐标轴。

模型原文件完整保留；空间显示预算为轻量 / 均衡 / 精细：最多 4 / 12 / 30 万三角面，或 0.8 / 2 / 5 万点。Mesh 使用抽样面及其平均顶点颜色，点云使用小四面体；显示精度不改变示教坐标或模型指纹。最多保存 50,000 个 Pose、1,000 段校准，空间中显示最近 500 个 Pose 标记。当前版本不包含 iPad 专用的原始相机预览、二维码相机扫描或已示教表面覆盖着色。

窗口预览使用独立显示数据：12 万面以内的模型保留完整网格，更密的扫描模型和点云采用最多 5 万个彩色点，按窗口尺寸设置点的可见大小，避免大量细小三角面被抽样后在缩小预览中消失。预览生成可取消、失败可重试，不改变空间示教的 1:1 模型与校准数据。原生回归测试覆盖稠密网格的预览策略、显示预算与点大小；`testExistingLocalModelPreview` 可通过测试运行器的 `ATLAS_PREVIEW_PROJECT_ID` 和 `ATLAS_PREVIEW_CAPTURE_URL` 检查指定本地模型，并让 Mac 端截图接收服务保存实际画面。

Apple 接口参考：[ARKit 权限与空间会话](https://developer.apple.com/documentation/visionos/setting-up-access-to-arkit-data)、[头显参考位姿查询](https://developer.apple.com/documentation/arkit/worldtrackingprovider/querydeviceanchor(attimestamp:))。

## 本次预检记录（2026-10-08）

- 环境：Xcode 26.6，visionOS SDK / Simulator 26.5。
- 通过：visionOS Release 真机架构编译（未签名）、模拟器编译、模拟器完整示教流程，以及完成后的只读空间回看。
- 通过：`npm run test:vision`、`test:ipad`、`test:ipad:native`、`test:ipad:qr`、`test:ipad:discovery`、`test:transfer`、Web 生产构建及 iPad 真机架构回归编译。
- 已通过 `simctl` 截图检查模型、任务窗口和空间控制板。真机尚未接入，物理定位精度、实际权限弹窗、锚点稳定性、长时间运行与佩戴交互待硬件联调。
- `test:abx` 的本工程断言已运行到外部契约阶段，完整回归因本机缺少 `../workspace/ABXBrainSystem/tools/web/teaching_store.py` 未完成。该外部项目就绪后可通过 `ABX_BRAIN_ROOT` 指定路径重跑。
