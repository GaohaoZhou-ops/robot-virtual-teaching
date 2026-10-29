# 🤖 Robot Virtual Teaching

**机器人虚拟示教工程 · 从局部工位示教到完整地图任务编排**

在三维场景中调整机器人位姿、记录停车点与机械臂 Pose、检查视觉参考，完成任务回放和工程导出。提供浏览器工作台、iPad / iPhone AR 应用与 Vision Pro 空间工作台。

[GitHub 仓库](https://github.com/GaohaoZhou-ops/robot-virtual-teaching) · [完整文档](docs/README.md) · [Vision Pro](vision/README.md)

[![地图示教工作台：三维工位、机器人姿态、停车点任务树与 Zivid 仿真视图](images/map-teaching.png)](images/map-teaching.png)

地图示教工作台：在同一场景中调整机器人姿态、组织停车点任务，并检查相机取景。

<a id="核心能力"></a>

## 可以做什么

| 场景 | 入口 |
| --- | --- |
| 在完整地图或局部工位中组织机器人示教任务 | [项目概览](docs/overview.md) · [示教流程](docs/teaching-workflow.md) |
| 用 iPad / iPhone 记录相机参考 Pose，或与电脑协作 | [AR 示教](docs/mobile-teaching.md) · [画面协作](docs/collaboration.md) |
| 在 Vision Pro 中查看完整工程、沉浸游走和空间示教 | [Vision Pro 使用指南](vision/README.md) |

<table>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="docs/mobile-teaching.md"><img src="images/iPad.png" width="420" alt="iPad AR 示教：在真实工位中查看模型并记录相机 Pose"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="vision/README.md"><img src="images/vision-pro.png" width="182" alt="Apple Vision Pro 头显"></a>
    </td>
  </tr>
  <tr>
    <td align="center"><a href="docs/mobile-teaching.md"><strong>iPad · AR 示教</strong></a><br>现场放置工件，逐个记录相机参考 Pose</td>
    <td align="center"><a href="vision/README.md"><strong>Vision Pro · 空间工作台</strong></a><br>1:1 沉浸游走，查看机器人与双相机取景</td>
  </tr>
</table>

<a id="快速启动"></a>

## 快速启动

准备 Node.js、npm 和 Git，然后运行：

```bash
git clone git@github.com:GaohaoZhou-ops/robot-virtual-teaching.git
cd robot-virtual-teaching
npm install
./scripts/start.sh
```

已有检出直接在项目目录运行 `npm install` 与启动脚本。SSH 克隆需要配置 GitHub SSH 认证。

打开 **http://127.0.0.1:21990**；其他设备使用 **http://<电脑的局域网 IP>:21990**。机器人模型及网格资源自行放入 `robots/`，不随仓库分发。

下一步：[完成一次示教](docs/teaching-workflow.md) → [保存工程](docs/projects.md)。环境要求、服务更新与端口配置见 [启动说明](docs/getting-started.md)。

<a id="文档导航"></a>

## 按需阅读

| 想做什么 | 文档 |
| --- | --- |
| 调整模型、视角、机器人并记录任务 | [工作台操作](docs/workbench.md) · [机器人与任务](docs/robot-control.md) |
| 查看相机、编辑导航或表面折线 | [相机大图](docs/cameras.md) · [点云与导航](docs/maps-and-navigation.md) · [折线示教](docs/surface-teaching.md) |
| 同步设备或使用空间示教 | [设备协作](docs/collaboration.md) · [iPad / iPhone](docs/mobile-teaching.md) · [Vision Pro](vision/README.md) |
| 保存、恢复和对接机器人 | [工程管理](docs/projects.md) · [机器人导出](docs/robot-export.md) |
| 编译、部署、测试与清理 | [构建与部署](docs/development.md) · [测试](docs/testing.md) · [维护](docs/maintenance.md) |
| 扩展功能、调整目录与检查依赖 | [代码结构与模块边界](docs/architecture.md) |

更多主题见 [完整文档目录](docs/README.md)。设备采集结果与机器人执行数据的区别见 [能力边界](docs/overview.md) 和 [导出检查](docs/robot-export.md#导出前检查)。

<details>
<summary>原 README 章节快捷入口</summary>

操作细节已迁到主题文档，原章节书签仍可在这里找到对应入口。

| 原章节 | 新文档 |
| --- | --- |
| <a id="虚拟示教流程"></a>虚拟示教流程 | [示教流程](docs/teaching-workflow.md) |
| <a id="工作台详细操作"></a>工作台详细操作 | [工作台操作](docs/workbench.md) |
| <a id="相机大图交互"></a>相机大图交互 | [相机大图](docs/cameras.md) |
| <a id="独立示教与地图示教转换"></a>独立示教与地图示教转换 | [模式转换](docs/teaching-workflow.md#独立示教与地图示教转换) |
| <a id="ipad-pro-ar-逐-pose-示教"></a>iPad Pro AR 逐 Pose 示教 | [移动端示教](docs/mobile-teaching.md) |
| <a id="vision-pro-空间示教"></a>Vision Pro 空间示教 | [Vision Pro](vision/README.md) |
| <a id="工作会话自动保护"></a>工作会话自动保护 | [工程管理](docs/projects.md) |
| <a id="机器人示教数据导出"></a>机器人示教数据导出 | [机器人导出](docs/robot-export.md) |
| <a id="停车点集群计算"></a>停车点集群计算 | [集群计算](docs/compute-backends.md#停车点集群计算) |
| <a id="可选-isaac-sim--physx-物理后端"></a>Isaac Sim / PhysX | [物理后端](docs/compute-backends.md#可选-isaac-sim--physx-物理后端) |
| <a id="清理编译产物与缓存"></a>清理编译产物与缓存 | [缓存清理](docs/maintenance.md) |
| <a id="验证与回归"></a>验证与回归 | [测试入口](docs/testing.md) |
| <a id="历史命名与兼容性"></a>历史命名与兼容性 | [兼容性](docs/maintenance.md#历史命名与兼容性) |

</details>
