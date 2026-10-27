# 测试与回归入口

[文档目录](README.md) · [项目首页](../README.md)

文中的命令均从仓库根目录执行。

[iPad 画面协作回归](#ipad-画面协作回归) · [表面折线示教回归](#表面折线示教回归)

<a id="验证与回归"></a>

下面是已有验证入口，按对应平台与依赖执行。各功能折叠区还保留了专用真机测试名称。

| 范围 | 入口 |
| --- | --- |
| Vision Pro 原生坐标、网络与工程往返 | `npm run test:vision`（macOS） |
| visionOS 构建与模拟器流程 | `./scripts/check-vision.sh --ui`（macOS + Xcode） |
| iPad 模型 / 协议 / 配对 | `npm run test:ipad` |
| 机器人预设文件格式、关节单位、限位、型号匹配及工程保存 | `npm run test:robot-presets` |
| 机器人预设创建 / 导入弹窗、输入换算、应用与刷新恢复 | `uv run --with playwright python tests/robot_presets_ui_smoke.py`（先启动服务） |
| 直线路径、双向箭头、2D / 3D 方向选择、参数修改及框选删除 | `uv run --with playwright python tests/route_rendering_ui_smoke.py`（先启动服务） |
| 设备 Pose → 机器人六轴容差、IK、关节锁定与结果保存 | `npm run test:mobile-solve` |
| 设备姿态求解界面、真实 URDF、应用、刷新与 ZIP 导出 | `uv run --with playwright python tests/mobile_teaching_solver_ui_smoke.py`（先启动服务） |
| 失败原因、旧报告补充提示、临界容差与窄屏显示 | `BASE_URL=http://127.0.0.1:22008 uv run --with playwright python tests/mobile_teaching_diagnostics_ui_smoke.py`（先另开 Vite 开发服务，使用端口 22008） |
| 参考起始姿态选择、预设库、后台初值及刷新恢复 | `uv run --with playwright python tests/mobile_teaching_reference_ui_smoke.py`（先启动服务） |
| 单相机分配、双臂同帧运动、共用停车点及预览保存一致性 | `uv run --with playwright python tests/mobile_teaching_assignment_ui_smoke.py`（先启动服务） |
| 多停车点、胸部升降、旧报告迁移与后台版本错误提示 | `uv run --with playwright python tests/mobile_teaching_parking_ui_smoke.py`（先启动服务） |
| 大型工程缓存、刷新、服务重启恢复与空间转换 | `uv run --with playwright python tests/large_workspace_storage_smoke.py`（先启动服务） |
| 后台计算进度、逐点虚影、暂停继续、取消重算与历史预览 | `uv run --with playwright python tests/mobile_teaching_background_ui_smoke.py`（先启动服务） |
| Mac 接收地图一致性、弹窗与重复接收 | `uv run --with playwright python tests/ipad_model_consistency_ui_smoke.py`（先启动服务） |
| iPad 原生网络、坐标与几何 | `npm run test:ipad:native`（macOS） |
| USB 设备检测、传输中断、模型校验及原生文件接收 | `npm run test:ipad:usb`（macOS 同时运行 Swift 校验） |
| 电脑端 USB 发送入口与状态 | `BASE_URL=http://127.0.0.1:22025 uv run --with playwright python tests/ipad_usb_ui_smoke.py` |
| 二维码配对 / 结果同步 | `npm run test:ipad:qr` |
| Bonjour 发现 | `npm run test:ipad:discovery`（macOS） |
| 示教转换 | `npm run test:transfer` |
| 模型坐标、裁剪、降采样与 PLY 往返 | `npm run test:model-editor` |
| 双模型姿态、旋转包络替换、合并与属性 / PLY 完整性 | `npm run test:model-composition` |
| 双模型入口、加载、三维姿态、替换 / 合并、保存与响应式页面 | `uv run --with playwright python tests/model_pair_editor_ui_smoke.py`（先启动服务） |
| 双模型分区加载、独立预览、开始编辑、重试与连续选文件 | `uv run --with playwright python tests/model_pair_loading_ui_smoke.py`（先启动服务） |
| A / B 独立显示质量、点面预算、设置保留与完整导出 | `uv run --with playwright python tests/model_pair_quality_ui_smoke.py`（先启动服务） |
| 模型编辑页面、预览、导出与导航 | `uv run --with playwright python tests/model_editor_ui_smoke.py`（先启动服务） |
| 模型缺失时返回欢迎页、清理失效状态与重新导入 | `uv run --with playwright python tests/model_editor_missing_model_ui_smoke.py`（先启动服务） |
| 六面裁剪框、取内 / 取外确认、橘黄色虚影与裁剪导出 | `uv run --with playwright python tests/model_editor_crop_ui_smoke.py`（先启动服务） |
| 模型 PLY 系统保存、文件名与目录选择、取消、写入失败及下载兼容 | `uv run --with playwright python tests/model_editor_export_save_ui_smoke.py`（先启动服务） |
| 模型编辑鼠标旋转 / 平移 / 缩放、显示质量与完整导出 | `uv run --with playwright python tests/model_editor_viewport_ui_smoke.py`（先启动服务） |
| 单 / 双模型切换移动、旋转、浏览模式保留视角与高倍缩放 | `uv run --with playwright python tests/model_editor_mode_view_ui_smoke.py`（先启动服务） |
| 三页旋转灵敏度、平移方向、Shift 切换与深度缩放一致性 | `uv run --with playwright python tests/viewport_navigation_ui_smoke.py`（先启动服务） |
| 模型原点三维移动 / 旋转、数值双向同步、取消与导出一致性 | `uv run --with playwright python tests/model_editor_origin_gizmo_ui_smoke.py`（先启动服务） |
| 模型编辑 Esc 退出、Ctrl / Cmd + Z 撤销、参数分组与导出一致性 | `uv run --with playwright python tests/model_editor_shortcuts_ui_smoke.py`（先启动服务） |
| 示教回放顺序与首姿态恢复 | `npm run test:playback` |
| 躯干高度 / yaw / pitch 联动与关节限位 | `npm run test:torso` |
| 胸甲双击、三轴拖拽、撤销 / 取消与工程恢复 | `uv run --with playwright python tests/torso_control_ui_smoke.py`（先启动服务） |
| 示教姿态编辑与躯干调整回写 | `uv run --with playwright python tests/teaching_pose_edit_smoke.py`（先启动服务） |
| 机器人 v11 导出适配 | `npm run test:abx-v11` |
| 机器人任务与完整路网导出 | `npm run test:abx-bundle` |
| 清理与数据保护 | `node tests/clean_build_smoke.mjs` |
| 构建脚本参数与失败处理 | `node tests/build_scripts_smoke.mjs` |
| iPad 部署脚本的设备选择、签名校验与失败保护（模拟 Apple 工具，不安装真机） | `python3 tests/ipad_deploy_script_smoke.py` |

<details>
<summary>iPad 命令、模拟器与真机 UI 验证</summary>

```bash
npm run test:ipad         # 模型、局域网协议、配对、结果重试、工程保存和坐标变换
npm run test:ipad:native  # macOS 上执行同一份 Swift 网络与本地存储代码
npm run test:ipad:qr      # Apple Vision 识别二维码 → Swift 接收模型 / 返回结果，核对模型和重试
npm run test:ipad:discovery # macOS 实际 Bonjour 发现、服务校验、去重与取消测试
xcrun swiftc ipad/AtlasTeaching/TeachingModels.swift ipad/Tests/main.swift -o /tmp/atlas-ipad-coordinates
/tmp/atlas-ipad-coordinates /tmp/atlas-ipad-swift-result.json
# 启动测试端口（npm run dev -- --port 22001）后，使用装有 Playwright 的 Python：
BASE_URL=http://127.0.0.1:22001 python tests/ipad_teaching_ui_smoke.py
# 电脑服务运行在 21990 时，Xcode 中 Product → Test：
# 模拟器验证原生接收、横竖屏控件可见性、离线重开以及不冒充 LiDAR 采样。
```

</details>

<details>
<summary>示教转换：数据、浏览器与三维操作回归</summary>

- 数据转换回归：`npm run test:transfer`。
- 矩阵导入界面回归：`uv run --with playwright python tests/teaching_transfer_matrix_ui_smoke.py`，覆盖示例 TXT、重复加载、错误输入保留、手动微调、矩阵放置与提取回写。
- 重复矩阵确认回归：`uv run --with playwright python tests/teaching_transfer_matrix_repeat_ui_smoke.py`，覆盖按数值识别、取消 / Esc、焦点隔离、重载纠错、叠加乘法顺序、定位基准、刷新恢复和旧绑定关系。
- 浏览器流程回归：启动服务后运行 `uv run --with playwright python tests/teaching_transfer_ui_smoke.py`，覆盖点击放置、区域提取、精调回写、重复回写、并发修改保护及工程目录保存。
- 三维操作回归：`uv run --with playwright python tests/teaching_transfer_3d_ui_smoke.py`，验证真实手柄拖拽、旋转、表面定位、裁剪盒调整、视角隔离与隐藏机器人的位姿转换。

</details>

<details>
<summary>机器人导出：大脑契约与浏览器验证</summary>

- 默认导出及显式 v11 兼容回归：`npm run test:abx`；扩展工程格式与执行计划回归：`ABX_WORKSPACE_ZIP=ABXBrainSystem.zip npm run test:abx-extended`。
- `test:abx` 同时验证重名站点、非连续编号、停车标记复用、缓存名称迁移和独立示教坐标往返；当前目录存在 `1019平地路网终版测试.json` 时使用其 40 个节点与 92 条边验证。完整界面流程为 `tests/abx_route_identity_ui_smoke.py`。
- 新的随包路网契约测试默认只读打开当前目录 `ABXBrainSystem.zip`，仅把原版导入器及其依赖复制到临时目录，不改动原始 ZIP。也可用 `ABX_WORKSPACE_ZIP` 指定压缩包，或 `ABX_BRAIN_ROOT` 指定只读参考代码路径；仍支持旧 `workspace.zip` 的源码目录布局。
- 测试在临时数据库验证 v23 导入、路网恢复、再导出、导航 / Pose 执行计划和校验失败，并用大脑原生 Web ZIP 读取器验证实际导入包。
- 禁止临时目录外写入、服务连接及子进程，关闭 Python 字节码写入，并核对参考源码摘要；不修改 `workspace` 或向运行中的大脑提交任务。
- 界面回归为 `tests/abx_teaching_export_ui_smoke.py`（需要 Python Playwright 与 Chrome），使用独立浏览器会话验证下载、坐标、错误处理和布局。

</details>

## iPad 画面协作回归

<details>
<summary>画面协作协议、USB 助手与真机用例</summary>

服务与原生协议回归：`npm run test:ipad:screen`，覆盖 Windows 助手的 TCP usbmux 协议、仅 USB 设备筛选、权限和连接生命周期，以及配对过期/更新/占用、无线帧与关节传输、后台保活和断线；macOS 额外使用 Apple Vision 识别真实协作二维码并通过 Swift 网络客户端连接。

双向邀请回归：`node tests/ipad_screen_invitation_smoke.mjs` 验证确认前禁止传输、双向接受/拒绝、取消、超时、拔线、重复邀请及多浏览器竞争；Windows 助手同类测试包含在 `python3 -B tests/ipad_usb_bridge_smoke.py`。真机联调使用独立测试服务运行 `ATLAS_SCREEN_LIVE=1 BASE_URL=http://127.0.0.1:22041 uv run --with playwright python tests/ipad_screen_invitation_ui_smoke.py`，输出 `INVITATION_BROWSER_READY` 后以 `TEST_RUNNER_ATLAS_USB_INVITATIONS_LIVE=1` 运行原生 `testLiveUSBBidirectionalInvitations`。测试使用独立浏览器与临时模型，验证真实双端弹窗和确认后的画面传输。

Windows 助手浏览器回归：用局域网 `BASE_URL` 运行 `tests/ipad_usb_bridge_ui_smoke.py`，验证下载包、独立浏览器工程、双臂与 3D 帧、关节、视角、Pose、后台保活、重连和工程导出，断言画面不请求服务器、工程未上传。测试使用 Windows usbmux TCP 协议设备替身；Windows 的 Apple 驱动与实际线缆仍需在目标 Windows 电脑验证。

助手的 iPad 真机记录回归：运行 `python3 src/server/ipadUSBBridge.py`，在原有 `tests/ipad_screen_capture_ui_smoke.py` 真机环境变量上增加 `ATLAS_SCREEN_BRIDGE=1` 并使用局域网 `BASE_URL`，搭配原生 `testLiveScreenPoseCapture` 验证缺少任务/停车点提示和双页记录 Pose。

真机界面回归使用 `tests/ipad_screen_ui_smoke.py`，需 `ATLAS_SCREEN_LIVE=1` 与 `BASE_URL`。有线模式自动连接；无线模式额外设置 `ATLAS_SCREEN_WIFI=1 ATLAS_SCREEN_DEVICE_ID=<iPad UDID>`，模拟 Windows 连接选项并输出 `build/ipad-screen-test/pairing.json`。将其中的地址与配对码传给 `xcodebuild test` 的 `TEST_RUNNER_ATLAS_SCREEN_LAN_ADDRESS`、`TEST_RUNNER_ATLAS_SCREEN_LAN_CODE`，运行原生 `testLiveScreenWiFiCollaboration` 验证相机与后台恢复。USB 只用于真机调试和读取诊断状态，协作帧通过 Wi-Fi 发送。

关节真机回归运行原生 `testLiveScreenJointControl` 并设置 `TEST_RUNNER_ATLAS_SCREEN_LIVE=1`；电脑脚本增加 `ATLAS_SCREEN_JOINTS=1 ATLAS_SCREEN_NATIVE_STOP=1 ATLAS_SCREEN_HOLD=120`。无线模式同时传入上述地址与配对码。检查 iPad 实际滑块拖动、电脑数值、指令确认、3D 画面变化、电脑反向修改、横竖屏与子页切换。

</details>

## 表面折线示教回归

<details>
<summary>折线示教的专用测试命令与覆盖范围</summary>

匀速与圆角回归 `tests/polyline_uniform_speed_smoke.mjs` 验证实际 BOTX 双臂 TCP 巡航速度、总精度容差、关节／底盘速度与加速度、闭合与部分进度、折返停车及关闭选项；工作线程规划、勾选状态、执行锁定、撤销、ZIP 导出与恢复使用 `tests/polyline_uniform_speed_ui_smoke.py`。

重复执行回归 `tests/polyline_replay_smoke.mjs` 验证缓存轨迹的精确逆向返回与正向回放、四种底盘模式、圆角／严格／闭合／最大保障和进度颜色；`tests/polyline_replay_ui_smoke.py` 验证无需新规划进程、旧橘色笔迹清除、返回不染色、暂停继续保留进度、多轮重播与配置变更失效。

保存折线的取消选择、300 mm/s 默认值、新建／刷新参数记忆、已保存记录参数优先、邻近新折线检查、列表高亮、窄屏布局、撤销、原记录保留、外部入口及 Esc 优先级使用 `tests/polyline_selection_ui_smoke.py`。参数边界、持久化内容隔离及损坏／不可用存储恢复由 `tests/polyline_preferences_smoke.mjs` 验证，并包含在 `npm run test:polyline` 中。

逐段起始虚影的边界采样、圆滑／严格折线、闭合、最大保障与重复执行包含在 `tests/polyline_replay_smoke.mjs` 中；逐段累积、提前停止、底盘同步、顶层显隐及清理使用 `tests/polyline_segment_ghost_ui_smoke.py`。

线段内进度的画面回归：`BASE_URL=http://127.0.0.1:<端口> uv run --with playwright --with pillow python tests/polyline_progress_ui_smoke.py`，使用真实截图像素验证有／无表面警告的线段在检查后、走到段内、暂停显隐、结束及重播时的青绿／橘黄分界，同时保留文字警告。

核心回归：`npm run test:polyline`（包含四种底盘模式、真实 BOTX 运动学、预定位碰撞和速度边界）。浏览器回归：启动 Vite 开发服务后运行 `BASE_URL=http://127.0.0.1:<端口> uv run --with playwright python tests/polyline_teaching_ui_smoke.py`；网格瑕疵警告与继续执行使用 `tests/polyline_surface_warning_ui_smoke.py`；底盘互斥选择、实际底盘回放、暂停继续、工程恢复及 ZIP 保存使用 `tests/polyline_base_ui_smoke.py`。

右侧与示教数据中心的独立折线预览、选择与回放、跨页自动检查、无停车点工程恢复、失败不运动及混合任务分别播放，使用同一开发服务运行 `tests/polyline_sidebar_ui_smoke.py`。

折线示教内的双臂末端双击、姿态输入、手柄拖动／撤销、取点和视角操作共存，以及路径失效和回放锁定，使用 `tests/polyline_end_effector_ui_smoke.py`。

腰部协同的双臂关节策略、临时腰部权限与其他关节锁定、真实 BOTX 插值、速度／限位、相机碰撞和连续前缀验证包含在 `npm run test:polyline` 中；勾选后自动参与、退出后全局锁定／解锁状态保留、完整／部分回放与工程恢复使用 `tests/polyline_waist_ui_smoke.py`。

接近碰撞诊断、自动绕行、连续插值、最大保障前缀、不可执行 P0、初始碰撞与取消计算包含在 `npm run test:polyline` 中；工作线程搜索、保存折线参考与来源提示、紫色接近预览显隐、固定底盘回放和接近阶段不累计划线进度使用 `tests/polyline_approach_ui_smoke.py`。诊断回归还包含同一初始姿态下“旧线可执行、相距 50 mm 的新线被全部通用绕行拒绝、参考旧线后通过”的窄通道样例，以及新 P0 真实碰撞时仍拒绝执行、部分划线、搜索取消和候选数量边界。

工具轴方向、旧相机模式的偏移兼容、零距离和真实 BOTX 镜像工件／姿态的碰撞与回放对照包含在 `npm run test:polyline` 中；相机／长杆探针模型下的方向即时生效、切换机械臂、撤销、保存及重新打开使用 `tests/polyline_tool_direction_ui_smoke.py`。

`tests/polyline_approach_diagnostics_smoke.mjs` 验证预留区与碰撞体重叠／包含的区分，且确认保守检查结果不变；另用同一目标、固定底盘和工具朝向验证“直连接近失败，但 P0、后续划线和单独指定的绕行路线均可行”，避免将单条接近路线失败当作不可达证明。冗余关节样例还验证左右臂的工件碰撞恢复：直连接近因中间部件进入 8 mm 预留区而失败时，可通过保持该部件的关节、使用另一可动关节完成接近和划线；整条回放仍接受原碰撞、底盘、朝向、关节锁定和插值检查。

`tests/polyline_optimization_smoke.mjs` 验证工件索引共享且候选状态独立、有限预算内优先覆盖较大绕行、局部回退后的真实连续回放与锁定关节、取消、成功姿态参考与失效规则，以及新 P0 碰撞时仍拒绝执行。可通过 `POLYLINE_BASELINE` 指向修改前的 `polylineTeachingApproach.js`，运行相同合成场景的前后对照；耗时只报告实测值，不作为测试门槛，也不代表用户具体场景的成功率。

算法参数的旧记录默认值、有效范围、参数记忆以及自定义时限／候选数／局部重试预算实际生效包含在 `npm run test:polyline` 中。`tests/polyline_parameters_ui_smoke.py` 验证折叠布局、问号位置与说明、空值／整数／越界提交、参数生效范围、工作线程收到的配置与搜索停止原因、执行中禁止修改但允许查看说明、恢复默认与撤销、工程导出和打开记录、刷新记忆及小窗口布局。

最大保障的连续前段规划、线段内部限位／碰撞、插值碰撞、闭合边、到起点失败和停止速度验证包含在 `npm run test:polyline` 中；勾选互斥状态、实际部分回放、保存与数据中心自动回放使用 `tests/polyline_partial_ui_smoke.py`。

逆解失败后的可行虚影搜索回归包含在 `npm run test:polyline` 中；真实点选、原位姿态建议、底盘位置建议、显隐、失效清除、主动采用和重新执行使用 `tests/polyline_suggestion_ui_smoke.py`。

</details>

---

[文档目录](README.md) · [项目首页](../README.md)
