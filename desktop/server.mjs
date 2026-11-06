import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createAtlasServicePlugins } from '../src/server/plugins.js';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ply': 'application/octet-stream' };
const devicePath = /^\/__atlas\/(?:ipad|work-sync|vision)/;
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startDesktopServer({ resources, userData, key, releaseClock, usbTransport,
  port = 0, host = '0.0.0.0', plugins: suppliedPlugins }) {
  const stack = [], cleanups = [];
  const middlewares = { use(fn) { stack.push(fn); } };
  let expired = false;
  const isInternal = (req) => equal(req.headers['x-atlas-desktop-key'], key);
  const server = createServer((req, res) => {
    const pathname = req.url?.split('?')[0] || '/';
    if (!isInternal(req) && !devicePath.test(pathname)) return json(res, 403, { error: '请从 Atlas Mac 应用打开工作台。' });
    if (pathname === '/__atlas/release') return json(res, 200, releaseClock.snapshot());
    if (releaseClock.snapshot().status === 'expired' && pathname.startsWith('/__atlas/')
      && !['/__atlas/session', '/__atlas/robots', '/__atlas/physics/config'].includes(pathname)
      && !pathname.startsWith('/__atlas/robot-files/')) return json(res, 403, { error: '当前版本已到期，请更新软件。', code: 'release_expired' });
    let index = 0;
    const next = (error) => {
      if (res.writableEnded) return;
      if (error) { if (res.headersSent) res.destroy(); else json(res, 500, { error: '本地服务处理失败。' }); return; }
      const handler = stack[index++];
      if (!handler) { void serveStatic(req, res, resources).catch(() => { if (res.headersSent) res.destroy(); else json(res, 500, { error: '无法读取应用资源。' }); }); return; }
      try { Promise.resolve(handler(req, res, next)).catch(next); } catch (err) { next(err); }
    };
    next();
  });
  // Prepend before service upgrade listeners. Unauthenticated device protocols
  // continue to apply their own pairing/token checks in the existing services.
  server.on('upgrade', (req, socket) => {
    if (releaseClock.snapshot().status === 'expired'
      || (!isInternal(req) && !devicePath.test(req.url || ''))) socket.destroy();
  });
  const plugins = suppliedPlugins || createAtlasServicePlugins({ dataRoot: userData, usbTransport, desktop: true });
  for (const plugin of plugins) {
    plugin.configResolved?.({ root: resources, logger: { warn: console.warn } });
    plugin.configureServer?.({ httpServer: server, middlewares });
    if (plugin.closeBundle) cleanups.push(() => plugin.closeBundle());
  }
  let closing;
  const closeServices = () => closing ||= Promise.allSettled(cleanups.splice(0).map((cleanup) => {
    try { return cleanup(); } catch (error) { return Promise.reject(error); }
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    port: server.address().port,
    refreshPolicy() {
      if (!expired && releaseClock.snapshot().status === 'expired') { expired = true; closeServices(); }
    },
    async close() { await closeServices(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

async function serveStatic(req, res, resources) {
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持此操作。' });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return json(res, 400, { error: '地址无效。' }); }
  if (pathname.startsWith('/__atlas/')) return json(res, 404, { error: '接口不存在。' });
  const root = path.join(resources, 'web');
  const route = ['/', '/workbench', '/teaching-data', '/model-editor', '/model-editor/dual'].includes(pathname);
  const file = path.resolve(root, route ? 'index.html' : `.${pathname}`);
  if (!file.startsWith(`${root}${path.sep}`) || pathname.includes('\0') || /\.(?:map|jsx|mjs|py|sh)$/.test(pathname)) {
    return json(res, 404, { error: '文件不存在。' });
  }
  let info;
  try {
    info = await stat(file);
    const resolved = await realpath(file);
    if (!resolved.startsWith(`${await realpath(root)}${path.sep}`) || !info.isFile()) throw new Error('not a file');
  } catch { return json(res, 404, { error: '文件不存在。' }); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
