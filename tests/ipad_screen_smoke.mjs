import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createIPadScreenService, SCREEN_PROTOCOL, validateScreenFrame } from '../src/server/ipadScreenService.js';

const jpeg = Buffer.from([255, 216, 255, 217]);
const pair = Buffer.alloc(16); pair.writeUInt32BE(4, 0); pair.writeUInt32BE(4, 4); jpeg.copy(pair, 8); jpeg.copy(pair, 12);
validateScreenFrame(pair);
assert.throws(() => validateScreenFrame(pair.subarray(0, 15)));
const corrupt = Buffer.from(pair); corrupt.writeUInt32BE(100, 0);
assert.throws(() => validateScreenFrame(corrupt));
let active = false, wired = true, frames = 0, now = 0, closed = false;
const calls = [];
const transport = {
  devices: async () => wired ? [{ id: 'test-usb-device' }] : [],
  async request(device, method, route, body, token) {
    calls.push({ device, method, route });
    if (!wired || device !== 'test-usb-device') throw new Error('Disconnected');
    if (route === '/status') return { status: 200, body: { protocol: SCREEN_PROTOCOL, deviceName: 'Test iPad', active } };
    assert.match(token, /^[a-f0-9]{64}$/);
    if (method === 'POST') { active = true; return { status: 200, body: { ready: true } }; }
    if (method === 'DELETE') { active = false; return { status: 200, body: { stopped: true } }; }
    if (!active) return { status: 410, body: { error: 'Device ended session' } };
    assert.deepEqual(body, pair); frames += 1;
    return { status: 200, body: { received: true } };
  }, close() { closed = true; },
};
const service = createIPadScreenService({ transport, supported: true, now: () => now });
const server = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad-screen`;
const request = async (route, options = {}, expected = 200) => {
  const response = await fetch(base + route, options); const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body)); return body;
};
const start = () => request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'test-usb-device' }) }, 201);
const frame = (session, expected = 200, body = pair) => request(`/session/${session.id}/frame`, {
  method: 'PUT', headers: { Authorization: `Bearer ${session.token}` }, body,
}, expected);
try {
  await request('/devices', { headers: { Origin: 'https://untrusted.example' } }, 403);
  const rebind = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/devices', { headers: { Host: 'rebind.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebind, 403);
  assert.equal(calls.length, 0, 'untrusted callers cannot touch USB');
  assert.equal((await request('/devices')).devices[0].ready, true);
  wired = false; assert.deepEqual((await request('/devices')).devices, []); wired = true;
  const [first, second] = await Promise.allSettled([start(), start()]);
  assert.equal([first, second].filter((result) => result.status === 'fulfilled').length, 1, 'only one browser can start');
  const session = [first, second].find((result) => result.status === 'fulfilled').value;
  await frame({ ...session, token: 'x'.repeat(64) }, 401);
  await frame(session, 400, corrupt); assert.equal(frames, 0);
  await frame(session); assert.equal(frames, 1);
  active = false; await frame(session, 410);
  await frame(session, 410);
  const reconnect = await start(); await frame(reconnect);
  wired = false; await frame(reconnect, 502); wired = true; active = false;
  const expired = await start(); now = 10000;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(active, false); await frame(expired, 410);
  const final = await start();
  await request(`/session/${final.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${final.token}` } });
  assert.equal(active, false);
  console.log('iPad screen: USB discovery, origin/host guards, session ownership, concurrent starts, frame validation, device stop, disconnect, expiry and reconnect passed.');
} finally { service.close(); await new Promise((resolve) => server.close(resolve)); assert.ok(closed); }
