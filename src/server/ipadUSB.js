import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
export const USB_PROTOCOL = 'atlas-ipad-usb/1';
const container = 'com.atlasroute.teaching';
const inbox = 'Documents/Atlas USB';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function wiredIPads(devices) {
  return devices.filter((device) => device.hardwareProperties?.deviceType === 'iPad'
    && device.hardwareProperties?.reality === 'physical'
    && device.connectionProperties?.transportType === 'wired'
    && device.connectionProperties?.pairingState === 'paired'
    && device.connectionProperties?.tunnelState !== 'unavailable');
}

// CoreDevice's JSON output is its supported scripting interface. Paths and
// arguments stay separate; no shell, arbitrary source path or uninstall action.
export function createIPadUSBBridge({ directory, serverId, serverName, platform = process.platform,
  command, now = Date.now, interval = 5000 }) {
  let devices = [], message = '', timer, refreshing, closed = false, queue = Promise.resolve();
  const supported = platform === 'darwin';
  const serialize = (operation) => {
    const result = queue.then(operation, operation); queue = result.catch(() => {}); return result;
  };
  const deviceCommand = command || (async (args, timeout = 30) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(directory, 'command-'));
    try {
      const output = path.join(temporary, 'result.json');
      await execute('xcrun', ['devicectl', ...args, '--quiet', '--timeout', String(timeout), '--json-output', output],
        { timeout: (timeout + 5) * 1000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(await readFile(output, 'utf8'));
      if (result.info?.outcome !== 'success') throw new Error('设备操作未完成');
      return result.result;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  const copy = (deviceId, source, destination, timeout = 30) => deviceCommand([
    'device', 'copy', 'to', '--device', deviceId, '--domain-type', 'appDataContainer',
    '--domain-identifier', container, '--source', source, '--destination', destination,
  ], timeout);
  const list = async () => wiredIPads((await deviceCommand(['list', 'devices'])).devices || []);
  const ping = async (device) => {
    const temporary = await mkdtemp(path.join(directory, 'heartbeat-'));
    try {
      const file = path.join(temporary, 'connection.json');
      const updatedAt = now();
      await writeFile(file, JSON.stringify({ protocol: USB_PROTOCOL, serverId, serverName,
        transport: 'usb', updatedAt, expiresAt: updatedAt + 20_000, nonce: randomUUID() }), { mode: 0o600 });
      await copy(device.identifier, file, `${inbox}/connection.json`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  };
  const snapshot = () => ({ supported, devices, message });
  const refresh = () => {
    if (!supported || closed) return Promise.resolve(snapshot());
    if (refreshing) return refreshing;
    refreshing = serialize(async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const connected = await list();
        const next = [];
        for (const device of connected) {
          const entry = { id: device.identifier, name: device.deviceProperties?.name || 'iPad', ready: false };
          try { await ping(device); entry.ready = true; }
          catch { entry.message = '请解锁 iPad、信任此电脑，并确认已安装 Atlas 示教。'; }
          next.push(entry);
        }
        devices = next; message = '';
      } catch { devices = []; message = '数据线连接检测不可用，请检查 Mac 的 Xcode 与设备连接。'; }
      return snapshot();
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return {
    status: snapshot,
    refresh,
    start() {
      if (!supported || timer || closed) return;
      void refresh(); timer = setInterval(() => { void refresh(); }, interval); timer.unref?.();
    },
    close() { closed = true; clearInterval(timer); timer = undefined; },
    async send({ deviceId, session, modelPath }) {
      if (!supported) fail(503, '数据线接收需要在连接 iPad 的 Mac 上运行示教服务。');
      return serialize(async () => {
        const device = (await list()).find((item) => item.identifier === deviceId);
        if (!device) fail(409, '这台 iPad 的数据线连接已断开，请重新连接后重试。');
        // The same frozen desktop session always maps to one distinct USB project.
        // A retry can reopen that project without replacing LAN credentials or Pose data.
        const digest = createHash('sha256').update(`atlas-usb-model:${session.id}`).digest('hex');
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = await mkdtemp(path.join(directory, 'transfer-'));
        try {
          await copy(deviceId, modelPath, `${inbox}/Inbox/${id}/model.atls`, 180);
          if (!(await list()).some((item) => item.identifier === deviceId)) fail(409, '数据线传输中断，请重新连接后重试。');
          const ready = path.join(temporary, 'ready.json');
          await writeFile(ready, JSON.stringify({ protocol: USB_PROTOCOL, id, serverName,
            sourceSessionId: session.id, manifest: session.manifest }), { mode: 0o600 });
          // Commit metadata last. The iPad ignores incomplete or interrupted copies.
          await copy(deviceId, ready, `${inbox}/Inbox/${id}/ready.json`);
          await ping(device);
          return { id, deviceName: device.deviceProperties?.name || 'iPad', name: session.manifest.name,
            byteLength: session.manifest.byteLength };
        } catch (error) {
          if (error.status) throw error;
          fail(502, '数据线发送未完成，请保持 iPad 解锁并连接，稍后重试；原有示教项目不受影响。');
        } finally { await rm(temporary, { recursive: true, force: true }); }
      });
    },
  };
}
