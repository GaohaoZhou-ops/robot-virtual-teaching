import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createWorkSyncService } from '../src/server/workSyncService.js';
import { WorkSyncClient } from '../src/lib/workSyncClient.js';
import { applySyncOperations, diffSyncDocument, rebaseSyncDocument, syncDocument, retainSyncReferences,
  WORK_SYNC_INTERVAL, WORK_SYNC_LEASE } from '../src/lib/workSyncDocument.js';

const copy = structuredClone;
const initial = syncDocument({ teachingTasks: [{ id: 'task', name: 'Task', parkingPoints: [
  { id: 'left', name: 'Left', poses: [] }, { id: 'right', name: 'Right', poses: [] },
] }] });
const edit = (document, parking, name) => {
  const result = copy(document);
  result.teachingTasks[0].parkingPoints.find((point) => point.id === parking).poses.push({ id: name, name, joints: { lift: 1 } });
  return result;
};
const left = edit(initial, 'left', 'pose-left');
const right = edit(initial, 'right', 'pose-right');
const combined = applySyncOperations(left, diffSyncDocument(initial, right));
assert.deepEqual(combined.teachingTasks[0].parkingPoints.map((point) => point.poses.length), [1, 1]);
assert.deepEqual(applySyncOperations(right, diffSyncDocument(initial, left)), combined);
const deleted = copy(initial); deleted.teachingTasks[0].parkingPoints.shift();
assert.equal(applySyncOperations(deleted, diffSyncDocument(initial, left)).teachingTasks[0].parkingPoints.length, 1);
const renamed = copy(left); renamed.teachingTasks[0].parkingPoints[0].name = 'Changed in flight';
assert.equal(rebaseSyncDocument(combined, left, renamed).teachingTasks[0].parkingPoints[0].name, 'Changed in flight');
assert.throws(() => applySyncOperations(initial, [{ type: 'set', path: ['teachingTasks', '__proto__', 'polluted'], value: true }]));
assert.equal({}.polluted, undefined);
const shared = retainSyncReferences(initial, left);
assert.equal(shared.teachingTasks[0].parkingPoints[1], initial.teachingTasks[0].parkingPoints[1]);
assert.deepEqual(diffSyncDocument(syncDocument({ waypoints: [{ id: 'a', optional: undefined }] }),
  syncDocument({ waypoints: [{ id: 'a' }] })), []);
assert.equal(WORK_SYNC_INTERVAL, 3000);
assert.equal(WORK_SYNC_LEASE, 300_000);

async function harness(options = {}) {
  const middleware = createWorkSyncService({ isLocal: (req) => req.headers['x-test-local'] === 'yes', ...options });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  middleware.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchAs = (local) => (url, options = {}) => fetch(`${origin}${url}`, {
    ...options, headers: { ...options.headers, 'x-test-local': local ? 'yes' : 'no' },
  });
  const api = async (route, { token, data = {}, method = 'POST', local = false, code = 200, bytes, headers = {} } = {}) => {
    const response = await fetchAs(local)(`/__atlas/work-sync${route}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(method === 'GET' ? {} : { body: bytes || JSON.stringify(data) }) });
    const payload = response.headers.get('content-type')?.includes('application/zip')
      ? new Uint8Array(await response.arrayBuffer()) : await response.json();
    assert.equal(response.status, code, JSON.stringify(payload));
    return payload;
  };
  return { api, fetchAs, openSocket: (path) => new WebSocket(`${origin.replace('http:', 'ws:')}${path}`),
    close: () => { middleware.close(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}

// Real HTTP authorization, renewed leases, idempotent updates and revocation.
let time = Date.now();
const server = await harness({ now: () => time });
try {
  const project = { key: 'host-project', mode: 'map', name: 'Fixture' };
  const host = await server.api('/clients', { local: true, data: { project }, code: 201 });
  const peer = await server.api('/clients', { data: { project }, code: 201 });
  const stranger = await server.api('/clients', { code: 201 });
  assert.equal(peer.role, 'peer');
  await server.api(`/links/${randomUUID()}/bootstrap`, { token: peer.token, method: 'GET', code: 403 });
  await server.api('/status', { token: peer.token, headers: { Origin: 'https://unrelated.example' }, code: 403 });
  const request = async () => {
    await server.api('/requests', { token: peer.token, code: 201 });
    return (await server.api('/status', { token: host.token, data: { project } })).requests[0];
  };
  const stale = await request(), pending = await request();
  assert.notEqual(stale.id, pending.id);
  await server.api('/decision', { token: peer.token, data: { requestId: pending.id, allow: true, document: initial }, code: 403 });
  await server.api('/decision', { token: host.token, data: { requestId: stale.id, allow: true, document: initial }, code: 409 });
  await server.api('/decision', { token: host.token, data: { requestId: pending.id, allow: false } });
  assert.match((await server.api('/status', { token: peer.token })).reason, /未授权/);
  const approval = await server.api('/decision', { token: host.token,
    data: { requestId: (await request()).id, allow: true, document: initial } });
  const id = approval.link.id;
  assert.equal(approval.link.expiresAt, time + WORK_SYNC_LEASE);
  await server.api(`/links/${id}/bootstrap`, { token: stranger.token, method: 'GET', code: 403 });
  await server.api(`/links/${id}/bundle`, { token: peer.token, method: 'PUT', bytes: Buffer.from('PKtest'), code: 403 });
  await server.api(`/links/${id}/bundle`, { token: host.token, method: 'PUT', bytes: Buffer.from('PKtest') });
  assert.equal(Buffer.from(await server.api(`/links/${id}/bundle`, { token: peer.token, method: 'GET' })).toString(), 'PKtest');
  const exchange = (token, document, sequence = 1) => server.api(`/links/${id}/exchange`, { token,
    data: { since: 0, sequence, operations: diffSyncDocument(initial, document) } });
  await exchange(host.token, left);
  const merged = await exchange(peer.token, right);
  assert.deepEqual(applySyncOperations(initial, merged.operations), combined);
  assert.equal((await exchange(peer.token, right)).revision, merged.revision, 'retry is idempotent');
  // Keep the authorizing browser online while advancing to the lease boundary.
  for (let i = 0; i < 4; i++) { time += 55_000; await server.api('/status', { token: host.token, data: { project } }); }
  const renewed = await server.api('/decision', { token: host.token, data: { requestId: (await request()).id, allow: true } });
  assert.equal(renewed.link.id, id);
  assert.equal(renewed.link.expiresAt, time + WORK_SYNC_LEASE);
  for (let i = 0; i < 5; i++) { time += 55_000; await server.api('/status', { token: host.token, data: { project } }); }
  time += 25_000;
  await server.api(`/links/${id}/bootstrap`, { token: peer.token, method: 'GET', code: 403 });
  assert.equal((await server.api('/status', { token: host.token, data: { project } })).link, null);
  const replacement = await server.api('/decision', { token: host.token,
    data: { requestId: (await request()).id, allow: true, document: combined } });
  await server.api(`/links/${replacement.link.id}/disconnect`, { token: peer.token });
  await server.api(`/links/${replacement.link.id}/exchange`, { token: host.token, code: 403 });
} finally { await server.close(); }

// Exercise the actual browser synchronization state machine through HTTP.
const live = await harness();
const makeAdapter = (isHost) => {
  const state = { document: copy(initial), identity: isHost ? 'host-local' : null, checkpoints: new Map(), saves: 0, installs: 0 };
  return { state, deviceName: isHost ? 'Host' : 'Peer', ready: () => true, identity: () => state.identity,
    project: () => state.identity ? { key: state.identity, name: 'Project', mode: 'map' } : null,
    readDocument: () => copy(state.document), applyDocument: (value) => { state.document = copy(value); },
    persist: async () => { state.saves++; },
    saveCheckpoint: async (value) => state.checkpoints.set(value.projectKey, copy(value)),
    loadCheckpoint: async (key) => copy(state.checkpoints.get(key)),
    buildInitial: async () => ({ localIdentity: state.identity, document: copy(state.document),
      bytes: Buffer.from(`PK${JSON.stringify(state.document)}`) }),
    installInitial: async (bytes) => { state.installs++; state.identity = 'peer-local'; state.document = JSON.parse(Buffer.from(bytes).toString().slice(2)); },
  };
};
const hostAdapter = makeAdapter(true), peerAdapter = makeAdapter(false);
let intercept = null;
const hostClient = new WorkSyncClient({ adapter: hostAdapter, request: live.fetchAs(true) });
const peerClient = new WorkSyncClient({ adapter: peerAdapter, request: async (...args) => {
  const response = await live.fetchAs(false)(...args);
  if (intercept && args[0].endsWith('/exchange')) { const handler = intercept; intercept = null; await handler(); }
  return response;
} });
hostClient.running = true; peerClient.running = true;
try {
  await hostClient.tick(); await peerClient.tick();
  const connect = async () => {
    await peerClient.requestAuthorization(); await hostClient.tick();
    assert.equal(hostClient.state.requests.length, 1);
    await hostClient.decide(hostClient.state.requests[0].id, true);
    assert.equal(hostClient.state.error, '');
    await peerClient.tick(); assert.equal(peerClient.state.error, '');
    assert.equal(peerClient.state.phase, 'connected');
  };
  await connect();
  assert.equal(peerAdapter.state.installs, 1);
  hostAdapter.state.document = edit(hostAdapter.state.document, 'left', 'host-pose');
  peerAdapter.state.document = edit(peerAdapter.state.document, 'right', 'peer-pose');
  await Promise.all([hostClient.tick(), peerClient.tick()]);
  await hostClient.tick(); await peerClient.tick();
  assert.deepEqual(hostAdapter.state.document, peerAdapter.state.document);
  assert.deepEqual(hostAdapter.state.document.teachingTasks[0].parkingPoints.map((point) => point.poses.length), [1, 1]);
  // A lost response is retried using the same sequence. In-flight edits survive.
  peerAdapter.state.document = edit(peerAdapter.state.document, 'right', 'retry-pose');
  intercept = () => { peerAdapter.state.document = edit(peerAdapter.state.document, 'right', 'in-flight-pose'); throw new Error('Response lost'); };
  await peerClient.tick(); await peerClient.tick(); await peerClient.tick(); await hostClient.tick();
  assert.deepEqual(hostAdapter.state.document, peerAdapter.state.document);
  assert.equal(peerAdapter.state.document.teachingTasks[0].parkingPoints[1].poses.length, 3);
  const lastVersion = peerClient.statusVersion;
  peerClient.acceptStatus({ statusVersion: lastVersion - 1, link: null, pending: false });
  assert.ok(peerClient.state.link, 'stale heartbeat cannot clear a new link');
  // Revocation during a response must not apply that response or reactivate sync.
  hostAdapter.state.document = edit(hostAdapter.state.document, 'left', 'after-revoke');
  await hostClient.tick();
  const before = copy(peerAdapter.state.document);
  intercept = () => peerClient.disconnect();
  await peerClient.tick(); await peerClient.tick(); await hostClient.tick();
  assert.equal(peerClient.state.link, null); assert.equal(hostClient.state.link, null);
  assert.deepEqual(peerAdapter.state.document, before);
  // Reauthorization merges offline work with the latest host state.
  peerAdapter.state.document = edit(peerAdapter.state.document, 'right', 'offline-pose');
  await connect(); await peerClient.tick(); await hostClient.tick();
  assert.equal(peerAdapter.state.installs, 1, 'resume must not replace an existing local workspace');
  assert.deepEqual(hostAdapter.state.document, peerAdapter.state.document);
  assert.equal(peerAdapter.state.document.teachingTasks[0].parkingPoints[1].poses.length, 4);
  const retained = copy(peerAdapter.state.document);
  await hostClient.disconnect(); await peerClient.tick();
  assert.equal(peerClient.state.link, null);
  assert.deepEqual(peerAdapter.state.document, retained);
  assert.ok(hostAdapter.state.saves && peerAdapter.state.saves);
} finally { hostClient.stop(); peerClient.stop(); await live.close(); }
console.log('work sync: per-parking merge, in-flight edits, authorization, expiry, renewal, retries, disconnect and offline resume passed');

// Actual notification sockets: idle and pending clients have no periodic HTTP
// traffic, while approval starts the real 3-second exchange and revocation stops it.
const pushed = await harness();
const traffic = { host: [], peer: [] };
const watch = (name, local) => (url, options) => {
  traffic[name].push(url); return pushed.fetchAs(local)(url, options);
};
const quietHostAdapter = makeAdapter(true), quietPeerAdapter = makeAdapter(false);
let idleReads = 0;
const originalRead = quietPeerAdapter.readDocument;
quietPeerAdapter.readDocument = () => { idleReads++; return originalRead(); };
const quietHost = new WorkSyncClient({ adapter: quietHostAdapter, request: watch('host', true), openSocket: pushed.openSocket });
const quietPeer = new WorkSyncClient({ adapter: quietPeerAdapter, request: watch('peer', false), openSocket: pushed.openSocket });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(25);
  assert.ok(predicate(), message);
};
try {
  quietHost.start(); quietPeer.start();
  await Promise.all([quietHost.starting, quietPeer.starting]);
  await until(() => quietHost.events?.readyState === WebSocket.OPEN, 'Mac listens for authorization');
  const idleCounts = [traffic.host.length, traffic.peer.length];
  await delay(WORK_SYNC_INTERVAL * 2 + 100);
  assert.deepEqual([traffic.host.length, traffic.peer.length], idleCounts, 'no idle polling on either device');
  assert.deepEqual(traffic.peer, ['/__atlas/work-sync/capabilities']);
  assert.equal(quietPeer.token, null); assert.equal(quietPeer.events, undefined);
  assert.equal(idleReads, 0); assert.equal(quietPeerAdapter.state.installs, 0);
  assert.equal(quietPeer.timer, null); assert.equal(quietHost.timer, null);
  await quietPeer.requestAuthorization();
  await until(() => quietHost.state.requests.length === 1, 'request arrives without host polling');
  const pendingCounts = [traffic.host.length, traffic.peer.length];
  await delay(WORK_SYNC_INTERVAL + 100);
  assert.deepEqual([traffic.host.length, traffic.peer.length], pendingCounts, 'pending approval has no polling');
  await quietHost.decide(quietHost.state.requests[0].id, false);
  await until(() => !quietPeer.state.pending, 'denial is pushed');
  assert.equal(quietPeer.events, null);
  await quietPeer.requestAuthorization();
  await until(() => quietHost.state.requests.length === 1, 'another request is pushed');
  await quietHost.decide(quietHost.state.requests[0].id, true);
  await until(() => quietPeer.state.phase === 'connected', 'initial data arrives following authorization');
  quietHostAdapter.state.document = edit(quietHostAdapter.state.document, 'left', 'automatic-host');
  quietPeerAdapter.state.document = edit(quietPeerAdapter.state.document, 'right', 'automatic-peer');
  await until(() => JSON.stringify(quietHostAdapter.state.document) === JSON.stringify(quietPeerAdapter.state.document),
    '3-second timers merge independent parking work', WORK_SYNC_INTERVAL * 3 + 1000);
  assert.ok(traffic.host.some((url) => url.endsWith('/exchange')));
  assert.ok(traffic.peer.some((url) => url.endsWith('/exchange')));
  const retained = copy(quietPeerAdapter.state.document);
  await quietHost.disconnect();
  await until(() => quietPeer.state.link === null, 'disconnect is pushed immediately');
  assert.deepEqual(quietPeerAdapter.state.document, retained);
  assert.equal(quietPeer.timer, null); assert.equal(quietHost.timer, null);
  await delay(100);
  const disconnectedCounts = [traffic.host.length, traffic.peer.length];
  await delay(WORK_SYNC_INTERVAL + 100);
  assert.deepEqual([traffic.host.length, traffic.peer.length], disconnectedCounts, 'disconnect stops periodic traffic');
  assert.deepEqual(quietPeerAdapter.state.document, retained);
  // A departed Mac must not occupy the authorizing role until an idle poll.
  quietHost.stop();
  const nextHost = new WorkSyncClient({ adapter: makeAdapter(true), request: watch('host', true), openSocket: pushed.openSocket });
  try {
    nextHost.start();
    await until(() => nextHost.state.role === 'host', 'new local page receives the authorizing role without polling');
  } finally { nextHost.stop(); }
  // Returning from the browser's back/forward cache stays independent.
  quietPeer.stop(); quietPeer.state.link = { id: 'old-link', expiresAt: Date.now() + WORK_SYNC_LEASE };
  const resumeStart = traffic.peer.length;
  quietPeer.start(); await quietPeer.starting;
  assert.equal(quietPeer.state.link, null);
  assert.equal(quietPeer.token, null); assert.equal(quietPeer.timer, null);
  assert.deepEqual(traffic.peer.slice(resumeStart), ['/__atlas/work-sync/capabilities']);
} finally { quietHost.stop(); quietPeer.stop(); await pushed.close(); }
console.log('work sync: idle silence, passive authorization, denial/retry, timed exchange and quiet disconnect passed');
