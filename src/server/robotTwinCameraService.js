import { randomBytes } from 'node:crypto';
import { robotFetch } from './robotTwinTransport.js';
import { BODY_CAMERAS, isBodyCamera, ROBOT_CAMERA_INTERVAL } from '../lib/robotTwinCamera.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Body-camera observation has its own exact API contract: catalog GET and
// preview/frame POST. No Zivid, capture/snapshot, camera configuration or motion
// URL can be forwarded. Cookies and native preview IDs remain server-side.
export function createRobotCamera(session) {
  const client = randomBytes(16).toString('hex');
  let revision = 0, nativeGeneration = 0, camera = null, lease = false, disposed = false;
  let controller = new AbortController(), transitions = Promise.resolve(), framePending, cached, idleTimer;

  async function request(kind, form, releasing = false) {
    const path = kind === 'catalog' ? '/api/v1/body-cameras' : `/api/v1/body-cameras/${kind}`;
    if (!['catalog', 'preview', 'frame'].includes(kind)) fail(403, '仅支持本体相机预览');
    const headers = { Accept: kind === 'frame' ? 'image/jpeg' : 'application/json', 'X-ABX-Web-Client': 'robot-dashboard',
      ...(session.cookie ? { Cookie: session.cookie } : {}),
      ...(session.credential ? { 'X-ABX-Control-Token': session.credential } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) };
    let response;
    try {
      response = await robotFetch(session, path, { method: form ? 'POST' : 'GET', headers,
        ...(form ? { body: new URLSearchParams(form) } : {}), redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(3000), ...(releasing ? [] : [session.controller.signal, controller.signal])]) });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > (kind === 'frame' ? 512 * 1024 : 64 * 1024)) fail(502, '相机响应超过预览大小限制');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (!response.ok) {
        let error;
        try { error = JSON.parse(bytes.toString('utf8')).error; } catch { /* HTTP status remains useful. */ }
        fail([401, 403, 409, 429, 503].includes(response.status) ? response.status : 502,
          [401, 403].includes(response.status) ? '相机鉴权失败，请重新连接机器人'
            : typeof error === 'string' ? error.slice(0, 500) : `本体相机接口返回 HTTP ${response.status}`);
      }
      if (kind !== 'frame') return JSON.parse(bytes.toString('utf8'));
      if (response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg'
        || bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) fail(502, '相机未返回有效的 JPEG 预览帧');
      const width = Number(response.headers.get('X-ABX-Preview-Width'));
      const height = Number(response.headers.get('X-ABX-Preview-Height'));
      const sequence = response.headers.get('X-ABX-Sequence');
      if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)
        || !/^\d{1,20}$/.test(sequence || '')) fail(502, '相机预览帧信息无效');
      return { bytes, width, height, sequence };
    } catch (error) {
      if (error.status) throw error;
      fail(502, response ? '本体相机返回数据无效或读取已中断' : '本体相机连接中断或响应超时');
    }
  }

  async function release() {
    if (!lease) return;
    const generation = String(++nativeGeneration);
    for (let attempt = 0; ; ++attempt) {
      try {
        const value = await request('preview', { client, generation, enabled: '0' }, true);
        if (value?.ok !== true) fail(502, '相机关闭未确认');
        lease = false; return;
      } catch (error) {
        // ABX briefly locks the broker while waiting for an initial frame.
        if (error.status !== 503 || attempt >= 4) throw error;
        await delay(250);
      }
    }
  }
  const enqueue = (operation) => {
    const result = transitions.catch(() => {}).then(operation);
    transitions = result.catch(() => {});
    return result;
  };
  function clear() {
    clearTimeout(idleTimer); controller.abort(); controller = new AbortController(); cached = null; framePending = null; camera = null;
  }
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      clear(); void enqueue(release).catch(() => {});
    }, 4000);
    idleTimer.unref();
  }

  return {
    async catalog() {
      if (disposed) fail(401, '孪生会话已结束');
      const data = await request('catalog');
      if (data?.ok !== true || !Array.isArray(data.cameras)) fail(502, '本体相机列表格式无效');
      return { cameras: Object.entries(BODY_CAMERAS).map(([id, label]) => ({ id, label,
        available: data.cameras.some((item) => item.id === id && item.available === true) })), previewFps: 6 };
    },
    async set(next, nextRevision) {
      if (next !== null && !isBodyCamera(next)) fail(400, '请选择本体相机，不支持 Zivid 画面流');
      if (!Number.isSafeInteger(nextRevision) || nextRevision <= 0) fail(400, '相机订阅版本无效');
      if (disposed || session.controller.signal.aborted) fail(401, '孪生会话已结束');
      if (nextRevision <= revision) fail(409, '相机切换请求已过期');
      revision = nextRevision; clear();
      return enqueue(async () => {
        // Closing the previous subscriber is acknowledged before opening a new
        // one. A later stop fences delayed enables even if their HTTP is aborted.
        await release();
        if (disposed || nextRevision !== revision || session.controller.signal.aborted) fail(409, '相机请求已取消');
        if (next === null) return { ok: true, camera: null, revision };
        const generation = ++nativeGeneration;
        lease = true;
        try {
          const value = await request('preview', { client, generation: String(generation), enabled: '1', camera: next });
          if (value?.ok !== true) fail(502, '相机开启未确认');
          if (disposed || nextRevision !== revision || session.controller.signal.aborted) fail(409, '相机请求已取消');
          camera = next; touch();
          return { ok: true, camera, revision };
        } catch (error) {
          await release().catch(() => {}); throw error;
        }
      });
    },
    async frame(expectedRevision) {
      if (disposed || !camera || revision !== expectedRevision) fail(409, '画面已关闭或相机已切换');
      touch();
      if (framePending) return framePending;
      if (cached && Date.now() - cached.receivedAt < ROBOT_CAMERA_INTERVAL) return cached;
      const selected = camera, generation = nativeGeneration;
      const pending = (async () => {
        const value = await request('frame', { client, generation: String(generation) });
        if (disposed || !camera || revision !== expectedRevision || generation !== nativeGeneration) fail(409, '相机画面已失效');
        cached = { ...value, camera: selected, revision, receivedAt: Date.now() };
        return cached;
      })();
      framePending = pending;
      try { return await pending; } finally { if (framePending === pending) framePending = null; }
    },
    close() { disposed = true; clear(); return enqueue(release); },
  };
}
