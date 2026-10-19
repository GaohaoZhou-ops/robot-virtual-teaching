import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_MOBILE_SOLVE_OPTIONS, buildMobileSolvedTask, measureMobileTarget, mobileSampleTarget, normalizeMobileSolveReport, solveMobileTeaching, validateMobileSolveOptions } from '../src/lib/mobileTeachingSolver.js';
import { mobileSolutionMapPose } from '../src/lib/mobileTeachingParking.js';
import { readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';
import { transformTeachingTasks } from '../src/lib/teachingTransfer.js';
import { createMobileTeachingPauseGate, restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { mobileRobotPoseLinks, mobileSampleStatus } from '../src/lib/mobileTeachingReview.js';
import { createMobilePosePreview, disposeIPadCaptureLayer } from '../src/lib/ipadCaptureDisplay.js';

// A limited six-axis Cartesian arm makes feasibility and impossible targets
// independently known, while still exercising the same URDF joint update code.
function model() {
  const robot = new THREE.Group(), chest = new THREE.Group(); chest.name = 'waist_yaw_L'; robot.add(chest);
  for (const side of ['left', 'right']) {
    let parent = chest;
    for (const [i, axis] of [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]], [3, [0, 0, 1]], [4, [0, 1, 0]], [5, [1, 0, 0]]]) {
      const joint = new THREE.Group(); joint.name = `${side}_${i}`;
      const prismatic = i < 3;
      joint.userData = { jointType: prismatic ? 'prismatic' : 'revolute', jointAxis: axis, jointValue: 0,
        restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1],
        jointLimit: { lower: prismatic ? -1 : -Math.PI, upper: prismatic ? (side === 'left' ? 1 : 0.3) : Math.PI } };
      parent.add(joint); parent = joint;
    }
    const tool = new THREE.Group(); tool.name = `tool_${side}`; parent.add(tool);
    const optical = new THREE.Group(); optical.name = `zivid_${side}_optical_frame`; optical.position.z = 0.08; tool.add(optical);
  }
  return robot;
}
const robot = model(), zero = { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
const capture = (position, quaternion = { x: 0, y: 0, z: 0, w: 1 }) => ({
  id: 'sample', name: 'Pose 001', kind: 'keyframe', segmentId: 'segment', capturedAt: '2026-10-17T03:00:00Z', tracking: 'normal',
  cameraPose: { frameName: 'ipad_camera_optical_frame', position, quaternion },
});
const task = { id: 'task', name: 'Test', coordinateFrame: 'virtual_origin', map: { fileName: 'test.ply', teachingSpaceMode: 'independent' }, parkingPoints: [],
  mobileCapture: { protocol: 'atlas-ipad-teaching/1', id: 'capture', sessionId: 'session', modelHash: 'a'.repeat(64),
    coordinateFrame: 'virtual_origin', createdAt: '2026-10-17T03:00:00Z', completedAt: '2026-10-17T03:00:00Z', device: { model: 'iPad', lidar: true },
    calibrations: [{ id: 'segment', worldFromModel: new THREE.Matrix4().toArray() }], samples: [capture({ x: 0.75, y: 0.2, z: 0.4 })] } };
const run = (options = {}, overrides = {}) => solveMobileTeaching({ robot, task, mapPose: zero,
  options: { targetFrame: 'tool', parkingMode: 'fixed', checkCollisions: false, allowTorsoHeight: false, ...options }, ...overrides });
const original = readRobotJointValues(robot);
const result = await run();
assert.equal(result.feasibleCount, 1);
assert.equal(result.rows[0].selectedSide, 'left');
assert.equal(result.rows[0].solutions.right.feasible, false);
assert.deepEqual(readRobotJointValues(robot), original, 'calculation must not mutate the live robot');
assert.equal((await run({ allowSingleArm: false })).feasibleCount, 0);
assert.equal((await run({ armMode: 'right' })).feasibleCount, 0);
const lockNames = Object.keys(original);
assert.equal((await run({}, { lockedJointNames: lockNames })).feasibleCount, 0);
assert.equal((await run({ respectJointLocks: false }, { lockedJointNames: lockNames })).feasibleCount, 1);
assert.equal((await run({}, { task: { ...task, mobileCapture: { ...task.mobileCapture, samples: [capture({ x: 4, y: 0, z: 0 })] } } })).feasibleCount, 0);

const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, -0.3, 1.2, 'ZYX'));
const orientationTask = structuredClone(task); orientationTask.mobileCapture.samples = [capture({ x: 0.4, y: -0.25, z: 0.6 }, { x: q.x, y: q.y, z: q.z, w: q.w })];
const oriented = await run({ armMode: 'left', targetFrame: 'optical', rotationTolerance: { roll: 0.3, pitch: 0.5, yaw: 1 } }, { task: orientationTask });
assert.equal(oriented.feasibleCount, 1, JSON.stringify(oriented.rows));
const frame = new THREE.Object3D(), target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
frame.position.set(0.04, 0.04, 0.04); frame.updateMatrixWorld(true);
assert.equal(measureMobileTarget(frame, target, DEFAULT_MOBILE_SOLVE_OPTIONS).withinTolerance, true, 'per-axis box, not radial distance');
assert.equal(measureMobileTarget(frame, target, { ...DEFAULT_MOBILE_SOLVE_OPTIONS, positionTolerance: { x: 0.03, y: 0.05, z: 0.05 } }).withinTolerance, false);
frame.position.set(0, 0, 0); frame.rotation.z = THREE.MathUtils.degToRad(-179); frame.updateMatrixWorld(true);
target.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(179));
assert.ok(Math.abs(measureMobileTarget(frame, target, DEFAULT_MOBILE_SOLVE_OPTIONS).rotationError.yaw - 2) < 1e-8);
for (const value of ['', NaN, Infinity, -1, 0]) assert.throws(() => validateMobileSolveOptions({ positionTolerance: { x: value, y: 0.05, z: 0.05 } }));
assert.equal(DEFAULT_MOBILE_SOLVE_OPTIONS.positionTolerance.x, 0.05);
assert.equal(DEFAULT_MOBILE_SOLVE_OPTIONS.rotationTolerance.roll, 5);
assert.equal(DEFAULT_MOBILE_SOLVE_OPTIONS.allowTorsoHeight, true);
assert.throws(() => validateMobileSolveOptions({ allowTorsoHeight: true, lockChestVertical: false }), /前胸垂直/);

const transform = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(2, 3, 1);
const moved = mobileSampleTarget(task.mobileCapture.samples[0], { ...task, mobileTransform: transform.toArray() });
assert.ok(moved.position.distanceTo(new THREE.Vector3(1.8, 3.75, 1.4)) < 1e-9);
assert.ok(moved.quaternion.angleTo(new THREE.Quaternion().setFromRotationMatrix(transform)) < 1e-8);
const tilted = model(); tilted.getObjectByName('waist_yaw_L').rotation.x = 0.2;
assert.equal((await run({ armMode: 'left' }, { robot: tilted })).feasibleCount, 0, 'locked chest tilt must reject otherwise reachable arm');
assert.equal((await run({ armMode: 'left', lockChestVertical: false }, { robot: tilted })).feasibleCount, 1);
const controller = new AbortController();
await assert.rejects(() => run({}, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
assert.deepEqual(readRobotJointValues(robot), original);
const saved = buildMobileSolvedTask(task, result, { id: 'robot', name: 'Robot' }, 'solved');
const normalized = normalizeTeachingTasks([{ ...task, mobileSolve: result }, saved]);
assert.deepEqual(normalized[0].mobileCapture, task.mobileCapture);
assert.deepEqual(normalized[0].mobileSolve, result);
assert.equal(normalized[1].parkingPoints[0].poses.length, 1);
assert.equal(normalized[1].parkingPoints[0].poses[0].mobileSampleId, 'sample');
assert.deepEqual(normalized[1].parkingPoints[0].poses[0].fullBodyJoints.values, result.rows[0].solutions.left.jointValues);
const linked = mobileRobotPoseLinks(normalized[0], normalized).get('sample');
assert.equal(linked.pose.id, normalized[1].parkingPoints[0].poses[0].id);
assert.equal(linked.parkingPoint.id, normalized[1].parkingPoints[0].id);
assert.equal(mobileSampleStatus(null, null), '待计算');
assert.equal(mobileSampleStatus({ feasible: false }, null), '未通过');
assert.equal(mobileSampleStatus(result.rows[0], null), '可达 · 待保存');
assert.equal(mobileSampleStatus(result.rows[0], linked), '已保存 · 可精修');
const unrelated = structuredClone(normalized[1]); unrelated.mobileSolveSource.taskId = 'other-source';
assert.equal(mobileRobotPoseLinks(normalized[0], [unrelated]).size, 0, 'identical sample IDs from another source must not be linked');
const differentFrame = { ...normalized[1], coordinateFrame: 'map' };
assert.equal(mobileRobotPoseLinks(normalized[0], [differentFrame]).size, 0);
const deleted = structuredClone(normalized[1]); deleted.parkingPoints[0].poses = [];
assert.equal(mobileRobotPoseLinks(normalized[0], [deleted]).size, 0, 'deleted saved poses must fall back to the computation result');
const preferred = { ...normalized[1], id: 'preferred', createdAt: '2020-01-01' };
assert.equal(mobileRobotPoseLinks({ ...normalized[0], mobileSolve: { ...result, savedTaskId: preferred.id } },
  [normalized[1], preferred]).get('sample').task.id, preferred.id, 'prefer the saved task belonging to the current report');
const originalCapture = structuredClone(task.mobileCapture);
const preview = createMobilePosePreview({ ...task, mobileTransform: new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(2, 3, 1).toArray() }, task.mobileCapture.samples[0]);
assert.ok(preview.children[0].position.distanceTo(new THREE.Vector3(2.4, 3.2, 0.25)) < 1e-9);
assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(preview.children[1].quaternion).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9,
  'the preview arrow follows optical +Z, after the workspace transform');
const scene = new THREE.Scene(); scene.add(preview); disposeIPadCaptureLayer(preview);
assert.equal(scene.children.length, 0);
assert.deepEqual(task.mobileCapture, originalCapture, 'preview and linking leave the raw capture intact');
assert.equal(transformTeachingTasks(normalized, transform, 'map', { name: 'map' })[0].mobileSolve, null, 'coordinate transfer invalidates the old solve report');
const empty = structuredClone(task); empty.mobileCapture.samples[0].kind = 'trajectory';
await assert.rejects(() => run({}, { task: empty }), /没有可计算/);
assert.equal((await run({ keyframesOnly: false }, { task: empty })).rows.length, 1);

// The worker gets a compact snapshot with identical FK, including current
// joint offsets and optical-frame transforms, but no mesh or live scene data.
const snapshotRobot = model();
snapshotRobot.rotation.z = 0.1;
setRobotJointValue(snapshotRobot.getObjectByName('left_0'), 0.12);
setRobotJointValue(snapshotRobot.getObjectByName('left_3'), 0.4);
snapshotRobot.getObjectByName('tool_left').position.x = 0.02;
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
mesh.name = 'visual-only'; snapshotRobot.add(mesh);
const restored = restoreMobileTeachingRobot(structuredClone(serializeMobileTeachingRobot(snapshotRobot)));
assert.equal(restored.getObjectByName('visual-only'), undefined);
assert.deepEqual(readRobotJointValues(restored), readRobotJointValues(snapshotRobot));
for (const name of ['waist_yaw_L', 'tool_left', 'tool_right', 'zivid_left_optical_frame', 'zivid_right_optical_frame']) {
  snapshotRobot.updateMatrixWorld(true); restored.updateMatrixWorld(true);
  assert.deepEqual(restored.getObjectByName(name).matrixWorld.elements, snapshotRobot.getObjectByName(name).matrixWorld.elements);
}
const snapshotResult = await run({}, { robot: restored });
const originalResult = await run({}, { robot: snapshotRobot });
assert.deepEqual(snapshotResult.rows, originalResult.rows);
mesh.geometry.dispose(); mesh.material.dispose();

// Pause at an actual sample boundary: no later rows/progress may arrive until
// resumed, then every row (including unreachable targets) arrives exactly once.
const sequenceTask = structuredClone(task);
sequenceTask.mobileCapture.samples = [0.2, 4, 0.5].map((x, i) => ({ ...capture({ x, y: 0, z: 0.2 }), id: `sequence-${i}` }));
const gate = createMobileTeachingPauseGate(), emitted = [], progressEvents = [];
let firstSample;
const firstSampleReady = new Promise((resolve) => { firstSample = resolve; });
const calculation = run({ armMode: 'left' }, {
  task: sequenceTask, waitIfPaused: gate.waitIfPaused,
  onProgress: (progress) => progressEvents.push(progress),
  onSample: ({ row, index, mapPose }) => {
    assert.equal(index, emitted.length);
    assert.deepEqual(mapPose.position, zero.position);
    emitted.push(row);
    if (emitted.length === 1) { gate.pause(); firstSample(); }
  },
});
await firstSampleReady;
const frozenProgress = progressEvents.length;
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(emitted.length, 1);
assert.equal(progressEvents.length, frozenProgress);
gate.resume();
const progressive = await calculation;
assert.deepEqual(emitted, progressive.rows);
assert.deepEqual(emitted.map((row) => row.feasible), [true, false, true]);
assert.deepEqual(progressEvents.at(-1), { completed: 3, total: 3, name: 'Pose 001', feasibleCount: 2 });

// Distributed captures require different chassis poses. Saved/normalized poses
// must reproduce the FK at their own parking point, not at the run's origin.
const distributed = structuredClone(task);
distributed.mobileCapture.samples = [0.3, 4, 4.1, -3].map((x, i) => ({ ...capture({ x, y: 0, z: 0.4 }), id: `parking-${i}` }));
const multi = await run({ parkingMode: 'auto', armMode: 'left' }, { task: distributed });
assert.equal(multi.feasibleCount, 4);
assert.ok(multi.parkingCount > 1);
assert.deepEqual(multi.rows[1].mapPose, multi.rows[2].mapPose, 'nearby targets reuse a suitable parking pose');
const multiSaved = buildMobileSolvedTask(distributed, multi, {}, 'multi');
assert.equal(multiSaved.parkingPoints.length, multi.parkingCount);
assert.deepEqual(multiSaved.parkingPoints.flatMap((p) => p.poses.map((pose) => pose.mobileSampleId)), distributed.mobileCapture.samples.map((s) => s.id));
for (const row of multi.rows) {
  const mapPose = mobileSolutionMapPose(multi, row);
  const savedParking = multiSaved.parkingPoints.find((p) => p.poses.some((pose) => pose.mobileSampleId === row.sampleId));
  assert.deepEqual(savedParking.mapPose.position, mapPose.position);
  const fkRobot = model(), fkLayer = new THREE.Group(); fkLayer.add(fkRobot);
  fkLayer.position.set(...['x', 'y', 'z'].map((axis) => mapPose.position[axis]));
  fkLayer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(mapPose.rpy[axis])), 'XYZ');
  const { applyRobotJointValues } = await import('../src/lib/robotLoader.js');
  applyRobotJointValues(fkRobot, row.solutions.left.jointValues); fkLayer.updateMatrixWorld(true);
  assert.ok(measureMobileTarget(fkRobot.getObjectByName('tool_left'), mobileSampleTarget(distributed.mobileCapture.samples.find((s) => s.id === row.sampleId), distributed), multi.options).withinTolerance);
}
assert.deepEqual(normalizeMobileSolveReport(multi), multi);
const corruptedParking = structuredClone(multi); corruptedParking.rows[0].solutions.left.mapPose.position.x = NaN;
assert.equal(normalizeMobileSolveReport(corruptedParking), null);
const perPose = await run({ parkingMode: 'per-pose', armMode: 'left' }, { task: distributed });
assert.equal(perPose.feasibleCount, 4);
assert.equal(buildMobileSolvedTask(distributed, perPose, {}, 'per-pose').parkingPoints.length, 4);
assert.equal((await run({ parkingMode: 'fixed', armMode: 'left' }, { task: distributed })).feasibleCount, 1);
const legacy = structuredClone(result); legacy.version = 1; delete legacy.options.parkingMode; delete legacy.options.checkCollisions;
for (const row of legacy.rows) { delete row.mapPose; for (const solution of Object.values(row.solutions)) delete solution.mapPose; }
assert.equal(normalizeMobileSolveReport(legacy).options.parkingMode, 'fixed');
assert.equal(normalizeMobileSolveReport(legacy).options.checkCollisions, false);
assert.deepEqual(mobileSolutionMapPose(legacy, legacy.rows[0]), zero);
assert.equal(DEFAULT_MOBILE_SOLVE_OPTIONS.parkingMode, 'auto');
assert.equal(DEFAULT_MOBILE_SOLVE_OPTIONS.checkCollisions, true);
assert.throws(() => validateMobileSolveOptions({ parkingMode: 'unknown' }));
console.log('Mobile retargeting: tolerances, FK/IK, limits, locks, transforms, cancellation, persistence, worker snapshot and paused progressive results passed.');
