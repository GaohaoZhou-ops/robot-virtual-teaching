import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createIPadScreenService, SCREEN_PROTOCOL } from "../src/server/devices/ipadScreenService.js";

let now = Date.now(), active = false, phase = '', token = '', outgoing = null, wired = true, supportsInvitations = true;
let cancelOnAccept = false, starts = 0, streams = 0, frames = 0, stops = 0;
const deviceId = 'invitation-test-ipad';
const fullName = 'Test iPad Air · iPad Air 11-inch (M3)';
let hostName = fullName;
const transport = {
  devices: async () => wired ? [{ id: deviceId, name: hostName }] : [],
  async request(device, method, path, body, suppliedToken) {
    if (!wired) throw new Error('unplugged');
    assert.equal(device, deviceId);
    if (outgoing && now >= outgoing.expiresAt) outgoing = null;
    if (path === '/status') return { status: 200, body: { protocol: SCREEN_PROTOCOL, deviceName: 'iPad', active,
      keepalive: true, jointControl: true, realtimeUSB: true, usbInvitations: supportsInvitations,
      invitationPending: phase === 'pending' || !!outgoing, outgoingInvitation: outgoing } };
    const failure = (error) => ({ status: 409, body: { error } });
    if (method === 'POST' && path === '/invitation') {
      const value = JSON.parse(body);
      if (!outgoing || outgoing.id !== value.id) return failure('stale invitation');
      outgoing = null; return { status: 200, body: { rejected: true } };
    }
    if (method === 'POST' && path === '/session') {
      const value = JSON.parse(body);
      assert.equal(value.protocol, SCREEN_PROTOCOL); assert.match(value.sessionId, /^[a-f0-9-]{36}$/);
      assert.equal(value.computerName, 'Test workstation');
      if (value.invitationId) {
        if (cancelOnAccept) { outgoing = null; cancelOnAccept = false; }
        if (!outgoing || outgoing.id !== value.invitationId) return failure('cancelled invitation');
        outgoing = null; active = true; phase = 'accepted';
      } else { active = false; phase = 'pending'; }
      token = suppliedToken; starts++;
      return { status: 200, body: { ready: active, invitationStatus: phase } };
    }
    assert.equal(suppliedToken, token);
    if (path === '/session' && method === 'GET') return { status: 200, body: { ready: active, invitationStatus: phase } };
    if (method === 'DELETE') { active = false; phase = ''; stops++; return { status: 200, body: { stopped: true } }; }
    assert(active, 'native must not receive frames or controls before consent');
    if (path === '/frame' || path === '/workspace') frames++;
    return { status: 200, body: { page: 'cameras' } };
  },
  events() { assert(active); streams++; return () => {}; },
  close() {},
};
const service = createIPadScreenService({ transport, supported: true, now: () => now, serverName: 'Test workstation' });
const server = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
service.attach(server); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad-screen`;
const request = async (route, method = 'GET', body, owner, expected = 200, headers = {}) => {
  const response = await fetch(base + route, { method, headers: { ...(owner ? { Authorization: `Bearer ${owner.token}` } : {}), ...headers },
    body: body == null ? undefined : typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
};
const waitFor = async (condition) => {
  const deadline = Date.now() + 4000;
  while (!condition()) { assert(Date.now() < deadline, 'timed out'); await delay(20); }
};
const watch = async (session) => {
  const messages = [], socket = new WebSocket(`${base.replace('http:', 'ws:')}/session/${session.id}/events`);
  socket.on('message', (data) => messages.push(JSON.parse(data)));
  await new Promise((resolve) => socket.once('open', resolve)); socket.send(JSON.stringify({ token: session.token }));
  await waitFor(() => messages.some((value) => value.ready)); return { socket, messages };
};
const invite = () => request('/session', 'POST', { deviceId }, null, 201);
const end = async (session, watcher) => {
  await request(`/session/${session.id}`, 'DELETE', null, session); await waitFor(() => watcher.socket.readyState === WebSocket.CLOSED);
};
try {
  assert.equal((await request('/devices')).devices[0].name, fullName);
  hostName = '';
  assert.equal((await request('/devices')).devices[0].name, `iPad · ${deviceId.slice(-8)}`);
  hostName = fullName;
  const session = await invite(), watcher = await watch(session);
  assert.equal(session.deviceName, fullName);
  assert(watcher.messages.some((value) => value.deviceName === fullName));
  assert.equal(session.deviceReady, false);
  assert(watcher.messages.some((value) => value.ready && value.deviceReady === false));
  await request(`/session/${session.id}/frame`, 'PUT', Buffer.alloc(16), session, 409);
  await request(`/session/${session.id}/workspace`, 'PUT', Buffer.alloc(16), session, 409);
  await delay(400); assert.equal(streams, 0); assert.equal(frames, 0);
  assert(!watcher.messages.some((value) => value.frameTick), 'no render clock before acceptance');
  await request(`/session/${session.id}`, 'DELETE', null, { token: '0'.repeat(64) }, 401);
  active = true; phase = 'accepted'; now += 1000;
  await waitFor(() => watcher.messages.some((value) => value.deviceReady));
  await waitFor(() => watcher.messages.some((value) => value.frameTick)); assert.equal(streams, 1);
  const jpeg = Buffer.from([255, 216, 255, 217]), frame = Buffer.alloc(16);
  frame.writeUInt32BE(4); frame.writeUInt32BE(4, 4); jpeg.copy(frame, 8); jpeg.copy(frame, 12);
  await request(`/session/${session.id}/frame`, 'PUT', frame, session); assert.equal(frames, 1);
  await end(session, watcher);

  const declined = await invite(), declineWatch = await watch(declined);
  phase = 'rejected'; now += 1000;
  await waitFor(() => declineWatch.socket.readyState === WebSocket.CLOSED);
  assert(declineWatch.messages.some((value) => value.error?.includes('拒绝'))); assert.equal(frames, 1);
  const cancelled = await invite(), cancelWatch = await watch(cancelled); await end(cancelled, cancelWatch);
  assert.equal(phase, '');

  outgoing = { id: randomUUID(), expiresAt: now + 60000 };
  const offer = (await request('/invitations')).invitations[0]; assert.equal(offer.invitationId, outgoing.id);
  assert.equal(offer.deviceName, fullName);
  await request('/invitations', 'GET', null, null, 403, { Origin: 'http://untrusted.example' });
  await request('/invitations/reject', 'POST', { deviceId, invitationId: randomUUID() }, null, 409);
  await request('/invitations/reject', 'POST', offer); assert.equal(outgoing, null);
  assert.equal((await request('/invitations')).invitations.length, 0);

  outgoing = { id: randomUUID(), expiresAt: now + 60000 };
  const acceptedOffer = { deviceId, invitationId: outgoing.id };
  const responses = await Promise.all([1, 2].map(() => fetch(base + '/session', { method: 'POST', body: JSON.stringify(acceptedOffer) })));
  assert.deepEqual(responses.map((value) => value.status).sort(), [201, 409], 'only one browser can accept an invitation');
  const accepted = await responses.find((value) => value.status === 201).json(); assert.equal(accepted.deviceReady, true);
  const acceptedWatch = await watch(accepted); await end(accepted, acceptedWatch);
  await request('/session', 'POST', acceptedOffer, null, 409);

  outgoing = { id: randomUUID(), expiresAt: now + 60000 }; cancelOnAccept = true;
  await request('/session', 'POST', { deviceId, invitationId: outgoing.id }, null, 409);
  outgoing = { id: randomUUID(), expiresAt: now - 1 };
  assert.equal((await request('/invitations')).invitations.length, 0);
  const expired = await invite(), expiredWatch = await watch(expired); now += 60001;
  await waitFor(() => expiredWatch.socket.readyState === WebSocket.CLOSED);
  assert(expiredWatch.messages.some((value) => value.error?.includes('过期')));
  const disconnected = await invite(), disconnectWatch = await watch(disconnected); wired = false; now += 1000;
  await waitFor(() => disconnectWatch.socket.readyState === WebSocket.CLOSED); wired = true; phase = ''; active = false;
  const beforeLegacy = starts; supportsInvitations = false;
  assert.equal((await request('/devices')).devices[0].ready, false);
  await request('/session', 'POST', { deviceId }, null, 409); assert.equal(starts, beforeLegacy);
  assert(stops >= 5);
  console.log('USB invitations: both directions, consent gate, rejection, cancellation, expiry, unplug, replay, competing browsers and legacy-app refusal passed.');
} finally { service.close(); await new Promise((resolve) => server.close(resolve)); }
