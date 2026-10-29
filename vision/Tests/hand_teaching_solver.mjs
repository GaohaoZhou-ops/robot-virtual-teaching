import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { restoreMobileTeachingRobot } from '../../src/features/teaching/mobile/model/mobileTeachingKinematics.js';
import { configureRobotArmSoftLimits, applyRobotJointValues, readRobotJointValues } from '../../src/features/robot/model/robotLoader.js';
import { configureRobotJointCoupling } from '../../src/features/robot/model/robotJointCoupling.js';
import { normalizeProject } from '../../src/features/workspace/model/io.js';
import { teachingTransferFixture } from '../../tests/teaching_transfer_helpers.mjs';
import { HandTeachingSolver } from '../web/handTeachingSolver.js';
import { appendHandTeachingPose } from '../web/handTeachingRecord.js';

const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const robot = restoreMobileTeachingRobot(fixture.robot);
configureRobotArmSoftLimits(robot, 0.95); configureRobotJointCoupling(robot, true);
const comfortable = [-20, -30, 15, 45, -12, 5, 8];
applyRobotJointValues(robot, Object.fromEntries(['left', 'right'].flatMap(side => comfortable.map((n, i) => [`${side}_J${i + 1}`, side === 'left' ? n : -n]))));
const base = new THREE.Matrix4().makeRotationZ(0.7).setPosition(3, -2, 1);
const solver = new HandTeachingSolver(robot, base.toArray());
const original = readRobotJointValues(robot);
const left = solver.pose('tool_left'), right = solver.pose('tool_right');
assert.ok(solver.jointNames.left.length && solver.jointNames.right.length);
assert.ok(solver.jointNames.left.every(name => !solver.jointNames.right.includes(name)));
assert.ok(Object.values(solver.jointNames).flat().every(name => !/(waist|ankle|knee|head)/i.test(name)));

// Reachable bimanual motion in a translated/rotated project frame.
const target = (pose, axis, delta, epoch = 1) => ({ ...pose, epoch, position: pose.position.map((v, i) => v + (i === axis ? delta : 0)) });
const result = solver.solve({ joints: original, targets: { left: target(left, 0, 0.001), right: target(right, 1, 0.001) }, deltaTime: 0.1 });
assert.equal(result.left.status, 'tracking'); assert.equal(result.right.status, 'tracking');
assert.ok(Object.keys(result.left.joints).every(name => solver.jointNames.left.includes(name)));
const moved = readRobotJointValues(robot);
for (const name of Object.keys(original)) {
  if (!Object.values(solver.jointNames).flat().includes(name)) assert.equal(moved[name], original[name], `${name} frozen`);
}

// Use forward kinematics to produce reachable position AND orientation goals
// well outside the acceptance tolerance; a no-op solver must fail this check.
const posed = { ...original };
for (const side of ['left', 'right']) {
  const sign = side === 'left' ? 1 : -1;
  posed[`${side}_J1`] += sign * 4;
  posed[`${side}_J4`] += sign * 3;
  posed[`${side}_J7`] += sign * 10;
}
solver.restore(posed);
const sixDofTargets = Object.fromEntries(['left', 'right'].map(side => [side, { ...solver.pose(`tool_${side}`), epoch: 2 }]));
const sixDof = solver.solve({ joints: original, targets: sixDofTargets, deltaTime: 0.1 });
for (const [side, initial] of [['left', left], ['right', right]]) {
  const goal = sixDofTargets[side], actual = sixDof[side].actual;
  const positionDistance = (a, b) => new THREE.Vector3().fromArray(a).distanceTo(new THREE.Vector3().fromArray(b));
  const rotationDistance = (a, b) => new THREE.Quaternion().fromArray(a).angleTo(new THREE.Quaternion().fromArray(b));
  assert.ok(positionDistance(goal.position, initial.position) > 0.01);
  assert.ok(rotationDistance(goal.quaternion, initial.quaternion) > THREE.MathUtils.degToRad(3));
  assert.equal(sixDof[side].status, 'tracking');
  assert.ok(positionDistance(actual.position, goal.position) <= 0.004);
  assert.ok(rotationDistance(actual.quaternion, goal.quaternion) <= THREE.MathUtils.degToRad(1.5));
}
for (const name of Object.keys(original)) {
  if (!Object.values(solver.jointNames).flat().includes(name)) assert.equal(readRobotJointValues(robot)[name], original[name], `${name} frozen during rotation`);
}

// The shared solver can leave a partial solution on failure. The Vision
// adapter must roll back the whole arm, while allowing the other to succeed.
const failed = solver.solve({ joints: original, targets: { left: target(left, 0, 10), right: target(right, 1, 0.001) }, deltaTime: 0.1 });
assert.equal(failed.left.status, 'unreachable'); assert.deepEqual(failed.left.joints, {});
assert.equal(failed.right.status, 'tracking');
for (const name of solver.jointNames.left) assert.equal(readRobotJointValues(robot)[name], original[name]);
const invalid = solver.solve({ joints: original, targets: { left: { position: [NaN, 0, 0], quaternion: [0, 0, 0, 1], epoch: 4 } } });
assert.equal(invalid.left.status, 'unreachable'); assert.deepEqual(readRobotJointValues(robot), original);
assert.throws(() => solver.solve({ joints: { left_J1: 0 }, targets: {} }), /不完整/);

// Discarding a native reply must not make its JS candidate the next baseline.
solver.solve({ joints: original, targets: { left: target(left, 0, 0.001) }, deltaTime: 0.1 });
solver.solve({ joints: original, targets: {} });
assert.deepEqual(readRobotJointValues(robot), original);

const source = teachingTransferFixture().config.config.project;
source.unknownFutureSetting = { keep: true };
const before = structuredClone(source), basePose = source.robot.origin;
const captured = appendHandTeachingPose(source, { joints: original, basePose, opticalTargets: {}, name: '双臂检查' });
assert.deepEqual(source, before, 'recording must not mutate the current document');
assert.deepEqual(captured.project.unknownFutureSetting, { keep: true });
assert.deepEqual(captured.project.virtualTeaching.tasks.slice(0, -1), source.virtualTeaching.tasks);
assert.deepEqual(captured.project.robot.joints, original);
const normalized = normalizeProject(captured.project);
const pose = normalized.teachingTasks.at(-1).parkingPoints[0].poses[0];
assert.equal(pose.name, '双臂检查'); assert.deepEqual(pose.fullBodyJoints.values, original);
const appended = appendHandTeachingPose(captured.project, { joints: moved, basePose, opticalTargets: {}, taskId: captured.taskId, parkingId: captured.parkingId });
assert.equal(appended.project.virtualTeaching.tasks.at(-1).parkingPoints[0].poses.length, 2);
assert.throws(() => appendHandTeachingPose(captured.project, { joints: original,
  basePose: { ...basePose, position: { ...basePose.position, x: basePose.position.x + 1 } }, opticalTargets: {},
  taskId: captured.taskId, parkingId: captured.parkingId }), /基座不在/);
console.log('Vision hand teaching: dual-arm IK, frozen body, unreachable rollback, stale candidate reset and project record roundtrip passed.');
