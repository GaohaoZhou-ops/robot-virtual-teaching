import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createFakeRobotServer } from '../scripts/lib/fake_robot_server.mjs';
import { createRobotTwinService } from "../src/server/robots/robotTwinService.js";
import { RobotTwinClient } from "../src/features/robot-twin/client/robotTwinClient.js";
import { colorRobotTwinPointCloud, parseRobotTwinPointCloud } from "../src/features/robot-twin/model/robotTwinPointCloud.js";
import { isRobotDetectionAlarm } from "../src/shared/protocols/robotTwinMonitor.js";
import { formatRobotDetectionConfidence, isSuspectedRobotDetection, summarizeRobotDetections } from "../src/shared/protocols/robotTwinInspection.js";

for (const [box, suspected] of [
  [{ confidence: 0 }, true], [{ confidence: 0.6999999999999 }, true], [{ confidence: 0.70 }, false],
  [{ confidence: 0.85, confidence_threshold: 0.9 }, true], [{ confidence: 0.9, confidence_threshold: 0.9 }, false],
  [{ confidence: 0.6, confidence_threshold: 0 }, true], [{ confidence: 0.8, confidence_threshold: 2 }, false],
  [{}, false], [{ confidence: null }, false], [{ confidence: '0.6' }, false], [{ confidence: -1 }, false],
  [{ confidence: NaN }, false], [{ confidence: 1.1 }, false],
]) assert.equal(isSuspectedRobotDetection(box), suspected);
assert.equal(formatRobotDetectionConfidence({ confidence: 0.6999999999999 }), '69.9%');
assert.equal(formatRobotDetectionConfidence({ confidence: 0.8, confidence_threshold: 0.9 }), '80%');
assert.equal(formatRobotDetectionConfidence({}), '');
assert.deepEqual(summarizeRobotDetections([{ confidence: 0.6 }, { confidence: 0.5 }]),
  { detectionCount: 2, suspectedCount: 2, confirmedCount: 0, severity: 'suspected' });
assert.equal(summarizeRobotDetections([{ confidence: 0.6 }, {}]).severity, 'defect', 'legacy red takes priority');
assert.equal(summarizeRobotDetections([]).severity, 'clear');

const exec = promisify(execFile), delay = (ms) => new Promise((done) => setTimeout(done, ms));
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((done) => { server.close(done); server.closeAllConnections(); });
async function until(check) {
  const deadline = Date.now() + 7000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(30); }
}

let time = 0;
const robot = createFakeRobotServer({ clock: () => time });
const nativeHandler = robot.listeners('request')[0];
let mediaFault = '', mediaAborted = false;
robot.removeAllListeners('request');
robot.on('request', (req, res) => {
  if (mediaFault && /\/cameras\/jobs\/[a-f0-9]{32}\/left\/png$/.test(req.url)) {
    if (mediaFault === 'auth') { res.writeHead(401); res.end('login expired'); }
    else if (mediaFault === 'oversize') { res.writeHead(200, { 'Content-Length': 70 * 1024 * 1024 }); res.flushHeaders(); }
    else if (mediaFault === 'invalid') { res.writeHead(200); res.end(Buffer.alloc(32)); }
    else {
      res.writeHead(200, { 'Content-Length': 100 });
      res.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0]));
      res.once('close', () => { mediaAborted = true; });
    }
    return;
  }
  void nativeHandler(req, res);
});
const upstream = await listen(robot), service = createRobotTwinService();
const app = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
const local = await listen(app);
const client = new RobotTwinClient({ request: (path, options) => fetch(local + path, options) });
try {
  assert.equal(await client.connect(upstream, 'incorrect'), false);
  assert.equal(client.state.authFailed, true);
  assert.equal(await client.connect(upstream, 'admin'), true);
  assert.equal(client.state.phase, 'live');
  assert.equal(client.state.snapshot.jointCount, 20);
  assert.equal(client.state.pose.x, 0);
  const firstJoints = { ...client.state.joints };
  await until(() => client.state.camera.catalogPhase === 'ready' && client.state.monitorPhase === 'live');
  assert.equal(client.state.camera.cameras.length, 6);
  assert.ok(client.state.camera.cameras.every((item) => item.available));
  assert.match(client.state.monitor.task.taskName, /模拟巡检任务/);
  await client.cameraClient.start('head-left');
  await until(() => client.state.camera.phase === 'live');
  const firstFrame = Buffer.from(await (await fetch(client.state.camera.imageUrl)).arrayBuffer());
  assert.equal(jpeg.decode(firstFrame).width, 480);
  time = 4000;
  await until(() => client.state.pose.x > 0.1);
  time = 8000;
  await until(() => client.state.pose.x > 0.5 && client.state.monitor.results[0]?.state === 'processing');
  assert.notDeepEqual(client.state.joints, firstJoints);
  await delay(250);
  const secondFrame = Buffer.from(await (await fetch(client.state.camera.imageUrl)).arrayBuffer());
  assert.notDeepEqual(firstFrame, secondFrame, 'synthetic camera pixels change over time');
  client.cameraClient.select('wrist-right');
  await until(() => client.state.camera.phase === 'live' && client.state.camera.selected === 'wrist-right');
  const status = await (await fetch(upstream + '/__fake_robot/status')).json();
  assert.equal(status.activeCamera, 'wrist-right');
  await client.cameraClient.stop();
  time = 19000;
  await until(() => client.state.monitor.results.length === 4 && client.state.monitor.results[0].state === 'complete');
  assert.deepEqual(client.state.monitor.results[0].labels, ['模拟表面划痕']);
  assert.ok(!Object.hasOwn(client.state.monitor.results[0], 'output'));
  const capture = client.state.monitor.latestCapture;
  const historyPath = `/capture-history/${client.state.monitor.task.id}/0`;
  const historyPage = await client.api(historyPath);
  assert.equal(historyPage.results.length, 4);
  assert.equal(historyPage.captures.length, 2);
  assert.equal(historyPage.nextOffset, 4);
  assert.equal(historyPage.pending, false);
  assert.ok(historyPage.results.every((item) => item.state === 'complete'));
  assert.equal(historyPage.captures[0].runId, client.state.monitor.task.id);
  await assert.rejects(client.api(historyPath, { method: 'POST' }), (error) => error.status === 405);
  for (const path of [`/capture-history/${client.state.monitor.task.id}/-1`, `/capture-history/not-a-run/0`, `${historyPath}?command=start`]) {
    await assert.rejects(client.api(path), (error) => [400, 404].includes(error.status));
  }
  assert.equal(client.state.monitor.captures.length, 2);
  assert.equal(client.state.monitor.captures[0].id, capture.id);
  const olderCapture = client.state.monitor.captures[1];
  assert.notEqual(olderCapture.id, capture.id);
  assert.ok(olderCapture.sides.left.image && olderCapture.sides.right.cloud);
  assert.equal(olderCapture.sides.right.abnormal, false, 'history keeps its own inspection result');
  const olderImage = await client.api(`/captures/${olderCapture.id}/right/png`, { binary: true });
  assert.equal(PNG.sync.read(Buffer.from(await olderImage.blob.arrayBuffer())).width, 480);
  assert.ok(capture.sides.left.image && capture.sides.left.cloud && capture.sides.right.image && capture.sides.right.cloud);
  assert.equal(capture.sides.left.abnormal, false);
  assert.equal(capture.sides.right.abnormal, true);
  assert.equal(capture.sides.right.severity, 'defect');
  assert.equal(client.state.monitor.results[0].detections[0].confidence, 0.93);
  assert.equal(client.state.monitor.results[0].detections[0].confidence_threshold, 0.7);
  assert.equal(client.state.monitor.results.filter(isRobotDetectionAlarm).length, 1);
  const imagePath = `/captures/${capture.id}/left/png`;
  const leftImage = await client.api(imagePath, { binary: true });
  assert.equal(PNG.sync.read(Buffer.from(await leftImage.blob.arrayBuffer())).width, 480);
  const cloudFile = await client.api(`/captures/${capture.id}/right/xyzbin`, { binary: true });
  const bytes = await cloudFile.blob.arrayBuffer(), cloud = parseRobotTwinPointCloud(bytes);
  assert.equal(cloud.count, 240 * 135);
  assert.ok(Math.abs(cloud.positions[0] + 0.216) < 1e-6, 'millimetres convert to metres');
  assert.ok(Math.abs(cloud.positions[1] - 0.1215) < 1e-6, 'optical Y points down');
  assert.ok(cloud.positions[2] < -0.5 && cloud.positions[2] > -1, 'optical Z points forward');
  const inspection = capture.sides.right;
  assert.equal(inspection.pixelMapping.step_x, 2, 'native certified mapping reaches the preview');
  const marked = colorRobotTwinPointCloud(cloud, inspection);
  assert.equal(marked.highlighted, 45 * 15, 'the 90 × 30 RGB box maps to 45 × 15 XYZ pixels');
  assert.equal(marked.warning, '');
  assert.equal(marked.confirmedPoints, 675); assert.equal(marked.suspectedPoints, 0);
  const low = { ...inspection.boxes[0], confidence: 0.6 };
  const yellow = colorRobotTwinPointCloud(cloud, { ...inspection, boxes: [low] });
  assert.equal(yellow.confirmedPoints, 0); assert.equal(yellow.suspectedPoints, 675);
  assert.deepEqual([...yellow.colors.slice((45 * 240 + 55) * 3, (45 * 240 + 55) * 3 + 3)], [250, 204, 21]);
  const overlapping = { ...low, x: 170, y: 100, width: 80, height: 40 };
  const redThenYellow = colorRobotTwinPointCloud(cloud, { ...inspection, boxes: [inspection.boxes[0], overlapping] });
  const yellowThenRed = colorRobotTwinPointCloud(cloud, { ...inspection, boxes: [overlapping, inspection.boxes[0]] });
  assert.equal(redThenYellow.confirmedPoints, 675);
  assert.equal(redThenYellow.suspectedPoints, 650);
  assert.equal(redThenYellow.highlighted, 1325);
  assert.deepEqual(redThenYellow.colors, yellowThenRed.colors, 'red wins overlap in either detection order');
  assert.deepEqual([...redThenYellow.colors.slice((50 * 240 + 85) * 3, (50 * 240 + 85) * 3 + 3)], [255, 32, 32]);
  assert.equal(colorRobotTwinPointCloud(cloud, { ...inspection, boxes: [{ ...low, confidence_threshold: 0.5 }] }).confirmedPoints,
    675, 'capture-specific threshold is honored when coloring points');
  const firstMarked = 45 * 240 + 55;
  assert.deepEqual([...marked.colors.slice(firstMarked * 3, firstMarked * 3 + 3)], [255, 32, 32]);
  assert.deepEqual([...marked.colors.slice((45 * 240 + 100) * 3, (45 * 240 + 100) * 3 + 3)],
    [...cloud.colors.slice((45 * 240 + 100) * 3, (45 * 240 + 100) * 3 + 3)], 'right edge is excluded');
  assert.notDeepEqual(marked.colors, cloud.colors, 'annotation never mutates cached base colors');
  assert.equal(colorRobotTwinPointCloud(cloud, capture.sides.left).colors, cloud.colors);
  assert.equal(colorRobotTwinPointCloud(cloud, { ...inspection, state: 'processing' }).highlighted, 0);
  const missingPixels = bytes.slice(0), missingView = new DataView(missingPixels);
  missingView.setFloat32(16, NaN, true);
  missingView.setFloat32(16 + firstMarked * 12, Infinity, true);
  const sparse = parseRobotTwinPointCloud(missingPixels);
  assert.equal(colorRobotTwinPointCloud(sparse, inspection).highlighted, 45 * 15 - 1);
  const sampled = parseRobotTwinPointCloud(missingPixels, 700), sampledColors = colorRobotTwinPointCloud(sampled, inspection);
  for (let i = 0; i < sampled.count; i++) {
    const index = sampled.pixels[i], col = index % 240, row = Math.floor(index / 240);
    assert.equal(sampledColors.colors[i * 3] === 255, col >= 55 && col < 100 && row >= 45 && row < 60,
      'filtering and sampling preserve original sensor-grid coordinates');
  }
  const nativeInspection = { ...inspection, imageWidth: 240, imageHeight: 135,
    boxes: [{ x: 55, y: 45, width: 45, height: 15 }],
    pixelMapping: { ...inspection.pixelMapping, image_width: 240, image_height: 135, step_x: 1, step_y: 1 } };
  assert.equal(colorRobotTwinPointCloud(cloud, nativeInspection).highlighted, 675, 'native all-pixel mapping');
  assert.equal(colorRobotTwinPointCloud(cloud, { ...inspection, boxes: [...inspection.boxes, ...inspection.boxes] }).highlighted,
    675, 'overlapping detections do not double-count points');
  for (const pixelMapping of [null, { ...inspection.pixelMapping, available: false }, { ...inspection.pixelMapping, offset_x: 1 },
    { ...inspection.pixelMapping, cloud_width: 239 }, { ...inspection.pixelMapping, step_y: 1 }]) {
    const unavailable = colorRobotTwinPointCloud(cloud, { ...inspection, pixelMapping });
    assert.equal(unavailable.colors, cloud.colors); assert.equal(unavailable.highlighted, 0);
    assert.ok(unavailable.warning, 'uncertified or mismatched mapping cannot color the wrong points');
  }
  assert.ok(parseRobotTwinPointCloud(bytes, 7).count <= 7);
  const corrupted = bytes.slice(0); new DataView(corrupted).setUint32(8, 1, true);
  assert.throws(() => parseRobotTwinPointCloud(corrupted), /长度/);
  const empty = bytes.slice(0), view = new DataView(empty);
  for (let offset = 16; offset < empty.byteLength; offset += 12) view.setFloat32(offset, NaN, true);
  assert.throws(() => parseRobotTwinPointCloud(empty), /没有有效/);
  mediaFault = 'oversize';
  await assert.rejects(client.api(imagePath, { binary: true }), (error) => error.status === 413);
  mediaFault = 'invalid';
  await assert.rejects(client.api(imagePath, { binary: true }), (error) => error.status === 502);
  mediaFault = 'slow';
  const cancel = new AbortController(), cancelled = client.api(imagePath, { binary: true, signal: cancel.signal });
  const rejection = assert.rejects(cancelled);
  await delay(100); cancel.abort(); await rejection; await until(() => mediaAborted);
  mediaFault = '';
  const beforeDenied = (await (await fetch(upstream + '/__fake_robot/status')).json()).requests;
  for (const path of [`/captures/${capture.id}/left/zdf`, `/captures/${capture.id}/../png`,
    `/captures/${capture.id}/chest-color/png`, `/captures/${capture.id}/left/png?path=/api/v1/control/enable`]) {
    await assert.rejects(client.api(path), (error) => [400, 404].includes(error.status));
  }
  const afterDenied = (await (await fetch(upstream + '/__fake_robot/status')).json()).requests;
  const fileRequest = `GET /api/v1/cameras/jobs/${capture.id}/left/png`;
  assert.equal(afterDenied[fileRequest], beforeDenied[fileRequest], 'rejected paths never reach the robot');
  assert.ok(!JSON.stringify(afterDenied).includes('control/enable'));
  time = 29000;
  await until(() => client.state.monitor.latestCapture?.sides.right.severity === 'suspected');
  assert.equal(client.state.monitor.results[0].severity, 'suspected');
  assert.equal(client.state.monitor.results[0].suspectedCount, 1);
  time = 39000;
  await until(() => client.state.monitor.results[0]?.detectionCount === 2);
  assert.equal(client.state.monitor.results[0].severity, 'defect', 'mixed result rows keep red severity');
  assert.equal(client.state.monitor.latestCapture.sides.right.severity, 'defect');
  assert.equal(client.state.monitor.latestCapture.sides.right.suspectedCount, 1);
  time = 42000;
  await until(() => client.state.monitor.task?.phase === 'succeeded');
  time = 53000;
  await until(() => client.state.monitor.task === null);
  assert.ok(client.state.monitor.latestCapture, 'idle retains the most recent pair for inspection');
  time = 61000;
  await until(() => client.state.monitor.task?.taskName === '模拟巡检任务 · 第 2 轮');
  assert.equal(client.state.monitor.latestCapture, null, 'a new task does not inherit old capture labels');
  for (const path of ['/api/v1/control/jog', '/api/v1/control/enable', '/api/v1/execution/start', '/api/v1/cameras/capture']) {
    assert.equal((await fetch(upstream + path, { method: 'POST' })).status, 405, 'fake robot has no motion or capture command API');
  }
  client.disconnect();
  await until(() => client.state.camera.imageUrl === null);
  await delay(250);
  const stopped = await (await fetch(upstream + '/__fake_robot/status')).json();
  assert.equal(stopped.activeCamera, null);
  assert.equal(await client.connect(upstream, 'admin'), true);
  mediaFault = 'auth';
  await assert.rejects(client.api(imagePath, { binary: true }), (error) => error.code === 'ROBOT_AUTH_FAILED');
  assert.equal(client.state.authFailed, true);
  assert.equal(client.state.active, false, 'media auth failure closes the entire twin session');
} finally {
  client.disconnect(); await service.close(); await Promise.all([close(app), close(robot)]);
}

// Exercise the actual detached command, including collision handling and cleanup.
const script = fileURLToPath(new URL('../scripts/fake_robot.mjs', import.meta.url));
const reservation = createServer((_, res) => res.end('unrelated service'));
const occupied = await listen(reservation), port = new URL(occupied).port;
const command = (action, env = process.env) => exec(process.execPath, [script, action, '--port', port], { env, timeout: 12000 });
const pidFile = fileURLToPath(new URL(`../.atlas-cache/fake-robot/${port}.pid`, import.meta.url));
try {
  await assert.rejects(command('start'), (error) => error.stderr.includes('已被占用'));
  assert.equal(await (await fetch(occupied)).text(), 'unrelated service', 'failed start never stops another service');
  assert.equal(existsSync(pidFile), false);
  await close(reservation);
  assert.match((await command('stop')).stdout, /未运行/);
  assert.match((await command('start')).stdout, /已启动/);
  const first = JSON.parse(readFileSync(pidFile, 'utf8'));
  assert.match((await command('start')).stdout, /已经运行/);
  assert.equal(JSON.parse(readFileSync(pidFile, 'utf8')).pid, first.pid);
  assert.match((await command('status')).stdout, /运行中/);
  let response = await fetch(occupied + '/api/v1/access/login', { method: 'POST', body: new URLSearchParams({ role: 'admin', password: 'admin' }) });
  assert.equal(response.status, 200);
  assert.match((await command('stop')).stdout, /已停止/);
  assert.equal(existsSync(pidFile), false);
  assert.match((await command('stop')).stdout, /未运行/);
  assert.match((await command('start', { ...process.env, FAKE_ROBOT_PASSWORD: 'fake-changed' })).stdout, /已启动/);
  response = await fetch(occupied + '/api/v1/access/login', { method: 'POST', body: new URLSearchParams({ role: 'admin', password: 'admin' }) });
  assert.equal(response.status, 401);
  response = await fetch(occupied + '/api/v1/access/login', { method: 'POST', body: new URLSearchParams({ role: 'admin', password: 'fake-changed' }) });
  assert.equal(response.status, 200);
} finally {
  if (reservation.listening) await close(reservation);
  await command('stop');
}
console.log('Fake robot passed: native twin connection, moving pose, 20 joints, task lifecycle/results, animated JPEG, preview cleanup, authentication and detached start/stop.');
