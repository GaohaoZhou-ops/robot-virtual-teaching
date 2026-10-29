import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Group } from 'three';
import { createRobotTwinService, robotTwinAddress } from "../../src/server/robots/robotTwinService.js";
import { ROBOT_TWIN_PREFIX, robotTwinSnapshot, robotTwinDisplayPose } from "../../src/shared/protocols/robotTwin.js";
import { RobotTwinClient } from "../../src/features/robot-twin/client/robotTwinClient.js";
import { loadRobotTwinCredentials, rememberRobotTwinCredential } from "../../src/features/robot-twin/client/robotTwinCredentials.js";
import { createRobotTwinFollowCamera } from "../../src/features/robot-twin/model/robotTwinFollowCamera.js";
import { applyRobotJointValues } from "../../src/features/robot/model/robotLoader.js";
import { systemRobotFetch } from "../../src/server/robots/robotTwinTransport.js";
import { createRobotCaptureHistory, createRobotTaskMonitor, isRobotMonitorRead } from "../../src/server/robots/robotTwinMonitor.js";
import { robotTwinTask } from "../../src/shared/protocols/robotTwinMonitor.js";
import { BODY_CAMERAS } from "../../src/shared/protocols/robotTwinCamera.js";

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
for (const yaw of [-180, -90, 0, 90, 179]) {
  const pose = { position: { x: 2, y: -3, z: .2 }, rpy: { roll: 0, pitch: 0, yaw } };
  const original = structuredClone(pose), follow = createRobotTwinFollowCamera(pose, 1.8);
  const heading = yaw * Math.PI / 180, dx = follow.position.x - 2, dy = follow.position.y + 3;
  assert(dx * Math.cos(heading) + dy * Math.sin(heading) < -3, 'camera stays behind the chassis');
  assert(Math.abs(dx * Math.sin(heading) - dy * Math.cos(heading)) < 1e-10);
  assert(follow.position.z > pose.position.z + 1.8, 'view is higher than the robot');
  assert((follow.target.x - 2) * Math.cos(heading) + (follow.target.y + 3) * Math.sin(heading) > .5);
  const moved = { ...pose, position: { x: 4, y: -4, z: .2 } };
  for (let i = 0; i < 120; ++i) follow.update(moved, 1 / 60);
  assert(Math.abs(follow.position.x - 4 - dx) < 1e-5 && Math.abs(follow.position.y + 4 - dy) < 1e-5);
  assert.deepEqual(pose, original, 'following never changes the robot pose');
}
const north = { position: { x: 0, y: 0, z: 0 }, rpy: { yaw: 179 } };
const acrossWrap = { position: { x: 2, y: 3, z: 0 }, rpy: { yaw: -179 } };
const at30Hz = createRobotTwinFollowCamera(north), at120Hz = createRobotTwinFollowCamera(north);
for (let i = 0; i < 30; ++i) {
  at30Hz.update(acrossWrap, 1 / 30);
  assert(at30Hz.position.x > 3, 'heading crosses ±180° by the short arc');
}
for (let i = 0; i < 120; ++i) at120Hz.update(acrossWrap, 1 / 120);
assert(at30Hz.position.distanceTo(at120Hz.position) < 1e-9, 'smoothing is independent of frame rate');
const held = at30Hz.position.clone();
at30Hz.update({ position: { x: NaN }, rpy: {} }, 1 / 60);
assert(held.equals(at30Hz.position), 'invalid pose feedback cannot corrupt the camera');
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
const cameraTraffic = [], cameraLeases = new Map();
let activeCamera = null, frameSequence = 0, freezeFrames = false, cameraDelay = 0;
let unauthorized = false, cameraUnauthorized = false, monitorUnauthorized = false, stale = false, redirect = false, failures = false;
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

// Complete history must include results older than the 24-record live window,
// including a paired job split by a page boundary and late algorithms.
{
  const records = [{ id: 'f'.repeat(32), side: 'head-left', sequence: 1 }, ...Array.from({ length: 36 }, (_, index) => ({
    id: (Math.floor(index / 2) + 100).toString(16).padStart(32, '0'), side: index % 2 ? 'right' : 'left', sequence: index + 2,
  }))];
  const calls = [], reads = new Map(); let running = 0, peak = 0, late = true;
  const history = createRobotCaptureHistory(async (path, signal) => {
    signal?.throwIfAborted(); calls.push(path); assert.ok(isRobotMonitorRead(path));
    if (path.includes('/captures?')) {
      const offset = Number(new URL(path, 'http://fixture').searchParams.get('offset'));
      const page = records.slice(offset, offset + 11);
      return { ok: true, run_id: run.id, captures: page, total: records.length, next_offset: offset + page.length };
    }
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 1)); running--;
    reads.set(path, (reads.get(path) || 0) + 1);
    const id = path.split('/').at(-1);
    return { job: { state: 'complete', cameras: Object.fromEntries(['left', 'right'].map((side) => [side, {
      files: [{ kind: 'png', url: `${path}/${side}/png` }],
      inspection: { state: late && id === records[1].id ? 'processing' : 'complete', image_width: 480, image_height: 270, boxes: [] },
    }])) } };
  });
  const all = [], details = new Map(); let offset = 0;
  do {
    const page = await history(run.id, offset);
    if (!offset) assert.equal(page.pending, true);
    all.push(...page.results); for (const item of page.captures) details.set(item.id, item);
    offset = page.nextOffset;
  } while (offset < records.length);
  assert.equal(all.length, 36); assert.equal(new Set(all.map((item) => item.key)).size, 36);
  assert.equal(details.size, 18); assert.equal(details.get(records[1].id).runId, run.id);
  assert.ok([...details.values()].every((item) => item.sides.left.image && item.sides.right.image));
  assert.equal(all.filter((item) => item.state === 'complete').length, 34);
  assert.equal(peak, 2, 'history bounds concurrent metadata reads');
  assert.ok(!calls.some((path) => /frame-captures|\/png|\/xyzbin/.test(path)), 'history reads only Zivid metadata');
  const before = [...reads]; await history(run.id, 24);
  assert.deepEqual([...reads], before, 'finished jobs are cached across page reads');
  late = false;
  assert.ok((await history(run.id, 0)).results.every((item) => item.state === 'complete'), 'old pending algorithms can finish');
  const aborted = new AbortController(); aborted.abort();
  const countBefore = calls.length;
  await assert.rejects(history(run.id, 0, aborted.signal), { name: 'AbortError' });
  assert.equal(calls.length, countBefore, 'cancelled history never contacts the robot');
  await assert.rejects(createRobotCaptureHistory(async () => ({ ok: true, run_id: run.id, total: 2, next_offset: 0, captures: [] }))(run.id, 0), /索引格式/);
  await assert.rejects(createRobotCaptureHistory(async () => { throw Object.assign(new Error('expired'), { code: 'ROBOT_AUTH_FAILED' }); })(run.id, 0),
    { code: 'ROBOT_AUTH_FAILED' });
}
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
  if (cameraUnauthorized && req.url === '/api/v1/body-cameras') return send(res, 403, { error: 'camera auth required' });
  if (monitorUnauthorized && req.url === '/api/v1/execution/activity') return send(res, 401, { error: 'task auth required' });
  if (req.url === '/api/v1/control-session' && req.method === 'GET') return send(res, 200, { token: credential });
  if (req.url === '/api/v1/body-cameras' && req.method === 'GET') return send(res, 200, { ok: true,
    cameras: [...Object.entries(BODY_CAMERAS).map(([id, label]) => ({ id, label, available: true })), { id: 'left', label: 'Zivid', available: true }] });
  if (req.method === 'POST' && ['/api/v1/body-cameras/preview', '/api/v1/body-cameras/frame'].includes(req.url)) {
    assert.equal(req.headers['x-abx-control-token'], credential);
    let content = ''; for await (const chunk of req) content += chunk;
    const fields = Object.fromEntries(new URLSearchParams(content));
    assert.match(fields.client, /^[a-f0-9]{32}$/);
    const generation = Number(fields.generation);
    assert.ok(Number.isSafeInteger(generation) && generation > 0);
    cameraTraffic.push({ path: req.url, ...fields });
    if (fields.enabled === '1' && cameraDelay) await delay(cameraDelay);
    const previous = cameraLeases.get(fields.client);
    if (req.url.endsWith('/preview')) {
      if (generation < (previous?.generation || 0)) return send(res, fields.enabled === '1' ? 409 : 200, { ok: fields.enabled !== '1' });
      if (fields.enabled === '1') {
        assert.ok(Object.hasOwn(BODY_CAMERAS, fields.camera), 'only body-camera IDs may be subscribed');
        assert.equal(activeCamera, null, 'release the previous stream before starting another');
        assert.equal(Object.keys(fields).length, 4);
        activeCamera = fields.camera;
      } else { assert.equal(fields.enabled, '0'); assert.equal(Object.keys(fields).length, 3); activeCamera = null; }
      cameraLeases.set(fields.client, { generation, camera: activeCamera });
      return send(res, 200, { ok: true });
    }
    assert.equal(Object.keys(fields).length, 2);
    if (!previous?.camera || previous.generation !== generation) return send(res, 409, { error: 'lease ended' });
    if (!freezeFrames) ++frameSequence;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-ABX-Preview-Width': '16', 'X-ABX-Preview-Height': '9', 'X-ABX-Sequence': String(frameSequence) });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return;
  }
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
  if (req.url === `/api/v1/execution/captures?run_id=${run.id}&offset=1`) return send(res, 200, {
    ok: true, run_id: run.id, captures: [], next_offset: 1, total: 1 });
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
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value),
} });
const profile = { id: 'robot-A', address: upstreamUrl };
const otherProfile = { id: 'robot-B', address: 'http://127.0.0.1:9091' };
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
  rememberRobotTwinCredential(profile, 'old-password');
  rememberRobotTwinCredential(otherProfile, 'another-password');
  assert.equal(await client.connect(upstreamUrl, 'wrong', profile.id), false);
  assert.equal(client.state.active, false);
  assert.equal(client.state.authFailed, true);
  assert.deepEqual(loadRobotTwinCredentials().map((item) => item.id), [otherProfile.id], 'failed auth invalidates only that robot');
  assert.equal(await client.connect(upstreamUrl, 'fixture-password', profile.id), true);
  assert.equal(client.state.authFailed, false);
  assert.equal(loadRobotTwinCredentials().find((item) => item.id === profile.id).password, 'fixture-password');
  await until(() => client.state.phase === 'live');
  assert.equal(client.state.pose.x, 1.25);
  assert.equal(client.state.joints.left_J7, 90);
  await until(() => client.state.camera.catalogPhase === 'ready');
  cameraUnauthorized = true;
  await client.cameraClient.load();
  assert.equal(client.state.authFailed, true, 'camera authentication failure invalidates the robot credential too');
  assert.deepEqual(loadRobotTwinCredentials().map((item) => item.id), [otherProfile.id]);
  cameraUnauthorized = false;
  assert.equal(await client.connect(upstreamUrl, 'fixture-password', profile.id), true);
  await until(() => client.state.camera.catalogPhase === 'ready');
  assert.equal(client.state.camera.cameras.length, 6, 'Zivid is excluded from the preview catalog');
  assert.equal(cameraTraffic.length, 0, 'connecting the twin never opens a preview automatically');
  await client.cameraClient.start('head-left');
  await until(() => client.state.camera.phase === 'live');
  const previewCount = cameraTraffic.filter((item) => item.path.endsWith('/preview')).length;
  const invalidCamera = await request(ROBOT_TWIN_PREFIX + '/camera', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Atlas-Robot-Twin': '1', Authorization: `Bearer ${client.token}` },
    body: JSON.stringify({ camera: 'left', revision: 999 }) });
  assert.equal(invalidCamera.status, 400);
  assert.equal(cameraTraffic.filter((item) => item.path.endsWith('/preview')).length, previewCount);
  freezeFrames = true;
  await until(() => client.state.camera.phase === 'stale');
  assert.ok(client.state.camera.imageUrl, 'keep the latest image while explicitly marking it stale');
  assert.equal(client.state.phase, 'live', 'camera freshness is independent of robot pose');
  freezeFrames = false;
  await until(() => client.state.camera.phase === 'live');
  client.cameraClient.select('wrist-right');
  await until(() => activeCamera === 'wrist-right' && client.state.camera.phase === 'live');
  const previewActions = cameraTraffic.filter((item) => item.path.endsWith('/preview'));
  assert.deepEqual(previewActions.slice(-3).map((item) => item.enabled), ['1', '0', '1']);
  await client.cameraClient.stop();
  assert.equal(activeCamera, null); assert.equal(client.state.camera.imageUrl, null);
  const stoppedFrames = cameraTraffic.length;
  await delay(500); assert.equal(cameraTraffic.length, stoppedFrames);
  cameraDelay = 350;
  const enabling = client.cameraClient.start('head-left');
  await until(() => cameraTraffic.length > stoppedFrames);
  await client.cameraClient.stop(); await enabling; await delay(450);
  assert.equal(activeCamera, null, 'a late enable cannot resurrect a cancelled stream');
  cameraDelay = 0;
  await client.cameraClient.start('chest-color'); await until(() => client.state.camera.phase === 'live');
  client.disconnect();
  assert.equal(client.state.camera.imageUrl, null);
  await until(() => activeCamera === null);
  const releasedTraffic = traffic.length;
  await delay(600); assert.equal(traffic.length, releasedTraffic, 'disconnect releases the preview and stops all data reads');
  assert.equal(await client.connect(upstreamUrl, 'fixture-password', profile.id), true);
  await until(() => client.state.phase === 'live');
  await until(() => client.state.monitorPhase === 'live');
  assert.equal(client.state.monitor.task, null);
  assert.ok(!traffic.includes('GET /api/v1/execution'), 'idle observation does not start the execution worker');
  run.phase = 'running';
  await until(() => client.state.monitor?.task?.taskName === '巡检任务');
  assert.equal(client.state.monitor.results[0].state, 'processing');
  algorithmProcessing = false;
  await until(() => client.state.monitor?.results[0]?.state === 'complete');
  assert.equal(client.state.monitor.results[0].labels[0], '表面裂纹');
  assert.ok(!Object.hasOwn(client.state.monitor.results[0], 'output'), 'raw algorithm output is not sent to the console');
  await until(() => !client.captureCache.historyLoading && client.captureCache.runs.get(run.id)?.scanned
    && client.captureCache.runs.get(run.id).pending.size === 0);
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
  // Isolate rejected requests from the telemetry, monitor and photo index polls.
  await until(() => client.controllers.size === 0);
  clearTimeout(client.timer); clearTimeout(client.monitorTimer); clearTimeout(client.captureCache.historyTimer);
  const before = traffic.length;
  for (const path of ['/api/v1/control/jog', '/control', '/snapshot?path=/api/v1/control/enable']) {
    const result = await request(ROBOT_TWIN_PREFIX + path, { method: 'POST', headers: { 'X-Atlas-Robot-Twin': '1', Authorization: `Bearer ${client.token}` } });
    assert.ok(result.status >= 400);
  }
  const denied = await request(ROBOT_TWIN_PREFIX + '/snapshot', { headers: { 'X-Atlas-Robot-Twin': '1', Origin: 'http://evil.test', Authorization: `Bearer ${client.token}` } });
  assert.equal(denied.status, 403);
  assert.equal(traffic.length, before, 'rejected paths and cross-origin requests never reach robot');
  void client.poll(client.generation); void client.pollMonitor(client.generation);
  void client.captureCache.syncHistory();
  stale = true;
  await until(() => client.state.phase === 'stale');
  assert.equal(client.state.pose.x, 1.25, 'retain last pose without odometry fallback');
  stale = false; slam.sample.pose.x_m = 2.5;
  await until(() => client.state.phase === 'live' && client.state.pose.x === 2.5);
  failures = true; await until(() => client.state.phase === 'stale');
  assert.equal(client.state.pose.x, 2.5);
  assert.ok(loadRobotTwinCredentials().some((item) => item.id === profile.id), 'temporary failures preserve the password');
  failures = false; await until(() => client.state.phase === 'live');
  redirect = true; await until(() => client.state.phase === 'stale');
  assert.ok(!traffic.some((entry) => entry.includes('/control/enable')), 'never follow upstream redirects');
  redirect = false; await until(() => client.state.phase === 'live');
  monitorUnauthorized = true;
  await until(() => client.state.authFailed);
  assert.deepEqual(loadRobotTwinCredentials().map((item) => item.id), [otherProfile.id], 'task authentication failure invalidates the robot credential');
  monitorUnauthorized = false;
  assert.equal(await client.connect(upstreamUrl, 'fixture-password', profile.id), true);
  unauthorized = true;
  await until(() => !client.token);
  assert.equal(client.state.authFailed, true);
  assert.equal(client.state.active, false, 'expired robot authentication exits the twin for password re-entry');
  assert.deepEqual(loadRobotTwinCredentials().map((item) => item.id), [otherProfile.id]);
  const afterAuth = traffic.length;
  await delay(650); assert.equal(traffic.length, afterAuth, 'authentication expiry requires explicit reconnect');
  client.disconnect();
  assert.equal(client.state.pose, null); assert.deepEqual(client.state.joints, {});
  assert.equal(client.state.monitor, null);
  await delay(650); assert.equal(traffic.length, afterAuth, 'disconnect stops robot requests');
  assert.deepEqual([...new Set(traffic)].sort(), ['POST /api/v1/access/login', 'GET /api/v1/control-session',
    'GET /api/v1/model', 'GET /api/v1/slam', 'GET /api/v1/state', 'GET /api/v1/execution/activity', 'GET /api/v1/execution',
    'GET /api/v1/body-cameras', 'POST /api/v1/body-cameras/preview', 'POST /api/v1/body-cameras/frame',
    `GET /api/v1/execution/captures?run_id=${run.id}&offset=0`, `GET /api/v1/execution/captures?run_id=${run.id}&offset=1`,
    `GET /api/v1/cameras/jobs/${capture.id}`].sort());
} finally {
  client.disconnect(); await service.close();
  await Promise.all([app, upstream].map((server) => new Promise((resolve) => server.close(resolve))));
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
}

const expiredLocalSession = new RobotTwinClient({ request: async () => new Response(JSON.stringify({ error: 'local session expired' }), { status: 401 }) });
assert.equal(await expiredLocalSession.connect('127.0.0.1:9090', 'fixture'), false);
assert.equal(expiredLocalSession.state.authFailed, false, 'local session expiry is not a rejected robot password');
expiredLocalSession.disconnect();

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
assert.equal(paired.captures.length, 1, 'paired result rows share one selectable capture');
assert.equal(paired.captures[0].id, capture.id);
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
assert.deepEqual(demo.captures, [], 'demo annotations do not claim real capture files');
console.log('Robot twin: SLAM, 20 joints, task monitoring, algorithm outputs, paired/body cameras, demo results, freshness, failure isolation, read-only allowlist and cancellation passed.');
