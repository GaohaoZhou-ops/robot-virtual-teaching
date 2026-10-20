import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { createMobileCollisionChecker, obbSeparationLowerBound } from '../src/lib/mobileTeachingCollision.js';
import { solveMobileTeaching, normalizeMobileSolveReport, validateMobileSolveOptions } from '../src/lib/mobileTeachingSolver.js';
import { readRobotJointValues, applyRobotJointValues } from '../src/lib/robotLoader.js';
import { mobileParkingKey } from '../src/lib/mobileTeachingParking.js';
import { restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const a = new OBB(new THREE.Vector3(), new THREE.Vector3(0.5, 0.5, 0.5));
const b = a.clone(); b.center.x = 1.04;
near(obbSeparationLowerBound(a, b), 0.04);
b.center.set(1.5, 1.5, 0);
near(obbSeparationLowerBound(a, b), 0.5);
assert.ok(obbSeparationLowerBound(a, b) < Math.hypot(0.5, 0.5), 'corner gap is a lower bound, not exact mesh distance');
b.center.set(2, 0, 0); b.rotation.setFromMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 4));
const gap = 1.5 - Math.SQRT1_2;
near(obbSeparationLowerBound(a, b), gap);
const transform = new THREE.Matrix4().compose(new THREE.Vector3(5, -3, 2),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -0.2, 1.3)), new THREE.Vector3(2, 2, 2));
const moved = (box) => new OBB(box.center.clone().applyMatrix4(transform), box.halfSize.clone().multiplyScalar(2),
  new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().extractRotation(transform)).multiply(box.rotation));
near(obbSeparationLowerBound(moved(a), moved(b)), gap * 2);
b.center.set(0, 0, 0); near(obbSeparationLowerBound(a, b), 0);

// Known geometry: a wrist at x=.27 has just .02 m of body clearance.
// Moving the chassis backward lets that same world target be reached with
// an extended arm. Tiny target tolerances prevent trading away the target.
function model() {
  const robot = new THREE.Group(), chest = new THREE.Group();
  chest.name = 'waist_yaw_L'; chest.position.z = 1; robot.add(chest);
  const body = new THREE.Object3D(); chest.add(body);
  body.userData.mobileCollision = { linkName: 'chest', chain: [], jointLink: true, center: [0, 0, 0], halfSize: [0.2, 0.2, 0.3] };
  for (const side of ['left', 'right']) {
    let parent = chest;
    const chain = [];
    for (const [i, axis] of [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]], [3, [0, 0, 1]], [4, [0, 1, 0]], [5, [1, 0, 0]]]) {
      const joint = new THREE.Group(); joint.name = `${side}_${i}`; chain.push(joint.name);
      const rest = i === 0 ? [0, side === 'left' ? 0.25 : -0.25, 0] : [0, 0, 0];
      joint.position.fromArray(rest); if (i === 0) joint.position.x = 0.27;
      joint.userData = { jointType: i < 3 ? 'prismatic' : 'revolute', jointAxis: axis, jointValue: i === 0 ? 0.27 : 0,
        restPosition: rest, restQuaternion: [0, 0, 0, 1], jointLimit: {
          lower: i === 0 ? 0.1 : i === 1 ? -0.02 : i === 2 ? -0.2 : -Math.PI,
          upper: i === 0 ? 0.9 : i === 1 ? 0.02 : i === 2 ? 0.2 : Math.PI } };
      parent.add(joint); parent = joint;
    }
    const tool = new THREE.Group(); tool.name = `tool_${side}`; parent.add(tool);
    const optical = new THREE.Group(); optical.name = `zivid_${side}_optical_frame`; tool.add(optical);
    const box = new THREE.Object3D(); tool.add(box);
    box.userData.mobileCollision = { linkName: `${side}-camera`, chain, jointLink: false, center: [0, 0, 0], halfSize: [0.05, 0.05, 0.05] };
  }
  return robot;
}
const robot = model(), original = readRobotJointValues(robot), layer = new THREE.Group(); layer.add(robot);
const far = { positions: new Float32Array([100, 100, 100]), kind: 'points' };
const checker = await createMobileCollisionChecker(robot, far, undefined, { armBodyClearance: 0.05 });
const initial = checker.check();
near(initial.armBodyClearance.minimum, 0.02);
assert.equal(initial.selfPairs.length, 0, 'no overlap is insufficient to satisfy the clearance buffer');
assert.equal(initial.clear, false);
assert.equal((await createMobileCollisionChecker(robot, far)).check().clear, true);
layer.scale.setScalar(2); near(checker.check().armBodyClearance.minimum, 0.04); layer.scale.setScalar(1);

// The buffer exemption at the shoulder must never disable its existing
// collision checks. This real-URDF shoulder state intersects the chest.
const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const botx = restoreMobileTeachingRobot(fixture.robot), botxLayer = new THREE.Group(); botxLayer.add(botx);
applyRobotJointValues(botx, { left_J1: 83, left_J2: -162 });
const shoulder = (await createMobileCollisionChecker(botx, far, undefined, { armBodyClearance: 0.05 })).check();
assert.ok(shoulder.selfPairs.some((pair) => pair.includes('waist_yaw_L') && pair.includes('left_L2')));
assert.equal(shoulder.clear, false);
const unidentified = new THREE.Group(), detection = new THREE.Object3D(); unidentified.add(detection);
detection.userData.mobileCollision = { linkName: 'unknown', chain: [], center: [0, 0, 0], halfSize: [0.1, 0.1, 0.1] };
await assert.rejects(() => createMobileCollisionChecker(unidentified, far, undefined, { armBodyClearance: 0.05 }));
const missingArm = model();
missingArm.traverse((node) => { if (node.userData.mobileCollision?.linkName === 'left-camera') delete node.userData.mobileCollision; });
await assert.rejects(() => createMobileCollisionChecker(missingArm, far, undefined, { armBodyClearance: 0.05 }),
  'one missing arm must not inherit the other arm\'s passing clearance');

const zero = { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
const task = { id: 'body-clearance', coordinateFrame: 'virtual_origin', map: {}, mobileCapture: { id: 'capture', samples: ['left', 'right'].map((side) => ({
  id: side, name: side, kind: 'keyframe', cameraPose: { position: { x: 0.27, y: side === 'left' ? 0.25 : -0.25, z: 1 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
})) } };
const options = { allowTorsoHeight: false, positionTolerance: { x: 0.001, y: 0.001, z: 0.001 }, rotationTolerance: { roll: 0.1, pitch: 0.1, yaw: 0.1 } };
const solve = (extra = {}, overrides = {}) => solveMobileTeaching({ robot, task, mapPose: zero, environment: far, options: { ...options, ...extra }, ...overrides });
const fixed = await solve({ parkingMode: 'fixed' });
assert.equal(fixed.feasibleCount, 0, 'fixed parking may not silently relax the buffer');
assert.ok(fixed.rows.every((row) => mobileParkingKey(row.mapPose) === mobileParkingKey(zero)));
const contactOnly = await solve({ parkingMode: 'fixed', armBodyClearance: 0 });
assert.equal(contactOnly.feasibleCount, 2);
const adjusted = await solve();
assert.equal(adjusted.feasibleCount, 2, JSON.stringify(adjusted.rows));
assert.equal(adjusted.parkingCount, 1);
assert.equal(adjusted.dualMotionCount, 1, 'clearance must also hold for jointly solved pairs');
assert.notEqual(mobileParkingKey(adjusted.rows[0].mapPose), mobileParkingKey(zero), 'base moves to make the same world targets comfortable');
for (const row of adjusted.rows) {
  const solution = row.solutions[row.selectedSide];
  assert.ok(solution.collision.armBodyClearance.minimum >= 0.05);
  assert.ok(solution.collision.armBodyClearance.bySide.left >= 0.05 && solution.collision.armBodyClearance.bySide.right >= 0.05);
  assert.ok(Object.values(solution.positionError).every((value) => Math.abs(value) <= 0.001));
  applyRobotJointValues(robot, solution.jointValues);
  assert.equal(checker.check().clear, true, 'independent full-body check');
}
applyRobotJointValues(robot, original);
const idle = await solve({ armMode: 'left' }, { task: { ...task, mobileCapture: { ...task.mobileCapture, samples: task.mobileCapture.samples.slice(0, 1) } } });
assert.equal(idle.feasibleCount, 1);
const idleSolution = idle.rows[0].solutions.left;
assert.ok(idleSolution.jointValues.right_0 > original.right_0 + 0.02, 'idle arm must also retreat from the body');
const blocked = await solve({ parkingMode: 'fixed', armMode: 'left' }, { lockedJointNames: Object.keys(original).filter((name) => name.startsWith('right_')) });
assert.equal(blocked.feasibleCount, 0, 'idle-arm locks remain binding');
assert.deepEqual(readRobotJointValues(robot), original, 'solving never moves the live model');

assert.ok(normalizeMobileSolveReport(JSON.parse(JSON.stringify(adjusted))));
const corrupt = JSON.parse(JSON.stringify(adjusted));
corrupt.rows[0].solutions[corrupt.rows[0].selectedSide].collision.armBodyClearance.minimum = 0.02;
assert.equal(normalizeMobileSolveReport(corrupt), null, 'stored reports cannot claim a passing margin below their configured minimum');
const legacy = JSON.parse(JSON.stringify(contactOnly)); legacy.version = 5; delete legacy.options.armBodyClearance;
assert.equal(normalizeMobileSolveReport(legacy).options.armBodyClearance, 0, 'v5 remains readable without inventing clearance checks');
for (const value of ['', null, NaN, Infinity, -0.01, 0.31]) assert.throws(() => validateMobileSolveOptions({ armBodyClearance: value }));
console.log('Clearance: conservative geometry, scale/rotation, hard buffer, base relocation, idle-arm retreat/locks, paired goals and v5/v6 persistence passed.');
