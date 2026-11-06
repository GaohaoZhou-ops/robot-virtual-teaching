# Mac 桌面版发包

桌面版将工作台、本地服务、Electron 运行时和 `robots/` 中的机器人资源一起封装成 `AtlasTeaching.app`。收件人无需检出工程，也无需安装 Node.js、npm 或 Python。当前运行时要求 macOS 13 或更新版本。

## 生成内部测试包

在 Mac 上准备 Node.js 22.12 或更新版本，确保 `robots/` 中包含要分发的模型，然后从工程根目录执行：

```bash
./scripts/build_mac.sh
```

脚本交互询问：

```text
请输入失效时间（北京时间，YYYY-MM-DD HH:mm）：2026-12-01 14:30
```

时间固定按北京时间解释，与构建机器或收件人的时区无关，精确到该分钟的第 0 秒。无效日期、过去的时间会要求重输。默认版本来自 `package.json`，默认架构与当前 Mac 一致。

需要指定版本、架构或自动化构建时：

```bash
./scripts/build_mac.sh --version 1.1.0 --arch arm64 --expires "2026-12-01 14:30"
```

- Apple Silicon Mac 使用 `--arch arm64`；Intel Mac 使用 `--arch x64`，两种包分别生成。
- 可用 `--validate-only` 只验证日期和参数；`--help` 查看所有选项。
- 首次构建会下载运行时；已有官方 Electron ZIP 时，可设置 `ATLAS_ELECTRON_ZIP_DIR` 指向所在目录。
- 默认不携带私人地图；如需示例，传入 `--sample-map /path/to/map.ply`。
- 构建不会重启现有 Web 服务，也不写入其 `build/service`。

产物位于 `build/macos/releases/AtlasTeaching-<版本>-<构建号>-<架构>-<签名方式>/`：

| 文件 | 用途 |
| --- | --- |
| `*.dmg` | 推荐分发；打开后将应用拖入 Applications |
| `*.zip` | 解压后直接打开应用 |
| `AtlasTeaching.app` | 已封装的应用 |
| `release.json` | 版本、统一期限、架构、运行时版本、包大小和 SHA-256 |
| `SHA256SUMS.txt` | 校验下载文件是否完整 |
| `使用说明.txt` | 可一同发给使用者的说明 |

存在 `BUILD_FAILED.txt` 的目录不可作为完成的发版使用。脚本不会覆盖已有发版。

当前机器人资源约 178 MB；Apple Silicon 首版 ZIP 约 195 MB、DMG 约 209 MB、解压应用约 450 MB，后续以该次 `release.json` 为准。地图和机器人资源增加时，体积会相应增长。

## 签名与首次打开

默认 `--signing internal` 使用本地 ad-hoc 签名，适合目前的内部试用。它没有 iOS 免费开发签名的 7 天安装期限，但未经 Apple 公证，其他 Mac 首次打开可能被 Gatekeeper 拦截，需要使用者在「系统设置 → 隐私与安全性」允许打开。不要将此包描述为已通过 Apple 安全检查。

已有 **Developer ID Application** 证书和 `notarytool` 钥匙串配置后，可使用保留的正式入口：

```bash
export ATLAS_SIGN_IDENTITY='Developer ID Application: Your Company (TEAMID)'
export ATLAS_NOTARY_PROFILE='your-notary-profile'
./scripts/build_mac.sh --signing developer-id
```

此模式启用 hardened runtime、Developer ID 签名并提交 Apple 公证；凭据缺失、公证失败会停止构建，不会自动退回内部签名。正式入口需要发布者的真实证书和公证配置验证；本机当前只验收内部测试路径。

## 到期与更新

所有收件人使用构建时写入的同一绝对截止时间，不从首次安装或首次运行起算。期限会显示在应用菜单的「关于」中，截止前 7 天显示更新提醒。

运行中每秒检查期限，电脑睡眠恢复时也会检查。到期后工作台停止编辑、播放和协作，显示更新提示，并保留当前完整工程或已完成编辑模型的备份导出入口。不会自动删除工程，也不会强制退出。安装过期包同样会锁定；替换成设置了新期限的版本即可继续。

工程缓存与服务数据保存在：

```text
~/Library/Application Support/AtlasTeachingDesktop/
```

应用每次使用同一数据目录与本地端口，替换 `.app` 会保留工程。首次使用桌面版可从原浏览器工作台导出完整工程 ZIP，再在桌面版加载；两者的缓存不会自动合并。更新前仍建议导出备份。

这是内部版本更新策略：运行时使用单调时钟，并记录曾见过的最晚时间，普通回拨时钟或重装同一包不会重新获得期限。完全离线的客户端不能抵御主动破解、清除数据后回拨时间等行为；如果未来需要强防篡改授权，需要加入服务端校验。

## 分发内容与能力范围

发版只包含压缩后的运行代码和所需资源，不包含仓库、原始 React/Python/Swift 业务源码、source map、开发依赖或测试文件；关闭开发者工具，将运行代码放入带完整性校验的 ASAR。ASAR 不是加密，压缩 JavaScript 仍可被专业工具提取和分析，不能保证任何人都无法看到实现。

为避免主动向使用者交付源码，桌面版隐藏了包含 Python 算法的「集群计算包」导出，并禁用 Windows USB 助手源码下载。本地求解、机器人资源、工程导出和网络设备协议保留；iPad、iPhone、Vision Pro 独立 App 不在此包中。

USB 画面协作的传输已内置，无需 Python。现有 USB 文件传输仍依赖 Xcode 的 `devicectl`，未安装时可使用网络传输。Isaac Sim 等外部物理后端不会被捆绑；默认本地计算可直接运行。

本地工作台界面只允许应用访问；设备配对接口继续使用原有配对校验。端口在首次启动时分配并持久保存，应用界面显示实际端口。

## 验证

```bash
npm run test:desktop
npm run check
```

`test:desktop` 覆盖日期和时区、分钟边界、运行期间时钟回拨、重启和新版本策略、本地接口访问控制、到期备份资源以及 USB 协议。它也已加入 `test:core`。

真实桌面 UI 验证需要一份未封装的官方 Electron 运行时，使用独立测试数据目录和 90 秒测试期限，不修改系统时钟：

```bash
ATLAS_TEST_ELECTRON='/path/Electron.app/Contents/MacOS/Electron' \
  node tests/integration/desktop_app_smoke.mjs
```

该测试会载入工程、显示机器人、等待到期、导出并核验完整备份、重启过期版本、替换新版本并恢复工程。截图和测试数据保存在 `build/macos/validation/`。真正的分发应用关闭调试入口，需要另行做普通启动验收。
