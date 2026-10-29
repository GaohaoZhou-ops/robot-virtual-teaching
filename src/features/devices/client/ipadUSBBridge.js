const origin = 'http://127.0.0.1:21994';
const protocol = 'atlas-ipad-usb-bridge/1';

// Opening a localhost window is a user action, not a LAN page fetching a local
// network resource. Exact-origin messages keep binary frames off the LAN and
// preserve the original workbench's browser storage and unsynchronized project.
export function connectIPadUSBBridge(onClose) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const popup = window.open(`${origin}/#${new URLSearchParams({ origin: location.origin, nonce })}`, `atlas-usb-${nonce}`, 'popup,width=620,height=440');
  if (!popup) return Promise.reject(new Error('请允许工作台打开弹窗，再点击“连接本机助手”。'));
  return new Promise((resolve, reject) => {
    let ready = false, closed = false, sequence = 0;
    const pending = new Map(), streams = new Map();
    const post = (value, transfer = []) => popup.postMessage({ protocol, nonce, ...value }, origin, transfer);
    const close = (reason = '本机助手已断开，请重新连接。') => {
      if (closed) return;
      closed = true; clearTimeout(timeout); clearInterval(watch);
      window.removeEventListener('message', receive);
      for (const operation of pending.values()) operation.reject(new Error(reason));
      pending.clear();
      for (const connection of streams.values()) connection.onclose?.();
      streams.clear(); popup.close();
      if (ready) onClose?.(reason); else reject(new Error(reason));
    };
    const receive = (event) => {
      const data = event.data;
      if (event.source !== popup || event.origin !== origin || data?.protocol !== protocol || data.nonce !== nonce) return;
      if (data.kind === 'ready' && !ready) { ready = true; clearTimeout(timeout); resolve(bridge); }
      if (data.kind === 'response') {
        const operation = pending.get(data.id);
        if (operation) data.error ? operation.reject(new Error(data.error)) : operation.resolve(data.value);
      }
      if (data.kind === 'event') streams.get(data.sessionId)?.onmessage?.({ data: data.data });
      if (data.kind === 'stream-closed') streams.get(data.sessionId)?.onclose?.();
      if (data.kind === 'closed') close();
    };
    const timeout = setTimeout(() => close('未连接本机助手。请先解压并运行助手，再重新连接；打开窗口后需点击“允许连接此工作台”。'), 60000);
    const watch = setInterval(() => { if (popup.closed) close(); }, 1000);
    window.addEventListener('message', receive);
    const bridge = {
      close,
      async request(route, options = {}) {
        if (closed) throw new Error('本机助手已断开，请重新连接。');
        const body = options.body instanceof Blob ? await options.body.arrayBuffer() : options.body;
        if (options.signal?.aborted) throw new Error('数据线请求已取消');
        return new Promise((success, failure) => {
          const id = ++sequence;
          const finish = (callback, value) => {
            clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); pending.delete(id); callback(value);
          };
          const operation = { resolve: (value) => finish(success, value), reject: (error) => finish(failure, error) };
          const timer = setTimeout(() => operation.reject(new Error('数据线请求超时，请检查助手和 iPad 连接。')), 15000);
          const aborted = () => operation.reject(new Error('数据线请求已取消'));
          options.signal?.addEventListener('abort', aborted, { once: true });
          pending.set(id, operation);
          try { post({ kind: 'request', id, route, method: options.method || 'GET',
            authorization: options.headers?.Authorization, body }, body instanceof ArrayBuffer ? [body] : []); }
          catch (error) { operation.reject(error); }
        });
      },
      events(session) {
        const connection = {
          send() { post({ kind: 'events', sessionId: session.id }); },
          close() { streams.delete(session.id); if (!closed) post({ kind: 'close-stream', sessionId: session.id }); },
        };
        streams.set(session.id, connection);
        queueMicrotask(() => { if (!closed) connection.onopen?.(); else connection.onclose?.(); });
        return connection;
      },
    };
  });
}
