/* Runs in its own localhost top-level window. LAN pages never fetch loopback
 * resources: exact-origin postMessage keeps frames on this computer and works
 * without weakening Chrome / Edge's Local Network Access protection. */
const protocol = 'atlas-ipad-usb-bridge/1';
const params = new URLSearchParams(location.hash.slice(1));
const nonce = params.get('nonce'), origin = params.get('origin');
const secret = document.querySelector('meta[name="atlas-bridge"]').content;
const allow = document.querySelector('#allow'), disconnect = document.querySelector('#disconnect');
const status = document.querySelector('#status');
let approved = false, session = null, stream = null;
const send = (value) => window.opener?.postMessage({ protocol, nonce, ...value }, origin);
const headers = (token) => ({ 'X-Atlas-Bridge': secret, ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const stop = () => {
  approved = false; stream?.abort(); stream = null;
  if (session) {
    void fetch(`/api/session/${session.id}`, { method: 'DELETE', headers: headers(session.token), keepalive: true }).catch(() => {});
    session = null;
  }
};
try {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || !/^[a-f0-9]{64}$/.test(nonce) || !window.opener) throw new Error();
  document.querySelector('#source').textContent = origin;
  allow.disabled = false;
  status.textContent = '仅连接当前工作台；画面和控制经这台电脑的数据线传输。';
} catch { status.textContent = '请关闭此窗口，从工作台点击“连接本机助手”。'; }

allow.addEventListener('click', () => {
  approved = true; allow.hidden = true; disconnect.hidden = false;
  status.textContent = '助手已连接，请返回工作台选择 iPad 并开始协作。';
  send({ kind: 'ready' });
});
disconnect.addEventListener('click', () => {
  send({ kind: 'closed' }); stop();
  disconnect.hidden = true; status.textContent = '已断开。重新连接时，请从工作台再次打开助手。';
});
window.addEventListener('message', async (event) => {
  const data = event.data;
  if (!approved || event.source !== window.opener || event.origin !== origin
    || data?.protocol !== protocol || data.nonce !== nonce) return;
  if (data.kind === 'close-stream') { stream?.abort(); stream = null; return; }
  if (data.kind === 'events') {
    if (!session || data.sessionId !== session.id || stream) return;
    const controller = new AbortController(); stream = controller;
    try {
      const response = await fetch(`/api/session/${session.id}/events`, { headers: headers(session.token), signal: controller.signal });
      if (!response.ok) throw new Error((await response.json()).error);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line) send({ kind: 'event', sessionId: data.sessionId, data: line });
        }
      }
      if (!controller.signal.aborted) send({ kind: 'stream-closed', sessionId: data.sessionId });
    } catch (error) {
      if (!controller.signal.aborted) send({ kind: 'stream-closed', sessionId: data.sessionId, error: error.message });
    } finally { if (stream === controller) stream = null; }
    return;
  }
  if (data.kind !== 'request' || typeof data.id !== 'number') return;
  try {
    const route = data.route;
    if (typeof route !== 'string' || !/^\/(devices|session(?:\/[a-f0-9-]{36}(?:\/(frame|workspace))?)?)$/.test(route)
      || !['GET', 'POST', 'PUT', 'DELETE'].includes(data.method)) throw new Error('连接操作无效');
    const auth = data.authorization || '';
    if (route.startsWith('/session/') && (!session || !route.startsWith(`/session/${session.id}`)
      || auth !== `Bearer ${session.token}`)) throw new Error('协作凭据无效');
    if (data.body?.byteLength > 2 * 1024 * 1024 || typeof data.body === 'string' && data.body.length > 65536) throw new Error('画面数据过大');
    const response = await fetch('/api' + route, { method: data.method, headers: { ...headers(), Authorization: auth },
      body: data.body, signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '数据线连接失败');
    if (route === '/session' && data.method === 'POST') {
      session = result; status.textContent = `${result.deviceName} 已连接。画面、关节与姿态记录经 USB 传输。`;
    }
    if (data.method === 'DELETE') { session = null; status.textContent = '协作已结束，可以从工作台重新开始。'; }
    send({ kind: 'response', id: data.id, value: result });
  } catch (error) { send({ kind: 'response', id: data.id, error: error.message }); }
});
window.addEventListener('pagehide', () => { if (approved) send({ kind: 'closed' }); stop(); });
setInterval(() => {
  if (approved && (!window.opener || window.opener.closed)) {
    stop(); status.textContent = '工作台已关闭，数据线协作已结束。'; disconnect.hidden = true;
  }
}, 1000);
