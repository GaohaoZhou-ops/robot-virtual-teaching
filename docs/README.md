# 文档目录

[项目首页](../README.md) · [Vision Pro 首页](../vision/README.md)

首次使用按 **启动服务 → 完成一次示教 → 保存工程** 阅读。日常操作、设备连接与开发维护分别查阅下表；详细参数和历史记录保留在主题页的折叠区。除非另行说明，命令均从仓库根目录执行。

## 开始使用

| 文档 | 内容 |
| --- | --- |
| [项目概览](overview.md) | 示教模式、平台能力和适用范围 |
| [安装、启动与服务管理](getting-started.md) | 环境、安装、访问地址、端口和更新服务 |
| [示教流程与模式转换](teaching-workflow.md) | 首次示教、局部工位放入地图、区域精调与回写 |

## Web 工作台

| 文档 | 内容 |
| --- | --- |
| [工作台操作](workbench.md) | 页面入口、模型编辑、视角、快捷键和 SpaceMouse |
| [机器人控制与任务](robot-control.md) | 关节、末端、姿态库、停车点、记录与回放 |
| [点云、切片与导航](maps-and-navigation.md) | 显示质量、Z 切片、导航点和有向路径 |
| [表面折线示教](surface-teaching.md) | 选点、工具偏移、算法参数、路径检查与划线 |
| [相机大图](cameras.md) | 双 Zivid 取景、交互、位姿反算和碰撞提示 |

## 设备与协作

| 文档 | 内容 |
| --- | --- |
| [连接与协作](collaboration.md) | 浏览器同步、iPad 画面协作、扫码、Wi-Fi 和 USB |
| [iPad / iPhone AR 示教](mobile-teaching.md) | 接收物体、放置、逐 Pose 采集和结果传回 |
| [移动端显示与编辑](mobile-display.md) | Pose 回看、地面辅助、重新放置、覆盖与质量上限 |
| [设备 Pose 转机器人姿态](mobile-robot-solving.md) | 电脑端求解、停车规划、报告和应用结果 |
| [Vision Pro 空间工作台](../vision/README.md) | 完整工程、沉浸游走、手腕召回、地面网格和历史相机示教 |

## 工程、开发与维护

| 文档 | 内容 |
| --- | --- |
| [工程保存与交换](projects.md) | 自动保存、恢复、JSON / ZIP、完整工程目录 |
| [机器人示教数据导出](robot-export.md) | 导出前检查、机器人文件交换和数据格式 |
| [本地构建与设备部署](development.md) | Web / 原生构建、iPad / iPhone 签名、模拟器与安装 |
| [代码结构与模块边界](architecture.md) | 功能归属、依赖规则、服务装配与新增代码约定 |
| [集群计算与物理后端](compute-backends.md) | 停车点集群计算、Isaac Sim / PhysX |
| [缓存清理与兼容性](maintenance.md) | 清理范围、数据保护和历史名称 |
| [测试与回归](testing.md) | 各功能测试入口、平台依赖及专用用例 |

## 文档维护

新增说明写入对应主题页，并在本目录补充入口。项目首页保留简介、快速启动和常用跳转；较长的参数表、实现细节及测试记录使用主题页或折叠区。
