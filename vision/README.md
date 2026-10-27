# Vision Pro 空间工作台

原生 visionOS App「Atlas 空间工作台」，工程入口为 [AtlasVisionTeaching.xcodeproj](AtlasVisionTeaching.xcodeproj)。打开工程后，地图与完整机器人直接进入全沉浸 RealityKit 空间，默认以米制原大站在机器人旁。完整工程编辑器通过辅助面板按需呼出。iPad / iPhone 的现场采集与逐 Pose 示教流程保持独立。最低 visionOS 2.0；原生双手操控使用 visionOS 26 的 ManipulationComponent，M5 联调使用 visionOS 26 或更新版本。

## 启动与完整工程

- **选择设备同步**：自动发现同一局域网的 Atlas 电脑，点选后申请同步电脑当前工程。在电脑已有工作台上允许同步后，完整地图、机器人资源、任务和导航数据传入头显。无需打开旧版“空间工程共享”窗口。发现失败时可展开地址输入。
- **载入当前工程**：恢复头显本机自动保存的工作区，自动进入沉浸空间；没有地图资源时显示工程准备页，可打开编辑工具新建或导入。
- **载入工程文件**：从系统文件选择器导入 Mac 导出的 ZIP 完整工程、双工作区工程和工作区集合。兼容 JSON 配置，但 JSON 不携带地图和机器人资源，离线迁移推荐 ZIP。

同步、导入和离线载入均在地图与机器人资源准备好后自动构建原生空间。同步入口等待电脑授权和完整接收，不会先展示上一次缓存工程。默认只显示小型空间工具面板，无需坐标、角度或名称输入。

启动 App 时只显示工程入口。沙盘工具窗在沉浸空间成功打开后出现，退出空间、取消进入或打开失败时自动收起，双相机窗口也随空间关闭。visionOS 26 禁用辅助窗的系统恢复；旧系统若恢复了失效工具窗，会将其关闭并返回工程入口。更新空间时保留当前工具窗，重开 App 不会保留上一次沉浸空间的工具面板。

沉浸空间和沙盘沿用 Web 当前的地图颜色模式（高程色、原始色或纯白色），地图内放置的独立对象保留各自的颜色模式。高程色使用整张地图的统一高度范围和同一色带；导出不修改源 RGB，也不改变机器人的材质颜色。修改颜色设置后，在空间选项中选择「更新空间」应用；重新载入工程时会读取已保存的颜色设置。

机器人网格使用表面法线、物理材质和固定的主光/补光，显示曲面明暗、反光及自身阴影；粗糙度和金属度随 Web 工程导出。旧缓存中的机器人使用与 Web URDF 加载器一致的默认材质参数。地图继续使用不受光照影响的颜色，避免高程色随机器人光照变化。

**编辑工具** 在单独窗口中提供完整工程编辑能力：地图与模型、导航图、机器人全关节与末端、任务 / 停车点 / 姿态、折线、路径检查、工程导入导出。这个可收起的窗口复用 Mac 的 React / Three.js 引擎；原生空间的渲染和游走使用 RealityKit。工程数据引擎留在本机后台，已接收完整工程后可离线继续。编辑器目前仍有数字与文字输入，后续逐项手势化。

- 空间面板 **… → 保存工程** 或编辑器顶部 **保存工程** 生成可回到 Mac 打开的完整 ZIP，保存在“文件 → Atlas 空间工作台 → Exports”。完成后 **导出文件** 可分享或另存。
- **工程入口** 会先自动保存并结束同步，再返回设备与本机入口。重新打开使用同一份本机缓存。
- 同步沿用现有协议：主机授权 5 分钟，每 3 秒双向合并任务、停车点、姿态、导航点、路径、关节预设和独立工程名称。地图与机器人资源在建立连接时完整传输；不同步实时视角、机器人临时关节拖动、模型几何编辑或整套历史工作区。几何变更需重新建立同步或交换 ZIP。过期后在工作台申请续期。
- Mac 的机器人目录、Isaac 服务和其他电脑专属服务仍需连接电脑。WebKit 不支持桌面的目录直接覆写 API，头显通过自动缓存与完整 ZIP 保存；Mac 外设和文件系统专属 API 尚未移植。

## 沉浸游走

默认进入 `project-space` 全沉浸空间。入口自动寻找机器人附近朝上的平坦表面，并检查落点的身体空间；找不到时展示沙盘，允许手动选择入口。稀疏点云与独立工件补充可见的参考地面。头部位置与朝向使用 WorldTrackingProvider，真实移动与项目米制距离保持 1:1。

1. **近处观察**：转头、转身和小范围移动直接改变观察位置。原大模式固定世界，不允许将地面整体拖走。
2. **前往远处**：注视地面并捏合，出现落点环后选择 **前往此处**；短暂淡出再进入新位置。拒绝墙面、陡坡、模型占据的位置；游走只改变观察位置，不改工程坐标。
3. **沙盘**：双手缩放、转动完整工程，在地面选择落点后进入。**… → 前往示教点** 可选择停车点旁的空地；**回到机器人旁**、转身和测量收进同一菜单。
4. **回放**：任务菜单、播放 / 暂停和时间轴驱动机器人底盘与完整关节链。
5. **空间检查**：开启 **测量两点间距** 后点选两处显示近似间距，再点一次重新开始。
6. **编辑后更新**：编辑工具或同步改变工程后提示 **工程有更新**，选择 **更新空间** 重建原生场景。完整编辑器仍为工程数据的来源，空间内暂未实现直接拖动机器人关节或编辑任务。

**双相机** 打开可移动的并排取景窗，分别显示机器人左、右 Zivid 虚拟相机看到的地图与模型。画面使用工程内的光学坐标系，跟随机器人姿态、回放和时间轴变化；转头、游走和缩放沙盘不会改变取景。视野与电脑端 M70 一致（56.6° × 35.6°，0.3–1.3 m），保留源网格和点云。关闭取景窗会停止渲染，保持沉浸空间；退出空间时一同关闭。没有 Zivid 光学坐标系的机器人不会启用此入口，只有一个相机时另一侧显示缺失提示。

网格地图保留全部三角形与碰撞表面；点云按距离加载显示细节，原始点集完整保存在本机。混合地图分别传入网格与未被三角面引用的点云，向点云地图放入网格模型后仍保留完整背景点云和参考地面。机器人保留完整关节层级。当前外观使用顶点与材质颜色，不包括 UV / PBR 贴图。测量与落点检查用于查看，不是精密碰撞校核。模拟器验证入口、落点切换、回放、编辑器收起、空间刷新、保存和重开；真实头部运动、注视捏合与大工程帧率需要在头显体验。

## 构建与工作台验证

Xcode 在应用构建阶段运行 `scripts/build_vision_workbench.mjs`，打包完整页面、Worker 和样式到生成目录 `AtlasVisionTeaching/WebWorkbench`。构建前运行 `npm install`；Xcode 可使用 `/opt/homebrew/bin` 或 `/usr/local/bin` 的 Node。只附带仓库的 `xian_map.ply` 示例地图，不打包其他本地地图和 `robots/` 目录；用户的完整资源随工程文件或同步传入。

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

## 历史单模型示教

首页的 **打开历史单模型示教** 保留既有相机草稿、离线任务与旧同步流程。以下说明适用于这个兼容入口。

## 虚拟相机示教

欢迎页与 iPad 采用一致的顶部标题与双栏卡片布局：左侧「从电脑接收物体」，右侧「保存在此 Vision Pro」。保留 Vision Pro 的青色主题与系统玻璃背景，通过局域网搜索或手动输入地址和配对码连接，不提供扫码入口。默认通过局域网发现和自动获取配对码连接，手动地址、端口和配对码折叠为备用入口。空间示教过程中不需要输入坐标、角度或名称。

1. 在电脑运行 `./scripts/start.sh`，打开独立示教物体，点击 **设备 → Vision Pro → 同步与接收 → 配对 Vision Pro**，弹窗自动准备模型并显示 4 位配对码。此入口只显示 Vision Pro 的示教来源和传输记录，不复用 iPad 的传输；两类设备的原有结果仍保存在同一工程中。
2. Vision Pro 与电脑接入同一局域网，打开 App，允许本地网络。点击欢迎页 **局域网配对** 下方的 **自动检测局域网服务器**，首个验证成功的服务会自动填入 IPv4 地址和端口，并获取该电脑当前 Vision Pro 配对窗口的有效配对码；找到多台时可点选切换。只有一个待配对物体时，四格配对码直接填入；多个窗口提供不同物体时，点选物体名称即可填码。电脑配对窗口需保持打开，已配对、已过期或已关闭的任务不会继续提供自动填码。无可用配对码时可点 **重新获取配对码**，也可手动填写。检测时显示进度，未找到时提示检查网络与电脑服务，并可点击 **重新检测局域网服务器** 重试。也可手动填写四段 IPv4（每段 `0–255`，支持整条地址粘贴）和端口（默认 `21990`），输入四位配对码，点击 **配对并检查模型**。搜索期间若开始手动编辑地址或端口，将保留手动输入。自动获取配对码期间开始手动输入时，迟到的网络响应不会覆盖输入；切换电脑会先清空旧配对码，自动填入的码过期后也会清空。自动填码后仍需点击 **配对并检查模型**。配对后先校验本地模型的实际 SHA-256 和文件大小：有一致文件时直接使用并显示文件信息；没有时弹窗展示新文件名、缩略图、大小、顶点数和尺寸，由用户选择 **同步模型** 或 **暂不同步**。预览仅传输缩略图，确认前不会下载完整模型。暂不同步后可点 **查看文件并同步** 继续；预览或下载失败可单独重试。同名但内容不同的文件不会复用，不同传输任务也不会混用已有 Pose。
3. 本地模型就绪后自动进入 **三维模型预览**，新同步和本地复用的模型都可先查看。注视模型，**捏住并左右 / 上下拖动**旋转；**双手各自捏住，拉开 / 靠拢**放大或缩小（50%–200%，默认 200%）；**连续捏合两次**恢复初始视角。松手后保留当前视角，重新打开任务时恢复默认视角。预览区显示手势提示，VoiceOver 也可通过自定动作旋转、复位，通过调整操作缩放。查看后选择 **进入空间示教**；选择 **返回主页** 会返回任务列表，模型仍保存在本机，可离线再次打开。已有 Pose 的任务也可直接 **查看记录**。预览不启动空间定位，旋转和缩放仅作用于预览副本，不改变原始模型、校准或 Pose。进入空间后允许空间感知，观察到青色水平面后，注视该区域并捏合放置；也可沿头部朝向放到已识别水平面，或使用 **放到前方** 手动放置。
4. 模型以底部中心作为放置基准，始终保持 **1:1**。**捏住工件移动、转动手腕调整朝向**，满意后选择 **确认摆放**。系统双手操控支持移动和旋转；为保持真实尺寸，空间工件与相机都不允许缩放。
5. 主工作台自动收起，保留一个系统工具窗；可捏住窗口底栏移到身旁。**捏住蓝色虚拟相机移动**，关闭「持续对准」后可转腕改变方向；**点选工件表面**会建立绿色瞄准点，相机保持对准它。近景 / 标准 / 远景提供三档距离，无需输入数值。取景窗显示该虚拟相机看到的模型，青色线框表示 M70 视野。移动头部或绕着工件走动，不会改变已摆好的相机；「取当前视角」只复制一次当前头显朝向。
6. 点击 **记录视点**，自动命名并保存。黄色标记或工具窗的前后箭头可召回已有视点，调整后 **更新视点**；「新视点」恢复新建状态。一次抓取松手形成一步撤销，表面选择和距离切换也可撤销。距离上一点小于 10 cm 时确认后再保存；确认保存首次点击时冻结的位姿。
7. **重新摆放**可调整工件在房间中的位置，原模型坐标中的相机视点保持不变；取消可恢复摆放。退出空间、切换任务或定位会话中断后需重新摆放确认。未记录的相机草稿及其对准状态也会保存，重开后可继续编辑。
8. 返回工作台后，**完成并保存在本机**会冻结结果；完成后的空间模式仅用于回看。回到局域网后同步，或直接 **完成并同步**。同步校验设备与电脑的实际模型 SHA-256；失败可重试同一结果。电脑端点击 **检查完成状态 → 接收示教结果**，继续做机器人求解。

## 注视与捏合操作

任务窗口和空间控制板均使用 visionOS 系统确认交互：**先注视目标，看到高亮后，让拇指和食指轻捏并松开一次**。手可以保持在舒适位置、处于设备可见范围，无需伸到按钮前，也无需反复把页面拉近。按钮仍支持近距离触碰；输入地址、配对码时，注视对应格并捏合即可选中。「持续对准」和「Zivid 视野」使用整块按钮切换。工具窗位置由系统管理，关闭工具窗会退出空间并恢复工作台。

水平面放置、工件表面选点和已记录视点选择各自限定输入目标；相机与工件使用系统空间操控。工具窗使用独立 SwiftUI WindowGroup，避免空间附件在模拟器中的可访问性树丢失问题，固定窗口值防止快速退出重入时重复开窗。UIKit 地址格和配对码格使用系统主操作事件和注视高亮，保持原有键盘输入、粘贴及禁用行为。

**Mac 模拟器中**，在画面底部选择交互模式（“Select to interact with the visionOS content”），鼠标指向目标模拟注视，**单击模拟一次捏合确认**；按住并拖动模拟捏住拖动。无需把模拟器视角移到按钮跟前。模拟器输入与自动化回归可以检查操作流程，实际眼动选中、手势识别和高亮仍需佩戴 Vision Pro 验证。

Apple 参考：[空间输入与高亮设计](https://developer.apple.com/videos/play/wwdc2025/303/)、[模拟器交互方式](https://developer.apple.com/documentation/xcode/interacting-with-your-visionos-app-in-device-hub)、[系统主操作事件](https://developer.apple.com/documentation/uikit/uicontrol/event/primaryactiontriggered)。

## 位姿含义

- 模型与保存结果采用 `virtual_origin`，米，右手系 Z 向上，与 iPad / 电脑一致。
- 新记录保存为 `visionpro_virtual_camera_optical_frame`，虚拟光学轴为 X 向右、Y 向下、Z 向前，位置与朝向来自独立虚拟相机。结果标记 `device.platform=visionOS`、`poseSource=spatialAuthoring`、`lidar=false`。
- `modelFromVirtualCamera = inverse(worldFromModel) × worldFromVirtualCamera`。手势只调整显示与目标，保存时始终回到原模型的米制坐标；头显位姿仅用于初次放置和主动选择「取当前视角」。
- 兼容已有 `poseSource=deviceAnchor`、`visionpro_head_optical_frame` 的头显参考数据；继续编辑旧任务时可以同时包含旧头显点和新空间相机点，电脑端按每点坐标系区分。
- 表面点来自当前显示几何的命中；初始射线未命中时仅提供朝向，不把模型中心伪装成表面点。取景采用本地模型的几何预览，大模型可能使用点云简化；它不是透视相机实拍，也不代表已验证遮挡、覆盖率或可达性。
- M70 视锥与取景近远裁切范围为 0.3–1.3 m，三档距离为 0.4 / 0.7 / 1.0 m。保存的是期望相机目标，使用机器人前仍须进行工具 / 相机外参标定、关节求解及碰撞检查；电脑继续拦截未求解结果的机器人导出。
- 确认后使用本次会话的 WorldAnchor 更新模型位置。不会用上次会话的 AR 世界坐标直接恢复校准，也不会自动声称已完成物体识别或高精度配准。

## 在 Mac 上用模拟器调试

日常 UI 和功能迭代先在 Mac 的 visionOS 模拟器中完成，之后再集中进行真机验证。在 Finder 中双击 [`scripts/start_vision_simulator.command`](../scripts/start_vision_simulator.command)，即可自动打开终端并启动模拟器与「Atlas 空间示教」。也可在仓库根目录执行：

```bash
./scripts/start_vision_simulator.command
```

脚本优先复用已启动的 visionOS 设备；没有运行中的设备时，选择已安装的最高版本。已安装应用时直接打开，正在运行的应用会保留进程和当前状态；首次未安装应用时才自动编译安装。同一 Mac 用户的两个启动入口及不同仓库副本共用进程锁，同时点击不会重复启动或编译，启动失败或退出后锁会自动释放。

**修改代码后，使用 `--rebuild` 重新编译、安装并重启应用：**

```bash
./scripts/start_vision_simulator.command --rebuild
```

原来的 `./scripts/run-vision-simulator.sh` 使用相同的单例逻辑，也支持 `--rebuild`。两个入口均可从任意工作目录启动，支持 `VISION_SIMULATOR_ID=<UDID>` 指定设备、`VISION_ARTIFACTS=<目录>` 指定编译产物和日志位置（相对路径以仓库根目录为基准，默认 `vision/test-artifacts/simulator-dev/`）。切换设备前需先在 Simulator 中关闭当前 visionOS 设备；如果已经有多个 visionOS 设备运行，脚本会提示关闭多余设备后重试。需要安装完整 Xcode、visionOS Simulator 运行时及 Python 3。

本机调试时，若电脑服务已启动但模拟器收不到 Node 的服务广播，可在 Mac 终端执行 `dns-sd -R "Atlas Simulator Discovery" _atlas-teach._tcp local. 21990`，通过系统 Bonjour 发布现有服务；端口需与电脑服务一致。保持该命令运行，结束调试后按 `Ctrl+C` 撤销广播。应用仍会验证实际 HTTP 服务，再自动填入解析到的 IPv4 和端口。

在应用中点击 **打开本地演练 → 进入空间示教 → 放到前方 → 确认摆放**。抓取相机，或用仅模拟器提供的 **演练相机拖动** 改变目标，再记录视点。**移动观察者**只改变合成头显位姿，用来检查相机保持不动。可以调试取景、记录 / 更新、撤销、重新摆放、退出重入、本地保存及完成后的回看。两个演练按钮不会出现在真机中。

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

## 实现范围

与 iPad 工程共享 `TeachingModels`、`TeachingSession`、`ProjectStore`、`LANClient`、Bonjour 发现和 ATLS 模型验证源码。独立的 visionOS Target 使用 RealityKit 渲染，不加载 iPad 的 ARSCNView。旧协议名称和 `/__atlas/ipad/` 路由保留，以兼容已有 iPad App；服务端依据明确的平台及位姿来源校验坐标轴。

虚拟相机示教模式的模型原文件完整保留；空间显示预算为轻量 / 均衡 / 精细：最多 4 / 12 / 30 万三角面，或 0.8 / 2 / 5 万点。Mesh 使用抽样面及其平均顶点颜色，点云使用小四面体；显示精度不改变示教坐标或模型指纹。最多保存 50,000 个 Pose、1,000 段校准，空间中显示最近 500 个 Pose 标记。此模式提供虚拟相机模型取景；机器人回放位于上述完整工程模式。当前版本不包含真实相机预览、二维码相机扫描、覆盖着色或头显端关节求解。

窗口预览使用独立显示数据：12 万面以内的模型保留完整网格，更密的扫描模型和点云采用最多 5 万个彩色点，按窗口尺寸设置点的可见大小，避免大量细小三角面被抽样后在缩小预览中消失。预览生成可取消、失败可重试，不改变空间示教的 1:1 模型与校准数据。原生回归测试覆盖稠密网格的预览策略、显示预算与点大小；`testExistingLocalModelPreview` 可通过测试运行器的 `ATLAS_PREVIEW_PROJECT_ID` 和 `ATLAS_PREVIEW_CAPTURE_URL` 检查指定本地模型，并让 Mac 端截图接收服务保存实际画面。

Apple 接口参考：[ARKit 权限与空间会话](https://developer.apple.com/documentation/visionos/setting-up-access-to-arkit-data)、[头显参考位姿查询](https://developer.apple.com/documentation/arkit/worldtrackingprovider/querydeviceanchor(attimestamp:))。

## 空间相机首版预检（2026-10-26）

- Xcode 26.6、visionOS Simulator 26.5；通过 visionOS Debug 模拟器与 Release 真机架构编译，真机产物未签名。
- 通过空间示教 UI 全流程：摆放、取景、观察者与相机分离、距离切换 / 撤销、连续记录、召回更新、取消摆放、退出重入、空间中强制退出应用后恢复草稿与对准状态，以及完成后的只读回看。结果：`test-artifacts/spatial-editor-ready.xcresult`。
- 通过连续模型预览旋转，以及 IPv4 / 配对码输入与粘贴、系统主操作事件检查。折叠手动连接后的输入回归结果：`test-artifacts/spatial-editor-input-verified.xcresult`。需要额外服务或指定本地工程的发现 / 配对 UI 用例未在本轮执行。
- 通过 `npm run test:vision`（含新旧坐标系混合、草稿持久化、真实 LAN 往返和归档）、`npm run test:ipad`、`npm run test:ipad:native`、Web 生产构建及共享 iOS 真机架构编译。
- 模拟器录像已检查空间模型、相机视锥和模型取景；XCTest 的「演练相机拖动」验证编辑状态，不代表真实手部追踪已验收。下一步在 M5 上验证注视命中、捏住移动、转腕、双手接力、工具窗舒适位置、空间定位恢复与大模型表现。

## 上一版预检记录（2026-10-08）

- 环境：Xcode 26.6，visionOS SDK / Simulator 26.5。
- 通过：visionOS Release 真机架构编译（未签名）、模拟器编译、模拟器完整示教流程，以及完成后的只读空间回看。
- 通过：`npm run test:vision`、`test:ipad`、`test:ipad:native`、`test:ipad:qr`、`test:ipad:discovery`、`test:transfer`、Web 生产构建及 iPad 真机架构回归编译。
- 已通过 `simctl` 截图检查模型、任务窗口和空间控制板。真机尚未接入，物理定位精度、实际权限弹窗、锚点稳定性、长时间运行与佩戴交互待硬件联调。
- `test:abx` 的本工程断言已运行到外部契约阶段，完整回归因本机缺少 `../workspace/ABXBrainSystem/tools/web/teaching_store.py` 未完成。该外部项目就绪后可通过 `ABX_BRAIN_ROOT` 指定路径重跑。
