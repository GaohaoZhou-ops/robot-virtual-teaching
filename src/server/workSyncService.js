import { randomBytes, randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { applySyncOperations, validateSyncDocument, WORK_SYNC_INTERVAL, WORK_SYNC_LEASE } from '../lib/workSyncDocument.js';

const PREFIX = '/__atlas/work-sync';
const JSON_LIMIT = 128 * 1024 * 1024;
const BUNDLE_LIMIT = 1024 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const reply = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
const address = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isLocalRequest = (req) => {
  const ip = address(req);
  return ip === '::1' || ip === '127.0.0.1'
    || Object.values(networkInterfaces()).flat().some((item) => item?.address === ip);
};
const checkOrigin = (req) => {
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail(403, '请求来源无效'); }
    if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, '不允许跨站同步请求');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '不允许跨站同步请求');
};
async function body(req, binary = false) {
  const limit = binary ? BUNDLE_LIMIT : JSON_LIMIT;
  if (Number(req.headers['content-length']) > limit) fail(413, '同步数据超出大小限制');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) fail(413, '同步数据超出大小限制');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (binary) return bytes;
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(400, '同步请求格式无效'); }
}

export function createWorkSyncService({ now = Date.now, isLocal = isLocalRequest, serverName = hostname(), leaseMs = WORK_SYNC_LEASE } = {}) {
  const clients = new Map();
  const requests = new Map();
  let host = null, link = null, statusVersion = 0;
  let deadlineTimer = null, closed = false;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const stop = (reason) => {
    if (link) for (const client of [host, clients.get(link.peerToken)]) if (client) client.reason = reason;
    link = null;
    statusVersion += 1;
  };
  const prune = () => {
    if (link && link.expiresAt <= now()) stop('授权已到期，请重新申请');
    for (const [id, request] of requests) if (request.expiresAt <= now()) { requests.delete(id); statusVersion += 1; }
    // Allow a briefly hidden browser to return; stale authorization still has a
    // strict five-minute limit even if timers are suspended by the browser.
    if (host && !host.sockets?.size && now() - host.seenAt > 60_000) { stop('主机已离线'); host = null; requests.clear(); }
    for (const [token, client] of clients) {
      if (!client.sockets?.size && now() - client.seenAt > WORK_SYNC_LEASE * 2) clients.delete(token);
    }
  };
  const authenticate = (req, suppliedToken) => {
    const token = suppliedToken || req.headers.authorization?.replace(/^Bearer /, '');
    const client = clients.get(token);
    if (!client) fail(401, '同步会话已失效，请重新连接');
    client.seenAt = now();
    return client;
  };
  const authorized = (client, id) => {
    prune();
    if (!link || link.id !== id || (client !== host && client.token !== link.peerToken)) fail(403, '连接已断开或授权已到期');
    return link;
  };
  const status = (client) => ({
    statusVersion, serverTime: now(),
    role: client === host ? 'host' : 'peer',
    serverName, hostAvailable: Boolean(host?.project), hostName: host?.name || serverName,
    project: host?.project || null, intervalMs: WORK_SYNC_INTERVAL,
    reason: client.reason || '',
    requests: client === host ? [...requests.values()].map(({ peerToken, ...request }) => request) : [],
    pending: [...requests.values()].some((request) => request.peerToken === client.token),
    link: link && (client === host || client.token === link.peerToken)
      ? { id: link.id, project: link.project, expiresAt: link.expiresAt, ready: Boolean(link.bundle), peerName: clients.get(link.peerToken)?.name || '另一台设备' } : null,
  });
  const updateProject = (client, project) => {
    const previous = JSON.stringify(client.project);
    client.project = project && typeof project.key === 'string' && ['map', 'independent'].includes(project.mode)
      ? { key: project.key.slice(0, 300), name: String(project.name || '当前工程').slice(0, 200), mode: project.mode } : null;
    if (!host && client.local && client.project) { host = client; statusVersion += 1; }
    if (client === host && previous !== JSON.stringify(client.project)) { requests.clear(); statusVersion += 1; }
    if (client === host && link && client.project?.key !== link.project.key) stop('主机已切换工程');
  };

  const publish = () => {
    if (closed) return;
    if (!host) {
      host = [...clients.values()].find((client) => client.local && client.project
        && [...(client.sockets || [])].some((socket) => socket.readyState === 1)) || null;
      if (host) statusVersion += 1;
    }
    for (const client of clients.values()) {
      for (const socket of client.sockets || []) {
        if (socket.readyState !== 1 || socket.sentVersion === statusVersion) continue;
        socket.sentVersion = statusVersion;
        socket.send(JSON.stringify(status(client)));
      }
    }
    clearTimeout(deadlineTimer);
    const deadlines = [...requests.values()].map((request) => request.expiresAt);
    if (link) deadlines.push(link.expiresAt);
    if (deadlines.length) {
      deadlineTimer = setTimeout(() => { prune(); publish(); }, Math.max(1, Math.min(...deadlines) - now()));
      deadlineTimer.unref?.();
    }
  };

  const middleware = async (req, res, next) => {
    const pathname = req.url?.split('?')[0] || '';
    if (!pathname.startsWith(`${PREFIX}/`)) { next(); return; }
    try {
      // LAN HTTP is supported. Neither arbitrary origins nor forwarded IP
      // headers may act as a local authorizing browser.
      checkOrigin(req);
      prune();
      const route = pathname.slice(PREFIX.length);
      if (req.method === 'GET' && route === '/capabilities') {
        reply(res, 200, { local: isLocal(req) && req.headers['x-atlas-client'] !== 'vision-pro' }); return;
      }
      if (req.method === 'POST' && route === '/clients') {
        const data = await body(req);
        if (clients.size >= 64) fail(429, '同步设备过多，请稍后重试');
        const token = randomBytes(32).toString('hex');
        const client = { token, id: randomUUID(), name: String(data.name || '浏览器设备').slice(0, 100), ip: address(req), local: isLocal(req) && req.headers['x-atlas-client'] !== 'vision-pro', seenAt: now(), reason: '' };
        clients.set(token, client); updateProject(client, data.project);
        reply(res, 201, { token, ...status(client) }); return;
      }
      const client = authenticate(req);
      if (req.method === 'POST' && route === '/leave') {
        if (client === host) { stop('主机已离开同步会话'); host = null; requests.clear(); }
        else if (link?.peerToken === client.token) stop('另一台设备已离开同步会话');
        for (const [id, request] of requests) if (request.peerToken === client.token) requests.delete(id);
        for (const socket of client.sockets || []) socket.close();
        clients.delete(client.token); statusVersion += 1; reply(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && route === '/status') {
        const data = await body(req); updateProject(client, data.project);
        reply(res, 200, status(client)); return;
      }
      if (req.method === 'POST' && route === '/requests') {
        if (!host?.project || client === host) fail(409, '请在另一台设备上申请同步当前主机工程');
        if (link && link.peerToken !== client.token) fail(409, '主机正在与另一台设备同步');
        for (const [id, request] of requests) if (request.peerToken === client.token) requests.delete(id);
        const request = { id: randomUUID(), peerToken: client.token, name: client.name, ip: client.ip,
          projectKey: host.project.key, createdAt: now(), expiresAt: now() + WORK_SYNC_LEASE, renewal: Boolean(link) };
        requests.set(request.id, request); client.reason = ''; statusVersion += 1;
        reply(res, 201, status(client)); return;
      }
      if (req.method === 'POST' && route === '/decision') {
        const data = await body(req); prune();
        if (client !== host || !client.local) fail(403, '仅当前主机可以授权');
        const request = requests.get(data.requestId);
        if (!request || request.projectKey !== host.project?.key) fail(409, '申请已更新或工程已切换，请处理最新申请');
        if (data.allow !== true) {
          requests.delete(request.id);
          const peer = clients.get(request.peerToken); if (peer) peer.reason = '主机未授权，可重新申请';
        } else if (link && link.peerToken === request.peerToken) {
          link.expiresAt = now() + leaseMs; requests.delete(request.id);
        } else {
          if (link) fail(409, '已有同步连接，请先断开');
          validateSyncDocument(data.document);
          link = { id: randomUUID(), peerToken: request.peerToken, project: { ...host.project }, expiresAt: now() + leaseMs,
            document: structuredClone(data.document), initialDocument: structuredClone(data.document), revision: 0,
            history: [], sequences: new Map(), bundle: null };
          requests.clear();
        }
        statusVersion += 1;
        reply(res, 200, status(client)); return;
      }
      const match = /^\/links\/([a-f0-9-]{36})\/(bundle|bootstrap|exchange|disconnect)$/.exec(route);
      if (!match) fail(404, '同步接口不存在');
      const [, id, action] = match;
      authorized(client, id);
      if (req.method === 'POST' && action === 'disconnect') {
        stop('连接已断开，本地结果已保留'); requests.clear(); reply(res, 200, status(client)); return;
      }
      if (req.method === 'PUT' && action === 'bundle') {
        if (client !== host) fail(403, '仅主机可以提供初始工程');
        const bytes = await body(req, true);
        const current = authorized(client, id);
        if (!bytes.length || bytes.subarray(0, 2).toString() !== 'PK') fail(400, '工程归档格式无效');
        current.bundle = bytes; statusVersion += 1; reply(res, 200, status(client)); return;
      }
      if (req.method === 'GET' && action === 'bundle') {
        if (!link.bundle) fail(409, '主机正在准备工程');
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': link.bundle.length, 'Cache-Control': 'no-store' });
        res.end(link.bundle); return;
      }
      if (req.method === 'GET' && action === 'bootstrap') {
        reply(res, 200, { ...status(client), document: link.initialDocument, revision: 0 }); return;
      }
      if (req.method === 'POST' && action === 'exchange') {
        const data = await body(req);
        const current = authorized(client, id);
        if (!Number.isSafeInteger(data.sequence) || data.sequence < 1 || !Number.isSafeInteger(data.since) || data.since < 0) fail(400, '同步序号无效');
        const previous = current.sequences.get(client.id) || 0;
        if (data.sequence > previous) {
          const document = applySyncOperations(current.document, data.operations);
          current.sequences.set(client.id, data.sequence);
          if (data.operations.length) {
            current.document = document; current.revision += 1;
            current.history.push({ revision: current.revision, operations: data.operations,
              byteLength: Buffer.byteLength(JSON.stringify(data.operations)) });
            let historyBytes = current.history.reduce((size, entry) => size + entry.byteLength, 0);
            while (current.history.length > 128 || (historyBytes > JSON_LIMIT && current.history.length > 1)) {
              historyBytes -= current.history.shift().byteLength;
            }
          }
        }
        const full = data.since > current.revision || data.since < (current.history[0]?.revision ?? 1) - 1;
        reply(res, 200, { ...status(client), revision: current.revision,
          ...(full ? { document: current.document } : { operations: current.history.filter((entry) => entry.revision > data.since).flatMap((entry) => entry.operations) }) }); return;
      }
      fail(405, '同步接口不支持此操作');
    } catch (error) {
      if (!res.headersSent) reply(res, error.status || 400, { error: error.message || '同步失败' });
      else res.destroy();
    } finally { publish(); }
  };
  middleware.attach = (server) => {
    if (!server) return;
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?')[0] !== `${PREFIX}/events`) return;
      try {
        checkOrigin(req); prune();
        const client = authenticate(req, new URL(req.url, 'http://localhost').searchParams.get('token'));
        sockets.handleUpgrade(req, socket, head, (connection) => {
          client.sockets ||= new Set(); client.sockets.add(connection);
          connection.on('error', () => {});
          connection.on('close', () => {
            client.sockets.delete(connection); client.seenAt = now();
            if (client === host && !client.sockets.size) {
              stop('主机通知连接已断开，可重新申请'); host = null; requests.clear();
            }
            publish();
          });
          publish();
        });
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
    });
  };
  middleware.close = () => {
    closed = true;
    clearTimeout(deadlineTimer);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
  return middleware;
}

export function workSyncPlugin() {
  const middleware = createWorkSyncService();
  const install = (server) => { server.middlewares.use(middleware); middleware.attach(server.httpServer); };
  return { name: 'atlas-work-sync', configureServer: install,
    configurePreviewServer: install, closeBundle: () => middleware.close() };
}
