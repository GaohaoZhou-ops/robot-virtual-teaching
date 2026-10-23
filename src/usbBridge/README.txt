Atlas iPad 数据线连接助手

首次准备（Windows）
1. 安装 Python 3.9 或以上：https://www.python.org/downloads/windows/
2. 安装并打开 Apple「Apple 设备」App，或带 Apple Mobile Device Support 的 iTunes。
   官方说明：https://support.apple.com/zh-cn/108643
3. 用支持数据传输的线缆连接 iPad，解锁并选择“信任此电脑”。
   确认 Apple 设备 App 能识别 iPad，然后在 iPad 上打开 Atlas App。

开始协作
1. 完整解压本目录，双击 start-windows.cmd，保持控制台运行。
2. 在原来的浏览器工程中进入“设备 → iPad / iPhone → 画面协作 → 数据线”。
3. 点击“连接本机助手”，在打开的小窗口核对工作台地址并允许连接。
4. 返回工作台，选择 iPad 并点击“开始协作”。只有一台就绪设备时自动开始。

可以继续访问 Mac 服务器，无需在 Windows 安装工程或同步当前工程。
画面和控制只在当前电脑与 iPad 之间传输，记录 Pose 保存在原浏览器工程中。
保持助手程序及其浏览器窗口运行，可最小化窗口；关闭它们会结束有线协作。
扫码、Wi-Fi 配对及 Mac 原有有线协作保持可用，iPad 无需因此更新 App。

如果弹窗被浏览器拦截，请允许当前工作台打开弹窗，再点击“连接本机助手”。
如果窗口无法打开，请先运行 start-windows.cmd；端口 21994 仅监听本机。
如果未找到设备，请检查线缆、信任状态以及 Apple 设备服务，再“刷新设备”。
本助手不提供 App 安装、项目管理、文件访问或模型传输功能。
macOS 也可用 python3 ipadUSBBridge.py 运行，用于远端工作台有线协作。
