import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, session } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReleaseClock, formatReleaseMinute } from './release-policy.mjs';
import { startDesktopServer } from './server.mjs';
import { createMacUSBTransport } from './usb-transport.mjs';

const release = __ATLAS_RELEASE__;
// A stable app identity and storage location keep projects through app replacement.
const userData = !app.isPackaged && process.env.ATLAS_DESKTOP_TEST_USER_DATA
  ? path.resolve(process.env.ATLAS_DESKTOP_TEST_USER_DATA)
  : path.join(app.getPath('appData'), 'AtlasTeachingDesktop');
app.setPath('userData', userData);
app.setName('Atlas 虚拟示教');
for (const name of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk']) {
  if (app.isPackaged) app.commandLine.removeSwitch(name);
}
let window, service, clock, timer, quitting = false, origin;
const stateFile = path.join(userData, 'release-clock.json');
let saveChain = Promise.resolve();
const persistClock = () => {
  const now = clock.snapshot().now;
  saveChain = saveChain.catch(() => {}).then(async () => {
    await writeFile(`${stateFile}.tmp`, JSON.stringify({ lastSeen: now }), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
  });
  return saveChain;
};
const validSender = (event) => event.sender === window?.webContents && event.senderFrame?.url.startsWith(`${origin}/`);
const broadcast = () => {
  const value = clock.snapshot();
  service.refreshPolicy();
  if (window && !window.isDestroyed()) window.webContents.send('atlas:release-changed', value);
  return value;
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(start).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Atlas 无法启动', error.code === 'EADDRINUSE'
      ? '工作台端口被占用。请关闭另一个 Atlas 实例后重试，已有工程不会被删除。'
      : `请将应用完整解压后重新打开，或联系发布者。\n${error.message}`);
    app.exit(1);
  });
}

async function start() {
  await mkdir(userData, { recursive: true });
  let saved = {}, settings = {};
  try { saved = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* first launch */ }
  const settingsFile = path.join(userData, 'desktop-settings.json');
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch { /* first launch */ }
  clock = createReleaseClock(release, { lastSeen: saved.lastSeen });
  const key = randomBytes(32).toString('hex');
  service = await startDesktopServer({ resources: app.getAppPath(), userData, key, releaseClock: clock,
    usbTransport: createMacUSBTransport(), port: Number.isInteger(settings.port) ? settings.port : 0 });
  await writeFile(settingsFile, JSON.stringify({ port: service.port }), { mode: 0o600 });
  origin = `http://127.0.0.1:${service.port}`;
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);
    if (url.host === `127.0.0.1:${service.port}` && ['http:', 'ws:'].includes(url.protocol)) {
      details.requestHeaders['X-Atlas-Desktop-Key'] = key;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    requestingOrigin === origin && ['hid', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem'].includes(permission));
  ses.setPermissionRequestHandler((webContents, permission, callback) => callback(
    webContents === window?.webContents && ['hid', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem'].includes(permission)));
  // SpaceMouse retains a user-driven device choice instead of granting every HID.
  ses.on('select-hid-device', async (event, details, callback) => {
    event.preventDefault();
    if (!details.deviceList.length || clock.snapshot().status === 'expired') return callback('');
    try {
      const devices = details.deviceList;
      const { response } = await dialog.showMessageBox(window, { type: 'question', title: '连接 SpaceMouse',
        message: '选择要连接的设备', buttons: [...devices.map((d) => d.name || d.productName || 'HID 设备'), '取消'],
        cancelId: devices.length, defaultId: devices.length });
      callback(devices[response]?.deviceId || '');
    } catch { callback(''); }
  });
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存导出文件', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  ipcMain.handle('atlas:release', (event) => { if (!validSender(event)) throw new Error('Invalid sender'); return clock.snapshot(); });
  ipcMain.on('atlas:quit', (event) => { if (validSender(event)) app.quit(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { label: '关于 Atlas 虚拟示教', click: () => dialog.showMessageBox(window, { title: 'Atlas 虚拟示教',
        message: `版本 ${release.version} · ${release.buildId}`,
        detail: `有效期至 ${formatReleaseMinute(release.expiresAt)}（北京时间）\n到期后请联系发布者获取新版。\n工程保存在本机，替换应用不会删除工程。`, buttons: ['好'] }) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
  ]));
  createWindow();
  powerMonitor.on('resume', () => { broadcast(); void persistClock().catch(console.error); });
  let ticks = 0;
  timer = setInterval(() => { broadcast(); if (++ticks % 10 === 0) void persistClock().catch(console.error); }, 1000);
  await persistClock();
  console.log(`Atlas desktop ready ${release.buildId} (expires ${release.expiresAt})`);
  app.on('activate', () => { if (!window || window.isDestroyed()) createWindow(); else window.show(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault(); quitting = true; clearInterval(timer);
    const flush = new Promise((resolve) => {
      if (!window || window.isDestroyed()) return resolve();
      const id = randomBytes(12).toString('hex');
      const done = (event, receipt) => { if (validSender(event) && receipt === id) finish(); };
      const finish = () => { clearTimeout(deadline); ipcMain.off('atlas:ready-to-quit', done); resolve(); };
      const deadline = setTimeout(finish, 4000);
      ipcMain.on('atlas:ready-to-quit', done);
      window.webContents.send('atlas:prepare-quit', id);
    });
    flush.then(() => Promise.allSettled([persistClock(), service.close()])).finally(() => app.quit());
  });
}

function createWindow() {
  window = new BrowserWindow({ title: 'Atlas 虚拟示教', width: 1500, height: 980, minWidth: 1100, minHeight: 720,
    backgroundColor: '#050b0e', show: false,
    webPreferences: { preload: path.join(app.getAppPath(), 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, devTools: false, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || ((input.meta || input.control) && input.alt && ['i', 'j', 'c'].includes(input.key.toLowerCase()))) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); app.quit(); }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer stopped:', details.reason);
    dialog.showErrorBox('工作台需要重新打开', '三维工作台意外停止。请重新启动应用，已保存的工程和自动缓存会保留。');
  });
  void window.loadURL(`${origin}/`);
}
