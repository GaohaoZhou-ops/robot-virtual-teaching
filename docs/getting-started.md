# 安装、启动与服务管理

[文档目录](README.md) · [项目首页](../README.md)

文中的命令均从仓库根目录执行。

[环境与资源](#环境与资源) · [安装与访问](#安装与访问) · [服务管理](#服务管理)

<a id="快速启动"></a>

## 环境与资源

| 项目 | 要求 |
| --- | --- |
| Web 服务 | Node.js、npm；服务脚本使用 Bash |
| 浏览器 | 支持 WebGL；浏览器条件见[工程目录与权限](projects.md)和 [SpaceMouse](workbench.md#spacemouse) |
| 克隆仓库 | 安装 Git，以下 SSH 地址需要已配置 GitHub SSH 认证 |
| 机器人模型 | 自行放入根目录 `robots/`，包括模型及网格资源；该目录不随 Git 分发 |
| 机械臂控制 | 需要包含关节定义的 URDF 模型，才能使用关节控制与 IK 示教 |

## 安装与访问

```bash
git clone git@github.com:GaohaoZhou-ops/robot-virtual-teaching.git
cd robot-virtual-teaching
npm install
./scripts/start.sh
```

已有检出可在现有项目目录执行 `npm install` 与启动脚本，本地文件夹名称可以保留。

| 访问位置 | 地址 |
| --- | --- |
| 本机 | `http://127.0.0.1:21990` |
| 同一局域网内的设备 | `http://<运行服务机器的局域网IP>:21990` |

启动和状态脚本会列出检测到的可访问地址。默认监听所有网卡；请使用可信网络，并允许 Node.js 接收入站连接。

## 服务管理

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `./scripts/status.sh` |
| 启动 | `./scripts/start.sh` |
| 重启 | `./scripts/restart.sh` |
| 停止 | `./scripts/stop.sh` |
| 使用其他端口 | `./scripts/restart.sh 22000` |

服务在独立的后台会话中运行，启动命令结束或终端关闭不会一并停止服务；请用停止脚本关闭。启动与状态检查会直连本机地址，不受 HTTP 代理设置影响。

| 配置项 | 用途 |
| --- | --- |
| `MAP_STUDIO_PORT` | 覆盖默认端口，也可使用启动 / 重启脚本的第一个参数 |
| `MAP_STUDIO_HOST` | 覆盖监听地址 |

> **运行与更新**：启动脚本构建并运行 `build/service/` 中的固定版本，修改源代码和构建 `dist/` 不会刷新正在示教的页面。更新服务请执行重启脚本；已打开的工作台保持本地操作，手动刷新才使用新版本，并继续恢复本设备已有工作现场。同步授权在服务重启后需要重新申请。

开发调试可用 `ATLAS_DEV_HMR=1 npm run dev -- --port 21991` 开启热更新，请与供同事使用的 21990 服务分开。

---

[文档目录](README.md) · [项目首页](../README.md)
