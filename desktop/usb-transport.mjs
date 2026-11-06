// Native Node transport for the existing app's usbmux protocol. The packaged
// Mac app does not spawn Python or distribute the Python helper sources.
import net from 'node:net';
import http from 'node:http';
import * as plist from 'plist';

const APP_PORT = 21991, MAX_FRAME = 2 * 1024 * 1024;
const validToken = (token) => typeof token === 'string' && /^[a-f0-9]*$/.test(token) && token.length <= 64;

export function createMacUSBTransport({ socketPath = '/var/run/usbmuxd', timeout = 6500 } = {}) {
  const sockets = new Set(), agents = new Map(), streams = new Set();
  let closed = false;
  async function mux(message) {
    if (closed) throw new Error('USB transport closed');
    const socket = net.createConnection(socketPath);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const failed = (error) => { cleanup(); socket.destroy(); reject(error); };
      const timedOut = () => failed(new Error('USB connection timed out'));
      const ended = () => failed(new Error('USB device disconnected'));
      const cleanup = () => { socket.off('data', data); socket.off('error', failed); socket.off('end', ended); socket.off('timeout', timedOut); socket.setTimeout(0); };
      const data = (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 16) return;
        const length = bytes.readUInt32LE(0);
        if (length < 16 || length > MAX_FRAME || bytes.readUInt32LE(4) !== 1
          || bytes.readUInt32LE(8) !== 8 || bytes.readUInt32LE(12) !== 1) return failed(new Error('Invalid USB response'));
        if (bytes.length < length) return;
        try {
          const value = plist.parse(bytes.subarray(16, length).toString());
          socket.pause(); cleanup();
          if (bytes.length > length) socket.unshift(bytes.subarray(length));
          resolve({ socket, value });
        } catch (error) { failed(error); }
      };
      socket.setTimeout(timeout, timedOut);
      socket.on('error', failed); socket.on('end', ended); socket.on('data', data);
      socket.once('connect', () => {
        const payload = Buffer.from(plist.build({ ClientVersionString: 'AtlasScreen/1', ProgName: 'AtlasTeaching', kLibUSBMuxVersion: 3, ...message }));
        const header = Buffer.alloc(16);
        [payload.length + 16, 1, 8, 1].forEach((value, index) => header.writeUInt32LE(value, index * 4));
        socket.write(Buffer.concat([header, payload]));
      });
    });
  }
  async function rawDevices() {
    const { socket, value } = await mux({ MessageType: 'ListDevices' });
    socket.destroy();
    return (value.DeviceList || []).map((item) => item.Properties).filter((d) => d?.ConnectionType === 'USB');
  }
  async function connect(deviceId) {
    const device = (await rawDevices()).find((d) => d.SerialNumber === deviceId);
    if (!device) throw new Error('USB device disconnected');
    const port = ((APP_PORT & 255) << 8) | (APP_PORT >>> 8);
    const { socket, value } = await mux({ MessageType: 'Connect', DeviceID: device.DeviceID, PortNumber: port });
    if (value.Number !== 0) { socket.destroy(); throw new Error('请在设备上打开新版 Atlas 示教 App。'); }
    return socket;
  }
  function agentFor(deviceId, persistent = true) {
    if (persistent && agents.has(deviceId)) return agents.get(deviceId);
    const agent = new http.Agent({ keepAlive: persistent, maxSockets: 1 });
    agent.createConnection = (_options, callback) => {
      connect(deviceId).then((socket) => { callback(null, socket); socket.resume(); }, callback);
    };
    if (persistent) agents.set(deviceId, agent);
    return agent;
  }
  return {
    async devices() {
      return (await rawDevices()).map((d) => ({ id: d.SerialNumber,
        name: `${d.DeviceName || 'USB 设备'} · ${d.SerialNumber.slice(-8)}` }));
    },
    request(deviceId, method, route, body = Buffer.alloc(0), token = '', options = {}) {
      if (closed) return Promise.reject(new Error('USB transport closed'));
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)
        || !['/status', '/session', '/invitation', '/frame', '/heartbeat', '/workspace'].includes(route)
        || body.length > MAX_FRAME || !validToken(token)) return Promise.reject(new Error('Invalid USB request'));
      const persistent = options.keepAlive === true;
      const agent = agentFor(deviceId, persistent);
      return new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: APP_PORT, method, path: route, agent,
          headers: { 'Content-Length': body.length, Authorization: `Bearer ${token}`, Connection: persistent ? 'keep-alive' : 'close' } }, (res) => {
          const chunks = []; let length = 0;
          res.on('data', (chunk) => { length += chunk.length; if (length > 65536) req.destroy(new Error('USB response too large')); else chunks.push(chunk); });
          res.on('error', reject);
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); }
            if (!persistent || method === 'DELETE') agent.destroy();
          });
        });
        const timer = setTimeout(() => req.destroy(new Error('USB request timed out')), timeout);
        req.on('close', () => clearTimeout(timer));
        req.on('error', (error) => { agent.destroy(); agents.delete(deviceId); reject(error); });
        req.end(body);
      });
    },
    events(deviceId, token, onStatus, onError) {
      if (closed || !validToken(token) || token.length !== 64) throw new Error('Invalid USB event credentials');
      const agent = agentFor(deviceId, false);
      let stopped = false, pending = '';
      const stop = () => { if (stopped) return; stopped = true; streams.delete(stop); req.destroy(); agent.destroy(); };
      const fail = (error) => { if (!stopped) { stop(); onError(error); } };
      const req = http.request({ host: 'localhost', port: APP_PORT, path: '/events', agent,
        headers: { Authorization: `Bearer ${token}`, Connection: 'close', 'Content-Length': 0 } }, (res) => {
        if (res.statusCode !== 200) return fail(new Error('USB control stream rejected'));
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          pending += chunk;
          let index;
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            if (Buffer.byteLength(line) > 65536) return fail(new Error('USB event too large'));
            try { onStatus(JSON.parse(line)); } catch (error) { return fail(error); }
          }
          if (Buffer.byteLength(pending) > 65536) fail(new Error('USB event too large'));
        });
        res.on('error', fail); res.on('end', () => fail(new Error('USB control stream closed')));
      });
      req.setTimeout(10000, () => fail(new Error('USB control stream timed out')));
      req.on('error', fail); req.end(); streams.add(stop);
      return stop;
    },
    close() { closed = true; for (const stop of [...streams]) stop(); for (const a of agents.values()) a.destroy(); for (const s of sockets) s.destroy(); },
  };
}
