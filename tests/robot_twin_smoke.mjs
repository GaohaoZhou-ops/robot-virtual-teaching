import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Group } from 'three';
import { createRobotTwinService, robotTwinAddress } from '../src/server/robotTwinService.js';
import { ROBOT_TWIN_PREFIX, robotTwinSnapshot, robotTwinDisplayPose } from '../src/lib/robotTwin.js';
import { RobotTwinClient } from '../src/lib/robotTwinClient.js';
import { applyRobotJointValues } from '../src/lib/robotLoader.js';
import { systemRobotFetch } from '../src/server/robotTwinTransport.js';

const names = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J', 'head_yaw_J', 'head_pitch_J',
  ...Array.from({ length: 7 }, (_, i) => `left_J${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `right_J${i + 1}`)];
const model = { name: 'botx_abx_zivid_m70', joint_names_sdk_order: names };
const sample = { valid: true, fresh: true, enabled: false, position_rad: Math.PI / 2 };
const state = { robot: { valid: true, state_fresh: true, health_fresh: true, state_age_ms: 5,
  joint_samples: Object.fromEntries([['head', 2], ['torso', 4], ['left_arm', 7], ['right_arm', 7]]
    .map(([key, count]) => [key, Array.from({ length: count }, () => ({ ...sample }))])) },
  localization: { valid: true, fresh: true, x_m: 999, y_m: 999, yaw_rad: Math.PI } };
const slam = { fresh: true, age_ms: 20, sample: { ok: true, source: 'slam_websocket',
  scene: { mode: 'kLocalization', operation_running: false }, pose: { x_m: 1.25, y_m: -2.5, yaw_rad: Math.PI / 2 } } };
const normalize = (changes = {}) => robotTwinSnapshot({ slam, state, model, ...changes });
assert.deepEqual(normalize().pose, { x: 1.25, y: -2.5, yaw: 90 });
assert.equal(normalize().jointCount, 20, 'disabled motors still supply valid measured feedback');
assert.equal(normalize().joints.left_J7, 90);
assert.equal(normalize({ elapsedMs: 1500 }).pose, null);
assert.equal(normalize({ slam: null }).pose, null, 'never silently substitute SDK odometry');
assert.equal(normalize({ slam: { ...slam, age_ms: null } }).pose, null);
assert.equal(normalize({ slam: { ...slam, sample: { ...slam.sample, source: 'mock_slam' } } }).pose, null);
assert.equal(normalize({ slam: { ...slam, sample: { ...slam.sample, pose: { x_m: null, y_m: 0, yaw_rad: 0 } } } }).pose, null);
assert.equal(normalize({ slam: { ...slam, sample: { ...slam.sample, scene: { mode: 'kMapping', operation_running: false } } } }).pose, null);
assert.equal(normalize({ model: { joint_names_sdk_order: Array(20).fill('left_J1') } }).jointCount, 0);
const partial = structuredClone(state); partial.robot.joint_samples.head[0].fresh = false;
assert.equal(normalize({ state: partial }).jointCount, 19);
assert.equal(normalize({ state: { robot: { ...state.robot, state_fresh: false } } }).jointCount, 0);
const offline = { position: { x: 8, y: 7, z: .12 }, rpy: { roll: 3, pitch: 4, yaw: 5 } };
assert.deepEqual(robotTwinDisplayPose(offline, normalize().pose), { position: { x: 1.25, y: -2.5, z: .12 }, rpy: { roll: 0, pitch: 0, yaw: 90 } });
assert.equal(offline.position.x, 8);
const robot = new Group(), joint = new Group(); joint.name = 'left_J1';
joint.userData = { jointType: 'revolute', jointLimit: { lower: -.2, upper: .2 }, jointAxis: [0, 0, 1] }; robot.add(joint);
assert.ok(applyRobotJointValues(robot, { left_J1: 90 }).left_J1 < 15);
assert.equal(applyRobotJointValues(robot, { left_J1: 90 }, { measured: true }).left_J1, 90);
assert.ok(applyRobotJointValues(robot, { left_J1: 90 }).left_J1 < 15, 'offline limits remain intact');
assert.equal(robotTwinAddress('192.168.0.112:9090'), 'http://192.168.0.112:9090');
for (const value of ['https://example.com', 'http://8.8.8.8', 'http://192.168.0.112/api/v1/control/jog',
  'http://admin:pass@192.168.0.112', 'http://192.168.0.112/?path=/control', 'file:///etc/passwd']) assert.throws(() => robotTwinAddress(value));

const traffic = [];
let unauthorized = false, stale = false, redirect = false, failures = false;
const credential = 'a'.repeat(64), cookie = 'b'.repeat(64);
const send = (res, status, payload, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
const upstream = createServer(async (req, res) => {
  traffic.push(`${req.method} ${req.url}`);
  if (req.url === '/api/v1/access/login' && req.method === 'POST') {
    let content = ''; for await (const data of req) content += data;
    assert.equal(new URLSearchParams(content).get('role'), 'admin');
    assert.equal(req.headers['x-abx-web-client'], 'robot-dashboard');
    if (new URLSearchParams(content).get('password') !== 'fixture-password') return send(res, 401, { error: 'bad password' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': `abx_access_9090=${cookie}; HttpOnly` });
  }
  if (unauthorized || req.headers.cookie !== `abx_access_9090=${cookie}`) return send(res, 401, { error: 'login required' });
  if (req.url === '/api/v1/control-session' && req.method === 'GET') return send(res, 200, { token: credential });
  assert.equal(req.method, 'GET', 'no robot mutation except login');
  assert.equal(req.headers['x-abx-control-token'], credential);
  if (req.url === '/api/v1/model') return send(res, 200, model);
  if (failures) return send(res, 503, { error: 'unavailable' });
  if (redirect) return send(res, 302, {}, { Location: '/api/v1/control/enable' });
  if (req.url === '/api/v1/slam') return send(res, 200, { ...slam, fresh: !stale });
  if (req.url === '/api/v1/state') return send(res, 200, state);
  assert.fail(`Unexpected robot endpoint: ${req.method} ${req.url}`);
});
const service = createRobotTwinService();
const app = createServer((req, res) => service(req, res, () => send(res, 404, {})));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const upstreamUrl = await listen(upstream), appUrl = await listen(app);
const request = (url, options) => fetch(appUrl + url, options);
const client = new RobotTwinClient({ request });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => { const deadline = Date.now() + 7000; while (!condition()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(25); } };
try {
  if (process.platform === 'darwin') {
    const systemRead = await systemRobotFetch(upstreamUrl + '/api/v1/slam', { method: 'GET',
      headers: { Cookie: `abx_access_9090=${cookie}`, 'X-ABX-Control-Token': credential }, signal: AbortSignal.timeout(3000) });
    assert.equal(systemRead.status, 200); assert.equal((await systemRead.json()).sample.pose.x_m, 1.25);
    redirect = true;
    const systemRedirect = await systemRobotFetch(upstreamUrl + '/api/v1/slam', { method: 'GET',
      headers: { Cookie: `abx_access_9090=${cookie}`, 'X-ABX-Control-Token': credential }, signal: AbortSignal.timeout(3000) });
    assert.equal(systemRedirect.status, 302, 'system transport must not follow redirects');
    redirect = false;
  }
  assert.equal(await client.connect(upstreamUrl, 'wrong'), false);
  assert.equal(client.state.active, false);
  assert.equal(await client.connect(upstreamUrl, 'fixture-password'), true);
  await until(() => client.state.phase === 'live');
  assert.equal(client.state.pose.x, 1.25);
  assert.equal(client.state.joints.left_J7, 90);
  assert.ok(!JSON.stringify(client.state).includes(cookie));
  assert.ok(!JSON.stringify(client.state).includes(credential));
  const before = traffic.length;
  for (const path of ['/api/v1/control/jog', '/control', '/snapshot?path=/api/v1/control/enable']) {
    const result = await request(ROBOT_TWIN_PREFIX + path, { method: 'POST', headers: { 'X-Atlas-Robot-Twin': '1', Authorization: `Bearer ${client.token}` } });
    assert.ok(result.status >= 400);
  }
  const denied = await request(ROBOT_TWIN_PREFIX + '/snapshot', { headers: { 'X-Atlas-Robot-Twin': '1', Origin: 'http://evil.test', Authorization: `Bearer ${client.token}` } });
  assert.equal(denied.status, 403);
  assert.equal(traffic.length, before, 'rejected paths and cross-origin requests never reach robot');
  stale = true;
  await until(() => client.state.phase === 'stale');
  assert.equal(client.state.pose.x, 1.25, 'retain last pose without odometry fallback');
  stale = false; slam.sample.pose.x_m = 2.5;
  await until(() => client.state.phase === 'live' && client.state.pose.x === 2.5);
  failures = true; await until(() => client.state.phase === 'stale');
  assert.equal(client.state.pose.x, 2.5);
  failures = false; await until(() => client.state.phase === 'live');
  redirect = true; await until(() => client.state.phase === 'stale');
  assert.ok(!traffic.some((entry) => entry.includes('/control/enable')), 'never follow upstream redirects');
  redirect = false; await until(() => client.state.phase === 'live');
  unauthorized = true;
  await until(() => !client.token);
  const afterAuth = traffic.length;
  await delay(650); assert.equal(traffic.length, afterAuth, 'authentication expiry requires explicit reconnect');
  client.disconnect();
  assert.equal(client.state.pose, null); assert.deepEqual(client.state.joints, {});
  await delay(650); assert.equal(traffic.length, afterAuth, 'disconnect stops robot requests');
  assert.deepEqual([...new Set(traffic)].sort(), ['POST /api/v1/access/login', 'GET /api/v1/control-session',
    'GET /api/v1/model', 'GET /api/v1/slam', 'GET /api/v1/state'].sort());
} finally {
  client.disconnect(); service.close();
  await Promise.all([app, upstream].map((server) => new Promise((resolve) => server.close(resolve))));
}

// A late successful connection is discarded and its server session released.
let finish, released = false;
const pending = new RobotTwinClient({ request: (url, options) => {
  if (options.method === 'POST') return new Promise((resolve) => { finish = resolve; });
  if (options.method === 'DELETE') released = true;
  return Promise.resolve(new Response('{}', { status: 200 }));
} });
const connecting = pending.connect('192.168.0.112:9090', 'fixture');
pending.disconnect(); finish(new Response(JSON.stringify({ token: 'c'.repeat(64) }), { status: 201 }));
await connecting; await delay(0);
assert.equal(pending.state.active, false); assert.equal(released, true);
console.log('Robot twin: SLAM coordinates, 20 joints, measured rendering, freshness, reconnect, auth, request allowlist, redirects, isolation and cancellation passed.');
