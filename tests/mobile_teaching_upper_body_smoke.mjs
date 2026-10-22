import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { mobileUpperBodyJoints, mobileReferenceMetrics } from '../src/lib/mobileTeachingReference.js';
import { solveMobileTeaching, measureMobileTarget, mobileSampleTarget, normalizeMobileSolveReport, mobileReportSolveOptions,
  validateMobileSolveOptions, buildMobileSolvedTask } from '../src/lib/mobileTeachingSolver.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';

// Two Cartesian wrists give an independently known answer: every target below
// is exactly the same reference posture, translated/turned by its chassis.
// Their optical axes point up, so heading must use full camera orientation,
// not the horizontal projection of the viewing direction.
const robot = new THREE.Group(), chest = new THREE.Group();
chest.name = 'waist_yaw_L'; chest.position.z = 0.8; robot.add(chest);
for (const side of ['left', 'right']) {
  const shoulder = new THREE.Group(); shoulder.position.y = side === 'left' ? 0.2 : -0.2; chest.add(shoulder);
  let parent = shoulder;
  for (const [i, axis] of [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]], [3, [0, 0, 1]], [4, [0, 1, 0]], [5, [1, 0, 0]]]) {
    const joint = new THREE.Group(), linear = i < 3; joint.name = `${side}_${i}`;
    joint.userData = { jointType: linear ? 'prismatic' : 'revolute', jointValue: 0, jointAxis: axis,
      jointLimit: { lower: linear ? -1 : -Math.PI, upper: linear ? 1 : Math.PI },
      restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1] };
    parent.add(joint); parent = joint;
  }
  const tool = new THREE.Group(); tool.name = `tool_${side}`; parent.add(tool);
  const optical = new THREE.Group(); optical.name = `zivid_${side}_optical_frame`; optical.position.z = 0.1; tool.add(optical);
}
const original = readRobotJointValues(robot);
const referenceValues = { ...original, left_0: 0.45, left_1: 0.06, left_2: 0.12, left_3: 30,
  right_0: 0.45, right_1: -0.06, right_2: 0.12, right_3: -30 };
const referencePose = { type: 'preset', id: 'reference', name: '上身准备姿态', robotId: 'fixture',
  joints: { angularUnit: 'degree', linearUnit: 'meter', values: referenceValues } };
const base = { position: { x: -2.2, y: 0.79, z: 0.02 }, rpy: { roll: 0.26, pitch: 0.08, yaw: 15.72 } };
const fk = restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot)), layer = new THREE.Group(); layer.add(fk);
const place = (pose) => {
  layer.position.set(...['x', 'y', 'z'].map((axis) => pose.position[axis]));
  layer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(pose.rpy[axis])), 'XYZ');
  layer.updateMatrixWorld(true);
};
const sample = (pose, side, id) => {
  applyRobotJointValues(fk, referenceValues); place(pose);
  const frame = fk.getObjectByName(`zivid_${side}_optical_frame`), p = frame.getWorldPosition(new THREE.Vector3()), q = frame.getWorldQuaternion(new THREE.Quaternion());
  return { id, name: id, kind: 'keyframe', cameraPose: {
    position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  } };
};
const task = { id: 'upper-body', name: 'Upper-body reference', coordinateFrame: 'virtual_origin', map: {},
  mobileCapture: { id: 'capture', samples: [-155, -92, -40, 35, 90, 155].map((yaw, i) => sample({
    position: { x: i * 1.4, y: i % 2, z: base.position.z }, rpy: { roll: 0, pitch: 0, yaw },
  }, 'left', `pose-${i}`)) } };
const before = structuredClone({ task, referencePose });
const options = { referencePose, armMode: 'left', parkingMode: 'per-pose', checkCollisions: false,
  positionTolerance: { x: 0.005, y: 0.005, z: 0.005 }, rotationTolerance: { roll: 0.5, pitch: 0.5, yaw: 0.5 } };
const run = (changes = {}, source = task, extra = {}) => solveMobileTeaching({ robot, task: source, mapPose: base,
  options: { ...options, ...changes }, ...extra });
const report = await run();
assert.equal(report.feasibleCount, 6, report.rows.map((row) => row.reason).join('\n'));
assert.equal(report.options.referencePreference, 'upper-body');
assert.equal(report.options.baseSupport, 'level');
assert.equal(report.options.chestTiltTolerance, 0.25, 'level the base without relaxing the front-chest limit');
assert.deepEqual(report.mapPose, base, 'retain the original start pose in the report');
for (const row of report.rows) {
  const solution = row.solutions.left;
  assert.equal(row.mapPose.rpy.roll, 0); assert.equal(row.mapPose.rpy.pitch, 0);
  assert.equal(row.mapPose.position.z, base.position.z, 'base translation cannot float to meet a target');
  assert.ok(solution.referenceDeviation.cost < 1e-10, 'chassis freedom should preserve the complete upper-body reference');
  assert.ok(solution.chestTilt <= 0.25);
  applyRobotJointValues(fk, solution.jointValues); place(solution.mapPose);
  assert.ok(measureMobileTarget(fk.getObjectByName('zivid_left_optical_frame'),
    mobileSampleTarget(task.mobileCapture.samples.find((entry) => entry.id === row.sampleId), task), report.options).withinTolerance);
  assert.deepEqual(mobileReferenceMetrics(mobileUpperBodyJoints(fk), referenceValues), solution.referenceDeviation);
}
const oldSearch = await run({ referencePreference: 'whole-body' });
assert.equal(oldSearch.feasibleCount, 6, 'compare posture quality at the same target tolerances and coverage');
const oldCost = oldSearch.rows.reduce((sum, row) => sum + row.solutions.left.referenceDeviation.cost, 0);
assert.ok(oldCost > 0.01, `old parking search should require upper-body changes: ${oldCost}`);
const fixed = await run({ parkingMode: 'fixed' }, { ...task, mobileCapture: { ...task.mobileCapture, samples: task.mobileCapture.samples.slice(0, 1) } });
assert.equal(fixed.feasibleCount, 0, 'fixed chassis must not be silently levelled');
assert.deepEqual(fixed.rows[0].mapPose, base);
const inherited = await run({ baseSupport: 'current' }, { ...task, mobileCapture: { ...task.mobileCapture, samples: task.mobileCapture.samples.slice(0, 1) } });
assert.equal(inherited.feasibleCount, 0, 'explicitly preserving the tilted base retains the world-up restriction');

// Preserve useful simultaneous motions when both reference cameras share one
// chassis pose. Pairing must compare each arm separately from the idle arm.
const sharedBase = { position: { x: 2, y: 1, z: 0.02 }, rpy: { roll: 0, pitch: 0, yaw: 132 } };
const sharedTask = { ...task, mobileCapture: { id: 'shared', samples: ['left', 'right'].map((side) => sample(sharedBase, side, side)) } };
const shared = await run({ parkingMode: 'auto', armMode: 'both' }, sharedTask);
assert.equal(shared.feasibleCount, 2); assert.equal(shared.parkingCount, 1); assert.equal(shared.dualMotionCount, 1);
for (const row of shared.rows) assert.ok(row.solutions[row.selectedSide].referenceDeviation.cost < 1e-10);
const saved = normalizeTeachingTasks([buildMobileSolvedTask(sharedTask, shared, {}, 'saved')])[0];
assert.deepEqual(saved.parkingPoints[0].mapPose.position, shared.rows[0].mapPose.position);
assert.deepEqual(saved.parkingPoints[0].mapPose.rpy, shared.rows[0].mapPose.rpy);
assert.deepEqual(saved.parkingPoints[0].poses[0].fullBodyJoints.values, shared.rows[0].solutions.left.jointValues);
assert.deepEqual(normalizeMobileSolveReport(report), report);
const floating = structuredClone(report); floating.rows[0].solutions.left.mapPose.position.z += 0.1;
assert.equal(normalizeMobileSolveReport(floating), null);
const legacy = structuredClone(report); legacy.version = 8;
delete legacy.options.baseSupport; delete legacy.options.referencePreference;
assert.equal(normalizeMobileSolveReport(legacy).options.baseSupport, 'current');
assert.equal(mobileReportSolveOptions(legacy).referencePreference, 'whole-body');
assert.throws(() => validateMobileSolveOptions({ baseSupport: 'unknown' }), /地面支撑/);
assert.throws(() => validateMobileSolveOptions({ referencePreference: 'unknown' }), /参考姿态偏好/);
assert.deepEqual({ task, referencePose }, before);
assert.deepEqual(readRobotJointValues(robot), original);
console.log(`Upper-body reference: 6/6 targets retain exact reference through chassis turns/moves; old posture cost ${oldCost.toFixed(4)} → 0; ground, fixed bases, dual motions, FK, persistence and legacy settings passed.`);
