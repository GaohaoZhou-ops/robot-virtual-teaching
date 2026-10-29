import { default as https } from 'node:https';
import { default as http } from 'node:http';
import { sendJson } from '../http/json.js';

export const PHYSICS_API_PREFIX = '/__atlas/physics';

export const PHYSICS_BACKENDS = new Set(['local', 'auto', 'isaac']);

export const normalizePhysicsBackend = (value) => {
  const normalized = String(value || 'local').trim().toLowerCase();
  return PHYSICS_BACKENDS.has(normalized) ? normalized : 'local';
};

export const physicsTransport = (url) => (url.protocol === 'https:' ? https : http);

export function requestIsaacHealth(baseUrl, token) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const target = new URL('/health', baseUrl);
    const request = physicsTransport(target).request(target, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > 64 * 1024) {
          finish({ available: false, error: 'Isaac 健康检查响应过大' });
          return;
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode === 200 && payload?.ok && payload?.apiVersion === 1) {
            finish({ available: true, health: payload });
          } else {
            finish({
              available: false,
              error: payload?.error || `Isaac 碰撞服务返回 HTTP ${response.statusCode}`,
            });
          }
        } catch {
          finish({ available: false, error: 'Isaac 健康检查响应格式无效' });
        }
      });
    });
    request.setTimeout(1200, () => {
      request.destroy();
      finish({ available: false, error: 'Isaac 碰撞服务连接超时' });
    });
    request.on('error', (error) => finish({
      available: false,
      error: error.code === 'ECONNREFUSED'
        ? 'Isaac 碰撞服务尚未启动'
        : error.message || 'Isaac 碰撞服务不可达',
    }));
    request.end();
  });
}

export function relayIsaacRequest(request, response, baseUrl, token) {
  const suffix = request.url.slice(PHYSICS_API_PREFIX.length);
  const target = new URL(suffix, baseUrl);
  const headers = {
    ...request.headers,
    host: target.host,
    connection: 'close',
  };
  delete headers.origin;
  delete headers.referer;
  if (token) headers.authorization = `Bearer ${token}`;
  const upstream = physicsTransport(target).request(target, {
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.statusCode = upstreamResponse.statusCode || 502;
    Object.entries(upstreamResponse.headers).forEach(([name, value]) => {
      if (value !== undefined && !['connection', 'keep-alive'].includes(name.toLowerCase())) {
        response.setHeader(name, value);
      }
    });
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(95_000, () => {
    upstream.destroy(new Error('Isaac collision request timed out'));
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) {
      sendJson(response, 503, {
        error: error.message || 'Isaac 碰撞服务不可达',
        code: 'isaac_unavailable',
      });
    } else {
      response.destroy(error);
    }
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

export function atlasPhysicsPlugin() {
  const requestedBackend = normalizePhysicsBackend(process.env.ATLAS_PHYSICS_BACKEND);
  let isaacUrl;
  try {
    isaacUrl = new URL(
      process.env.ISAAC_SIM_COLLISION_URL || 'http://127.0.0.1:49101',
    );
    if (!['http:', 'https:'].includes(isaacUrl.protocol)) throw new Error('unsupported protocol');
  } catch {
    isaacUrl = new URL('http://127.0.0.1:49101');
  }
  const token = process.env.ISAAC_SIM_COLLISION_TOKEN || '';

  const installEndpoints = (middlewares) => {
    middlewares.use(async (request, response, next) => {
      const pathname = request.url?.split('?')[0] || '';
      if (pathname === `${PHYSICS_API_PREFIX}/config`) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: '仅支持 GET' });
          return;
        }
        const probe = requestedBackend === 'local'
          ? { available: false, error: null }
          : await requestIsaacHealth(isaacUrl, token);
        const activeBackend = probe.available
          ? 'isaac'
          : requestedBackend === 'auto' || requestedBackend === 'local'
            ? 'local'
            : 'unavailable';
        sendJson(response, 200, {
          apiVersion: 1,
          requestedBackend,
          activeBackend,
          localAvailable: true,
          isaac: {
            available: probe.available,
            engine: probe.health?.engine || 'NVIDIA PhysX',
            isaacSimVersion: probe.health?.isaacSimVersion || null,
            apiVersion: probe.health?.apiVersion || null,
            error: probe.error || null,
          },
        });
        return;
      }
      if (!pathname.startsWith(`${PHYSICS_API_PREFIX}/v1/`)) {
        next();
        return;
      }
      if (requestedBackend === 'local') {
        sendJson(response, 409, {
          error: '服务端当前配置为本地碰撞后端',
          code: 'backend_disabled',
        });
        return;
      }
      relayIsaacRequest(request, response, isaacUrl, token);
    });
  };

  return {
    name: 'atlas-physics-services',
    configureServer(server) {
      installEndpoints(server.middlewares);
    },
    configurePreviewServer(server) {
      installEndpoints(server.middlewares);
    },
  };
}
