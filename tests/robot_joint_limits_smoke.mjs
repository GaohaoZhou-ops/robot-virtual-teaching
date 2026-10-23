import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { getRobotJointLimits } from '../src/lib/robotJointLimits.js';
import { applyRobotJointValues, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
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
console.log('PASS: central 95%, asymmetric ranges, all 14 BOTX joints, numeric clamping, non-arm limits, worker snapshots and old references');
