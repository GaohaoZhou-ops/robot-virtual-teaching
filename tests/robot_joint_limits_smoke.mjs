import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { getRobotJointLimits, normalizeArmSoftLimitRatio } from '../src/lib/robotJointLimits.js';
import { applyRobotJointValues, configureRobotArmSoftLimits, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { buildExport, normalizeProject } from '../src/lib/io.js';
import { jointPresetErrors } from '../src/lib/robotJointPresets.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { applyMobileReferencePose } from '../src/lib/mobileTeachingReference.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const makeJoint = (name, lower, upper, jointType = 'revolute') => {
  const joint = new THREE.Object3D();
  joint.name = name;
  joint.userData = { jointType, jointLimit: { lower, upper }, jointAxis: [0, 0, 1],
    restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1], jointValue: 0 };
  return joint;
};

for (const [name, hard, soft] of [
  ['left_J1', [-180, 180], [-171, 171]],
  ['right_J2', [-8, 176], [-3.4, 171.4]],
  ['left_J2', [-176, 8], [-171.4, 3.4]],
  ['left_J3', [20, 100], [22, 98]],
]) {
  const joint = makeJoint(name, ...hard.map(THREE.MathUtils.degToRad));
  const originalLimits = structuredClone(joint.userData.jointLimit);
  const limit = getRobotJointLimits(joint);
  close(THREE.MathUtils.radToDeg(limit.lower), soft[0]);
  close(THREE.MathUtils.radToDeg(limit.upper), soft[1]);
  assert.equal(limit.softLimited, true);
  for (let repeat = 0; repeat < 3; repeat += 1) {
    close(setRobotJointValue(joint, -100), limit.lower);
    close(setRobotJointValue(joint, 100), limit.upper);
    close(setRobotJointValue(joint, (limit.lower + limit.upper) / 2), (limit.lower + limit.upper) / 2);
  }
  assert.deepEqual(joint.userData.jointLimit, originalLimits, 'never shrink stored hard limits');
}

// Non-arm joints, linear travel and ranges without two distinct finite ends
// must keep their existing motion bounds, even when a serialized end is null.
for (const joint of [
  makeJoint('waist_yaw_J', -1, 1), makeJoint('head_pitch_J', -1, 1),
  makeJoint('wheel_LF_J', -Infinity, Infinity, 'continuous'),
  makeJoint('left_J1', 0, 1, 'prismatic'), makeJoint('left_J1', null, null, 'continuous'),
  makeJoint('left_J1', -Infinity, 1), makeJoint('right_J2', null, 1), makeJoint('right_J3', 2, 2),
]) {
  const limit = getRobotJointLimits(joint);
  assert.equal(limit.softLimited, false);
  assert.equal(limit.lower, limit.hardLower);
  assert.equal(limit.upper, limit.hardUpper);
  close(setRobotJointValue(joint, 20), Math.min(limit.upper, Math.max(limit.lower, 20)));
}

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const robot = restoreMobileTeachingRobot(fixture.robot);
const expected = {
  right_J1: [-167.2, 167.2], right_J2: [-3.4, 171.4], right_J3: [-167.2, 167.2],
  right_J4: [-132.1, 92.1], right_J5: [-165.3, 165.3], right_J6: [-47.5, 47.5], right_J7: [-83.6, 83.6],
  left_J1: [-167.2, 167.2], left_J2: [-171.4, 3.4], left_J3: [-167.2, 167.2],
  left_J4: [-92.1, 132.1], left_J5: [-165.3, 165.3], left_J6: [-47.5, 47.5], left_J7: [-83.6, 83.6],
};
const before = structuredClone(fixture.robot);
for (const [name, [lower, upper]] of Object.entries(expected)) {
  const limit = getRobotJointLimits(robot.getObjectByName(name));
  close(THREE.MathUtils.radToDeg(limit.lower), lower, 1e-4);
  close(THREE.MathUtils.radToDeg(limit.upper), upper, 1e-4);
}
for (const sign of [-1, 1]) {
  const values = Object.fromEntries(Object.keys(expected).map((name) => [name, sign * 999]));
  const applied = applyRobotJointValues(robot, { ...values, wheel_LF_J: 720, head_pitch_J: 30 });
  for (const [name, range] of Object.entries(expected)) close(applied[name], range[sign === -1 ? 0 : 1], 1e-4);
  close(applied.wheel_LF_J, 720);
  close(applied.head_pitch_J, 30, 1e-4);
  const restored = restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot));
  assert.deepEqual(readRobotJointValues(restored), applied);
  assert.deepEqual(applyRobotJointValues(restored, values), applied, 'worker round trips cannot shrink the range again');
}
assert.deepEqual(fixture.robot, before, 'source snapshots and saved poses remain unchanged');
assert.throws(() => applyMobileReferencePose(robot, {
  type: 'preset', id: 'old', name: 'Old pose', robotId: 'botx',
  joints: { angularUnit: 'degree', linearUnit: 'meter', values: { right_J2: 175 } },
}, new Set()), /超出关节限位/);
// Changing the ratio updates both live values and UI definitions from the
// original hard bounds. Worker copies retain the ratio at dispatch time.
for (const invalid of [undefined, null, '', '0.8', true, NaN, Infinity]) {
  assert.equal(normalizeArmSoftLimitRatio(invalid), 0.95);
}
assert.equal(normalizeArmSoftLimitRatio(-1), 0.01);
assert.equal(normalizeArmSoftLimitRatio(2), 1);
let workerCopy;
const nonArmBefore = getRobotJointLimits(robot.getObjectByName('head_pitch_J'));
for (const ratio of [0.8, 0.5, 1, 0.01, 0.95, 0.8]) {
  const definitions = configureRobotArmSoftLimits(robot, ratio);
  for (const name of Object.keys(expected)) {
    const joint = robot.getObjectByName(name);
    const { lower, upper } = joint.userData.jointLimit;
    const margin = (upper - lower) * (1 - ratio) / 2;
    const limit = getRobotJointLimits(joint);
    close(limit.lower, lower + margin);
    close(limit.upper, upper - margin);
    assert.ok(joint.userData.jointValue >= limit.lower - 1e-9 && joint.userData.jointValue <= limit.upper + 1e-9);
    const definition = definitions.find((item) => item.name === name);
    close(definition.lower, THREE.MathUtils.radToDeg(limit.lower));
    close(definition.upper, THREE.MathUtils.radToDeg(limit.upper));
    assert.equal(definition.softLimitRatio, ratio);
    close(setRobotJointValue(joint, 99), limit.upper);
    close(setRobotJointValue(joint, -99), limit.lower);
  }
  assert.deepEqual(getRobotJointLimits(robot.getObjectByName('head_pitch_J')), nonArmBefore);
  if (!workerCopy) workerCopy = restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot));
  assert.equal(getRobotJointLimits(workerCopy.getObjectByName('right_J2')).softLimitRatio, 0.8);
  const right = definitions.find((joint) => joint.name === 'right_J2');
  assert.match(jointPresetErrors([right], { right_J2: 999 }).right_J2, new RegExp(`${ratio * 100}%`));
}
const restoredCustom = restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot));
close(applyRobotJointValues(restoredCustom, { right_J2: 999 }).right_J2, 157.6, 1e-4);
assert.throws(() => applyMobileReferencePose(restoredCustom, {
  type: 'preset', id: 'outside-custom', name: 'Outside 80%', robotId: 'botx',
  joints: { angularUnit: 'degree', linearUnit: 'meter', values: { right_J2: 170 } },
}, new Set()), /超出关节限位/);

for (const ratio of [undefined, 0.8, 1, 0.01]) {
  const exported = buildExport({ mapData: { name: 'limits.ply' }, heightRange: [0, 1], waypoints: [], edges: [],
    robot: { id: 'botx.urdf', relativePath: 'botx.urdf' }, robotArmSoftLimitRatio: ratio });
  const restored = normalizeProject(JSON.parse(JSON.stringify(exported)));
  assert.equal(restored.robot.armSoftLimitRatio, ratio ?? 0.95);
}
assert.equal(normalizeProject({ robot: { relativePath: 'legacy.urdf' } }).robot.armSoftLimitRatio, 0.95);
console.log('PASS: default/custom ratios, all 14 BOTX joints, live clamping, hard-limit preservation, worker isolation, references, dynamic validation and project round trips');
