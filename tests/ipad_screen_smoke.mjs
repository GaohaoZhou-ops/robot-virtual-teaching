import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createIPadScreenService, SCREEN_PROTOCOL, validateScreenFrame, validateScreenWorkspace } from "../src/server/devices/ipadScreenService.js";
import { screenJointState, screenJointCommand, screenPoseCaptureState, screenPoseCaptureCommand } from "../src/shared/protocols/ipadScreenControl.js";

const jpeg = Buffer.from([255, 216, 255, 217]);
const pair = Buffer.alloc(16); pair.writeUInt32BE(4, 0); pair.writeUInt32BE(4, 4); jpeg.copy(pair, 8); jpeg.copy(pair, 12);
validateScreenFrame(pair);
assert.throws(() => validateScreenFrame(pair.subarray(0, 15)));
const corrupt = Buffer.from(pair); corrupt.writeUInt32BE(100, 0);
assert.throws(() => validateScreenFrame(corrupt));
let active = false, wired = true, frames = 0, now = 0, closed = false, heartbeats = 0, keepalive = true;
let nativePage = 'cameras', nativeCommands = [], nativeCaptureRequest, nativeViewportCommands = [];
const jointState = screenJointState({ id: 'robot-1', name: 'Test Robot' }, [
  { name: 'left_J1', type: 'revolute', lower: -90, upper: 90 },
  { name: 'lift', type: 'prismatic', lower: 0, upper: 1 },
  { name: 'fixed', type: 'fixed' },
], { left_J1: 12, lift: 0.3 });
assert.equal(jointState.joints.length, 2);
assert.deepEqual(jointState.joints.map(({ unit, step }) => [unit, step]), [['°', 0.1], ['m', 0.001]]);
const workspaceBody = (state, image = jpeg) => {
  const data = Buffer.from(JSON.stringify(state)), header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0); header.writeUInt32BE(image.length, 4);
  return Buffer.concat([header, data, image]);
};
assert.deepEqual(validateScreenWorkspace(workspaceBody(jointState)), jointState);
assert.throws(() => validateScreenWorkspace(workspaceBody({ ...jointState, ack: -1 })));
assert.throws(() => validateScreenWorkspace(workspaceBody({ ...jointState, joints: [...jointState.joints, jointState.joints[0]] })));
assert.throws(() => validateScreenWorkspace(workspaceBody(jointState).subarray(0, 12)));
const command = { robotId: 'robot-1', sequence: 1, name: 'left_J1', value: 150, ageMs: 0, receivedAt: 0 };
assert.equal(screenJointCommand(command, jointState, 0, 0).value, 90);
for (const invalid of [{ ...command, name: 'unknown' }, { ...command, robotId: 'other' },
  { ...command, value: Infinity }, { ...command, sequence: 0 }, { ...command, ageMs: 3100 }]) {
  assert.equal(screenJointCommand(invalid, jointState, 0, 0), null);
}
assert.equal(screenJointCommand(command, jointState, 1, 0), null);
assert.equal(screenJointCommand(command, jointState, 0, 4000), null, 'suspended-page commands expire');
assert.equal(screenJointCommand(command, { ...jointState, editable: false }, 0, 0), null);
const captureTask = { id: 'task-1', name: '示教任务', parkingPoints: [{ id: 'parking-1', name: '停车点' }] };
assert.match(screenPoseCaptureState(null).reason, /网页端.*示教任务/);
assert.match(screenPoseCaptureState(captureTask, null).reason, /网页端.*停车点/);
assert.match(screenPoseCaptureState({ ...captureTask, mobileCapture: {} }, 'parking-1').reason, /虚拟示教任务/);
jointState.capture = screenPoseCaptureState(captureTask, 'parking-1');
assert.equal(jointState.capture.reason, '');
const captureRequest = { id: '00000000-1111-2222-3333-444444444444', robotId: 'robot-1', taskId: 'task-1', parkingPointId: 'parking-1', ageMs: 0, receivedAt: 0 };
assert.deepEqual(screenPoseCaptureCommand(captureRequest, jointState, 0), captureRequest);
for (const invalid of [{ ...captureRequest, id: 'bad' }, { ...captureRequest, robotId: 'other' },
  { ...captureRequest, taskId: {} }, { ...captureRequest, ageMs: -1 }, { ...captureRequest, ageMs: 4000 }]) {
  assert.equal(screenPoseCaptureCommand(invalid, jointState, 0), null);
}
assert.equal(screenPoseCaptureCommand(captureRequest, jointState, 4000), null, 'suspended recording requests expire');
assert.deepEqual(validateScreenWorkspace(workspaceBody({ ...jointState,
  captureResult: { id: captureRequest.id, status: 'complete', message: '已记录停车点 / A01' } })).capture, jointState.capture);
assert.throws(() => validateScreenWorkspace(workspaceBody({ ...jointState, capture: { taskId: {} } })));
assert.throws(() => validateScreenWorkspace(workspaceBody({ ...jointState, captureResult: { id: 'bad', status: 'complete', message: '' } })));
const calls = [];
const transport = {
  devices: async () => wired ? [{ id: 'test-usb-device' }] : [],
  async request(device, method, route, body, token) {
    calls.push({ device, method, route });
    if (!wired || device !== 'test-usb-device') throw new Error('Disconnected');
    if (route === '/status') return { status: 200, body: { protocol: SCREEN_PROTOCOL, deviceName: 'Test iPad', active, keepalive, jointControl: true, usbInvitations: true } };
    assert.match(token, /^[a-f0-9]{64}$/);
    if (method === 'POST') { active = true; return { status: 200, body: { ready: true } }; }
    if (method === 'DELETE') { active = false; return { status: 200, body: { stopped: true } }; }
    if (!active) return { status: 410, body: { error: 'Device ended session' } };
    if (route === '/heartbeat') { heartbeats += 1; return { status: 200, body: { page: nativePage, commands: nativeCommands, captureRequest: nativeCaptureRequest, viewportCommands: nativeViewportCommands } }; }
    if (route === '/workspace') {
      const state = validateScreenWorkspace(body);
      nativeCommands = nativeCommands.filter((item) => item.sequence > state.ack);
      nativeViewportCommands = nativeViewportCommands.filter((item) => item.sequence > (state.viewportControl?.ack || 0));
      return { status: 200, body: { page: nativePage, commands: nativeCommands, captureRequest: nativeCaptureRequest, viewportCommands: nativeViewportCommands } };
    }
    assert.deepEqual(body, pair); frames += 1;
    return { status: 200, body: { received: true, page: nativePage, commands: nativeCommands } };
  }, close() { closed = true; },
};
const service = createIPadScreenService({ transport, supported: true, now: () => now });
const server = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
service.attach(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad-screen`;
const request = async (route, options = {}, expected = 200) => {
  const response = await fetch(base + route, options); const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body)); return body;
};
const start = (expected = 201) => request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'test-usb-device' }) }, expected);
const frame = (session, expected = 200, body = pair) => request(`/session/${session.id}/frame`, {
  method: 'PUT', headers: { Authorization: `Bearer ${session.token}` }, body,
}, expected);
const workspace = (session, state, expected = 200) => request(`/session/${session.id}/workspace`, {
  method: 'PUT', headers: { Authorization: `Bearer ${session.token}` }, body: workspaceBody(state),
}, expected);
const waitFor = async (condition) => {
  const deadline = Date.now() + 3500;
  while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise((resolve) => setTimeout(resolve, 25)); }
};
const connect = (session, { token = session.token, ...options } = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/session/${session.id}/events`, { origin: new URL(base).origin, ...options });
  socket.on('error', reject);
  socket.once('open', () => socket.send(JSON.stringify({ token })));
  socket.once('message', (data) => { assert.equal(JSON.parse(data).ready, true); resolve(socket); });
  socket.once('close', (code) => reject(new Error(`Socket closed: ${code}`)));
});
try {
  await request('/devices', { headers: { Origin: 'https://untrusted.example' } }, 403);
  const rebind = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/devices', { headers: { Host: 'rebind.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebind, 403);
  assert.equal(calls.length, 0, 'untrusted callers cannot touch USB');
  keepalive = false; assert.equal((await request('/devices')).devices[0].ready, false);
  await start(409); assert.equal(active, false); keepalive = true;
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
  await assert.rejects(connect(final, { origin: 'https://untrusted.example' }), /403/);
  await assert.rejects(connect(final, { token: 'a'.repeat(64) }), /1008/);
  const socket = await connect(final);
  const events = []; socket.on('message', (data) => events.push(JSON.parse(data)));
  await assert.rejects(connect(final), /1008/, 'another socket cannot replace the owner');
  await workspace({ ...final, token: 'b'.repeat(64) }, jointState, 401);
  await workspace(final, { ...jointState, ack: -1 }, 400);
  nativePage = 'joints'; nativeCommands = [{ ...command, receivedAt: undefined }, { ...command, sequence: 2, name: 'unknown' }];
  await workspace(final, jointState);
  await waitFor(() => events.some((event) => event.commands?.length));
  const delivered = events.find((event) => event.commands?.length);
  assert.equal(delivered.page, 'joints'); assert.equal(delivered.commands.length, 1);
  assert.equal(delivered.commands[0].value, 90, 'USB controls use the current robot limits');
  await workspace(final, { ...jointState, ack: 2 });
  assert.equal(nativeCommands.length, 0, 'acknowledgement clears coalesced gestures');
  nativeCommands = [{ ...command, sequence: 3, ageMs: 3500 }];
  const previousEvents = events.length;
  await workspace(final, { ...jointState, editable: false, reason: 'playback' });
  await waitFor(() => events.length > previousEvents);
  assert.equal(events.at(-1).commands.length, 0, 'blocked or expired gestures cannot move the robot');
  nativeCommands = []; nativePage = 'cameras'; await workspace(final, jointState);
  nativeCaptureRequest = { ...captureRequest, receivedAt: undefined };
  await workspace(final, jointState);
  await waitFor(() => events.some((event) => event.captureRequest?.id === captureRequest.id));
  assert.equal(events.find((event) => event.captureRequest).captureRequest.taskId, 'task-1');
  nativeCaptureRequest = { ...nativeCaptureRequest, ageMs: 3100 };
  const beforeExpiredCapture = events.length;
  await workspace(final, jointState);
  await waitFor(() => events.length > beforeExpiredCapture);
  assert.equal(events.at(-1).captureRequest, null, 'USB relay drops stale recording requests');
  nativeCaptureRequest = undefined;
  jointState.viewportControl = { enabled: true, aspect: 1.6, ack: 0 };
  nativeViewportCommands = [{ robotId: 'robot-1', sequence: 1, kind: 'rotate', dx: 0.1, dy: 0, zoom: 0, ageMs: 0 }];
  await workspace(final, { ...jointState, editable: false });
  await waitFor(() => events.some((event) => event.viewportCommands?.length));
  assert.equal(events.find((event) => event.viewportCommands?.length).viewportCommands[0].kind, 'rotate');
  jointState.viewportControl.ack = 1;
  await workspace(final, jointState);
  assert.equal(nativeViewportCommands.length, 0, 'viewport acknowledgement clears relative gestures separately from joints');
  const savedFrames = frames;
  for (let i = 0; i < 5; i++) {
    const previous = heartbeats; now += 4000;
    await waitFor(() => heartbeats > previous);
    assert.equal(active, true, 'background connection survives the original 8s/10s frame expiry');
  }
  assert.equal(frames, savedFrames, 'keepalive must not resend stale JPEGs as fresh frames');
  await frame(final); assert.equal(frames, savedFrames + 1, 'foreground rendering resumes in the same session');
  socket.close(); await waitFor(() => !active);
  await frame(final, 410);
  const silent = await start();
  await connect(silent, { autoPong: false }); now += 16000;
  await waitFor(() => !active); await frame(silent, 410);
  const deviceStop = await start(); await connect(deviceStop); active = false; now += 3000;
  await waitFor(() => calls.at(-1)?.method === 'DELETE');
  await frame(deviceStop, 410);
  const explicitStop = await start(); await connect(explicitStop);
  await request(`/session/${explicitStop.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${explicitStop.token}` } });
  assert.equal(active, false);
  console.log('iPad screen: USB discovery, HTTP/WebSocket origin and ownership, frame validation, background keepalive/resume, browser close, unresponsive browser, device stop, disconnect and reconnect passed.');
} finally { service.close(); await new Promise((resolve) => server.close(resolve)); assert.ok(closed); }
