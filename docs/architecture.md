# 代码结构与模块边界

[文档目录](README.md) · [测试与回归](testing.md)

本项目采用单仓库、按业务功能组织的模块结构。浏览器、Node 服务、计算 Worker 和原生应用有各自的运行环境；协议、数据格式和通用计算通过明确的共享模块复用。

## 目录职责

```text
src/
  app/                         应用入口、路由、工作台布局与跨功能协调
  features/
    workspace/                 工程导入导出、存储、恢复与同步适配
    teaching/                  示教任务、停车点、姿态与回放
      polyline/                表面折线算法与交互
      mobile/                  移动设备采集结果的求解与审核
    robot/                     模型、关节、IK、碰撞与机器人设置
    robot-twin/                真机连接、监控、媒体查看与孪生场景
    collaboration/             浏览器工程同步与 iPad 画面协作
    viewport/                  三维视口、场景对象、渲染与输入
    navigation/                地图路网、二维视图与连通性
    model-editor/              点云模型裁剪、拼合、编辑与导出
    cameras/                   虚拟相机、视觉覆盖与投影
    devices/                   iPad / Vision Pro 数据交换与工作台接入
  shared/
    protocols/                 客户端与服务端共用的协议、常量和校验
    geometry/                  通用几何处理
    robotics/                  跨模块的机器人基础规则
    utils/                     小型通用工具
    ui/                        无业务归属的组件与菜单上下文
  server/
    robots/                    机器人协议适配与只读代理
    devices/                   设备配对、发现、USB 与屏幕传输
    collaboration/             工程协作服务
    vision/                    空间场景共享
    workspace/                 工程服务标识与机器人静态资源
    physics/                   物理后端配置与代理
    http/                      HTTP 通用响应
    plugins.js                 服务装配入口
  usbBridge/                   可下载的 USB 助手网页与启动入口
  cluster/                     可导出的离线集群计算程序
ipad/                          iPad / iPhone 原生应用与原生测试
vision/                        Vision Pro 原生应用与原生测试
scripts/                       构建、启动、部署、验证入口
tests/                         自动化回归与小型固定输入
```

功能内部按需要设置 `ui/`、`model/`、`client/`、`hooks/`、`workers/`。`model/` 放与界面组件无关的数据处理和业务规则；`client/` 放通信适配；`hooks/` 管理 React 状态订阅及生命周期；Worker 入口与调用封装跟随所属功能。不要为了目录对称创建空层级。

## 依赖规则

1. `app` 组合功能并协调工程状态。功能模块不能反向导入 `app`。
2. `shared` 只能依赖其他共享模块及适用的外部库，不能反向导入功能或服务实现。
3. `server` 只依赖服务端模块与共享协议，不能通过浏览器业务模块复用实现。
4. 浏览器模块不能导入 `server` 或 Node 内置模块；业务数据处理模块不能导入 UI 或 Hook。
5. Worker 的依赖链不能到达 UI 或 Hook。通过消息协议交换数据，并在任务结束或取消时释放 Worker。
6. 模块之间不允许循环导入。跨功能调用使用明确的命名导出；需要双向调用时，在应用层协调，或提取真正共享的协议。

执行 `npm run check:architecture` 检查上述可静态判定的边界、导入环、相对模块路径，以及 `new URL(..., import.meta.url)` 指向的 Worker 和资源。检查器覆盖静态导入、再导出及字符串字面量动态导入；运行时拼接路径仍需通过构建和相应端到端测试验证。

## 关键扩展位置

| 需要修改的行为 | 入口 |
| --- | --- |
| 工程与协作协议之间的转换 | `src/features/workspace/client/workspaceSyncAdapter.js` |
| 几何缓存序列化与恢复 | `src/features/workspace/model/workspaceGeometry.js` |
| 回放运行状态转换 | `src/features/teaching/model/teachingPlaybackState.js` |
| 三维场景对象、交互辅助、着色与诊断 | `src/features/viewport/scene/` |
| 机器人连接、轮询和媒体队列 | `src/features/robot-twin/client/`、`model/` |
| 机器人上游请求与会话 | `src/server/robots/` |
| 服务注册顺序 | `src/server/plugins.js` |
| 对外接口与数据格式 | `src/shared/protocols/` |

`createWorkspaceSyncAdapter` 通过 `workspace` 和 `checkpoints` 接口读取当前工程、提交合并、安装归档和保存检查点。它不持有 React 状态；长时间传输期间的读取通过接口获取最新快照，不能在创建适配器时冻结整个工程。

视口的 `scene/` 模块分别管理配置、视角、碰撞几何、机器人显示、交互辅助、材质、停车虚影和坐标轴。继续提取交互逻辑时，应明确资源的创建者与销毁者，避免把大量闭包变量改为没有边界的通用上下文对象。

`App.jsx` 与 `PointCloudViewer.jsx` 仍包含较多流程协调代码。后续新增功能应落在所属模块；进一步拆分时，连同状态、订阅和清理职责一起迁移，避免只抽取 Hook 而让顶层继续接收所有高频更新。

## 服务与构建

`vite.config.js` 只保存构建、开发服务配置和插件装配调用。HTTP 路由和服务实现放在 `src/server/`。目前开发与预览仍通过 Vite 插件接入这些服务；将来替换服务宿主时，从服务装配与生命周期入手，不修改客户端协议。

资源 URL 保持 `/__atlas/...` 协议，由服务模块定义。源码目录名不属于持久化工程格式，不应存入工程文件或设备协议。

原生 Vision Pro 工作台使用 `scripts/build_vision_workbench.mjs` 独立构建 Web 资源，不加载桌面端服务插件。修改 Worker、动态导入或资源路径后，也应验证该构建。

## 多机器人扩展

当前部署目标是同一局域网内 2–4 台机器人、最多 4 个终端，保持单仓库内的模块分工即可。后续多终端共享采集与缓存应集中在 `server/robots/`；终端订阅、媒体解码与显示生命周期归 `features/robot-twin/`；双方共用的消息格式归 `shared/protocols/`。

本次结构整理没有改变轮询频率、缓存容量或媒体传输策略。进一步优化带宽时，应单独验证 4 台机器人 × 4 个终端下的上游请求数、带宽、显示延迟和内存，并覆盖终端退出后的资源释放。

## 测试与临时文件

新增无浏览器测试放入 `tests/unit/`，真实本地 HTTP／多模块协议测试放入 `tests/integration/`。孪生与工作协作测试已按此分类。现有根目录测试入口及平台测试继续兼容；迁移其他测试时同时更新辅助导入、npm 命令和文档。

- `npm run check`：架构检查、核心回归、生产构建，适合普通代码提交。
- `npm run test:extended`：算法、工程交换、设备协议等较完整的回归，不执行原生应用安装或真机控制。
- `npm run test:external`：需要机器人参考源码包的 ABX 导出与交换契约检查，通过 `ABX_WORKSPACE_ZIP` 指定输入；不包含在普通回归中。
- 各功能 `npm run test:*` 保留，便于定位和复跑失败项。
- 浏览器与原生测试按 [测试文档](testing.md) 执行；核心 CI 不替代真机验收。

持续集成配置位于 `.github/workflows/ci.yml`，在 Node 22、24 下运行核心检查。脚本与依赖锁文件一同维护。

构建和诊断结果放入 `build/<任务>/`，浏览器截图及报告放入 `test-artifacts/<测试>/`，一次性数据使用系统临时目录。维护的输入放入 `tests/fixtures/`。不要在仓库根目录继续创建按日期或个人操作命名的输出目录；已有 `.gitignore` 规则保留兼容，迁移旧输出位置后再删除对应规则。
