import { once } from 'node:events';
import { robotFetch } from './robotTwinTransport.js';

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Only existing PNG/ABXXYZ1 files are readable. This endpoint cannot submit a
// capture, subscribe to Zivid preview, download arbitrary files or send motion.
export async function streamRobotCapture(session, res, { id, side, kind }) {
  if (!/^[a-f0-9]{32}$/.test(id) || !['left', 'right'].includes(side) || !['png', 'xyzbin'].includes(kind)) fail(400, '采集文件参数无效');
  session.captureReads ||= new Set();
  if (session.captureReads.size >= 2) fail(429, '正在读取其他采集文件，请稍后重试', 'ROBOT_CAPTURE_BUSY');
  const controller = new AbortController(); session.captureReads.add(controller);
  const cancel = () => {
    if (!res.writableEnded) { controller.abort(); session.captureReads.delete(controller); }
  };
  res.once('close', cancel);
  const signal = AbortSignal.any([controller.signal, session.controller.signal, AbortSignal.timeout(60_000)]);
  const maxBytes = kind === 'png' ? 64 * 1024 * 1024 : 120_000_016;
  try {
    const response = await robotFetch(session, `/api/v1/cameras/jobs/${id}/${side}/${kind}`, {
      method: 'GET', redirect: 'error', signal, maxBytes, timeoutMs: 60_000,
      headers: { Accept: kind === 'png' ? 'image/png' : 'application/octet-stream', 'X-ABX-Web-Client': 'robot-dashboard',
        ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.credential ? { 'X-ABX-Control-Token': session.credential } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) fail(401, '采集结果鉴权失败，请重新输入管理员密码', 'ROBOT_AUTH_FAILED');
      fail([404, 409, 429, 503].includes(response.status) ? response.status : 502,
        response.status === 404 ? '本次采集文件不存在或已被清理' : `采集文件暂不可用（HTTP ${response.status}）`);
    }
    const length = Number(response.headers.get('content-length'));
    if (length > maxBytes) { await response.body?.cancel(); fail(413, '采集文件超过预览大小限制'); }
    let received = 0, prefix = Buffer.alloc(0), begun = false;
    for await (const value of response.body) {
      const chunk = Buffer.from(value); received += chunk.length;
      if (received > maxBytes) fail(413, '采集文件超过预览大小限制');
      if (!begun) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 16) continue;
        if (kind === 'png' ? !prefix.subarray(0, 8).equals(PNG) : prefix.subarray(0, 8).toString('ascii') !== 'ABXXYZ1\0') fail(502, '采集文件格式无效');
        res.writeHead(200, { 'Content-Type': kind === 'png' ? 'image/png' : 'application/octet-stream', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', ...(length > 0 ? { 'Content-Length': length } : {}) });
        begun = true;
        if (!res.write(prefix)) await once(res, 'drain', { signal });
        prefix = null;
      } else if (!res.write(chunk)) await once(res, 'drain', { signal });
    }
    if (!begun || (length > 0 && received !== length)) fail(502, '采集文件不完整');
    res.end();
  } catch (error) {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) {
      if (error.status) throw error;
      fail(502, '采集文件读取中断或超时，请重试');
    }
  } finally { controller.abort(); res.off('close', cancel); session.captureReads.delete(controller); }
}
