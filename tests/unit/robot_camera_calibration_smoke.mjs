import assert from 'node:assert/strict';
import { Group, Matrix4 } from 'three';
import { parseHandEyeCalibration, readOptionalCalibration } from '../../src/shared/robotics/handEyeCalibration.js';
import { loadRobotCameraCalibrations } from '../../src/features/robot/model/robotCameraCalibration.js';
import { normalizeRobotDescriptor, registerPortableRobotPackage, releasePortableRobotPackage, resolveRobotResourceUrl } from '../../src/features/robot/model/robotLoader.js';
import { collectProjectRobotResources } from '../../src/features/workspace/model/projectArchive.js';
import { serializeMobileTeachingRobot, restoreMobileTeachingRobot } from '../../src/features/teaching/mobile/model/mobileTeachingKinematics.js';
import { handEyeReport, calibrationRobotPackage } from '../fixtures/hand_eye_calibration.mjs';

const parsed = parseHandEyeCalibration('\uFEFF' + JSON.stringify(handEyeReport()));
assert.equal(parsed.method, 'Park');
assert.equal(parsed.intrinsics.K[0][2], 1000);
for (const mutate of [
  (r) => { r.format = 'unsupported'; },
  (r) => { r.recommended_method = '__proto__'; },
  (r) => { delete r.methods.Park; },
  (r) => { r.methods.Park.camera_to_tool.rotation[0][0] = 2; },
  (r) => { r.methods.Park.camera_to_tool.rotation[0][0] = 1; },
  (r) => { r.methods.Park.camera_to_tool.translation_m[1] = '0'; },
  (r) => { r.methods.Park.tool_to_camera.translation_m[0] = 1; },
  (r) => { r.intrinsics.K[0][0] = 0; },
  (r) => { r.intrinsics.K[0][0] = 1e308; },
  (r) => { r.intrinsics.K[0][1] = .1; },
  (r) => { r.intrinsics.K[0][2] = -100; },
  (r) => { r.intrinsics.height = 0; },
  (r) => { r.intrinsics.distortion = [0]; },
]) {
  const report = handEyeReport(); mutate(report);
  assert.throws(() => parseHandEyeCalibration(JSON.stringify(report)));
}
for (const text of ['{', 'null', '<html>not json</html>', '{"format":"botx_handeye_real_report_v1","intrinsics":{}}']) {
  assert.throws(() => parseHandEyeCalibration(text));
}

assert.equal((await readOptionalCalibration(null)).status, 'missing');
for (const [http, state] of [[404, 'missing'], [403, 'unavailable'], [500, 'unavailable']]) {
  assert.equal((await readOptionalCalibration('/test', { fetcher: async () => new Response('', { status: http }) })).status, state);
}
assert.equal((await readOptionalCalibration('/test', { fetcher: async () => { throw Error('offline'); } })).status, 'unavailable');
assert.equal((await readOptionalCalibration('/test', { fetcher: async () => new Response('x', { headers: { 'content-length': '2000000' } }) })).status, 'invalid');
assert.equal((await readOptionalCalibration('/test', { fetcher: async () => new Response('x'.repeat(1024 * 1024 + 1)) })).status, 'invalid');
const stalledFetch = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
assert.match((await readOptionalCalibration('/test', { fetcher: stalledFetch, timeoutMs: 5 })).message, /超时/);
const abort = new AbortController();
const pending = readOptionalCalibration('/test', { fetcher: stalledFetch, signal: abort.signal });
abort.abort(); await assert.rejects(pending, { name: 'AbortError' });

function robotFixture() {
  const robot = new Group(); robot.position.set(1, 2, 3); robot.rotation.set(.2, .3, .4);
  for (const side of ['left', 'right']) {
    const tool = new Group(); tool.name = `tool_${side}`; tool.position.set(.2, side === 'left' ? .3 : -.3, .5); tool.rotation.set(.5, -.2, .1); robot.add(tool);
    const housing = new Group(); housing.name = `zivid_${side}_link`; housing.position.set(.1, .2, .3); housing.rotation.set(.1, .3, .2); tool.add(housing);
    const joint = new Group(); joint.userData.jointType = 'fixed'; joint.position.set(.01, .02, .03); housing.add(joint);
    const optical = new Group(); optical.name = `zivid_${side}_optical_frame`; optical.position.set(.02, 0, 0); joint.add(optical);
  }
  robot.updateWorldMatrix(true, true);
  return robot;
}
const closeMatrix = (a, b) => a.elements.forEach((v, i) => assert.ok(Math.abs(v - b.elements[i]) < 1e-10));
for (const [left, right, expected] of [
  [null, null, ['missing', 'missing']],
  [handEyeReport(), null, ['loaded', 'missing']],
  [null, handEyeReport('right'), ['missing', 'loaded']],
  ['{', handEyeReport('right'), ['invalid', 'loaded']],
  [handEyeReport(), '{', ['loaded', 'invalid']],
  [handEyeReport(), handEyeReport('right'), ['loaded', 'loaded']],
  ['{', '{', ['invalid', 'invalid']],
]) {
  const robot = robotFixture();
  const before = Object.fromEntries(['left', 'right'].map((s) => [s, robot.getObjectByName(`zivid_${s}_optical_frame`).matrixWorld.clone()]));
  const housingBefore = robot.getObjectByName('zivid_left_link').matrixWorld.clone();
  const reports = { left, right };
  const states = await loadRobotCameraCalibrations(robot, (path) => reports[path.includes('left') ? 'left' : 'right'] === null ? null : path,
    { fetcher: async (path) => { const report = reports[path.includes('left') ? 'left' : 'right']; return new Response(typeof report === 'string' ? report : JSON.stringify(report)); } });
  assert.deepEqual([states.left.status, states.right.status], expected);
  closeMatrix(robot.getObjectByName('zivid_left_link').matrixWorld, housingBefore);
  for (const side of ['left', 'right']) {
    const optical = robot.getObjectByName(`zivid_${side}_optical_frame`);
    if (states[side].status !== 'loaded') { closeMatrix(optical.matrixWorld, before[side]); continue; }
    const { rotation: r, translation_m: t } = reports[side].methods.Park.camera_to_tool;
    const target = robot.getObjectByName(`tool_${side}`).matrixWorld.clone()
      .multiply(new Matrix4().set(...r[0], t[0], ...r[1], t[1], ...r[2], t[2], 0, 0, 0, 1));
    closeMatrix(optical.matrixWorld, target);
    assert.deepEqual(optical.parent.userData.restPosition, optical.parent.position.toArray());
    const restored = restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot));
    restored.updateWorldMatrix(true, true);
    closeMatrix(restored.getObjectByName(optical.name).matrixWorld, target);
  }
}
assert.equal(await loadRobotCameraCalibrations(new Group(), () => { throw Error('must not read'); }), null);

// An older archive may contain only one calibration, while the other has been
// added to robots/<package>/calib later. Supplement only the missing side.
const legacyPackage = { ...calibrationRobotPackage({ left: handEyeReport() }), resourceDigest: 'legacy-calibration-test' };
const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
const resourceId = registerPortableRobotPackage(legacyPackage), requests = [];
const rightReport = JSON.stringify(handEyeReport('right'));
try {
  globalThis.window = { location: { href: 'http://calibration-test.local/' } };
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('blob:')) return originalFetch(url, options);
    requests.push(String(url));
    return String(url).endsWith('/handeye_right_real_report.json')
      ? new Response(rightReport) : new Response('missing', { status: 404 });
  };
  const descriptor = normalizeRobotDescriptor({ ...legacyPackage, portableResourceId: resourceId });
  const rightPath = 'calib/handeye_right_real_report.json';
  assert.equal(resolveRobotResourceUrl(descriptor, rightPath, { packageRelative: true, optional: true }), null);
  assert.equal(resolveRobotResourceUrl(descriptor, 'missing.stl', { optional: true }), null);
  const states = await loadRobotCameraCalibrations(robotFixture(), (path) => resolveRobotResourceUrl(descriptor, path,
    { packageRelative: true, optional: true, catalogFallback: true }));
  assert.deepEqual([states.left.status, states.right.status], ['loaded', 'loaded']);
  assert.equal(states.left.intrinsics.K[0][0], 1600);
  const enriched = await collectProjectRobotResources(descriptor, undefined, legacyPackage);
  assert.equal(enriched.files.length, legacyPackage.files.length + 1);
  assert.equal(legacyPackage.files.length, 3, 'export must not mutate the original package');
  assert.equal(enriched.resourceDigest, null, 'changed package must not reuse the old resource cache key');
  const bundled = enriched.files.find((file) => file.path.endsWith(rightPath));
  assert.equal(new TextDecoder().decode(bundled.bytes), rightReport);
  assert.ok(requests.length >= 2 && requests.every((url) => url.endsWith(rightPath)));
  const requestCount = requests.length;
  await collectProjectRobotResources(descriptor, undefined, enriched);
  assert.equal(requests.length, requestCount, 'already bundled calibration must not be replaced by local files');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  releasePortableRobotPackage(resourceId);
}
console.log('Calibration validation, fallback, legacy local supplements/export, transforms and worker kinematics passed.');
