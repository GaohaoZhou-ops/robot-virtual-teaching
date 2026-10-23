import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { ipadServerIdentity, lanAddresses, randomPairingCode, pairingQRCode } from './ipadPairing.js';
import { IPAD_PROTOCOL, MAX_MODEL_BYTES, validateModelBytes, validateIPadResult, validateIPadPoseSeed, ipadPoseArm } from '../lib/ipadProtocol.js';
import { advertiseIPadService } from './ipadDiscovery.js';
import { modelThumbnail } from './modelThumbnail.js';
import { createIPadUSBBridge } from './ipadUSB.js';
import { ipadPoseSeedJSON, ipadNavigationReferenceJSON } from '../lib/ipadTransferSnapshot.js';
import { validateIPadNavigationReference } from '../lib/ipadNavigationReference.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const fail = (code, message) => { const error = new Error(message); error.status = code; throw error; };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
const atomicWrite = async (file, data) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
};
async function readBody(req, limit, asJSON = true) {
  if (Number(req.headers['content-length']) > limit) fail(413, '传输数据超出限制');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, '传输数据超出限制'); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  if (!asJSON) return body;
  try { return JSON.parse(body.toString('utf8')); } catch { fail(400, 'JSON 数据无效'); }
}

export function createIPadTeachingService({ directory, serverId = randomUUID(), serverName = hostname().replace(/\.local$/i, '').slice(0, 120), generatePairingCode = randomPairingCode, getAddresses = lanAddresses, usbBridge }) {
  const locks = new Map(), attempts = new Map();
  // Only an open, owner-authorized Vision Pro pairing window publishes a code.
  // Keep these short leases in memory; session files continue storing hashes only.
  const visionPairingOffers = new Map();
  const pruneVisionOffers = () => {
    for (const [id, offer] of visionPairingOffers) if (offer.leaseExpiresAt <= Date.now()) visionPairingOffers.delete(id);
  };
  async function serialized(id, run) {
    const previous = locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(run);
    locks.set(id, operation);
    try { return await operation; } finally { if (locks.get(id) === operation) locks.delete(id); }
  }
  const sessionFile = (id) => path.join(directory, id, 'session.json');
  const save = (session) => atomicWrite(sessionFile(session.id), JSON.stringify(session));
  async function load(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(404, '配对任务不存在');
    try {
      const session = JSON.parse(await readFile(sessionFile(id), 'utf8'));
      // Also identify pre-feature transfers, including old model-only QRs.
      session.referencePoseHash ||= hash(ipadPoseSeedJSON(session.poseSeed));
      session.navigationReferenceHash ||= hash(ipadNavigationReferenceJSON(session.navigationReference));
      return session;
    }
    catch (error) { if (error.code === 'ENOENT') fail(404, '配对任务不存在'); throw error; }
  }
  // Creation and renewal share one reservation lock, including the durable write.
  // Keep existing stored codes reserved so an older task cannot shadow a new one.
  const withNewPairingCode = (persist) => serialized('pairing-codes', async () => {
    const entries = await readdir(directory, { withFileTypes: true });
    const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)).map((entry) => load(entry.name)));
    const used = new Set(sessions.map((session) => session.pairingCodeHash));
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const code = generatePairingCode();
      if (/^[A-Z0-9]{4}$/.test(code) && !used.has(hash(code))) return persist(code);
    }
    fail(503, '暂时无法分配配对码，请稍后重试');
  });
  const authorize = (req, session, role) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!equal(hash(String(token || '')), session[`${role}TokenHash`])) fail(401, '配对凭据无效');
    if (session.status === 'cancelled') fail(410, '配对任务已结束');
  };
  const publicSession = (session) => ({ id: session.id, status: session.status, manifest: session.manifest,
    referencePoseHash: session.referencePoseHash,
    navigationReferenceHash: session.navigationReferenceHash,
    referenceParkingPointCount: session.navigationReference?.parkingPoints.length || 0,
    referencePathCount: session.navigationReference?.paths.length || 0,
    referencePoseCount: session.poseSeed?.samples.length || 0,
    referenceIPadPoseCount: session.poseSeed?.samples.filter((sample) => sample.origin === 'ipad').length || 0,
    referenceLeftArmPoseCount: session.poseSeed?.samples.filter((sample) => ipadPoseArm(sample) === 'left').length || 0,
    referenceRightArmPoseCount: session.poseSeed?.samples.filter((sample) => ipadPoseArm(sample) === 'right').length || 0,
    createdAt: session.createdAt, pairedAt: session.pairedAt, completedAt: session.completedAt,
    importedAt: session.importedAt, sampleCount: session.sampleCount || 0, deviceName: session.deviceName || '' });
  async function verifyModel(session, identity) {
    if (!/^[a-f0-9]{64}$/.test(identity?.modelHash) || !Number.isInteger(identity?.byteLength)
      || identity.byteLength < 48 || identity.byteLength > MAX_MODEL_BYTES) fail(400, '模型校验信息无效');
    if (identity.modelHash !== session.manifest.modelHash || identity.byteLength !== session.manifest.byteLength) {
      fail(409, '设备与电脑配对任务中的模型内容不一致，已停止同步；请确认使用的是同一模型');
    }
    // Re-read the actual frozen model. Names, project metadata and all poses are excluded.
    const digest = createHash('sha256'); let byteLength = 0;
    try {
      for await (const chunk of createReadStream(path.join(directory, session.id, 'model.atls'))) {
        byteLength += chunk.length;
        if (byteLength > session.manifest.byteLength) fail(409, '电脑端模型文件已改变，已停止同步；请恢复配对时的模型后重试');
        digest.update(chunk);
      }
    } catch (error) {
      if (error.code === 'ENOENT') fail(409, '电脑端缺少配对时的模型文件，已停止同步；请恢复模型后重试');
      throw error;
    }
    const modelHash = digest.digest('hex');
    if (byteLength !== identity.byteLength || modelHash !== identity.modelHash) {
      fail(409, '电脑端模型文件已改变，已停止同步；请恢复配对时的模型后重试');
    }
    return { sessionId: session.id, modelHash, byteLength, verified: true };
  }

  return async function ipadMiddleware(req, res, next) {
    const pathname = (req.url || '').split('?')[0];
    if (!pathname.startsWith('/__atlas/ipad/')) return next();
    try {
      // No cross-origin access or ambient cookies; native iPad calls use bearer credentials.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, '不允许跨站访问配对服务');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const route = pathname.slice('/__atlas/ipad'.length);
      const localUSB = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (route === '/usb' && req.method === 'GET') {
        if (!localUSB) return json(res, 200, { supported: false, devices: [], message: '请在连接 iPhone / iPad 的 Mac 上使用 http://127.0.0.1:' + req.socket.localPort + ' 打开工作台。' });
        return json(res, 200, usbBridge?.status() || { supported: false, devices: [], message: '请在连接 iPhone / iPad 的 Mac 上运行示教服务。' });
      }
      if (route === '/info' && req.method === 'GET') {
        const port = req.socket.localPort;
        const addresses = getAddresses(port);
        return json(res, 200, { protocol: IPAD_PROTOCOL, serverId, serverName, port, addresses, maxModelBytes: MAX_MODEL_BYTES });
      }
      if (route === '/vision-pairing' && req.method === 'GET') {
        pruneVisionOffers();
        const offers = new Map();
        for (const offer of visionPairingOffers.values()) {
          if (!offer.code) continue;
          const session = await load(offer.sessionId);
          if (session.status !== 'ready' || session.deviceId || Date.now() >= session.pairingExpiresAt
            || !equal(session.pairingCodeHash, hash(offer.code))) continue;
          offers.set(session.id, { sessionId: session.id, name: session.manifest.name.slice(0, 240),
            code: offer.code, expiresAt: session.pairingExpiresAt });
        }
        return json(res, 200, { protocol: IPAD_PROTOCOL, serverId, offers: [...offers.values()].slice(0, 16) });
      }
      if (route === '/sessions' && req.method === 'POST') {
        const { manifest, targetDevice = 'ipad', poseSeed, navigationReference } = await readBody(req, 32 * 1024 * 1024);
        if (!['ipad', 'vision'].includes(targetDevice)) fail(400, '采集设备类型无效');
        if (manifest?.protocol !== IPAD_PROTOCOL || manifest.coordinateFrame !== 'virtual_origin'
          || manifest.distanceUnit !== 'meter' || manifest.verticalAxis !== 'Z'
          || !/^[a-f0-9]{64}$/.test(manifest.modelHash) || typeof manifest.name !== 'string'
          || !Number.isInteger(manifest.byteLength) || manifest.byteLength < 48 || manifest.byteLength > MAX_MODEL_BYTES) fail(400, '独立示教物体清单无效');
        let references, navigation;
        try {
          references = targetDevice === 'ipad' ? validateIPadPoseSeed(poseSeed, manifest) : undefined;
          navigation = targetDevice === 'ipad' ? validateIPadNavigationReference(navigationReference) : undefined;
        }
        catch (error) { fail(400, error.message); }
        return await withNewPairingCode(async (pairingCode) => {
          const id = randomUUID(), ownerToken = secret();
          const session = { id, manifest, targetDevice, poseSeed: references, referencePoseHash: hash(ipadPoseSeedJSON(references)), status: 'preparing', createdAt: new Date().toISOString(),
            navigationReference: navigation, navigationReferenceHash: hash(ipadNavigationReferenceJSON(navigation)),
            ownerTokenHash: hash(ownerToken), pairingCodeHash: hash(pairingCode),
            pairingExpiresAt: Date.now() + 15 * 60 * 1000 };
          await mkdir(path.join(directory, id), { mode: 0o700 });
          await save(session);
          return json(res, 201, { ...publicSession(session), ownerToken, pairingCode, pairingExpiresAt: session.pairingExpiresAt });
        });
      }
      if (['/pair', '/pair-result'].includes(route) && req.method === 'POST') {
        const forResult = route === '/pair-result';
        const peer = req.socket.remoteAddress, now = Date.now();
        for (const [key, value] of attempts) if (now - value.start > 60000) attempts.delete(key);
        const attempt = attempts.get(peer) || { start: now, count: 0 }; attempt.count += 1; attempts.set(peer, attempt);
        if (attempt.count > 20) fail(429, '配对尝试过于频繁，请一分钟后重试');
        const body = await readBody(req, 4096);
        if (forResult && (!/^[a-zA-Z0-9-]{1,80}$/.test(body.resultId || '') || !body.sessionId || !body.serverId)) {
          fail(400, '扫码同步信息无效，请重新扫描电脑二维码');
        }
        if ((body.sessionId != null || body.serverId != null)
          && (body.serverId !== serverId || !/^[a-f0-9-]{36}$/.test(body.sessionId || ''))) fail(409, '二维码对应的服务已变更，请重新扫描电脑上的二维码');
        const code = String(body.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) fail(400, '请输入 4 位配对码，仅支持大写字母 A–Z 和数字 0–9');
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.deviceId || '')) fail(400, '配对设备标识无效');
        const dirs = await readdir(directory, { withFileTypes: true });
        for (const dir of dirs.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))) {
          const candidate = await load(dir.name);
          if (!equal(candidate.pairingCodeHash, hash(code))) continue;
          return await serialized(candidate.id, async () => {
            const session = await load(candidate.id);
            if (body.sessionId != null && body.sessionId !== session.id) fail(409, '二维码与当前传输任务不匹配，请重新扫描');
            if (!equal(session.pairingCodeHash, hash(code))) fail(404, '配对码已更新，请使用电脑显示的新配对码');
            if (now > session.pairingExpiresAt) fail(410, '配对码已过期，请在电脑上重新生成');
            if (!(forResult ? ['ready', 'paired', 'completed', 'imported'] : ['ready', 'paired']).includes(session.status)) fail(409, '该任务当前不可配对');
            if (session.deviceId && session.deviceId !== body.deviceId) fail(409, '配对码已被另一台设备使用');
            if (forResult) {
              // Check both files before claiming the task or rotating credentials.
              // A scan of a different workpiece must not consume its QR code.
              await verifyModel(session, body.modelIdentity);
              if (session.resultHash) {
                const existing = JSON.parse(await readFile(path.join(directory, session.id, 'result.json'), 'utf8'));
                if (existing.id !== body.resultId) fail(409, '电脑任务已有另一份示教结果，请点击「新建传输」后重新扫码');
              }
            }
            const deviceToken = secret();
            Object.assign(session, { status: session.resultHash ? session.status : 'paired', deviceId: body.deviceId, deviceName: String(body.deviceName || 'iPad Pro').slice(0, 80),
              deviceTokenHash: hash(deviceToken), pairedAt: new Date().toISOString() });
            await save(session);
            return json(res, 200, { ...publicSession(session), deviceToken,
              ...(!forResult && session.navigationReference ? { navigationReference: session.navigationReference } : {}),
              ...(!forResult && session.poseSeed ? { poseSeed: session.poseSeed } : {}) });
          });
        }
        fail(404, '找不到配对码，请确认电脑地址与配对码');
      }
      const match = /^\/sessions\/([a-f0-9-]{36})(?:\/(model|thumbnail|verify-model|result|imported|renew|pairing-qr|vision-pairing|usb))?$/.exec(route);
      if (!match) fail(404, '接口不存在');
      const [, id, action] = match;
      await serialized(id, async () => {
        const session = await load(id);
        const role = (['model', 'thumbnail'].includes(action) && req.method === 'GET')
          || (['verify-model', 'result'].includes(action) && req.method === 'POST') ? 'device' : 'owner';
        authorize(req, session, role);
        if (action === 'usb' && req.method === 'POST') {
          if (!localUSB) fail(403, '请在连接 iPhone / iPad 的 Mac 本机工作台发送数据线文件。');
          if (!usbBridge) fail(503, '当前服务未启用 Mac 数据线传输。');
          if (session.targetDevice === 'vision' || !['ready', 'paired', 'completed', 'imported'].includes(session.status)) {
            fail(409, '请先为 iPhone / iPad 准备好当前物体。');
          }
          const { deviceId } = await readBody(req, 4096);
          if (typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(deviceId)) fail(400, '请选择已连接的 iPhone / iPad。');
          await verifyModel(session, session.manifest);
          return json(res, 200, await usbBridge.send({ deviceId, session, modelPath: path.join(directory, id, 'model.atls') }));
        }
        if (action === 'vision-pairing' && ['POST', 'DELETE'].includes(req.method)) {
          const { publisherId, code } = await readBody(req, 4096);
          if (!/^[a-f0-9-]{36}$/.test(publisherId || '')) fail(400, '配对窗口标识无效');
          pruneVisionOffers();
          const previous = visionPairingOffers.get(publisherId);
          if (previous && previous.sessionId !== id) fail(409, '配对窗口与任务不匹配');
          if (req.method === 'DELETE') {
            // A delayed heartbeat cannot reopen a window that was already closed.
            visionPairingOffers.set(publisherId, { sessionId: id, code: null, leaseExpiresAt: Date.now() + 45_000 });
            return json(res, 200, { published: false });
          }
          if (previous && !previous.code) fail(409, '配对窗口已关闭');
          if (session.targetDevice && session.targetDevice !== 'vision') fail(409, '请从 Vision Pro 配对窗口连接');
          if (session.status !== 'ready' || session.deviceId) fail(409, '此任务已配对或尚未准备好，请在电脑上新建传输');
          if (Date.now() >= session.pairingExpiresAt) fail(410, '配对码已过期，请在电脑更新配对码');
          if (typeof code !== 'string' || !/^[A-Z0-9]{4}$/.test(code) || !equal(session.pairingCodeHash, hash(code))) {
            fail(409, '配对码已更新，请使用当前配对窗口');
          }
          visionPairingOffers.set(publisherId, { sessionId: id, code, leaseExpiresAt: Date.now() + 45_000 });
          return json(res, 200, { published: true });
        }
        if (!action && req.method === 'GET') return json(res, 200, publicSession(session));
        if (!action && req.method === 'DELETE') {
          session.status = 'cancelled'; await save(session); return json(res, 200, { status: 'cancelled' });
        }
        if (action === 'pairing-qr' && req.method === 'POST') {
          if (!['ready', 'paired'].includes(session.status)) fail(409, '只有等待配对或结果同步的任务可以生成二维码');
          if (Date.now() >= session.pairingExpiresAt) fail(410, '配对码已过期，请点击「更新配对码」');
          const { address, code } = await readBody(req, 4096);
          if (!getAddresses(req.socket.localPort).includes(address)) fail(400, '请选择当前电脑的局域网地址');
          if (typeof code !== 'string' || !/^[A-Z0-9]{4}$/.test(code)
            || !equal(session.pairingCodeHash, hash(code))) fail(409, '配对码已更新，请刷新任务或更新配对码');
          const payload = { protocol: 'atlas-ipad-pairing/1', address, code,
            sessionId: session.id, serverId, expiresAt: session.pairingExpiresAt };
          const image = await pairingQRCode(payload);
          return json(res, 200, { image, expiresAt: session.pairingExpiresAt });
        }
        if (action === 'renew' && req.method === 'POST') {
          if (!['ready', 'paired'].includes(session.status)) fail(409, '只有等待配对或结果同步的任务可以更新配对码');
          return await withNewPairingCode(async (pairingCode) => {
            session.pairingCodeHash = hash(pairingCode); session.pairingExpiresAt = Date.now() + 15 * 60 * 1000;
            await save(session); return json(res, 200, { pairingCode, pairingExpiresAt: session.pairingExpiresAt });
          });
        }
        if (action === 'model' && req.method === 'PUT') {
          if (session.status !== 'preparing') fail(409, '模型已冻结，请创建新的配对任务');
          const body = await readBody(req, MAX_MODEL_BYTES, false);
          if (body.length !== session.manifest.byteLength || hash(body) !== session.manifest.modelHash) fail(400, '模型传输校验失败');
          const counts = validateModelBytes(body);
          if (counts.vertices !== session.manifest.vertices || counts.indices !== session.manifest.indices) fail(400, '模型清单与数据不一致');
          await atomicWrite(path.join(directory, id, 'model.atls'), body);
          session.status = 'ready'; await save(session); return json(res, 200, publicSession(session));
        }
        if (action === 'model' && req.method === 'GET') {
          const file = path.join(directory, id, 'model.atls');
          const stats = await stat(file);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stats.size,
            'Cache-Control': 'no-store', 'X-Content-SHA256': session.manifest.modelHash });
          const stream = createReadStream(file); stream.on('error', (error) => res.destroy(error)); stream.pipe(res); return;
        }
        if (action === 'thumbnail' && req.method === 'GET') {
          if (!['paired', 'completed', 'imported'].includes(session.status)) fail(409, '该任务当前不可预览');
          const file = path.join(directory, id, 'thumbnail-v1.png');
          let image;
          try { image = await readFile(file); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const model = await readFile(path.join(directory, id, 'model.atls'));
            if (model.length !== session.manifest.byteLength || hash(model) !== session.manifest.modelHash) fail(409, '电脑模型文件与配对时不一致');
            image = await modelThumbnail(model);
            await atomicWrite(file, image);
          }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Model-SHA256': session.manifest.modelHash });
          res.end(image); return;
        }
        if (action === 'verify-model' && req.method === 'POST') {
          const identity = await readBody(req, 4096);
          return json(res, 200, await verifyModel(session, identity));
        }
        if (action === 'result' && req.method === 'POST') {
          const result = await readBody(req, 48 * 1024 * 1024);
          validateIPadResult(result, session.manifest, id);
          // Recheck on receipt as well, including older clients and a file changed after preflight.
          await verifyModel(session, { modelHash: result.modelHash, byteLength: session.manifest.byteLength });
          const body = JSON.stringify(result), digest = hash(body);
          // Exactly one immutable completed result. Retrying after a lost response is safe.
          if (session.resultHash && session.resultHash !== digest) fail(409, '已收到不同的完成结果，不能覆盖');
          await atomicWrite(path.join(directory, id, 'result.json'), body);
          Object.assign(session, { status: session.importedAt ? 'imported' : 'completed', resultHash: digest,
            completedAt: result.completedAt, sampleCount: result.samples.length });
          await save(session); return json(res, 200, { id: result.id, received: true, sampleCount: session.sampleCount });
        }
        if (action === 'result' && req.method === 'GET') {
          if (!session.resultHash) fail(409, '设备尚未提交完成结果');
          return json(res, 200, JSON.parse(await readFile(path.join(directory, id, 'result.json'), 'utf8')));
        }
        if (action === 'imported' && req.method === 'POST') {
          if (!session.resultHash) fail(409, '尚无结果可以接收');
          session.importedAt = new Date().toISOString(); session.status = 'imported'; await save(session);
          return json(res, 200, publicSession(session));
        }
        fail(405, '不支持该操作');
      });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || (error.code ? 500 : 400), { error: error.code ? '局域网文件服务暂时不可用' : error.message });
      else res.destroy(error);
    }
  };
}

export function ipadTeachingPlugin() {
  let root, logger;
  const cleanups = new Set();
  const install = (server) => {
    const identity = ipadServerIdentity(server.httpServer);
    const usbBridge = createIPadUSBBridge({ directory: path.join(root, '.atlas-cache', 'ipad-usb'), ...identity });
    server.middlewares.use(createIPadTeachingService({ directory: path.join(root, '.atlas-cache', 'ipad-teaching'), ...identity, usbBridge }));
    if (server.httpServer) {
      const start = () => usbBridge.start();
      if (server.httpServer.listening) start(); else server.httpServer.once('listening', start);
      const stop = () => { server.httpServer.removeListener('listening', start); usbBridge.close(); };
      server.httpServer.once('close', stop); cleanups.add(stop);
    }
    if (server.httpServer) cleanups.add(advertiseIPadService(server.httpServer, { ...identity,
      onError: (error) => logger?.warn(`iPad 局域网发现暂不可用，仍可手动填写地址：${error.message}`) }));
  };
  return { name: 'atlas-ipad-teaching', configResolved(config) { root = config.root; logger = config.logger; },
    configureServer: install, configurePreviewServer: install,
    closeBundle() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); } };
}
