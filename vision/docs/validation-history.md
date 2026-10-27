# Vision Pro 验证记录

[Vision Pro 首页](../README.md) · [全项目文档](../../docs/README.md)

[空间相机首版预检（2026-10-26）](#空间相机首版预检2026-10-26) · [上一版预检记录（2026-10-08）](#上一版预检记录2026-10-08)

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

---

[Vision Pro 首页](../README.md) · [全项目文档](../../docs/README.md)
