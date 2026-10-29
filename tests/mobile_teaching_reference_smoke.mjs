import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solveMobileTeaching, normalizeMobileSolveReport, validateMobileSolveOptions } from "../src/features/teaching/mobile/model/mobileTeachingSolver.js";
import { mobileReferenceFromPreset } from "../src/features/teaching/mobile/model/mobileTeachingReference.js";
import { readRobotJointValues } from "../src/features/robot/model/robotLoader.js";

// Two collinear sliders have infinitely many solutions for the same camera
// target. Their sum is independently known, so the chosen branch must come
// from the reference instead of a change to the target or tolerance.
const robot = new THREE.Group();
function joint(parent, name, type, axis) {
  const node = new THREE.Group(); node.name = name;
  node.userData = { jointType: type, jointAxis: axis, jointValue: 0,
    restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1],
    jointLimit: { lower: type === 'prismatic' ? -1 : -Math.PI, upper: type === 'prismatic' ? 1 : Math.PI } };
  parent.add(node); return node;
}
const slider = joint(robot, 'left_slider_a', 'prismatic', [1, 0, 0]);
const end = joint(slider, 'left_slider_b', 'prismatic', [1, 0, 0]);
const tool = new THREE.Group(); tool.name = 'tool_left'; end.add(tool);
joint(robot, 'head_yaw_J', 'revolute', [0, 0, 1]);
joint(robot, 'right_J1', 'revolute', [0, 1, 0]);
const descriptor = { id: 'test-robot', name: 'Reference test robot' };
const task = { id: 'source', coordinateFrame: 'virtual_origin', mobileCapture: { id: 'capture', samples: [
  { id: 'one', name: 'Same target', kind: 'keyframe', cameraPose: {
    position: { x: 0.5, y: 0, z: 0.25 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
  } },
] } };
const preset = { id: 'preset-a', name: '准备姿态 A', robot: descriptor,
  joints: { source: 'robot-preset', angularUnit: 'degree', linearUnit: 'meter',
    values: { left_slider_a: 0.6, left_slider_b: -0.1, head_yaw_J: 30, right_J1: -35 } } };
const reference = mobileReferenceFromPreset(preset, descriptor);
const consoleReference = mobileReferenceFromPreset({ ...preset, joints: { ...preset.joints, source: 'joint-console' } }, descriptor);
assert.deepEqual(consoleReference, reference, 'console records are reusable reference postures');
const original = structuredClone({ task, preset, values: readRobotJointValues(robot) });
const run = (options = {}, extra = {}) => solveMobileTeaching({ robot, task,
  mapPose: { position: { x: 0, y: 0, z: 0.25 }, rpy: { roll: 0, pitch: 0, yaw: 0 } },
  options: { targetFrame: 'tool', parkingMode: 'fixed', checkCollisions: false, armMode: 'left',
    allowTorsoHeight: false, lockChestVertical: false,
    positionTolerance: { x: 0.001, y: 0.001, z: 0.001 }, ...options }, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const current = await run();
assert.equal(current.feasibleCount, 1);
assert.deepEqual(current.options.referencePose, { type: 'current' });
assert.deepEqual(current.initialJointValues, original.values);
assert.ok(Math.abs(current.rows[0].solutions.left.jointValues.left_slider_a - 0.25) < 0.001);

const chosen = await run({ referencePose: reference });
assert.equal(chosen.feasibleCount, 1);
for (const [name, value] of Object.entries(preset.joints.values)) {
  near(chosen.initialJointValues[name], value);
  near(chosen.rows[0].solutions.left.jointValues[name], value);
}
const other = structuredClone(preset);
other.id = 'preset-b'; other.name = '准备姿态 B';
other.joints.values.left_slider_a = -0.1; other.joints.values.left_slider_b = 0.6;
const alternate = await run({ referencePose: mobileReferenceFromPreset(other, descriptor) });
assert.equal(alternate.feasibleCount, 1);
near(alternate.rows[0].solutions.left.jointValues.left_slider_a, -0.1);
near(alternate.rows[0].solutions.left.jointValues.left_slider_b, 0.6);
assert.deepEqual(alternate.rows[0].target, chosen.rows[0].target);
assert.deepEqual(chosen.mapPose, current.mapPose, 'a reference never replaces the chassis pose');

const locked = await run({ referencePose: reference }, { lockedJointNames: ['left_slider_a', 'head_yaw_J'] });
assert.equal(locked.feasibleCount, 1);
assert.equal(locked.initialJointValues.left_slider_a, 0);
assert.equal(locked.rows[0].solutions.left.jointValues.left_slider_a, 0);
assert.equal(locked.rows[0].solutions.left.jointValues.head_yaw_J, 0);
const unlocked = await run({ referencePose: reference, respectJointLocks: false }, { lockedJointNames: ['left_slider_a', 'head_yaw_J'] });
near(unlocked.initialJointValues.head_yaw_J, 30);
near(unlocked.initialJointValues.left_slider_a, 0.6);
const radians = structuredClone(preset); radians.joints.angularUnit = 'rad';
radians.joints.values.head_yaw_J = Math.PI / 6; radians.joints.values.right_J1 = -35 * Math.PI / 180;
const radReport = await run({ referencePose: mobileReferenceFromPreset(radians, descriptor) });
near(radReport.initialJointValues.head_yaw_J, 30);
near(radReport.initialJointValues.left_slider_a, 0.6);

// Freeze the source metadata and exact values in reports, independently of
// subsequent library changes; reject incompatible or invalid references.
const serialized = JSON.parse(JSON.stringify(chosen));
assert.deepEqual(normalizeMobileSolveReport(serialized), serialized);
const old = structuredClone(current); old.version = 6; delete old.options.referencePose;
assert.deepEqual(normalizeMobileSolveReport(old).options.referencePose, { type: 'current' });
assert.throws(() => mobileReferenceFromPreset(preset, { id: 'another-robot' }), /当前机器人/);
assert.throws(() => mobileReferenceFromPreset(undefined, descriptor), /不存在/);
for (const invalid of [null, { type: 'missing' }, { ...reference, joints: { ...reference.joints, angularUnit: 'unknown' } },
  { ...reference, joints: { ...reference.joints, values: { left_slider_a: NaN } } }]) {
  assert.throws(() => validateMobileSolveOptions({ referencePose: invalid }), /参考/);
}
for (const [values, reason] of [[{ missing_joint: 1 }, /不兼容/], [{ left_slider_a: 2 }, /限位/]]) {
  await assert.rejects(run({ referencePose: { ...reference, joints: { ...reference.joints, values } } }), reason);
}
assert.deepEqual({ task, preset, values: readRobotJointValues(robot) }, original, 'reference solving leaves live joints and source data untouched');
reference.joints.values.left_slider_a = -0.9;
near(chosen.options.referencePose.joints.values.left_slider_a, 0.6);
console.log('Reference postures: distinct IK branches, full-body seeds, live pose, locks, units, immutable reports and legacy compatibility passed.');
