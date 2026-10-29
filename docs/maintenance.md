# 缓存清理与兼容性

[文档目录](README.md) · [项目首页](../README.md)

文中的命令均从仓库根目录执行。

[🧹 清理编译产物与缓存](#-清理编译产物与缓存) · [🕰️ 历史命名与兼容性](#-历史命名与兼容性)

<a id="清理编译产物与缓存"></a>

## 🧹 清理编译产物与缓存

构建和测试结束后可运行以下脚本。脚本按自身位置定位仓库，需要 Node.js，无需安装 npm 依赖。

```bash
./scripts/clean_build.sh --dry-run  # 预览范围与大小
./scripts/clean_build.sh            # 执行清理
```

| 处理方式 | 范围 |
| --- | --- |
| 清理 | Web / iPad / Vision Pro 构建产物、仓库内工具缓存、可再生成渲染缓存、测试结果与临时测试程序 |
| 保留 | 工程 JSON、完整 `.atlas-project` 目录 / ZIP、恢复工程、源点云、机器人资源 |
| 保留 | `node_modules`、Xcode / 签名配置、`.atlas-cache/ipad-teaching/`、浏览器存储 |
| 条件保护 | 跟踪文件、Pose、无法确认可再生成的模型所在目标，及不满足源文件摘要校验的地图副本 |

`ipad/test-artifacts/`、`vision/test-artifacts/` 等测试输出目录会逐项检查：原生任务 JSON / ATLS 快照单独保留，同级测试报告、录像、截图和编译缓存继续清理。完整工程目录、设备导出容器，以及可能引用图片等相对资源的工程 / Pose 配置目录仍整体保留。`--dry-run` 使用同样规则，仅列出处理结果。

脚本不停止服务；运行中的日志和 PID 会保留。清理后可用 `./scripts/restart.sh` 重建前端缓存。

`.gitignore` 按依赖缓存、构建产物、本地运行状态、测试产物及工程导出分类。浏览器截图、录像和追踪包按测试输出目录，或根目录与 `tests/` 下的 `atlas-` / `transfer-` 文件名限定范围，测试报告、截图和下载目录的 ZIP 打包文件也按明确路径忽略。

新增检查的日志、报告和临时运行器统一放在 `build/<任务>/`，截图与下载放在 `test-artifacts/<测试>/`。忽略规则也覆盖 `tests/unit/`、`tests/integration/` 等测试目录下的标准产物目录与打包副本；`tests/fixtures/` 和各测试套件内的 `fixtures/` 保留工程格式输入。历史输出名称继续兼容，不再为每次验证追加专用规则。

Vision Pro 空间相机调试产物保存在 `vision/build/spatial-editor/` 与 `vision/test-artifacts/`；单独复制到根目录、`tests/` 或 `vision/` 的 `atlas-spatial-*-attachments` 附件目录、编号重试副本及 ZIP 也会忽略。`vision/` 下的 `atlas-spatial-*` PNG、MP4、WebM 截图录像保留在本机，同名嵌套测试样例和设计素材仍可跟踪。

沉浸式工程的构建与验证输出使用 `vision/build/workbench*` 和 `vision/test-artifacts/workbench/`。Xcode 生成的 `vision/AtlasVisionTeaching/WebWorkbench/` 及其 ZIP 副本不提交；根目录、`tests/` 或 `vision/` 下的 `atlas-vision-scene-*`、`atlas-vision-workbench-*` 临时目录与 ZIP，以及 `VisionWorkbenchImports/` 工程导入缓存也保留在本机，嵌套测试夹具仍可跟踪。

根目录中的本地参考文件 `sample-pre-teaching-pose.json`、`pre-teaching-pose.json`、`position_[0-9]*.txt`、`1014平地路网终版.json`、`1019平地路网终版测试.json`、`380B平地巡检.zip`、`ABXBrainSystem.zip` 及其同名解压目录，以及另存为目录 `saved-project/` 和 `saved-project.zip` 保留在本机。预设与转换矩阵回归使用 `tests/fixtures/` 下的独立样例；路网与机器人导出测试包含独立构造的样例，本地参考文件存在时额外校验真实格式，提交后无需依赖这些根目录文件。动作排序和路网映射 UI 测试产生的 `atlas-insert-action-*`、`atlas-route-identity-*` 临时目录及归档在根目录或 `tests/` 下也会被忽略。

姿态计算导出的 `mobile-solve-*.json` 诊断报告，以及根目录恢复工作区的 `recovered-projects.zip` / `recovered-projects-*.zip` 打包副本保留在本机；测试夹具中的同名 JSON / ZIP 仍可跟踪。

倾斜矩阵路网导出回归产生的 `atlas-tilted-route-*` 临时目录与 ZIP、`atlas-tilted-*.json` 坐标快照，以及 `atlas-current-route-height-check.json` 路网诊断副本，在根目录或 `tests/` 下忽略；回归脚本与夹具仍可跟踪。

独立示教导出格式选择回归产生的 `atlas-independent-export-*` 临时目录及 ZIP 副本，在根目录或 `tests/` 下忽略；其中下载的任务 ZIP 与示教 JSON 保留在本机，嵌套测试夹具仍可跟踪。

ZIP 导入、独立浏览器及机器人导入契约测试的 `atlas-import-*`、`atlas-independent-test-*`、`atlas-abx-bundle-*` 临时目录及 ZIP 副本，以及协作状态与独立示教状态快照，在根目录或 `tests/` 下忽略。根目录的 `ABXBrainSystem-*` 解压目录和重新打包副本也保留在本机。

Pose 批量编辑、标题栏布局和 M70 取景对照检查使用的 `atlas-pose-batch-*`、`atlas-pose-header-*`、`atlas-ipad-fov-review-*` 临时目录及 ZIP 副本，在仓库根目录、`ipad/` 和 `tests/` 下均忽略；模型传输包的 `*.atls.zip` 压缩副本也保留在本机，测试夹具中的同名文件仍可跟踪。

工程保存目标测试的 `atlas-save-target-*` 临时目录，以及停车点名、路径名、距离警告与忽略关节检查的 `atlas-waypoint-names-*`、`atlas-path-names-*`、`atlas-distance-warning-*`、`atlas-ignore-joints-*` 临时目录及 ZIP 副本，在仓库根目录或 `tests/` 下也会被忽略，适用于 `TMPDIR` 指向仓库的情况；`tests/fixtures/` 中的对应输入仍可跟踪。

iPad 传输进度与电脑端模型一致性检查的 `atlas-transfer-progress-*`、`atlas-model-consistency-*` 临时目录，在仓库根目录、`tests/` 或 `ipad/` 下均会被忽略；原生网络、配对码、二维码和服务发现测试的临时目录也覆盖 `tests/`。

保留源码、锁文件、共享 Xcode 配置、设计素材及环境变量示例。本地 `robots/` 和 `recovered-projects/` 仅匹配仓库根目录，避免屏蔽测试夹具中的同名子目录。Web、iPad 和 Vision Pro 的测试夹具目录统一保留 PLY、ATLS、ABX、JSON 和 ZIP 输入，例外规则位于导出规则之后，同时覆盖目录直属文件和嵌套文件。可用 `git check-ignore -v --no-index -- 路径` 查看命中的规则；忽略规则不会删除本地文件。

<details>
<summary>删除条件与数据保护规则</summary>

- 清理范围包括 Web 的 `dist/`、日志目录 `build/`、Xcode 的 `ipad/build/` 和 `vision/build/`、仓库内 DerivedData、Vite/npm/Python 等工具缓存、`.atlas-cache/surfaces/` 等可再生成渲染缓存，以及 Web / iPad / Vision Pro 测试结果、截图、录像和临时原生测试程序。
- `dist/` 内由 `maps/` 复制的点云只有在源文件仍存在且 SHA-256 相同时才允许清理。
- 脚本使用明确的目录和文件规则，不依赖 `.gitignore` 删除。普通构建 / 缓存目录内发现 Git 跟踪文件、工程配置、Pose 或源模型时，整个目标保留；混合测试输出目录则递归检查，保留资料并继续清理独立产物。`.atlas-project`、`.xcappdata` 和含工程 / Pose 资源引用的目录保持完整，符号链接不会被跟随到仓库外。

- 保留工程 JSON、完整 `.atlas-project` 目录和 ZIP、恢复工程、源点云、机器人资源、`node_modules` 已安装依赖、Xcode/签名配置。
- `.atlas-cache/ipad-teaching/` 虽然位于缓存目录中，但包含配对凭据、同步校验所需的冻结模型及待接收结果，整体保留。
- 浏览器 IndexedDB 中混有未保存的配置/Pose，脚本不会直接清理浏览器存储，也不会访问 iPad 数据或仓库外的全局缓存。
- 脚本不停止服务；正在运行的服务日志和 PID 状态会保留，清理后可执行 `./scripts/restart.sh` 重建前端缓存。
- 清理回归使用 `node tests/clean_build_smoke.mjs`，在临时工程中验证实际删除、混合测试目录、原生 JSON 转义、资料与关联资源保护；构建脚本回归使用 `node tests/build_scripts_smoke.mjs`，验证跨工作目录、空格路径、真机 / 模拟器参数、缺失依赖安装及失败退出。

- 当前完整工程目录/ZIP 会携带地图、机器人及已采集的视觉资源，与仅记录模型指纹和 Pose 的轻量配置并非同一种保存形态。
- 清理脚本会完整保留这些已有工程，不通过删除其资源来缩小工程，也不改变现有保存格式。

</details>

<a id="历史命名与兼容性"></a>

## 🕰️ 历史命名与兼容性

- 项目早期以地图浏览和导航路径编辑为主，使用过 **Atlas Route Studio** 名称；当前项目名称为 **Robot Virtual Teaching（机器人虚拟示教工程）**，界面名称为“虚拟示教平台”。
- [chat.md](../chat.md) 保留最初的需求记录，当前功能和操作见[文档目录](README.md)。

| 现有标识 | 用途 |
| --- | --- |
| `atlas-route-studio` | npm 包名、浏览器存储键前缀 |
| `atlas-route-studio-project` | 工程归档格式标识 |
| `atlas.project.json` / `.atlas-project` | 工程入口与目录 / 归档命名 |
| `MAP_STUDIO_*` / `ATLAS_*` | 脚本及配套服务配置项 |
| `AtlasTeaching` | iPad 原生工程名称 |

这些标识承接已有工程、缓存和脚本的兼容性，不应随 GitHub 仓库改名直接替换。

[↑ 返回阅读导航](README.md)

---

[文档目录](README.md) · [项目首页](../README.md)
