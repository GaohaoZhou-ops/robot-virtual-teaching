import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { solveMobileTeaching, mobileSampleTarget, measureMobileTarget, normalizeMobileSolveReport, buildMobileSolvedTask } from '../src/lib/mobileTeachingSolver.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';
import { mobileParkingCandidates } from '../src/lib/mobileTeachingParking.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const bodyNames = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'];
const robot = restoreMobileTeachingRobot(fixture.robot), original = readRobotJointValues(robot);
const tilted = { ...original, ankle_pitch_J: 30, knee_pitch_J: -70, waist_pitch_J: 15, waist_yaw_J: 22 };
applyRobotJointValues(robot, tilted);
const liveBefore = readRobotJointValues(robot);
const base = { position: { x: 0.4, y: -0.7, z: 0.1 }, rpy: { roll: 0, pitch: 0, yaw: 37 } };
const fk = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group(); layer.add(fk);
const place = (pose) => {
  layer.position.set(...['x', 'y', 'z'].map((a) => pose.position[a]));
  layer.rotation.set(...['roll', 'pitch', 'yaw'].map((a) => THREE.MathUtils.degToRad(pose.rpy[a])), 'XYZ');
  layer.updateMatrixWorld(true);
};
place(base);
const sampleFromJoints = (values, id) => {
  applyRobotJointValues(fk, values); layer.updateMatrixWorld(true);
  const frame = fk.getObjectByName('zivid_left_optical_frame');
  const p = frame.getWorldPosition(new THREE.Vector3()), q = frame.getWorldQuaternion(new THREE.Quaternion());
  return { id, name: id, kind: 'keyframe', cameraPose: {
    position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  } };
};
const task = { id: 'height', name: 'Height regression', coordinateFrame: 'virtual_origin', map: {}, mobileCapture: { id: 'height-capture', samples: [
  sampleFromJoints({ ...tilted, ankle_pitch_J: 65, knee_pitch_J: -130, waist_pitch_J: 65 }, 'crouched'),
  sampleFromJoints({ ...tilted, ankle_pitch_J: 0, knee_pitch_J: 0, waist_pitch_J: 0 }, 'standing'),
] } };
const options = { parkingMode: 'fixed', armMode: 'left', checkCollisions: false,
  positionTolerance: { x: 0.005, y: 0.005, z: 0.005 }, rotationTolerance: { roll: 1, pitch: 1, yaw: 1 } };
// With all joints locked, an initially tilted chest explains every failed row.
const fixed = await solveMobileTeaching({ robot, task, mapPose: base, lockedJointNames: Object.keys(tilted), options: { ...options, allowTorsoHeight: false } });
assert.equal(fixed.feasibleCount, 0);
assert.ok(fixed.rows.every((row) => /前胸未满足垂直约束/.test(row.reason)));
// Explicit height control overrides only the three pitch locks; both arms and
// torso yaw stay locked. These two FK targets force a substantial height change.
const report = await solveMobileTeaching({ robot, task, mapPose: base, lockedJointNames: Object.keys(tilted), options });
assert.equal(report.feasibleCount, 2, JSON.stringify(report.rows));
assert.deepEqual(report.heightJointNames, bodyNames);
assert.deepEqual(report.lockedJointNames, Object.keys(tilted).filter((name) => !bodyNames.includes(name)));
assert.deepEqual(readRobotJointValues(robot), liveBefore, 'the live tilted pose must not change during a solve');
for (const row of report.rows) {
  const solution = row.solutions.left;
  assert.deepEqual(solution.mapPose, base, 'height changes must come from joints, not a floating chassis');
  for (const name of report.lockedJointNames) assert.equal(solution.jointValues[name], tilted[name]);
  applyRobotJointValues(fk, solution.jointValues); place(solution.mapPose);
  assert.ok(measureMobileTarget(fk.getObjectByName('zivid_left_optical_frame'),
    mobileSampleTarget(task.mobileCapture.samples.find((s) => s.id === row.sampleId), task), report.options).withinTolerance);
  const chest = fk.getObjectByName('waist_yaw_L');
  const tilt = THREE.MathUtils.radToDeg(new THREE.Vector3(0, 0, 1).applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion())).angleTo(new THREE.Vector3(0, 0, 1)));
  assert.ok(tilt <= 0.25);
  assert.ok(Math.abs(solution.chestHeight - (chest.getWorldPosition(new THREE.Vector3()).z - base.position.z)) < 1e-8);
  fk.traverse((node) => {
    if (node.userData.jointType !== 'revolute') return;
    assert.ok(node.userData.jointValue >= node.userData.jointLimit.lower - 1e-9);
    assert.ok(node.userData.jointValue <= node.userData.jointLimit.upper + 1e-9);
  });
}
assert.ok(report.rows[1].solutions.left.chestHeight - report.rows[0].solutions.left.chestHeight > 0.35);
assert.deepEqual(normalizeMobileSolveReport(report), report);
const badTilt = structuredClone(report); badTilt.rows[0].solutions.left.chestTilt = 1;
assert.equal(normalizeMobileSolveReport(badTilt), null, 'a feasible result may never bypass the upright constraint');
const legacy = structuredClone(report); legacy.version = 2; delete legacy.options.allowTorsoHeight;
assert.equal(normalizeMobileSolveReport(legacy).options.allowTorsoHeight, false);
const saved = normalizeTeachingTasks([buildMobileSolvedTask(task, report, {}, 'saved-height')])[0];
assert.deepEqual(saved.parkingPoints[0].poses.map((pose) => pose.fullBodyJoints.values), report.rows.map((row) => row.solutions.left.jointValues));

// Upright is measured against world Z, including a pitched chassis.
const pitchedBase = { ...base, rpy: { ...base.rpy, pitch: 10, yaw: 0 } }; place(pitchedBase);
const pitchedTask = { ...task, mobileCapture: { ...task.mobileCapture, samples: [
  sampleFromJoints({ ...tilted, ankle_pitch_J: 30, knee_pitch_J: -80, waist_pitch_J: 40 }, 'pitched-base'),
] } };
const pitched = await solveMobileTeaching({ robot, task: pitchedTask, mapPose: pitchedBase, lockedJointNames: Object.keys(tilted), options });
assert.equal(pitched.feasibleCount, 1, JSON.stringify(pitched.rows));
assert.ok(pitched.rows[0].solutions.left.chestTilt <= 0.25);

// A parking turn is about world Z, not Euler.z in the tilted XYZ convention.
// All candidate headings must preserve a torso's ability to remain upright.
const pitchedParking = { position: { x: 20, y: 20, z: 0 }, rpy: { roll: 0, pitch: 5, yaw: 0 } };
const parkingTask = { ...task, mobileCapture: { id: 'pitched-parking', samples: [0, 7, 9].map((index) => ({
  id: `parking-${index}`, kind: 'keyframe', cameraPose: fixture.targets[index],
})) } };
for (const candidate of mobileParkingCandidates(mobileSampleTarget(parkingTask.mobileCapture.samples[0], parkingTask), pitchedParking, null, 'auto', { refineClearance: true })) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(candidate.rpy[axis])), 'XYZ',
  ));
  const pitchAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  assert.ok(Math.abs(pitchAxis.z) < 1e-10, 'parking must not introduce roll about the torso pitch axis');
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  assert.ok(Math.abs(up.angleTo(new THREE.Vector3(0, 0, 1)) - THREE.MathUtils.degToRad(5)) < 1e-10);
}
const turned = await solveMobileTeaching({ robot: restoreMobileTeachingRobot(fixture.robot), task: parkingTask,
  mapPose: pitchedParking, lockedJointNames: [...bodyNames, 'waist_yaw_J'], options: { checkCollisions: false } });
assert.equal(turned.feasibleCount, 3, turned.rows.map((row) => row.reason).join('\n'));
for (const row of turned.rows) {
  const solution = row.solutions[row.selectedSide];
  applyRobotJointValues(fk, solution.jointValues); place(solution.mapPose);
  assert.ok(measureMobileTarget(fk.getObjectByName(`zivid_${row.selectedSide}_optical_frame`),
    mobileSampleTarget(parkingTask.mobileCapture.samples.find((s) => s.id === row.sampleId), parkingTask), turned.options).withinTolerance);
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(fk.getObjectByName('waist_yaw_L').getWorldQuaternion(new THREE.Quaternion()))
    .angleTo(new THREE.Vector3(0, 0, 1)) <= THREE.MathUtils.degToRad(0.25));
}

// The 16 imported poses also start with a tilted, crouched torso and its default
// four locks. Keep real robot collision proxies, and check the solutions by FK.
const far = { positions: new Float32Array([100, 100, 100]), kind: 'points' };
const captureTask = { ...task, mobileCapture: { id: 'ipad-16', samples: fixture.targets.map((cameraPose, i) => ({ id: `sample-${i}`, kind: 'keyframe', cameraPose })) } };
const capture = await solveMobileTeaching({ robot, task: captureTask,
  mapPose: { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } },
  lockedJointNames: [...bodyNames, 'waist_yaw_J'], environment: far });
assert.equal(capture.feasibleCount, 16, capture.rows.filter((r) => !r.feasible).map((r) => r.reason).join('\n'));
const checker = await createMobileCollisionChecker(fk, far, undefined, capture.options);
for (const row of capture.rows) {
  for (const [side, solution] of Object.entries(row.solutions)) {
    if (!solution.feasible) continue;
    applyRobotJointValues(fk, solution.jointValues); place(solution.mapPose);
    assert.ok(measureMobileTarget(fk.getObjectByName(`zivid_${side}_optical_frame`),
      mobileSampleTarget(captureTask.mobileCapture.samples.find((s) => s.id === row.sampleId), captureTask), capture.options).withinTolerance);
    assert.ok(solution.chestTilt <= 0.25);
    assert.equal(solution.jointValues.waist_yaw_J, tilted.waist_yaw_J);
    assert.equal(checker.check().clear, true);
  }
}
console.log(`Height regression: locked/tilted failure reproduced; standing/crouching, world-up, locks, limits, persistence and 16/16 collision-screened imported poses passed (${capture.parkingCount} parking points).`);
