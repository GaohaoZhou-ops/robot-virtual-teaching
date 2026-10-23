import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createIPadScreenService, SCREEN_PROTOCOL } from '../src/server/ipadScreenService.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { screenJointState } from '../src/lib/ipadScreenControl.js';

let now = Date.now(), usbCalls = 0;
const serverId = randomUUID();
const directory = await mkdtemp(path.join(tmpdir(), 'atlas-screen-lan-'));
const teaching = createIPadTeachingService({ directory, serverId });
const service = createIPadScreenService({ supported: false, serverId, now: () => now,
  getAddresses: (port) => [`http://127.0.0.1:${port}`],
  transport: { devices() { usbCalls++; throw new Error('No USB on Windows'); },
    request() { usbCalls++; throw new Error('No USB on Windows'); }, close() {} } });
const server = createServer((req, res) => service(req, res, () => teaching(req, res, () => { res.writeHead(404); res.end(); })));
service.attach(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`, base = address + '/__atlas/ipad-screen';
const sockets = [];
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
const api = async (path, { method = 'GET', token, body, raw, origin, status = 200 } = {}) => {
  const response = await fetch(base + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
    body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
};
const waitFor = async (test) => {
  const deadline = Date.now() + 7000;
  while (!test()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise((r) => setTimeout(r, 20)); }
};
const owner = async (session) => {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/session/${session.id}/events`, { origin: address });
  sockets.push(ws); const events = []; ws.on('message', (data) => events.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ token: session.token })); await waitFor(() => events[0]?.ready);
  return { ws, events };
};
const start = () => api('/session', { method: 'POST', body: { mode: 'wifi' }, status: 201 });
const pair = (session, overrides = {}, expected = 200) => api('/pair', { method: 'POST', status: expected,
  body: { code: session.pairingCode.toLowerCase(), deviceId: 'ipad-lan-device', deviceName: 'LAN iPad', serverId, sessionId: session.id, ...overrides } });
const native = async (session, credential) => {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/session/${session.id}/device`, { headers: { Authorization: `Bearer ${credential.deviceToken}` } });
  sockets.push(ws);
  const state = { frames: 0, workspaces: 0, heartbeats: 0, commands: [], page: 'cameras', ack: 0 };
  ws.on('message', (data, binary) => {
    assert.ok(binary); const action = data[0], requestId = data.readUInt32BE(1), body = data.subarray(5);
    if (action === 1) assert.equal(JSON.parse(body).protocol, SCREEN_PROTOCOL);
    if (action === 2) state.frames++;
    if (action === 3) { state.workspaces++; state.ack = JSON.parse(body.subarray(8, 8 + body.readUInt32BE(0))).ack; }
    if (action === 4) state.heartbeats++;
    ws.send(JSON.stringify({ requestId, status: 200, body: { page: state.page, commands: state.commands.filter((c) => c.sequence > state.ack) } }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, state };
};
const jpeg = Buffer.from([255, 216, 255, 217]);
const frame = Buffer.alloc(16); frame.writeUInt32BE(4); frame.writeUInt32BE(4, 4); jpeg.copy(frame, 8); jpeg.copy(frame, 12);
const joints = screenJointState({ id: 'robot', name: 'LAN robot' }, [{ name: 'left_J1', type: 'revolute', lower: -90, upper: 90 }], {});
const workspace = (ack = 0) => {
  const json = Buffer.from(JSON.stringify({ ...joints, ack })), header = Buffer.alloc(8);
  header.writeUInt32BE(json.length); header.writeUInt32BE(jpeg.length, 4); return Buffer.concat([header, json, jpeg]);
};
try {
  const info = await api('/info'); assert.equal(info.usbSupported, false); assert.equal(info.wirelessSupported, true);
  assert.deepEqual((await api('/devices')).devices, []);
  await api('/session', { method: 'POST', body: { deviceId: 'usb-device' }, status: 503 });
  await api('/session', { method: 'POST', body: null, status: 400 });
  const session = await start(), desktop = await owner(session);
  assert.equal(desktop.events[0].deviceReady, false);
  const qr = await api(`/session/${session.id}/pairing-qr`, { method: 'POST', token: session.token, body: { address, code: session.pairingCode } });
  assert.match(qr.image, /^data:image\/png;base64,/);
  await api(`/session/${session.id}/pairing-qr`, { method: 'POST', body: { address, code: session.pairingCode }, status: 401 });
  await api(`/session/${session.id}/pairing-qr`, { method: 'POST', token: session.token, body: { address: 'http://8.8.8.8', code: session.pairingCode }, status: 400 });
  const renewed = { ...session, ...await api(`/session/${session.id}/renew`, { method: 'POST', token: session.token }) };
  assert.notEqual(renewed.pairingCode, session.pairingCode);
  await pair(session, {}, 404);
  await pair(renewed, { serverId: randomUUID() }, 409);
  await pair(renewed, { sessionId: randomUUID() }, 409);
  await api('/pair', { method: 'POST', body: {}, origin: 'https://outside.example', status: 403 });
  const paired = await pair(renewed); assert.notEqual(paired.deviceToken, session.token);
  await pair(renewed, { deviceId: 'another-ipad' }, 409);
  await api(`/session/${session.id}/frame`, { method: 'PUT', token: paired.deviceToken, raw: frame, status: 401 });
  const device = await native(session, paired);
  await waitFor(() => desktop.events.some((event) => event.deviceReady));
  assert.equal(desktop.events.at(-1).deviceName, 'LAN iPad');
  await pair(renewed, {}, 409);
  device.state.page = 'joints'; device.state.commands = [{ robotId: 'robot', name: 'left_J1', value: 120, sequence: 1, ageMs: 10 }];
  await api(`/session/${session.id}/workspace`, { method: 'PUT', token: session.token, raw: workspace() });
  await api(`/session/${session.id}/frame`, { method: 'PUT', token: session.token, raw: frame });
  await waitFor(() => desktop.events.some((event) => event.commands?.length));
  assert.equal(desktop.events.find((event) => event.commands?.length).commands[0].value, 90);
  await api(`/session/${session.id}/workspace`, { method: 'PUT', token: session.token, raw: workspace(1) });
  assert.equal(device.state.ack, 1); assert.equal(device.state.frames, 1);
  for (let i = 0; i < 5; i++) {
    const count = device.state.heartbeats, events = desktop.events.length; now += 4000;
    await waitFor(() => device.state.heartbeats > count && desktop.events.length > events);
  }
  assert.equal(device.state.frames, 1, 'keepalive does not fabricate new camera frames');
  device.ws.close(); await waitFor(() => desktop.ws.readyState === WebSocket.CLOSED);
  await api(`/session/${session.id}/frame`, { method: 'PUT', token: session.token, raw: frame, status: 410 });
  const closing = await start(), closingOwner = await owner(closing), closingDevice = await native(closing, await pair(closing));
  await waitFor(() => closingOwner.events.some((event) => event.deviceReady));
  closingOwner.ws.close(); await waitFor(() => closingDevice.ws.readyState === WebSocket.CLOSED);
  const malformed = await start(), malformedOwner = await owner(malformed), malformedDevice = await native(malformed, await pair(malformed));
  await waitFor(() => malformedOwner.events.some((event) => event.deviceReady));
  malformedDevice.ws.send('null');
  await waitFor(() => malformedDevice.ws.readyState === WebSocket.CLOSED && malformedOwner.ws.readyState === WebSocket.CLOSED);
  if (process.platform === 'darwin') {
    now += 60000;
    const qrSession = await start(), qrOwner = await owner(qrSession);
    const image = await api(`/session/${qrSession.id}/pairing-qr`, { method: 'POST', token: qrSession.token, body: { address, code: qrSession.pairingCode } });
    const file = path.join(directory, 'screen.png'), binary = path.join(directory, 'native-screen');
    await writeFile(file, Buffer.from(image.image.split(',')[1], 'base64'));
    await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
      'ipad/AtlasTeaching/LANClient.swift', 'ipad/Tests/ScreenPairingTests.swift', '-o', binary]);
    const nativeRun = run(binary, [file]); nativeRun.catch(() => {});
    await waitFor(() => qrOwner.events.some((event) => event.deviceReady));
    await api(`/session/${qrSession.id}/workspace`, { method: 'PUT', token: qrSession.token, raw: workspace() });
    await api(`/session/${qrSession.id}/frame`, { method: 'PUT', token: qrSession.token, raw: frame });
    await api(`/session/${qrSession.id}`, { method: 'DELETE', token: qrSession.token });
    await nativeRun;
  }
  const expired = await start(); await owner(expired); now += 16 * 60 * 1000;
  await pair(expired, {}, 410); await waitFor(() => sockets.at(-1).readyState === WebSocket.CLOSED);
  now += 60000;
  const throttled = await start(); await owner(throttled);
  for (let i = 0; i < 12; i++) await pair(throttled, { code: 'BAD!' }, 400);
  await pair(throttled, {}, 429);
  assert.equal(usbCalls, 0, 'Windows wireless collaboration never invokes Apple/Python USB tools');
  console.log('Wireless: Windows capabilities, QR ownership, renewal, expiry, attempt limits, session/device binding, separate credentials, camera/workspace relay, joint limits, acknowledgements, background keepalive and two-way disconnect passed.');
} finally {
  sockets.forEach((socket) => socket.terminate()); service.close(); await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
