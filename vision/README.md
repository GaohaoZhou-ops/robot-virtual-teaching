# Vision Pro 空间工作台

原生 visionOS App「Atlas 空间工作台」。打开工程后先识别现场地面，将地图原点放在脚下，再以 1:1 比例查看地图、机器人和示教模型。

[项目首页](../README.md) · [全项目文档](../docs/README.md) · [Xcode 工程](AtlasVisionTeaching.xcodeproj)

## 开始使用

1. 启动电脑工作台，在头显选择设备同步当前工程；也可载入头显本机工程或导入工程文件。
2. 进入 3D 空间并允许空间感知。识别到唯一稳定地面时自动放置；多个候选时注视绿色区域并捏合确认。
3. 使用「沉浸游走」控制卡片切换沙盘、回放和双 Zivid 取景。找不到卡片时，抬起左手点击「唤回控制」。

地面网格默认开启；靠近已感知的前方障碍物时，真实环境逐渐显现。完整操作和识别限制见 [沉浸游走指南](docs/project-workspace.md#沉浸游走)。

## 按任务查阅

| 想做什么 | 文档 |
| --- | --- |
| 导入、同步和使用完整地图工程 | [完整工程与沉浸游走](docs/project-workspace.md) |
| 调整地面、网格、颜色、窗口召回与双相机 | [空间操作](docs/project-workspace.md#沉浸游走) · [唤回控制](docs/project-workspace.md#唤回控制窗口) |
| 对单个工件记录虚拟相机视点 | [历史单模型示教](docs/virtual-camera.md) |
| 启动模拟器、编译、签名或连接真机 | [开发与部署](docs/development.md) |
| 查找测试命令或历史验证范围 | [构建与验证](docs/development.md#构建与验证) · [验证记录](docs/validation-history.md) |

## 在 Mac 上启动模拟器

需要完整 Xcode、visionOS Simulator 运行时及 Python 3。从仓库根目录执行：

```bash
./scripts/run-vision-simulator.sh start
# 修改代码后重新编译、安装并重启
./scripts/run-vision-simulator.sh start --rebuild
```

最低 visionOS 2.0；系统双手操控使用 visionOS 26。设备选择、模拟器演练和真机签名见 [开发文档](docs/development.md)。模拟器用于界面与流程验证，实际空间感知、手势和佩戴体验需在真机验证。

<details>
<summary>原章节快捷入口</summary>

| 原章节 | 新文档 |
| --- | --- |
| <a id="启动与完整工程"></a>启动与完整工程 | [工程入口](docs/project-workspace.md#启动与完整工程) |
| <a id="沉浸游走"></a>沉浸游走 | [地面对齐、网格与游走](docs/project-workspace.md#沉浸游走) |
| <a id="构建与工作台验证"></a>构建与工作台验证 | [工作台验证](docs/development.md#构建与工作台验证) |
| <a id="历史单模型示教"></a><a id="虚拟相机示教"></a>历史单模型 / 虚拟相机 | [虚拟相机示教](docs/virtual-camera.md) |
| <a id="注视与捏合操作"></a>注视与捏合操作 | [手势说明](docs/virtual-camera.md#注视与捏合操作) |
| <a id="位姿含义"></a>位姿含义 | [坐标约定](docs/virtual-camera.md#位姿含义) |
| <a id="在-mac-上用模拟器调试"></a>模拟器调试 | [模拟器说明](docs/development.md#在-mac-上用模拟器调试) |
| <a id="真机接入"></a>真机接入 | [真机签名与联调](docs/development.md#真机接入) |
| <a id="构建与验证"></a>构建与验证 | [构建和测试](docs/development.md#构建与验证) |
| <a id="实现范围"></a>实现范围 | [单模型能力范围](docs/virtual-camera.md#实现范围) |
| <a id="空间相机首版预检2026-10-26"></a><a id="上一版预检记录2026-10-08"></a>预检记录 | [历史验证记录](docs/validation-history.md) |

</details>
