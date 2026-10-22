import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const SCREEN_PROTOCOL = 'atlas-ipad-screen/1';
export const MAX_SCREEN_FRAME = 2 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const readBody = async (req, limit = MAX_SCREEN_FRAME) => {
  if (Number(req.headers['content-length']) > limit) fail(413, '画面数据过大');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, '画面数据过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
};
export function validateScreenFrame(body) {
  if (body.length < 16 || body.length > MAX_SCREEN_FRAME) fail(400, '双臂画面数据无效');
  const left = body.readUInt32BE(0), right = body.readUInt32BE(4);
  if (left < 4 || right < 4 || left + right + 8 !== body.length
    || body.readUInt16BE(8) !== 0xffd8 || body.readUInt16BE(8 + left) !== 0xffd8
    || body.readUInt16BE(6 + left) !== 0xffd9 || body.readUInt16BE(body.length - 2) !== 0xffd9) fail(400, '双臂 JPEG 画面不完整');
}

export function createScreenUSBTransport(root) {
  let child, pending, closed = false, queue = Promise.resolve();
  function start() {
    const process = spawn('python3', ['-u', path.join(root, 'src/server/ipadScreenUSB.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = process;
    const lines = createInterface({ input: process.stdout });
    lines.on('line', (line) => {
      if (child !== process || !pending) return;
      try { const result = JSON.parse(line); result.error ? pending.reject(new Error(result.error)) : pending.resolve(result.value); }
      catch (error) { pending?.reject(error); }
    });
    const exited = () => {
      lines.close();
      if (child !== process) return;
      child = undefined; pending?.reject(new Error('USB transport unavailable'));
    };
    process.on('error', exited); process.on('exit', exited);
    process.stdin.on('error', () => {});
  }
  const run = (command) => {
    const next = queue.then(() => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('USB transport closed'));
      if (!child) start();
      const timer = setTimeout(() => {
        const process = child; child = undefined;
        pending?.reject(new Error('USB transport timed out')); process?.kill();
      }, 6500);
      let operation;
      const finish = () => { clearTimeout(timer); if (pending === operation) pending = undefined; };
      // Attach cleanup to this operation before the next queued command starts.
      operation = { resolve: (value) => { finish(); resolve(value); }, reject: (error) => { finish(); reject(error); } };
      pending = operation;
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) operation.reject(error); });
    }));
    queue = next.catch(() => {}); return next;
  };
  return { devices: () => run({ action: 'devices' }),
    request: (deviceId, method, route, body = Buffer.alloc(0), token = '') => run({ action: 'request', deviceId, method, path: route, token, body: body.toString('base64') }),
    close() { closed = true; pending?.reject(new Error('USB transport closed')); child?.kill(); child = undefined; } };
}

export function createIPadScreenService({ transport, supported = process.platform === 'darwin', now = Date.now }) {
  let session = null, starting = false, frameBusy = false, discovering;
  const appRequest = async (deviceId, method, route, body, token) => {
    let reply;
    try { reply = await transport.request(deviceId, method, route, body, token); }
    catch { fail(502, '有线画面连接已断开，请保持设备解锁，并在前台打开新版 Atlas App。'); }
    if (reply.status !== 200) fail(reply.status, reply.body?.error || '设备已结束画面协作，请重新连接');
    return reply.body;
  };
  const end = async (current) => {
    if (!current) return;
    if (session === current) session = null;
    await appRequest(current.deviceId, 'DELETE', '/session', undefined, current.token).catch(() => {});
  };
  const timer = setInterval(() => { if (session && now() - session.updatedAt > 8000) void end(session); }, 1000);
  timer.unref?.();
  const discover = () => {
    if (discovering) return discovering;
    discovering = (async () => {
      const devices = await transport.devices();
      const result = [];
      for (const device of devices) {
        try {
          const status = await appRequest(device.id, 'GET', '/status');
          result.push({ id: device.id, name: status.deviceName, ready: status.protocol === SCREEN_PROTOCOL && !status.active,
            active: !!status.active, message: status.active ? '正在进行画面协作' : '' });
        } catch { result.push({ id: device.id, name: 'USB 设备', ready: false, message: '请解锁设备，并在前台打开新版 Atlas App。' }); }
      }
      return { supported: true, devices: result };
    })().finally(() => { discovering = undefined; });
    return discovering;
  };
  const middleware = async (req, res, next) => {
    const route = (req.url || '').split('?')[0];
    if (!route.startsWith('/__atlas/ipad-screen/')) return next();
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)
        || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) fail(403, '请在连接设备的电脑上使用 localhost 或 127.0.0.1 打开工作台。');
      if (!supported) {
        if (route === '/__atlas/ipad-screen/devices' && req.method === 'GET') return json(res, 200, { supported: false, devices: [], message: '有线画面协作需要 macOS。' });
        fail(503, '有线画面协作需要 macOS');
      }
      if (route === '/__atlas/ipad-screen/devices' && req.method === 'GET') return json(res, 200, await discover());
      if (route === '/__atlas/ipad-screen/session' && req.method === 'POST') {
        if (session || starting) fail(409, '已有画面协作，请先结束当前协作');
        let body;
        try { body = JSON.parse((await readBody(req, 1024)).toString()); } catch { fail(400, '设备参数无效'); }
        if (!/^[a-zA-Z0-9-]{8,80}$/.test(body.deviceId || '')) fail(400, '设备参数无效');
        // Reserve before the first asynchronous device operation (two browser tabs).
        if (session || starting) fail(409, '已有画面协作，请先结束当前协作');
        starting = true;
        try {
          const status = await appRequest(body.deviceId, 'GET', '/status');
          if (status.protocol !== SCREEN_PROTOCOL) fail(409, '请更新设备上的 Atlas App');
          if (status.active) fail(409, '设备正在进行画面协作，请先在设备上结束协作');
          const current = { id: randomUUID(), token: randomBytes(32).toString('hex'), deviceId: body.deviceId, deviceName: status.deviceName, updatedAt: now() };
          await appRequest(current.deviceId, 'POST', '/session', Buffer.from(JSON.stringify({ protocol: SCREEN_PROTOCOL })), current.token);
          session = current;
          return json(res, 201, { id: current.id, token: current.token, deviceName: current.deviceName });
        } finally { starting = false; }
      }
      const match = route.match(/^\/__atlas\/ipad-screen\/session\/([a-f0-9-]{36})(\/frame)?$/);
      if (!match) fail(404, '画面协作接口不存在');
      const current = session, token = req.headers.authorization?.replace(/^Bearer /, '') || '';
      if (!current || current.id !== match[1]) fail(410, '画面协作已结束，请重新连接');
      if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(current.token))) fail(401, '画面协作凭据无效');
      if (req.method === 'DELETE' && !match[2]) { await end(current); return json(res, 200, { stopped: true }); }
      if (req.method !== 'PUT' || !match[2]) fail(405, '不支持该操作');
      if (frameBusy) fail(429, '上一帧正在传输');
      frameBusy = true;
      try {
        const body = await readBody(req); validateScreenFrame(body);
        if (session !== current) fail(410, '画面协作已结束');
        const status = await appRequest(current.deviceId, 'PUT', '/frame', body, current.token);
        if (session === current) current.updatedAt = now();
        return json(res, 200, status);
      } catch (error) { if (error.status !== 400 && error.status !== 413) void end(current); throw error; }
      finally { frameBusy = false; }
    } catch (error) { if (!res.headersSent) json(res, error.status || 503, { error: error.status ? error.message : '数据线检测不可用，请检查 Python 3 和设备连接。' }); }
  };
  middleware.close = () => { clearInterval(timer); session = null; transport.close(); };
  return middleware;
}

export function ipadScreenPlugin() {
  let root; const services = new Set();
  const install = (server) => {
    const service = createIPadScreenService({ transport: createScreenUSBTransport(root) });
    services.add(service); server.middlewares.use(service);
    server.httpServer?.once('close', () => { service.close(); services.delete(service); });
  };
  return { name: 'atlas-ipad-screen', configResolved(config) { root = config.root; }, configureServer: install,
    configurePreviewServer: install, closeBundle() { for (const service of services) service.close(); services.clear(); } };
}
