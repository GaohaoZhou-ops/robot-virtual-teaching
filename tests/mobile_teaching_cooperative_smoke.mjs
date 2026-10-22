import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { solveMobileTeaching, mobileParkingArmUsage, measureMobileTarget, mobileSampleTarget,
  normalizeMobileSolveReport, validateMobileSolveOptions, buildMobileSolvedTask } from '../src/lib/mobileTeachingSolver.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';
import { mobileCooperativeParkingCandidates } from '../src/lib/mobileTeachingParking.js';

const joint = (parent, name, axis, range, linear = true) => {
  const node = new THREE.Group(); node.name = name;
  node.userData = { jointType: linear ? 'prismatic' : 'revolute', jointValue: 0, jointAxis: axis,
    jointLimit: { lower: -range, upper: range }, restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1] };
  parent.add(node); return node;
};
function model({ lift = false, rightHeight = 0, rightEnabled = true } = {}) {
  const robot = new THREE.Group(), chest = new THREE.Group();
  chest.name = 'waist_yaw_L'; chest.position.z = 0.8;
  (lift ? joint(robot, 'shared_lift', [0, 0, 1], 1) : robot).add(chest);
  for (const side of rightEnabled ? ['left', 'right'] : ['left']) {
    const shoulder = new THREE.Group(); shoulder.position.set(0, side === 'left' ? 0.6 : -0.6, side === 'right' ? rightHeight : 0);
    chest.add(shoulder); let parent = shoulder;
    for (const [i, axis] of [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]], [3, [0, 0, 1]], [4, [0, 1, 0]], [5, [1, 0, 0]]]) {
      parent = joint(parent, `${side}_${i}`, axis, i === 1 ? (lift ? 0.1 : 0.7) : i < 3 ? 0.2 : Math.PI, i < 3);
    }
    const tool = new THREE.Group(); tool.name = `tool_${side}`; parent.add(tool);
    const camera = new THREE.Group(); camera.name = `zivid_${side}_optical_frame`; tool.add(camera);
  }
  return robot;
}
const sample = (id, x, y = 0.6, z = 0.8) => ({ id, name: id, kind: 'keyframe', cameraPose: {
  position: { x, y, z }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
} });
const task = { id: 'cooperation', name: 'Cooperation', coordinateFrame: 'virtual_origin', map: {},
  mobileCapture: { id: 'capture', samples: [sample('first', 0.1), sample('second', 0.2)] } };
const robot = model(), before = structuredClone(task), original = readRobotJointValues(robot);
const options = { armMode: 'cooperative', checkCollisions: false, allowTorsoHeight: false,
  positionTolerance: { x: 0.002, y: 0.002, z: 0.002 }, rotationTolerance: { roll: 0.5, pitch: 0.5, yaw: 0.5 } };
const run = (changes = {}, extra = {}) => solveMobileTeaching({ robot, task, mapPose: {}, options: { ...options, ...changes }, ...extra });
function verify(report, source = task, sourceRobot = robot) {
  const fk = restoreMobileTeachingRobot(serializeMobileTeachingRobot(sourceRobot)), layer = new THREE.Group(); layer.add(fk);
  for (const row of report.rows.filter((row) => row.feasible)) {
    const solution = row.solutions[row.selectedSide];
    layer.position.set(...['x', 'y', 'z'].map((axis) => row.mapPose.position[axis]));
    layer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(row.mapPose.rpy[axis])), 'XYZ');
    applyRobotJointValues(fk, solution.jointValues); layer.updateMatrixWorld(true);
    assert.ok(measureMobileTarget(fk.getObjectByName(`zivid_${row.selectedSide}_optical_frame`),
      mobileSampleTarget(source.mobileCapture.samples.find((entry) => entry.id === row.sampleId), source), report.options).withinTolerance);
    fk.traverse((node) => {
      if (!node.userData.jointLimit) return;
      assert.ok(node.userData.jointValue >= node.userData.jointLimit.lower - 1e-9);
      assert.ok(node.userData.jointValue <= node.userData.jointLimit.upper + 1e-9);
    });
  }
  assert.equal(new Set(report.rows.map((row) => row.sampleId)).size, source.mobileCapture.samples.length);
  assert.deepEqual(normalizeMobileSolveReport(JSON.parse(JSON.stringify(report))), JSON.parse(JSON.stringify(report)));
}

// Both goals are cheapest for the left reference camera. Cooperation must
// actually relocate the chassis and assign the right arm, not just change UI.
const ordinary = await run({ armMode: 'both' });
assert.equal(ordinary.feasibleCount, 2);
assert.ok(mobileParkingArmUsage(ordinary).every((parking) => parking.sides.length === 1));
const emitted = [], report = await run({}, { onSample: ({ row }) => emitted.push(structuredClone(row)) });
assert.equal(report.feasibleCount, 2);
assert.equal(report.parkingCount, 1);
assert.equal(report.dualMotionCount, 1, JSON.stringify(report.rows.map((row) => ({ side: row.selectedSide, base: row.mapPose,
  solutions: Object.fromEntries(Object.entries(row.solutions).map(([side, solution]) => [side, { feasible: solution.feasible, reason: solution.reason }])) }))));
assert.equal(report.motionCount, 1);
assert.deepEqual(new Set(report.rows.map((row) => row.selectedSide)), new Set(['left', 'right']));
assert.equal(mobileParkingArmUsage(report)[0].sides.length, 2);
assert.deepEqual(report.rows, emitted, 'published rows remain final');
assert.notDeepEqual(report.rows[0].mapPose, ordinary.rows[0].mapPose);
verify(report);
const saved = normalizeTeachingTasks([buildMobileSolvedTask(task, report, {}, 'cooperative-solved')])[0];
assert.equal(saved.parkingPoints.length, 1);
assert.equal(saved.parkingPoints[0].poses.length, 1);
assert.deepEqual(new Set(saved.parkingPoints[0].poses[0].mobileSampleIds), new Set(['first', 'second']));

// A high or absent right camera cannot be made reachable by moving the base
// in XY. Its failure must never discard valid left-arm goals.
for (const singleRobot of [model({ rightHeight: 2 }), model({ rightEnabled: false })]) {
  const fallback = await run({ allowSingleArm: false }, { robot: singleRobot });
  assert.equal(fallback.options.allowSingleArm, true);
  assert.equal(fallback.feasibleCount, 2);
  assert.ok(fallback.rows.every((row) => row.selectedSide === 'left'));
  assert.ok(mobileParkingArmUsage(fallback).every((parking) => parking.sides.length === 1));
  verify(fallback, task, singleRobot);
}
const one = { ...task, mobileCapture: { ...task.mobileCapture, samples: task.mobileCapture.samples.slice(0, 1) } };
const onlyTarget = await run({}, { task: one });
assert.equal(onlyTarget.feasibleCount, 1); assert.equal(onlyTarget.dualMotionCount, 0);
assert.equal(mobileParkingArmUsage(onlyTarget)[0].sides.length, 1, 'do not duplicate a target to claim two-arm cooperation');

// Two different torso heights are feasible in sequence, not simultaneously.
// A shared parking point still counts as cooperative with two valid motions.
const lifted = model({ lift: true }), heights = { ...task, mobileCapture: { ...task.mobileCapture,
  samples: [sample('high-left', 0.1, 0.6, 1.6), sample('low-right', 0.1, -0.6, 0.1)] } };
const serial = await run({ parkingMode: 'fixed' }, { robot: lifted, task: heights });
assert.equal(serial.feasibleCount, 2); assert.equal(serial.parkingCount, 1);
assert.equal(serial.dualMotionCount, 0); assert.equal(serial.motionCount, 2);
assert.equal(mobileParkingArmUsage(serial)[0].sides.length, 2);
verify(serial, heights, lifted);
const separate = await run({ parkingMode: 'per-pose' });
assert.equal(separate.feasibleCount, 2); assert.equal(separate.parkingCount, 2); assert.equal(separate.dualMotionCount, 0);
const legacy = structuredClone(ordinary); legacy.version = 9;
assert.equal(normalizeMobileSolveReport(legacy).options.armMode, 'both', 'older reports retain their original participation mode');
assert.equal(validateMobileSolveOptions({ armMode: 'cooperative' }).armMode, 'cooperative');
assert.throws(() => validateMobileSolveOptions({ armMode: 'unknown' }), /机械臂配置/);
// The shared placement search must keep inherited tilt about the same world
// axis, just like ordinary parking turns, and never invent a support height.
const tilted = { position: { x: 0, y: 0, z: 0.02 }, rpy: { roll: 0, pitch: 5, yaw: 0 } };
const referenceFrames = ['left', 'right'].map((side) => ({ side,
  position: new THREE.Vector3(0, side === 'left' ? 0.6 : -0.6, 0.8), quaternion: new THREE.Quaternion() }));
const targets = [0, 120].map((yaw) => ({ position: new THREE.Vector3(1, 2, 0.8),
  quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(yaw)) }));
for (const pose of mobileCooperativeParkingCandidates(...targets, tilted, { baseSupport: 'current', referenceFrames })) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(pose.rpy[axis])), 'XYZ'));
  assert.equal(pose.position.z, 0.02);
  assert.ok(Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(q).z) < 1e-10);
  assert.ok(Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(q).angleTo(new THREE.Vector3(0, 0, 1)) - THREE.MathUtils.degToRad(5)) < 1e-10);
}
assert.deepEqual(task, before); assert.deepEqual(readRobotJointValues(robot), original);
console.log('Cooperation: shared parking beats single-arm reference fit; simultaneous/serial motions, unreachable/missing-arm fallback, per-pose isolation, FK, limits, persistence and v9 compatibility passed.');
