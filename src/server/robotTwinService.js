import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ROBOT_TWIN_PREFIX, ROBOT_TWIN_INTERVAL, robotTwinSnapshot } from '../lib/robotTwin.js';
import { robotFetch } from './robotTwinTransport.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const reply = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

export function robotTwinAddress(value) {
  let url;
  try { url = new URL(String(value).includes('://') ? value : `http://${value}`); }
  catch { fail(400, '请输入机器人局域网 IPv4 地址和端口'); }
  const [a, b] = url.hostname.split('.').map(Number);
  if (isIP(url.hostname) !== 4 || !(a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) fail(400, '仅支持局域网 IPv4 地址和端口，不接受接口路径');
  return url.origin;
}

function sameOrigin(req) {
  if (req.headers['x-atlas-robot-twin'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') fail(403, '请从当前工作台连接机器人');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail(403, '请求来源无效'); }
    if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, '不允许跨站机器人连接');
  }
}

async function body(req) {
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) fail(413, '连接参数过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, '连接参数格式无效'); }
}

// The only upstream POST is password authentication. There is deliberately no
// generic proxy, control-ownership request, motion, enable, stop or task route.
const allowedReads = new Set(['/api/v1/control-session', '/api/v1/model', '/api/v1/slam', '/api/v1/state']);
async function readRobot(session, path, login) {
  if (login ? path !== '/api/v1/access/login' : !allowedReads.has(path)) fail(403, '真机孪生只允许读取状态');
  const headers = { Accept: 'application/json', 'X-ABX-Web-Client': 'robot-dashboard' };
  if (session.cookie) headers.Cookie = session.cookie;
  if (session.credential) headers['X-ABX-Control-Token'] = session.credential;
  if (login) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  let response;
  try {
    response = await robotFetch(session, path, { method: login ? 'POST' : 'GET', headers,
      ...(login ? { body: new URLSearchParams({ role: 'admin', password: login.password }) } : {}),
      redirect: 'error', signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(3000)]) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) fail(502, '机器人响应过大');
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 401 : 502,
      response.status === 401 || response.status === 403 ? '机器人鉴权失败，请检查管理员密码并重新连接'
        : `机器人状态接口返回 HTTP ${response.status}`);
    if (login) session.cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
    return payload;
  } catch (error) {
    if (error.status) throw error;
    fail(502, error.name === 'TimeoutError' ? '机器人响应超时，正在等待恢复'
      : response ? '机器人返回了无效的状态数据' : '无法连接机器人，请检查地址、端口和局域网连接');
  }
}

export function createRobotTwinService() {
  const sessions = new Map();
  let pending = 0;
  const prune = () => {
    for (const [id, session] of sessions) if (Date.now() - session.lastSeen > 60_000) {
      session.controller.abort(); sessions.delete(id);
    }
  };
  const cleanup = setInterval(prune, 30_000); cleanup.unref();

  async function snapshot(session) {
    // Multiple tabs/requests for one session cannot multiply the robot poll rate.
    if (session.pending) return session.pending;
    if (session.cached && Date.now() - session.sampledAt < ROBOT_TWIN_INTERVAL) return session.cached;
    session.pending = (async () => {
      const started = Date.now();
      const results = await Promise.allSettled([
        readRobot(session, '/api/v1/slam'), readRobot(session, '/api/v1/state'),
      ]);
      const unauthorized = results.find((item) => item.status === 'rejected' && item.reason.status === 401);
      if (unauthorized) throw unauthorized.reason;
      if (results.every((item) => item.status === 'rejected')) throw results[0].reason;
      const result = robotTwinSnapshot({
        slam: results[0].status === 'fulfilled' ? results[0].value : null,
        state: results[1].status === 'fulfilled' ? results[1].value : null,
        model: session.model, elapsedMs: Date.now() - started,
        errors: results.flatMap((item) => item.status === 'rejected' ? [item.reason.message] : []),
      });
      session.sampledAt = Date.now();
      session.cached = { ...result, sampledAt: session.sampledAt };
      return session.cached;
    })();
    try { return await session.pending; } finally { session.pending = null; }
  }

  const middleware = async (req, res, next) => {
    const pathname = req.url?.split('?')[0];
    if (pathname !== ROBOT_TWIN_PREFIX && !pathname?.startsWith(`${ROBOT_TWIN_PREFIX}/`)) return next();
    try {
      sameOrigin(req);
      if (req.url !== pathname) fail(400, '孪生接口不接受查询参数');
      if (pathname === `${ROBOT_TWIN_PREFIX}/sessions` && req.method === 'POST') {
        prune();
        if (sessions.size + pending >= 16) fail(429, '孪生连接过多，请先断开不用的连接');
        pending += 1;
        try {
          const data = await body(req);
          const session = { address: robotTwinAddress(data.address), lastSeen: Date.now(), controller: new AbortController() };
          res.once('close', () => { if (!res.writableEnded) session.controller.abort(); });
          // Try anonymous observation first; read-only ABX deployments need no login.
          try { await readRobot(session, '/api/v1/slam'); }
          catch (error) {
            if (error.status !== 401) throw error;
            if (typeof data.password !== 'string' || !data.password) fail(401, '请输入机器人管理员密码');
            await readRobot(session, '/api/v1/access/login', { password: data.password });
            // This GET only returns the Web session credential; it does not
            // acquire control ownership. The credential stays on this server.
            const access = await readRobot(session, '/api/v1/control-session');
            if (typeof access.token !== 'string' || !/^[a-f0-9]{64}$/.test(access.token)) fail(502, '机器人会话凭据无效');
            session.credential = access.token;
          }
          session.model = await readRobot(session, '/api/v1/model');
          const initial = await snapshot(session);
          const token = randomBytes(32).toString('hex');
          session.lastSeen = Date.now(); sessions.set(token, session);
          reply(res, 201, { token, address: session.address, snapshot: initial });
        } finally { pending -= 1; }
        return;
      }
      if (pathname !== `${ROBOT_TWIN_PREFIX}/snapshot` && pathname !== `${ROBOT_TWIN_PREFIX}/session`) fail(404, '孪生接口不存在');
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const session = sessions.get(token);
      if (!session || Date.now() - session.lastSeen > 60_000) {
        session?.controller.abort(); sessions.delete(token); fail(401, '孪生会话已结束，请重新连接');
      }
      if (pathname.endsWith('/session') && req.method === 'DELETE') {
        session.controller.abort(); sessions.delete(token); reply(res, 200, { ok: true }); return;
      }
      if (!pathname.endsWith('/snapshot') || req.method !== 'GET') fail(405, '真机孪生仅支持读取状态或断开本地会话');
      session.lastSeen = Date.now();
      try {
        const result = await snapshot(session);
        // Durations survive client/server clock differences and cached replies.
        const heldMs = Date.now() - result.sampledAt;
        reply(res, 200, { ...result, poseValidForMs: Math.max(0, result.poseValidForMs - heldMs),
          jointsValidForMs: Math.max(0, result.jointsValidForMs - heldMs) });
      } catch (error) {
        if (error.status === 401) sessions.delete(token);
        throw error;
      }
    } catch (error) {
      if (!res.headersSent) reply(res, error.status || 500, { error: error.message || '真机状态读取失败' });
    }
  };
  middleware.close = () => { clearInterval(cleanup); for (const session of sessions.values()) session.controller.abort(); sessions.clear(); };
  return middleware;
}

export function robotTwinPlugin() {
  const install = (server) => {
    const service = createRobotTwinService();
    server.middlewares.use(service);
    server.httpServer?.once('close', service.close);
  };
  return { name: 'atlas-robot-twin-readonly', configureServer: install, configurePreviewServer: install };
}
