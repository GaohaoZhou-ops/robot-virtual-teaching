import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeRobotServer } from "../../scripts/lib/fake_robot_server.mjs";
import { createRobotTwinService } from "../../src/server/robots/robotTwinService.js";
import { RobotTwinClient } from "../../src/features/robot-twin/client/robotTwinClient.js";
import { RobotTwinFleet } from "../../src/features/robot-twin/model/robotTwinFleet.js";
import { loadRobotTwinProfiles, saveRobotTwinProfiles } from "../../src/features/robot-twin/model/robotTwinProfiles.js";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((done) => { server.close(done); server.closeAllConnections(); });
async function until(check) {
  const deadline = Date.now() + 8000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(25); }
}
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
const times = [0, 0], rejected = [false, false], traffic = [[], []];
const upstreams = [0, 1].map((index) => {
  const server = createFakeRobotServer({ instance: 'identical-robot-task-ids', password: `robot-${index}`, clock: () => times[index] });
  const handler = server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request', (req, res) => {
    traffic[index].push([req.method, req.url]);
    if (rejected[index] && req.url.startsWith('/api/')) { res.writeHead(401); res.end('{}'); return; }
    void handler(req, res);
  });
  return server;
});
const addresses = await Promise.all(upstreams.map(listen));
const service = createRobotTwinService();
const app = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
const local = await listen(app), clients = [];
const fleet = new RobotTwinFleet({ createClient: (options) => {
  const client = new RobotTwinClient({ ...options, request: (path, settings) => fetch(local + path, settings) });
  clients.push(client); return client;
} });
const profiles = addresses.map((address, index) => ({ id: `robot-${index}`, name: `机器人 ${index}`, address, password: `robot-${index}` }));
try {
  // Legacy single selection migrates, including an intentionally empty new selection.
  saveRobotTwinProfiles({ profiles, selectedId: profiles[0].id });
  assert.deepEqual(loadRobotTwinProfiles().selectedIds, ['robot-0']);
  saveRobotTwinProfiles({ profiles, selectedIds: ['robot-0', 'robot-1'] });
  assert.deepEqual(loadRobotTwinProfiles().selectedIds, ['robot-0', 'robot-1']);
  saveRobotTwinProfiles({ profiles, selectedIds: [] });
  assert.deepEqual(loadRobotTwinProfiles().selectedIds, []);
  assert.ok(![...storage.values()].some((value) => value.includes('password')));
  times[0] = 19000; times[1] = 39000;
  assert.equal(await fleet.connectMany([profiles[0], { ...profiles[1], password: 'wrong' }]), false);
  assert.equal(fleet.state.connectedCount, 1);
  assert.equal(fleet.state.active, true, 'one failed robot does not disconnect the other');
  assert.equal(fleet.state.robots[1].authFailed, true);
  const loginsA = traffic[0].filter(([, path]) => path.endsWith('/login')).length;
  assert.equal(await fleet.connectMany(profiles), true);
  assert.equal(traffic[0].filter(([, path]) => path.endsWith('/login')).length, loginsA, 'retry preserves successful sessions');
  await until(() => fleet.state.robots.every((robot) => robot.monitor && robot.camera.catalogPhase === 'ready'));
  assert.equal(fleet.state.connectedCount, 2);
  assert.notEqual(fleet.state.robots[0].pose.x, fleet.state.robots[1].pose.x);
  const captureA = fleet.state.monitor.latestCapture.id;
  const accessA = fleet.state.access;
  await accessA.startCamera();
  await until(() => fleet.state.camera.phase === 'live');
  fleet.select('robot-1');
  assert.equal(fleet.state.selectedId, 'robot-1');
  assert.equal(fleet.state.monitor.task.completedPoints, 3);
  assert.equal(clients[0].cameraClient.state.wanted, false);
  assert.equal(fleet.state.camera.wanted, false);
  await fleet.state.access.startCamera();
  await until(() => fleet.state.camera.phase === 'live');
  const status = async (address) => (await fetch(address + '/__fake_robot/status')).json();
  assert.equal((await status(addresses[0])).activeCamera, null);
  assert.equal((await status(addresses[1])).activeCamera, 'head-left');
  const photoA = await accessA.readCapture(captureA, 'left', 'png');
  assert.equal(traffic[0].filter(([, path]) => path.endsWith(`/${captureA}/left/png`)).length, 1, 'viewing reuses the background download');
  assert.equal(photoA, clients[0].captureCache.peek(captureA, 'left', 'png').value);
  assert.notEqual(photoA, clients[1].captureCache.peek(captureA, 'left', 'png')?.value, 'old callbacks keep the original robot cache');
  times[0] += 1000;
  const oldX = fleet.state.robots[0].pose.x;
  await until(() => fleet.state.robots[0].pose.x !== oldX);
  rejected[1] = true;
  await until(() => fleet.state.robots[1].authFailed);
  assert.equal(fleet.state.selectedId, 'robot-0');
  assert.equal(fleet.state.active, true);
  assert.equal(fleet.state.connectedCount, 1);
  await until(() => fleet.state.monitor.task.completedPoints === 2);
  rejected[1] = false;
  assert.equal(await fleet.connectMany(profiles), true);
  fleet.disconnect();
  await delay(500);
  const counts = traffic.map((items) => items.length);
  await delay(1700);
  assert.deepEqual(traffic.map((items) => items.length), counts, 'stop cancels every pose, task and video poll');
  assert.equal(fleet.state.active, false); assert.deepEqual(fleet.state.robots, []);
  assert.ok(clients.every((client) => client.captureCache.assets.size === 0), 'disconnect clears every robot photo cache');
  assert.ok(traffic.flat().every(([method, path]) => method === 'GET' || /^\/api\/v1\/(access\/login|body-cameras\/(preview|frame))$/.test(path)), 'only authentication and read-only preview POSTs');
  // Cancel an in-flight batch; no late connection may repopulate the scene.
  const pending = fleet.connectMany(profiles); fleet.disconnect();
  assert.equal(await pending, false); assert.deepEqual(fleet.state.robots, []);
  assert.equal(fleet.state.connecting, false);
  console.log('robot twin fleet: partial connection, retry, independent telemetry/media, selection, auth isolation and stop passed');
} finally {
  fleet.disconnect(); await service.close(); await Promise.all([close(app), ...upstreams.map(close)]);
  delete globalThis.localStorage;
}
