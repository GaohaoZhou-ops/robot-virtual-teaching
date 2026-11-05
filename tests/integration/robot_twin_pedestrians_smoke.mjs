import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakeRobotServer } from '../../scripts/lib/fake_robot_server.mjs';
import { createRobotTwinService } from '../../src/server/robots/robotTwinService.js';
import { RobotTwinClient } from '../../src/features/robot-twin/client/robotTwinClient.js';
import { RobotTwinFleet } from '../../src/features/robot-twin/model/robotTwinFleet.js';
import { ROBOT_PEDESTRIANS_PATH } from '../../src/shared/protocols/robotTwinPedestrians.js';

const fixtures = [0, 1].map(() => ({ reads: 0, cancelled: 0, slow: 0, status: 200, boxes: true, stale: false, active: 0, peak: 0 }));
const traffic = [], clients = [];
const robots = fixtures.map((fixture, index) => {
  const server = createFakeRobotServer({ clock: () => 0 });
  const handler = server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    traffic.push([req.method, req.url]);
    if (req.url !== ROBOT_PEDESTRIANS_PATH) { void handler(req, res); return; }
    assert.equal(req.method, 'GET');
    assert.match(req.headers['x-abx-control-token'] || '', /^[a-f0-9]{64}$/);
    fixture.reads++; fixture.active++; fixture.peak = Math.max(fixture.peak, fixture.active);
    res.once('close', () => { fixture.active--; if (!res.writableEnded) fixture.cancelled++; });
    if (fixture.slow) await delay(fixture.slow);
    if (res.destroyed) return;
    res.writeHead(fixture.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: 'resident', enabled: true, ready: true, state: 'running',
      frame: 'base_link', captured_at_ms: Date.now(), ttl_ms: 600, result_age_ms: fixture.stale ? 700 : 10, source_age_ms: 20,
      boxes: fixture.boxes ? [{ label: 'person', center_m: [2 + index, 1, .9], size_m: [.5, .6, 1.8], yaw_rad: 0, score: .9 }] : [] }));
  });
  return server;
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const until = async (condition) => {
  const deadline = Date.now() + 6000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(15); }
};
const addresses = await Promise.all(robots.map(listen));
const service = createRobotTwinService();
const proxy = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
const local = await listen(proxy);
const fleet = new RobotTwinFleet({ createClient: (options) => {
  const client = new RobotTwinClient({ ...options, request: (path, settings) => fetch(local + path, settings) });
  clients.push(client); return client;
} });
const profiles = addresses.map((address, i) => ({ id: String(i), name: `fixture ${i}`, address, password: 'admin' }));
try {
  assert.equal(await fleet.connectMany(profiles), true);
  assert.equal(fleet.state.pedestrians.enabled, true, 'the selected robot enables visualization after connecting');
  await until(() => fleet.state.pedestrians.phase === 'live');
  assert.equal(fleet.state.pedestrians.boxes.length, 1);
  const firstReads = fixtures[0].reads;
  await delay(1200);
  assert.ok(fixtures[0].reads - firstReads <= 3, 'polling is bounded to 2 Hz');
  assert.equal(fixtures[1].reads, 0, 'only the selected robot is read');
  fleet.state.access.setPedestriansEnabled(false);
  await delay(50);
  const manuallyStopped = fixtures[0].reads;
  await delay(700);
  assert.equal(fixtures[0].reads, manuallyStopped, 'telemetry updates must not undo a manual close');
  const oldAccess = fleet.state.access;
  fleet.select('1');
  assert.equal(clients[0].state.pedestrians.enabled, false);
  assert.equal(fleet.state.pedestrians.enabled, true, 'first selection uses the connected robot default');
  const stopped = fixtures[0].reads;
  oldAccess.setPedestriansEnabled(true);
  await delay(650); assert.equal(fixtures[0].reads, stopped, 'old UI callbacks cannot restart another robot');
  await until(() => fleet.state.pedestrians.phase === 'live');
  fleet.select('0');
  assert.equal(fleet.state.pedestrians.enabled, false, 'switching back remembers a manual close within this connection');
  await delay(650);
  assert.equal(fixtures[0].reads, stopped);
  fleet.select('1');
  await until(() => fleet.state.pedestrians.phase === 'live');
  fleet.setPedestriansVisible(false);
  assert.equal(fleet.state.pedestrians.phase, 'paused'); assert.equal(fleet.state.pedestrians.boxes.length, 0);
  const paused = fixtures[1].reads; await delay(700); assert.equal(fixtures[1].reads, paused);
  fleet.setPedestriansVisible(true);
  await until(() => fleet.state.pedestrians.phase === 'live');
  fixtures[1].boxes = false;
  await until(() => fleet.state.pedestrians.phase === 'live' && !fleet.state.pedestrians.boxes.length);
  fixtures[1].stale = true;
  await until(() => fleet.state.pedestrians.phase === 'waiting');
  assert.equal(fleet.state.pedestrians.boxes.length, 0);
  fixtures[1].stale = false; fixtures[1].boxes = true; fixtures[1].slow = 1600;
  await until(() => fixtures[1].active === 1);
  fleet.state.access.setPedestriansEnabled(false);
  await until(() => fixtures[1].cancelled > 0);
  const cancelledReads = fixtures[1].reads;
  await delay(1700);
  assert.equal(fixtures[1].reads, cancelledReads); assert.equal(fleet.state.pedestrians.boxes.length, 0);
  fixtures[1].slow = 0;

  // Concurrent browser reads share one upstream GET; invalid methods/paths
  // cannot enable detection, fetch point clouds, or alter robot parameters.
  const session = clients[1];
  const headers = { 'X-Atlas-Robot-Twin': '1', Authorization: `Bearer ${session.token}` };
  const api = (suffix, options = {}) => fetch(local + '/__atlas/robot-twin' + suffix, { headers, ...options });
  const before = fixtures[1].reads;
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => api('/pedestrians').then((r) => r.json())));
  assert.equal(fixtures[1].reads - before, 1);
  assert.ok(concurrent.every((r) => r.boxes.length === 1));
  const cached = await (await api('/pedestrians')).json();
  assert.equal(cached.sampleId, concurrent[0].sampleId);
  assert.ok(cached.sampleAgeMs >= concurrent[0].sampleAgeMs && cached.validForMs <= concurrent[0].validForMs,
    'cached replies advance source age without renewing detection time');
  assert.equal((await api('/pedestrians', { method: 'POST' })).status, 405);
  assert.equal((await api('/pedestrians?enabled=1')).status, 400);
  assert.equal((await api('/lidars/detection/preview', { method: 'POST' })).status, 404);
  assert.equal((await fetch(local + '/__atlas/robot-twin/pedestrians', { headers: { 'X-Atlas-Robot-Twin': '1' } })).status, 401);

  await delay(550); fixtures[1].status = 404;
  fleet.state.access.setPedestriansEnabled(true);
  await until(() => fleet.state.pedestrians.phase === 'error' && !fleet.state.pedestrians.enabled);
  const unsupported = fixtures[1].reads; await delay(650); assert.equal(fixtures[1].reads, unsupported);
  assert.equal(fleet.state.phase, 'live', 'an unavailable perception endpoint does not interrupt the twin');
  fixtures[1].status = 200;
  fleet.state.access.setPedestriansEnabled(true);
  await until(() => fleet.state.pedestrians.phase === 'live');
  fleet.state.access.setPedestriansEnabled(false);
  fleet.disconnect();
  await delay(100);
  const disconnected = fixtures.map((f) => f.reads);
  await delay(750); assert.deepEqual(fixtures.map((f) => f.reads), disconnected);
  assert.equal(await fleet.connectMany(profiles), true);
  await until(() => fleet.state.pedestrians.phase === 'live');
  assert.equal(fleet.state.pedestrians.enabled, true, 'a new connection restores automatic visualization');
  fleet.disconnect();
  assert.ok(fixtures.every((f) => f.peak === 1), 'slow requests never overlap');
  assert.ok(traffic.every(([method, path]) => method === 'GET' || path === '/api/v1/access/login'), 'robot receives only reads and login');
  assert.ok(!traffic.some(([, path]) => /lidars\/(preview|frame|detection\/preview)|parameters/.test(path)));
  console.log('Pedestrian HTTP integration: default-on, manual close, reconnect, 2 Hz, selection, pause/resume, expiry, cancellation, shared reads, read-only robot access and disconnect passed.');
} finally {
  fleet.disconnect(); await service.close();
  await Promise.all([proxy, ...robots].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
}
