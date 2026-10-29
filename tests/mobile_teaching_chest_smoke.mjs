import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { restoreMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { readRobotJointValues, applyRobotJointValues } from "../src/features/robot/model/robotLoader.js";
import { mobileChestTiltLowerBound } from "../src/features/teaching/mobile/model/mobileTeachingChest.js";
import { mobileChestWithinTolerance, mobileSolutionFailureReasons } from "../src/features/teaching/mobile/model/mobileTeachingDiagnostics.js";
import { mobileParkingCandidates } from "../src/features/teaching/mobile/model/mobileTeachingParking.js";
import { solveMobileTeaching, validateMobileSolveOptions, normalizeMobileSolveReport, mobileReportSolveOptions,
  measureMobileTarget, mobileSampleTarget } from "../src/features/teaching/mobile/model/mobileTeachingSolver.js";
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const robot = restoreMobileTeachingRobot(fixture.robot), original = readRobotJointValues(robot);
const fk = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group(); layer.add(fk);
// The reported chassis pose: XYZ Euler angles make the uncompensatable roll
// 0.272 degrees, slightly beyond the previous hard-coded 0.25-degree limit.
const base = { position: { x: -2.2, y: 0.79, z: 0.02 }, rpy: { roll: 0.26, pitch: 0.08, yaw: 15.72 } };
const place = (pose) => {
  layer.position.set(...['x', 'y', 'z'].map((axis) => pose.position[axis]));
  layer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(pose.rpy[axis])), 'XYZ');
  layer.updateMatrixWorld(true);
};
place(base);
const chest = fk.getObjectByName('waist_yaw_L'), frame = fk.getObjectByName('zivid_left_optical_frame');
const lowerBound = mobileChestTiltLowerBound(fk, chest);
assert.ok(lowerBound > 0.2719 && lowerBound < 0.272);
const p = frame.getWorldPosition(new THREE.Vector3()), q = frame.getWorldQuaternion(new THREE.Quaternion());
const task = { id: 'chest-regression', coordinateFrame: 'virtual_origin', map: {}, mobileCapture: { id: 'capture', samples: [{
  id: 'tilted-base', kind: 'keyframe', cameraPose: {
    position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  },
}] } };
const environment = { kind: 'points', positions: new Float32Array([100, 100, 100]) };
const options = { parkingMode: 'fixed', armMode: 'left', armBodyClearance: 0,
  positionTolerance: { x: 0.2, y: 0.2, z: 0.2 }, rotationTolerance: { roll: 30, pitch: 30, yaw: 30 } };
const run = (changes = {}, geometry = environment) => solveMobileTeaching({ robot, task, mapPose: base,
  lockedJointNames: Object.keys(original), environment: geometry, options: { ...options, ...changes } });
const strict = await run();
assert.equal(strict.feasibleCount, 0);
assert.match(strict.rows[0].reason, /XYZ \/ RPY 均在容差内/);
assert.match(strict.rows[0].reason, /底盘侧倾使前胸倾角至少为 0.27°/);
assert.match(strict.rows[0].reason, /放宽相机 XYZ \/ RPY 容差对此无效/);

const relaxed = await run({ chestTiltTolerance: 0.5 });
assert.equal(relaxed.feasibleCount, 1, relaxed.rows[0].reason);
const solution = relaxed.rows[0].solutions.left;
assert.ok(solution.chestTilt > 0.25 && mobileChestWithinTolerance(solution.chestTilt, relaxed.options));
assert.deepEqual(solution.mapPose, base, 'accept an explicit tolerance without flattening or moving the chassis');
assert.equal(solution.collision.checked, true);
assert.equal(solution.collision.clear, true);
applyRobotJointValues(fk, solution.jointValues); place(base);
const actualTilt = THREE.MathUtils.radToDeg(new THREE.Vector3(0, 0, 1)
  .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion())).angleTo(new THREE.Vector3(0, 0, 1)));
assert.ok(Math.abs(actualTilt - solution.chestTilt) < 1e-8);
assert.ok(measureMobileTarget(frame, mobileSampleTarget(task.mobileCapture.samples[0], task), relaxed.options).withinTolerance);
const checker = await createMobileCollisionChecker(fk, environment, undefined, relaxed.options);
assert.equal(checker.check().clear, true, 'independent collision check still applies');
for (const name of relaxed.lockedJointNames) assert.equal(solution.jointValues[name], original[name]);
assert.deepEqual(readRobotJointValues(robot), original, 'keep the live robot unchanged');
assert.deepEqual(normalizeMobileSolveReport(relaxed), relaxed);
const stricterReport = structuredClone(relaxed); stricterReport.options.chestTiltTolerance = 0.25;
assert.equal(normalizeMobileSolveReport(stricterReport), null);
const oldPassing = structuredClone(relaxed); oldPassing.version = 7;
assert.equal(normalizeMobileSolveReport(oldPassing), null, 'old reports never inherit the new relaxed threshold');
const oldFailure = structuredClone(strict); oldFailure.version = 7; delete oldFailure.options.chestTiltTolerance;
assert.equal(normalizeMobileSolveReport(oldFailure).options.chestTiltTolerance, 0.25);
assert.equal(mobileReportSolveOptions({ version: 7, options: { chestTiltTolerance: 10 } }).chestTiltTolerance, 0.25);
assert.equal(mobileSolutionFailureReasons({ ...solution, feasible: false, chestTilt: 0.6 }, relaxed.options)
  .some((reason) => reason.includes('0.60° > 0.5°')), true);

// Widening the front-chest tolerance must never bypass the environment check.
const obstacle = new THREE.BoxGeometry(20, 20, 20);
const obstructed = await run({ chestTiltTolerance: 0.5, allowTorsoHeight: false }, {
  kind: 'mesh', positions: obstacle.attributes.position.array, indices: obstacle.index.array,
});
assert.equal(obstructed.feasibleCount, 0);
assert.match(obstructed.rows[0].reason, /工件干涉/);
obstacle.dispose();

for (const candidate of mobileParkingCandidates(mobileSampleTarget(task.mobileCapture.samples[0], task), base, null, 'auto')) {
  place(candidate);
  assert.ok(Math.abs(mobileChestTiltLowerBound(fk, chest) - lowerBound) < 1e-7,
    'moving or turning about world Z cannot remove the inherited side tilt');
}
applyRobotJointValues(fk, original);
place({ ...base, rpy: { roll: 0, pitch: 10, yaw: 0 } });
assert.ok(mobileChestTiltLowerBound(fk, chest) < 1e-5, 'a compensatable forward pitch is not a lateral-tilt failure');
const rollJoint = new THREE.Object3D(); rollJoint.name = 'extra_roll';
rollJoint.userData = { jointType: 'revolute', jointAxis: [1, 0, 0] };
const link = fk.getObjectByName('base_link'); fk.add(rollJoint); rollJoint.add(link);
assert.equal(mobileChestTiltLowerBound(fk, chest), null, 'do not claim impossibility for a model with a roll joint');
rollJoint.userData.jointAxis = [0, 0, 1]; place(base);
assert.equal(mobileChestTiltLowerBound(fk, chest), null, 'yaw above the torso could turn its pitch plane to compensate the slope');
for (const value of ['', null, NaN, Infinity, 0, -1, 10.01]) {
  assert.throws(() => validateMobileSolveOptions({ chestTiltTolerance: value }), /前胸垂直容差/);
}
assert.equal(validateMobileSolveOptions({ chestTiltTolerance: '0.5' }).chestTiltTolerance, 0.5);
assert.equal(mobileChestWithinTolerance(0.5 + 5e-8, { chestTiltTolerance: 0.5 }), true);
assert.equal(mobileChestWithinTolerance(0.5 + 2e-7, { chestTiltTolerance: 0.5 }), false);
console.log('Chest regression: reported 0.272° side tilt rejected at 0.25°, accepted at explicit 0.5°; FK, collisions, locks, old reports, turns and diagnostics passed.');
