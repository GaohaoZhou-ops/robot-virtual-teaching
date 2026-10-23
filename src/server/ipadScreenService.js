import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';
import { SCREEN_CONTROL_LIMIT, validScreenJointState, screenJointCommand } from '../lib/ipadScreenControl.js';

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

export function validateScreenWorkspace(body) {
  if (body.length < 10 || body.length > MAX_SCREEN_FRAME) fail(400, '关节与三维画面数据无效');
  const stateLength = body.readUInt32BE(0), imageLength = body.readUInt32BE(4);
  if (stateLength > SCREEN_CONTROL_LIMIT || 8 + stateLength + imageLength !== body.length
    || (imageLength && (imageLength < 4 || body.readUInt16BE(8 + stateLength) !== 0xffd8
      || body.readUInt16BE(body.length - 2) !== 0xffd9))) fail(400, '三维画面数据不完整');
  let state;
  try { state = JSON.parse(body.subarray(8, 8 + stateLength).toString()); } catch { fail(400, '关节状态无效'); }
  if (!validScreenJointState(state)) fail(400, '关节状态无效');
  return state;
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

const checkLocalRequest = (req) => {
  let host, origin;
  try {
    host = new URL(`http://${req.headers.host}`).hostname;
    origin = req.headers.origin ? new URL(req.headers.origin) : null;
  } catch { fail(403, '画面协作请求来源无效'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    || (origin && (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)))) {
    fail(403, '请在连接设备的电脑上使用 localhost 或 127.0.0.1 打开工作台。');
  }
};
const validToken = (current, token) => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
  && timingSafeEqual(Buffer.from(token), Buffer.from(current.token));

export function createIPadScreenService({ transport, supported = process.platform === 'darwin', now = Date.now }) {
  let session = null, starting = false, frameBusy = false, discovering;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const attachments = new Map();
  const appRequest = async (deviceId, method, route, body, token) => {
    let reply;
    try { reply = await transport.request(deviceId, method, route, body, token); }
    catch { fail(502, '有线画面连接已断开，请保持设备解锁，并在前台打开新版 Atlas App。'); }
    if (reply.status !== 200) fail(reply.status, reply.body?.error || '设备已结束画面协作，请重新连接');
    return reply.body;
  };
  const end = async (current, error) => {
    if (!current || current.ended) return;
    current.ended = true;
    if (session === current) session = null;
    if (current.socket?.readyState === WebSocket.OPEN) {
      if (error) current.socket.send(JSON.stringify({ error }));
      current.socket.close();
    }
    await appRequest(current.deviceId, 'DELETE', '/session', undefined, current.token).catch(() => {});
  };
  const publishControls = (current, status) => {
    if (session !== current) return;
    current.page = status.page === 'joints' ? 'joints' : 'cameras';
    const commands = (Array.isArray(status.commands) ? status.commands.slice(0, 128) : [])
      .map((command) => screenJointCommand({ ...command, receivedAt: now() }, current.controlState, current.controlState?.ack || 0, now()))
      .filter(Boolean).sort((a, b) => a.sequence - b.sequence);
    if (current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ page: current.page, commands }));
  };
  const timer = setInterval(() => {
    const current = session;
    if (!current) return;
    if (!current.socket) {
      if (now() - current.updatedAt > 8000) void end(current);
      return;
    }
    // WebSocket control frames are handled by the browser's network stack even
    // while page timers/rendering are suspended. Never treat cached images as new frames.
    if (now() - current.lastPong > 15000) {
      void end(current, '电脑连接已断开，请重新连接画面协作。'); return;
    }
    if (current.socket.readyState === WebSocket.OPEN && now() - current.lastPing >= 2000) {
      current.lastPing = now(); current.socket.ping();
    }
    if (!current.keepingAlive && now() - current.updatedAt >= (current.page === 'joints' ? 200 : 2000)) {
      current.keepingAlive = true;
      void appRequest(current.deviceId, 'PUT', '/heartbeat', undefined, current.token)
        .then((status) => { current.updatedAt = now(); publishControls(current, status); })
        .catch((error) => end(current, error.message))
        .finally(() => { current.keepingAlive = false; });
    }
  }, 250);
  timer.unref?.();
  const discover = () => {
    if (discovering) return discovering;
    discovering = (async () => {
      const devices = await transport.devices();
      const result = [];
      for (const device of devices) {
        try {
          const status = await appRequest(device.id, 'GET', '/status');
          result.push({ id: device.id, name: status.deviceName, ready: status.protocol === SCREEN_PROTOCOL && status.keepalive === true && status.jointControl === true && !status.active,
            active: !!status.active, message: status.active ? '正在进行画面协作' : status.jointControl !== true ? '请更新 Atlas App 以支持关节协作。' : '' });
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
      checkLocalRequest(req);
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
          if (status.protocol !== SCREEN_PROTOCOL || status.keepalive !== true || status.jointControl !== true) fail(409, '请更新设备上的 Atlas App 以支持关节协作。');
          if (status.active) fail(409, '设备正在进行画面协作，请先在设备上结束协作');
          const current = { id: randomUUID(), token: randomBytes(32).toString('hex'), deviceId: body.deviceId, deviceName: status.deviceName, updatedAt: now() };
          await appRequest(current.deviceId, 'POST', '/session', Buffer.from(JSON.stringify({ protocol: SCREEN_PROTOCOL })), current.token);
          session = current;
          return json(res, 201, { id: current.id, token: current.token, deviceName: current.deviceName });
        } finally { starting = false; }
      }
      const match = route.match(/^\/__atlas\/ipad-screen\/session\/([a-f0-9-]{36})(\/frame|\/workspace)?$/);
      if (!match) fail(404, '画面协作接口不存在');
      const current = session, token = req.headers.authorization?.replace(/^Bearer /, '') || '';
      if (!current || current.id !== match[1]) fail(410, '画面协作已结束，请重新连接');
      if (!validToken(current, token)) fail(401, '画面协作凭据无效');
      if (req.method === 'DELETE' && !match[2]) { await end(current); return json(res, 200, { stopped: true }); }
      if (req.method !== 'PUT' || !match[2]) fail(405, '不支持该操作');
      if (frameBusy) fail(429, '上一帧正在传输');
      frameBusy = true;
      try {
        const body = await readBody(req);
        if (match[2] === '/workspace') current.controlState = validateScreenWorkspace(body);
        else validateScreenFrame(body);
        if (session !== current) fail(410, '画面协作已结束');
        const status = await appRequest(current.deviceId, 'PUT', match[2], body, current.token);
        if (session === current) current.updatedAt = now();
        publishControls(current, status);
        return json(res, 200, status);
      } catch (error) { if (error.status !== 400 && error.status !== 413) void end(current); throw error; }
      finally { frameBusy = false; }
    } catch (error) { if (!res.headersSent) json(res, error.status || 503, { error: error.status ? error.message : '数据线检测不可用，请检查 Python 3 和设备连接。' }); }
  };
  middleware.attach = (server) => {
    if (!server || attachments.has(server)) return;
    const upgrade = (req, socket, head) => {
      const match = req.url?.split('?')[0].match(/^\/__atlas\/ipad-screen\/session\/([a-f0-9-]{36})\/events$/);
      if (!match) return;
      try {
        checkLocalRequest(req);
        const current = session;
        if (!current || current.id !== match[1]) fail(410, '画面协作已结束');
        sockets.handleUpgrade(req, socket, head, (connection) => {
          // Authenticate in the first message; never put session tokens in URLs.
          const authTimer = setTimeout(() => connection.terminate(), 5000);
          authTimer.unref?.();
          connection.on('error', () => {});
          connection.on('close', () => {
            clearTimeout(authTimer);
            if (current.socket === connection) void end(current);
          });
          connection.once('message', (data) => {
            let token;
            try { token = JSON.parse(data.toString()).token; } catch { /* Rejected below. */ }
            if (session !== current || current.socket || !validToken(current, token)) { connection.close(1008); return; }
            clearTimeout(authTimer);
            current.socket = connection; current.lastPong = now(); current.lastPing = now();
            connection.on('pong', () => { current.lastPong = now(); });
            connection.send(JSON.stringify({ ready: true }));
          });
        });
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
    };
    attachments.set(server, upgrade); server.on('upgrade', upgrade);
  };
  middleware.close = () => {
    clearInterval(timer); session = null;
    for (const [server, upgrade] of attachments) server.off('upgrade', upgrade);
    attachments.clear();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); transport.close();
  };
  return middleware;
}

export function ipadScreenPlugin() {
  let root; const services = new Set();
  const install = (server) => {
    const service = createIPadScreenService({ transport: createScreenUSBTransport(root) });
    services.add(service); server.middlewares.use(service); service.attach(server.httpServer);
    server.httpServer?.once('close', () => { service.close(); services.delete(service); });
  };
  return { name: 'atlas-ipad-screen', configResolved(config) { root = config.root; }, configureServer: install,
    configurePreviewServer: install, closeBundle() { for (const service of services) service.close(); services.clear(); } };
}
