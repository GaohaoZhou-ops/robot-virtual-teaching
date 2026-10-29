import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createIPadScreenService, SCREEN_PROTOCOL } from "../src/server/devices/ipadScreenService.js";
import { screenJointState } from "../src/shared/protocols/ipadScreenControl.js";

let push, disconnect, releaseFrame, stopCount = 0, realtime = true;
const calls = [];
const transport = {
  devices: async () => [],
  async request(device, method, route, body, token, options) {
    calls.push({ method, route, keepAlive: options?.keepAlive });
    if (route === '/status') return { status: 200, body: { protocol: SCREEN_PROTOCOL, deviceName: 'Test iPad',
      keepalive: true, jointControl: true, usbInvitations: true, realtimeUSB: realtime } };
    if (route === '/session' && method === 'POST') return { status: 200, body: { ready: true } };
    if (route === '/workspace' && releaseFrame) await new Promise((resolve) => { releaseFrame = resolve; });
    return { status: 200, body: { page: 'cameras' } };
  },
  events(device, token, onStatus, onError) {
    push = onStatus; disconnect = onError;
    return () => { stopCount++; };
  },
  close() {},
};
const service = createIPadScreenService({ transport, supported: true });
const server = createServer((req, res) => service(req, res, () => res.end()));
service.attach(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad-screen`;
const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert(Date.now() < deadline, 'Timed out waiting for protocol event'); await delay(5); }
};
const start = async () => {
  const reply = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test-mac-ipad' }) });
  assert.equal(reply.status, 201);
  const session = await reply.json(), messages = [];
  const socket = new WebSocket(base.replace('http:', 'ws:') + `/session/${session.id}/events`);
  socket.on('message', (bytes) => messages.push(JSON.parse(bytes)));
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ token: session.token }));
  await waitFor(() => messages.some((value) => value.ready));
  return { session, socket, messages };
};
const state = { ...screenJointState({ id: 'robot' }), viewportControl: { enabled: true, aspect: 1.6, ack: 0 } };
const workspace = (session) => {
  const json = Buffer.from(JSON.stringify(state)), header = Buffer.alloc(8);
  header.writeUInt32BE(json.length);
  return fetch(`${base}/session/${session.id}/workspace`, { method: 'PUT',
    headers: { Authorization: `Bearer ${session.token}` }, body: Buffer.concat([header, json]) });
};
try {
  const { session, socket, messages } = await start();
  assert.equal(session.realtimeUSB, true);
  assert.equal((await workspace(session)).status, 200);
  await waitFor(() => messages.some((value) => value.frameTick));
  await delay(140);
  assert.equal(messages.filter((value) => value.frameTick).length, 1, 'a suspended browser gets one tick, not a queue');

  releaseFrame = true;
  let imageFinished = false;
  const image = workspace(session).then((response) => { imageFinished = true; return response; });
  await waitFor(() => typeof releaseFrame === 'function');
  push({ page: 'joints', viewportCommands: [{ robotId: 'robot', sequence: 1, kind: 'rotate', dx: 0.1, dy: 0, zoom: 0, ageMs: 0 }] });
  await waitFor(() => messages.some((value) => value.viewportCommands?.[0]?.sequence === 1));
  assert.equal(imageFinished, false, 'input arrives while the image request is still blocked');
  const release = releaseFrame; releaseFrame = null; release();
  assert.equal((await image).status, 200);
  await delay(20);
  assert.equal(messages.filter((value) => value.page).at(-1).page, 'joints', 'a delayed image reply cannot revert a newer page switch');
  assert(calls.filter((call) => call.route === '/workspace').every((call) => call.keepAlive), 'images reuse the USB connection');
  socket.send(JSON.stringify({ frameReady: true }));
  await waitFor(() => messages.filter((value) => value.frameTick).length === 2);
  disconnect(new Error('USB unplugged'));
  await waitFor(() => socket.readyState === WebSocket.CLOSED);
  assert.equal(stopCount, 1, 'disconnect closes the independent control stream exactly once');
  const count = messages.length; push({ page: 'cameras' }); await delay(80);
  assert.equal(messages.length, count, 'ended sessions cannot publish controls or clock ticks');

  realtime = false;
  const legacy = await start();
  assert.equal(legacy.session.realtimeUSB, false);
  await delay(100);
  assert(!legacy.messages.some((value) => value.frameTick), 'old iPad apps retain the legacy transport');
  await fetch(`${base}/session/${legacy.session.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${legacy.session.token}` } });
  await waitFor(() => legacy.socket.readyState === WebSocket.CLOSED);
  assert.equal(stopCount, 1);
  console.log('Mac/iPad USB: independent input during blocked frames, bounded frame clock, persistent requests, teardown and legacy negotiation passed.');
} finally {
  service.close();
  await new Promise((resolve) => server.close(resolve));
}
