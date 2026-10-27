import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Group } from 'three';
import { createRobotTwinService, robotTwinAddress } from '../src/server/robotTwinService.js';
import { ROBOT_TWIN_PREFIX, robotTwinSnapshot, robotTwinDisplayPose } from '../src/lib/robotTwin.js';
import { RobotTwinClient } from '../src/lib/robotTwinClient.js';
import { applyRobotJointValues } from '../src/lib/robotLoader.js';
import { systemRobotFetch } from '../src/server/robotTwinTransport.js';
import { createRobotTaskMonitor, isRobotMonitorRead } from '../src/server/robotTwinMonitor.js';
import { robotTwinTask } from '../src/lib/robotTwinMonitor.js';

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
let taskFailures = false, resultFailures = false, algorithmProcessing = true;
const run = { id: 'd'.repeat(32), phase: 'idle', task_name: '巡检任务', task_index: 0,
  parking_name: '一号停车点', point_name: '焊缝检测', stage: 'capture', message: '正在采集',
  completed_points: 2, completed_captures: 1, elapsed_ms: 1234, algorithm_mode: 'execute', algorithm_state: 'processing',
  confirmation: 'do-not-expose', summary: { point_count: 4, tasks: [{ id: 'private-plan', name: '巡检任务', point_count: 4 }] } };
const capture = { id: 'e'.repeat(32), side: 'left', sequence: 1, task_name: '巡检任务', point_name: '焊缝检测' };
assert.ok(!JSON.stringify(robotTwinTask(run)).includes('do-not-expose'));
assert.ok(!JSON.stringify(robotTwinTask(run)).includes('private-plan'));
for (const path of ['/api/v1/execution/start', '/api/v1/execution/cancel', '/api/v1/cameras/capture',
  `/api/v1/cameras/jobs/${capture.id}/wait-capture`, `/api/v1/execution/captures?run_id=${run.id}&offset=0&start=1`,
  '/api/v1/execution/captures?run_id=../../control&offset=0']) assert.equal(isRobotMonitorRead(path), false);
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
  if (taskFailures) return send(res, 503, { error: 'task unavailable' });
  if (req.url === '/api/v1/execution/activity') return send(res, 200, { ok: true, task_phase: run.phase, navigation_phase: 'idle' });
  if (req.url === '/api/v1/execution') return send(res, 200, { ok: true, run });
  if (resultFailures) return send(res, 503, { error: 'results unavailable' });
  if (req.url === `/api/v1/execution/captures?run_id=${run.id}&offset=0`) return send(res, 200, {
    ok: true, run_id: run.id, captures: [capture], next_offset: 1, total: 1 });
  if (req.url === `/api/v1/cameras/jobs/${capture.id}`) return send(res, 200, { job: {
    state: 'complete', cameras: { left: { inspection: algorithmProcessing ? { state: 'processing' }
      : { state: 'complete', boxes: [{ label: '表面裂纹', x: 10, y: 20, width: 30, height: 40 }] } } } } });
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
  await until(() => client.state.monitorPhase === 'live');
  assert.equal(client.state.monitor.task, null);
  assert.ok(!traffic.includes('GET /api/v1/execution'), 'idle observation does not start the execution worker');
  run.phase = 'running';
  await until(() => client.state.monitor?.task?.taskName === '巡检任务');
  assert.equal(client.state.monitor.results[0].state, 'processing');
  algorithmProcessing = false;
  await until(() => client.state.monitor?.results[0]?.state === 'complete');
  assert.equal(client.state.monitor.results[0].labels[0], '表面裂纹');
  assert.ok(client.state.monitor.results[0].output.includes('"x": 10'));
  const jobReads = traffic.filter((entry) => entry.includes('/cameras/jobs/')).length;
  resultFailures = true;
  await until(() => Boolean(client.state.monitor?.resultsError));
  assert.equal(client.state.monitor.task.taskName, '巡检任务');
  assert.equal(client.state.monitor.results[0].labels[0], '表面裂纹', 'retain and mark stale results for the same run');
  assert.equal(client.state.phase, 'live', 'results failures do not interrupt pose polling');
  resultFailures = false;
  await until(() => !client.state.monitor?.resultsError);
  assert.equal(traffic.filter((entry) => entry.includes('/cameras/jobs/')).length, jobReads, 'finished algorithm results are cached');
  taskFailures = true;
  await until(() => client.state.monitorPhase === 'stale');
  assert.equal(client.state.phase, 'live', 'task failures do not interrupt pose polling');
  taskFailures = false;
  await until(() => client.state.monitorPhase === 'live');
  run.phase = 'idle';
  await until(() => client.state.monitor?.task === null);
  assert.deepEqual(client.state.monitor.results, [], 'idle state clears previous task outputs');
  assert.ok(!JSON.stringify(client.state).includes(cookie));
  assert.ok(!JSON.stringify(client.state).includes(credential));
  // Isolate rejected requests from the two legitimate background polling loops.
  await until(() => client.controllers.size === 0);
  clearTimeout(client.timer); clearTimeout(client.monitorTimer);
  const before = traffic.length;
  for (const path of ['/api/v1/control/jog', '/control', '/snapshot?path=/api/v1/control/enable']) {
    const result = await request(ROBOT_TWIN_PREFIX + path, { method: 'POST', headers: { 'X-Atlas-Robot-Twin': '1', Authorization: `Bearer ${client.token}` } });
    assert.ok(result.status >= 400);
  }
  const denied = await request(ROBOT_TWIN_PREFIX + '/snapshot', { headers: { 'X-Atlas-Robot-Twin': '1', Origin: 'http://evil.test', Authorization: `Bearer ${client.token}` } });
  assert.equal(denied.status, 403);
  assert.equal(traffic.length, before, 'rejected paths and cross-origin requests never reach robot');
  void client.poll(client.generation); void client.pollMonitor(client.generation);
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
  assert.equal(client.state.monitor, null);
  await delay(650); assert.equal(traffic.length, afterAuth, 'disconnect stops robot requests');
  assert.deepEqual([...new Set(traffic)].sort(), ['POST /api/v1/access/login', 'GET /api/v1/control-session',
    'GET /api/v1/model', 'GET /api/v1/slam', 'GET /api/v1/state', 'GET /api/v1/execution/activity', 'GET /api/v1/execution',
    `GET /api/v1/execution/captures?run_id=${run.id}&offset=0`, `GET /api/v1/cameras/jobs/${capture.id}`].sort());
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

// Paired Zivid sides share a job; body cameras use the frame-result read route.
const records = [{ ...capture, side: 'left' }, { ...capture, side: 'right', sequence: 2 },
  { ...capture, id: 'f'.repeat(32), side: 'chest-color', sequence: 3 }];
const monitorReads = [];
const monitor = createRobotTaskMonitor(async (path) => {
  assert.ok(isRobotMonitorRead(path)); monitorReads.push(path);
  if (path.endsWith('/activity')) return { ok: true, task_phase: 'running', navigation_phase: 'idle' };
  if (path === '/api/v1/execution') return { ok: true, run: { ...run, phase: 'running', completed_captures: 3 } };
  if (path.includes('/captures?')) return { ok: true, run_id: run.id, total: 3, captures: records };
  return { job: { state: 'complete', cameras: Object.fromEntries(['left', 'right', 'chest-color'].map((side) =>
    [side, { inspection: { state: 'complete', boxes: [] } }])) } };
});
const paired = await monitor();
assert.equal(paired.results.length, 3); assert.equal(paired.results[0].camera, 'chest-color');
assert.ok(paired.results.every((item) => item.received && item.state === 'complete' && item.detectionCount === 0));
assert.equal(monitorReads.filter((path) => path.includes('/cameras/jobs/')).length, 1);
assert.equal(monitorReads.filter((path) => path.includes('/frame-captures/')).length, 1);
await monitor(); assert.equal(monitorReads.length, 5, 'one session shares its cached monitor response');

// Demo mode reads the last page of persisted annotations, never camera jobs.
const demoReads = [];
const demoMonitor = createRobotTaskMonitor(async (path) => {
  assert.ok(isRobotMonitorRead(path)); demoReads.push(path);
  if (path.endsWith('/activity')) return { ok: true, task_phase: 'succeeded', navigation_phase: 'idle' };
  if (path === '/api/v1/execution') return { ok: true, run: { ...run, phase: 'succeeded', algorithm_mode: 'demo', demo_image_count: 12 } };
  assert.equal(path, `/api/v1/execution/demo-images?run_id=${run.id}&offset=4`);
  return { ok: true, total: 12, algorithm_state: 'complete', images: [{ ...capture, sequence: 5, width: 640, height: 480, boxes: [{ label: '演示缺陷' }] }] };
});
const demo = await demoMonitor();
assert.equal(demo.results[0].demo, true); assert.equal(demo.results[0].labels[0], '演示缺陷');
assert.equal(demo.resultLimit, 8); assert.equal(demoReads.length, 3);
console.log('Robot twin: SLAM, 20 joints, task monitoring, algorithm outputs, paired/body cameras, demo results, freshness, failure isolation, read-only allowlist and cancellation passed.');
