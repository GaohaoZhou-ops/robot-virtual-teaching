import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as plist from 'plist';
import { createMacUSBTransport } from '../../desktop/usb-transport.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-usbmux-'));
const socketPath = path.join(directory, 'mux.sock');
const sockets = new Set(); let connections = 0;
const device = { DeviceID: 12, SerialNumber: 'atlas-test-device-1234', ConnectionType: 'USB', DeviceName: 'Test iPad' };
const app = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'joint', value: 12 }) + '\n'); return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const output = JSON.stringify({ route: req.url, bytes: body.length, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(output) });
    res.end(output);
  });
});
const mux = net.createServer((socket) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  let bytes = Buffer.alloc(0);
  const receive = (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 16 || bytes.length < bytes.readUInt32LE(0)) return;
    const length = bytes.readUInt32LE(0), request = plist.parse(bytes.subarray(16, length).toString());
    socket.off('data', receive);
    const payload = Buffer.from(plist.build(request.MessageType === 'ListDevices' ? { DeviceList: [{ Properties: device }] } : { Number: 0 }));
    const header = Buffer.alloc(16);
    [payload.length + 16, 1, 8, 1].forEach((n, i) => header.writeUInt32LE(n, i * 4));
    // Deliberately split the packet header to exercise real socket framing.
    socket.write(header.subarray(0, 7));
    socket.write(Buffer.concat([header.subarray(7), payload]));
    if (request.MessageType === 'Connect') {
      connections++;
      assert.equal(request.DeviceID, 12);
      assert.equal(request.PortNumber, ((21991 & 255) << 8) | (21991 >>> 8));
      app.emit('connection', socket);
    }
  };
  socket.on('data', receive);
});
await new Promise((resolve) => mux.listen(socketPath, resolve));
const transport = createMacUSBTransport({ socketPath, timeout: 1500 });
try {
  assert.equal((await transport.devices())[0].id, device.SerialNumber);
  const token = 'a'.repeat(64);
  const first = await transport.request(device.SerialNumber, 'GET', '/status', Buffer.alloc(0), token, { keepAlive: true });
  assert.equal(first.status, 200); assert.equal(first.body.auth, `Bearer ${token}`);
  const second = await transport.request(device.SerialNumber, 'POST', '/frame', Buffer.from('frame-data'), token, { keepAlive: true });
  assert.equal(second.body.bytes, 10); assert.equal(connections, 1, 'streamed frames reuse the USB socket');
  const event = await new Promise((resolve, reject) => {
    const stop = transport.events(device.SerialNumber, token, (value) => { stop(); resolve(value); }, reject);
  });
  assert.deepEqual(event, { type: 'joint', value: 12 });
  await assert.rejects(transport.request(device.SerialNumber, 'GET', '/private', Buffer.alloc(0), token));
  await assert.rejects(transport.request('missing', 'GET', '/status'));
  console.log('Desktop USB: framing, device discovery, persistent frame transport, controls and invalid endpoints passed.');
} finally {
  transport.close(); for (const s of sockets) s.destroy();
  await new Promise((resolve) => mux.close(resolve)); app.close();
  await rm(directory, { recursive: true, force: true });
}
