import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_SCENE_ASSET_BYTES, MAX_SCENE_BYTES, validateVisionScene, VISION_SCENE_FORMAT } from '../lib/visionSceneProtocol.js';

const token = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function jsonBody(req, max = 12 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) fail(413, '空间工程清单过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, '空间工程 JSON 无效'); }
}

// A read-only, explicitly published scene snapshot. No endpoint controls robots
// or modifies a desktop project. Closing the publishing dialog revokes sharing.
export function createVisionSceneService({ directory = path.resolve('.atlas-cache/vision-scenes'), now = () => Date.now() } = {}) {
  const sessions = new Map();
  async function prune() {
    for (const [id, scene] of sessions) if (scene.expiresAt < now()) {
      sessions.delete(id); await rm(path.join(directory, id), { recursive: true, force: true });
    }
  }
  return async function visionSceneMiddleware(req, res, next) {
    const pathname = (req.url || '').split('?')[0];
    if (!pathname.startsWith('/__atlas/vision-scenes')) return next();
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, '不允许跨站共享空间工程');
      await prune();
      const route = pathname.slice('/__atlas/vision-scenes'.length);
      if (route === '' && req.method === 'GET') return send(res, 200, { format: VISION_SCENE_FORMAT, scenes: [...sessions.values()].filter((s) => s.manifest).map((s) => ({
        id: s.id, name: s.manifest.name, createdAt: s.manifest.createdAt, readToken: s.readToken, bytes: s.bytes,
        hasRobot: !!s.manifest.robotRoot, clipCount: s.manifest.clips.length,
      })) });
      if (route === '' && req.method === 'POST') {
        if (sessions.size >= 8) fail(409, '请先关闭旧的空间工程共享窗口');
        const session = { id: randomUUID(), ownerToken: token(), readToken: token(), expiresAt: now() + 30 * 60000, bytes: 0, assets: new Map() };
        await mkdir(path.join(directory, session.id), { recursive: true, mode: 0o700 });
        sessions.set(session.id, session); return send(res, 201, { id: session.id, ownerToken: session.ownerToken });
      }
      const match = /^\/([a-f0-9-]{36})(?:\/(manifest|heartbeat|assets\/([a-f0-9]{64})))?$/.exec(route);
      if (!match || !sessions.has(match[1])) fail(404, '空间工程共享已结束，请在电脑重新打开');
      const session = sessions.get(match[1]), bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const owner = equal(bearer, session.ownerToken), reader = equal(bearer, session.readToken);
      if (!owner && !(reader && req.method === 'GET' && session.manifest)) fail(403, '空间工程访问凭据无效');
      const folder = path.join(directory, session.id), operation = match[2], hash = match[3];
      if (!operation && req.method === 'DELETE' && owner) {
        sessions.delete(session.id); await rm(folder, { recursive: true, force: true }); return send(res, 200, { closed: true });
      }
      if (operation === 'heartbeat' && req.method === 'POST' && owner) {
        session.expiresAt = now() + 30 * 60000; return send(res, 200, { active: true });
      }
      if (hash && req.method === 'PUT' && owner && !session.manifest) {
        if (session.uploading) fail(409, '请顺序上传空间资源');
        if (session.assets.has(hash)) return send(res, 200, { stored: true });
        session.uploading = true;
        const temporary = path.join(folder, `${hash}.partial`), target = path.join(folder, `${hash}.atls`);
        let handle;
        try {
          handle = await open(temporary, 'w', 0o600); const digest = createHash('sha256'); let size = 0;
          let header = Buffer.alloc(0);
          for await (const chunk of req) {
            if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
            size += chunk.length;
            if (size > MAX_SCENE_ASSET_BYTES || session.bytes + size > MAX_SCENE_BYTES) fail(413, '空间资源超过大小限制');
            digest.update(chunk); await handle.writeFile(chunk);
          }
          if (size < 48 || digest.digest('hex') !== hash) fail(400, '空间资源校验失败');
          const vertices = header.readUInt32LE(8), indices = header.readUInt32LE(12);
          if (header.readUInt32LE(0) !== 0x534c5441 || header.readUInt32LE(4) !== 1 || vertices < 1 || vertices > 5_000_000
            || indices > 30_000_000 || indices % 3 !== 0 || size !== 32 + vertices * 16 + indices * 4) fail(400, '空间资源格式无效');
          await handle.close(); handle = null; await rename(temporary, target);
          session.assets.set(hash, { size, vertices, indices }); session.bytes += size;
        } finally { await handle?.close(); await rm(temporary, { force: true }); session.uploading = false; }
        return send(res, 200, { stored: true });
      }
      if (operation === 'manifest' && req.method === 'PUT' && owner && !session.manifest) {
        let manifest;
        try { manifest = validateVisionScene(await jsonBody(req)); } catch (error) { fail(error.status || 400, error.message); }
        if (session.uploading || manifest.assets.some((a) => {
          const uploaded = session.assets.get(a.id);
          return uploaded?.size !== a.byteLength || uploaded.vertices !== a.vertices || uploaded.indices !== a.indices;
        })) fail(409, '空间资源尚未完整上传');
        const completed = { ...manifest, id: session.id };
        await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(completed), { mode: 0o600 });
        session.manifest = completed;
        return send(res, 200, { ready: true, id: session.id });
      }
      if (operation === 'manifest' && req.method === 'GET' && session.manifest) return send(res, 200, session.manifest);
      if (hash && req.method === 'GET' && session.manifest?.assets.some((asset) => asset.id === hash)) {
        const file = path.join(folder, `${hash}.atls`), info = await stat(file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
        createReadStream(file).on('error', (error) => res.destroy(error)).pipe(res); return;
      }
      fail(405, '不支持此空间工程操作');
    } catch (error) { if (!res.headersSent) send(res, error.status || 500, { error: error.message }); else res.destroy(error); }
  };
}

export function visionScenePlugin() {
  const middleware = createVisionSceneService();
  return { name: 'atlas-vision-scenes', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
