import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { createRobotTorsoController, readRobotTorsoPose, solveRobotTorsoPose } from '../src/lib/robotTorsoControl.js';

// A URDF-shaped four-joint chain with the robot's real link lengths and limits.
const robot = new THREE.Group();
const base = new THREE.Group();
base.name = 'base_link';
robot.add(base);
let parent = base;
for (const [name, position, rotation, lower, upper] of [
  ['ankle_pitch', [-0.09, 0, 0.2006], -Math.PI / 2, 0, 86],
  ['knee_pitch', [0, -0.387, 0], 0, -145, 0],
  ['waist_pitch', [0, -0.33, 0], 0, 0, 117],
  ['waist_yaw', [0, -0.183, 0], Math.PI / 2, -175, 175],
]) {
  const joint = new THREE.Group();
  joint.name = `${name}_J`;
  joint.position.fromArray(position);
  joint.rotation.x = rotation;
  joint.userData = {
    jointType: 'revolute', jointValue: 0, jointAxis: [0, 0, 1],
    restPosition: position, restQuaternion: joint.quaternion.toArray(),
    jointLimit: { lower: THREE.MathUtils.degToRad(lower), upper: THREE.MathUtils.degToRad(upper) },
  };
  const link = new THREE.Group();
  link.name = `${name}_L`;
  joint.add(link);
  parent.add(joint);
  parent = link;
}
const controller = createRobotTorsoController(robot, new THREE.Vector3(0, 0, 0.18));
assert.ok(controller);
const original = readRobotTorsoPose(controller);
const originalBase = base.matrix.toArray();
const lower = solveRobotTorsoPose(controller, { ...original, height: original.height - 0.15 }, original.forward);
assert.equal(lower.status, 'tracking');
assert.ok(Math.abs(lower.pose.height - (original.height - 0.15)) < 0.001, JSON.stringify(lower));
assert.ok(Math.abs(lower.pose.pitch) < 0.1);
const bent = readRobotJointValues(robot);
assert.ok(bent.ankle_pitch_J > 10 && bent.knee_pitch_J < -20 && bent.waist_pitch_J > 10, JSON.stringify(bent));
assert.deepEqual(base.matrix.toArray(), originalBase);

for (const [yaw, pitch] of [[30, 15], [-40, -12], [0, 0]]) {
  const result = solveRobotTorsoPose(controller, { height: lower.pose.height, yaw, pitch }, original.forward);
  assert.ok(Math.abs(result.pose.yaw - yaw) < 0.01, JSON.stringify(result));
  assert.ok(Math.abs(result.pose.pitch - pitch) < 0.5, JSON.stringify(result));
  assert.ok(Math.abs(result.pose.height - lower.pose.height) < 0.005, JSON.stringify(result));
}

// A rotated and translated chassis uses the same relative height and body angles.
robot.position.set(2, -3, 1);
robot.rotation.set(0.1, -0.15, 0.7, 'ZYX');
const transformed = solveRobotTorsoPose(controller, { height: lower.pose.height, yaw: 25, pitch: 10 }, original.forward);
assert.ok(Math.abs(transformed.pose.height - lower.pose.height) < 0.005);
assert.ok(Math.abs(transformed.pose.pitch - 10) < 0.5);
assert.ok(Math.abs(transformed.pose.yaw - 25) < 0.01);
assert.deepEqual(robot.position.toArray(), [2, -3, 1]);

// Requested values beyond the mechanism's reach must remain finite and limited.
const limited = solveRobotTorsoPose(controller, { height: 100, yaw: 900, pitch: 400 }, original.forward);
assert.equal(limited.status, 'limited');
for (const joint of controller.joints) {
  const { jointValue, jointLimit } = joint.userData;
  assert.ok(Number.isFinite(jointValue));
  assert.ok(jointValue >= jointLimit.lower && jointValue <= jointLimit.upper);
}
for (const joint of controller.joints) setRobotJointValue(joint, 0);
const uprightTilt = solveRobotTorsoPose(controller, { ...original, pitch: -10 }, original.forward);
assert.ok(uprightTilt.pose.pitch < -5, JSON.stringify(uprightTilt));
assert.equal(createRobotTorsoController(new THREE.Group()), null);
console.log('Torso IK: linked height, yaw/pitch, singularity recovery, chassis frame and joint limits passed');
