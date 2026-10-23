// Keep the same request/response contract as USB. A bounded request waits for the
// iPad's acknowledgement before the desktop encodes another frame.
export const SCREEN_LAN_ACTIONS = { 'POST /session': 1, 'PUT /frame': 2, 'PUT /workspace': 3, 'PUT /heartbeat': 4, 'DELETE /session': 5 };

export function createScreenLANTransport(socket) {
  let sequence = 0, pending, queue = Promise.resolve(), closed = false;
  const close = () => { closed = true; pending?.reject(new Error('Wi-Fi connection closed')); };
  socket.on('close', close); socket.on('error', close);
  socket.on('message', (data, binary) => {
    let reply;
    try {
      if (binary) throw new Error();
      reply = JSON.parse(data.toString());
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error();
    } catch { socket.close(1008); return; }
    if (!pending || reply.requestId !== pending.id) return;
    if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || !reply.body || typeof reply.body !== 'object' || Array.isArray(reply.body)) {
      socket.close(1008); return;
    }
    pending.resolve({ status: reply.status, body: reply.body });
  });
  return {
    request(method, route, body = Buffer.alloc(0)) {
      const next = queue.then(() => new Promise((resolve, reject) => {
        if (closed || socket.readyState !== 1 || socket.bufferedAmount > 2 * 1024 * 1024) return reject(new Error('Wi-Fi connection unavailable'));
        const action = SCREEN_LAN_ACTIONS[`${method} ${route}`];
        if (!action || body.length > 2 * 1024 * 1024) return reject(new Error('Invalid screen request'));
        const id = ++sequence, header = Buffer.alloc(5); header[0] = action; header.writeUInt32BE(id, 1);
        const timer = setTimeout(() => pending?.reject(new Error('Wi-Fi response timed out')), 5000);
        const finish = () => { clearTimeout(timer); pending = undefined; };
        pending = { id, resolve: (value) => { finish(); resolve(value); }, reject: (error) => { finish(); reject(error); } };
        socket.send(Buffer.concat([header, body]), (error) => { if (error && pending?.id === id) pending.reject(error); });
      }));
      queue = next.catch(() => {}); return next;
    },
    close() { close(); socket.terminate(); },
  };
}
