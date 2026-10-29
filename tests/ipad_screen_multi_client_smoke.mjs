import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createIPadScreenService, SCREEN_PROTOCOL } from "../src/server/devices/ipadScreenService.js";
import { randomPairingCode } from "../src/server/devices/ipadPairing.js";
import { screenJointState } from "../src/shared/protocols/ipadScreenControl.js";

let now = Date.now(), usbCalls = 0;
const plannedCodes = ['AAAA', 'AAAA', 'BBBB'];
const serverId = randomUUID(), sockets = [];
const service = createIPadScreenService({ serverId, supported: true, now: () => now,
  getAddresses: (port) => [`http://192.168.42.10:${port}`, `http://192.168.42.11:${port}`],
  generatePairingCode: () => plannedCodes.shift() || randomPairingCode(),
  transport: { devices() { usbCalls++; return []; }, close() {},
    request() { usbCalls++; return { status: 200, body: { protocol: SCREEN_PROTOCOL, keepalive: true, jointControl: true, usbInvitations: true, ready: true } }; } },
});
const server = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
service.attach(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}`;
// Advertised Host + matching Origin exercises a LAN browser without depending
// on the test machine's interfaces. It must never gain loopback-only USB access.
const remote = `http://192.168.42.11:${server.address().port}`;
const api = async (path, { method = 'GET', body, raw, token, status = 200, localOnly = false, headers = {} } = {}) => {
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(local + '/__atlas/ipad-screen' + path, { method,
    headers: { Host: new URL(localOnly ? local : remote).host, Origin: localOnly ? local : remote,
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
  const value = JSON.parse(response.body);
  assert.equal(response.status, status, JSON.stringify(value)); return value;
};
const waitFor = async (check) => {
  const deadline = Date.now() + 6000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise((resolve) => setTimeout(resolve, 20)); }
};
const start = () => api('/session', { method: 'POST', body: { mode: 'wifi' }, status: 201 });
const pair = (session, deviceId, overrides = {}, status = 200) => api('/pair', { method: 'POST', status,
  body: { code: session.pairingCode, sessionId: session.id, serverId, deviceId, ...overrides } });
const connect = (session, kind = 'events', token = session.token, origin = remote, onMessage) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${local.replace('http:', 'ws:')}/__atlas/ipad-screen/session/${session.id}/${kind}`, {
    origin, headers: { Host: new URL(remote).host, ...(kind === 'device' ? { Authorization: `Bearer ${token}` } : {}) },
  });
  sockets.push(ws); ws.on('error', reject);
  if (onMessage) ws.on('message', (data) => onMessage(data, ws));
  ws.once('open', () => resolve(ws));
});
const owner = async (session) => {
  const ws = await connect(session), events = [];
  ws.on('message', (data) => events.push(JSON.parse(data)));
  ws.send(JSON.stringify({ token: session.token }));
  await waitFor(() => events.some((event) => event.ready)); return { ws, events };
};
const native = async (session, credential, robotId) => {
  const state = { frames: [], workspaces: [], heartbeat: 0, commands: [], viewportCommands: [] };
  const ws = await connect(session, 'device', credential.deviceToken, remote, (data, connection) => {
    const action = data[0], requestId = data.readUInt32BE(1), body = data.subarray(5);
    if (action === 1) assert.equal(JSON.parse(body).protocol, SCREEN_PROTOCOL);
    if (action === 2) state.frames.push(body);
    if (action === 3) {
      const workspace = JSON.parse(body.subarray(8, 8 + body.readUInt32BE(0)));
      assert.equal(workspace.robotId, robotId, 'only this browser workspace reaches the paired iPad');
      state.workspaces.push(workspace);
    }
    if (action === 4) state.heartbeat++;
    connection.send(JSON.stringify({ requestId, status: 200, body: { page: 'joints', ...state,
      frames: undefined, workspaces: undefined } }));
  });
  return { ws, state };
};
const workspace = (suffix) => {
  const state = { ...screenJointState({ id: `robot-${suffix}` }, [{ name: 'left_J1', type: 'revolute', lower: -90, upper: 90 }]),
    capture: { taskId: `task-${suffix}`, parkingPointId: `parking-${suffix}`, taskName: suffix, parkingPointName: suffix, reason: '' },
    viewportControl: { enabled: true, aspect: 1.6, ack: 0 } };
  const bytes = Buffer.from(JSON.stringify(state)), header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
};
const frame = (marker) => {
  const jpeg = Buffer.from([255, 216, marker, 255, 217]), header = Buffer.alloc(8);
  header.writeUInt32BE(jpeg.length); header.writeUInt32BE(jpeg.length, 4);
  return Buffer.concat([header, jpeg, jpeg]);
};
const put = (session, route, raw, status = 200) => api(`/session/${session.id}/${route}`, { method: 'PUT', raw, token: session.token, status });
try {
  const info = await api('/info');
  assert.equal(info.usbSupported, false); assert.equal(info.addresses[0], remote);
  assert.equal((await api('/info', { localOnly: true })).usbSupported, true);
  assert.deepEqual((await api('/devices')).devices, []);
  await api('/session', { method: 'POST', body: { deviceId: 'usb-test-device' }, status: 403 });
  await api('/info', { headers: { Origin: 'https://untrusted.example' }, status: 403 });
  await api('/info', { headers: { Host: 'rebind.example', Origin: 'http://rebind.example' }, status: 403 });
  assert.equal(usbCalls, 0, 'LAN browsers cannot discover or operate server USB devices');

  const [a, b] = await Promise.all([start(), start()]);
  assert.notEqual(a.pairingCode, b.pairingCode, 'pairing-code collisions are retried across all sessions');
  const [ownerA, ownerB] = await Promise.all([owner(a), owner(b)]);
  for (const session of [a, b]) {
    const qr = await api(`/session/${session.id}/pairing-qr`, { method: 'POST', token: session.token,
      body: { address: remote, code: session.pairingCode } });
    assert.match(qr.image, /^data:image\/png;base64,/);
  }
  await api(`/session/${a.id}/renew`, { method: 'POST', token: b.token, status: 401 });
  const oldCode = a.pairingCode;
  plannedCodes.push(b.pairingCode, 'CCCC');
  Object.assign(a, await api(`/session/${a.id}/renew`, { method: 'POST', token: a.token }));
  assert.equal(a.pairingCode, 'CCCC');
  await pair(a, 'device-a', { code: oldCode }, 404);
  await pair(a, 'device-a', { sessionId: b.id }, 409);
  const credentialA = await pair(a, 'device-a');
  await pair(b, 'device-a', {}, 409);
  const credentialB = await pair(b, 'device-b');
  await assert.rejects(connect(a, 'device', credentialB.deviceToken), /403/);
  await assert.rejects(connect(a, 'events', a.token, 'http://untrusted.example'), /403/);
  const impostor = await connect(a);
  impostor.send(JSON.stringify({ token: b.token }));
  await waitFor(() => impostor.readyState === WebSocket.CLOSED);
  const [deviceA, deviceB] = await Promise.all([native(a, credentialA, 'robot-A'), native(b, credentialB, 'robot-B')]);
  await waitFor(() => ownerA.events.some((event) => event.deviceReady) && ownerB.events.some((event) => event.deviceReady));
  for (const [device, suffix, value] of [[deviceA, 'A', 25], [deviceB, 'B', -40]]) {
    device.state.commands = [{ robotId: `robot-${suffix}`, name: 'left_J1', sequence: 1, ageMs: 0, value }];
    device.state.captureRequest = { id: randomUUID(), robotId: `robot-${suffix}`, taskId: `task-${suffix}`,
      parkingPointId: `parking-${suffix}`, ageMs: 0 };
    device.state.viewportCommands = [{ robotId: `robot-${suffix}`, sequence: 1, kind: 'rotate', dx: 0.1, dy: 0, zoom: 0, ageMs: 0 }];
  }
  await put({ ...a, token: b.token }, 'workspace', workspace('B'), 401);
  await Promise.all([put(a, 'workspace', workspace('A')), put(b, 'workspace', workspace('B'))]);
  await Promise.all([put(a, 'frame', frame(1)), put(b, 'frame', frame(2))]);
  for (const [desktop, device, suffix, marker] of [[ownerA, deviceA, 'A', 1], [ownerB, deviceB, 'B', 2]]) {
    await waitFor(() => desktop.events.some((event) => event.captureRequest));
    assert.deepEqual(device.state.frames, [frame(marker)]);
    const events = desktop.events.filter((event) => event.commands?.length);
    assert.ok(events.length);
    assert.ok(events.every((event) => event.commands.every((command) => command.robotId === `robot-${suffix}`)));
    assert.ok(events.every((event) => event.captureRequest.taskId === `task-${suffix}`));
    assert.ok(events.every((event) => event.viewportCommands[0].robotId === `robot-${suffix}`));
  }
  const usb = await api('/session', { method: 'POST', localOnly: true, body: { deviceId: 'usb-test-device' }, status: 201 });
  await put(usb, 'frame', frame(3), 403);
  await assert.rejects(connect(usb), /403/);
  await api(`/session/${usb.id}`, { method: 'DELETE', token: usb.token, localOnly: true });
  await api(`/session/${a.id}`, { method: 'DELETE', token: b.token, status: 401 });
  await api(`/session/${a.id}`, { method: 'DELETE', token: a.token });
  await waitFor(() => ownerA.ws.readyState === WebSocket.CLOSED && deviceA.ws.readyState === WebSocket.CLOSED);
  await put(a, 'frame', frame(1), 410);
  await put(b, 'frame', frame(2)); assert.equal(deviceB.state.frames.length, 2);
  const replacement = await start(); await owner(replacement);
  await native(replacement, await pair(replacement, 'device-a'), 'robot-C');
  const abandoned = await start(); now += 9000;
  await waitFor(() => deviceB.state.heartbeat > 0);
  await api(`/session/${abandoned.id}/renew`, { method: 'POST', token: abandoned.token, status: 410 });
  await put(b, 'frame', frame(2));
  for (let i = 0; i < 14; i++) { const waiting = await start(); await owner(waiting); }
  await api('/session', { method: 'POST', body: { mode: 'wifi' }, status: 429 });
  console.log('Multi-client collaboration: LAN ownership, unique QR codes, isolated frames/joints/Pose/viewport commands, independent teardown, device switching, abandoned-session cleanup, bounded invitations and loopback-only USB passed.');
} finally {
  sockets.forEach((ws) => ws.terminate()); service.close();
  await new Promise((resolve) => server.close(resolve));
}
