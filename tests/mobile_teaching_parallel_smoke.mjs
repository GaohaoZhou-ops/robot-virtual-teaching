import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solveMobileTeaching, buildMobileSolvedTask, mobileMotionGroups, measureMobileTarget, mobileSampleTarget, normalizeMobileSolveReport } from '../src/lib/mobileTeachingSolver.js';
import { applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';
import { mobileRobotPoseLinks } from '../src/lib/mobileTeachingReview.js';
import { transformTeachingTasks } from '../src/lib/teachingTransfer.js';
import { buildTeachingDataExport } from '../src/lib/teachingData.js';
import { buildTeachingTaskTrajectory, sampleTeachingTrajectorySegment } from '../src/lib/teachingPlayback.js';

// Two disjoint lateral workspaces share one vertical torso actuator. Each arm
// can compensate by only ±20 cm, making simultaneous reachability analytical.
const robot = new THREE.Group();
const joint = (parent, name, axis, range) => {
  const node = new THREE.Group(); node.name = name;
  node.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: axis,
    restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1], jointLimit: { lower: -range, upper: range } };
  parent.add(node); return node;
};
const torso = joint(robot, 'shared_lift', [0, 0, 1], 1);
const chest = new THREE.Group(); chest.name = 'waist_yaw_L'; chest.position.z = 1; torso.add(chest);
for (const side of ['left', 'right']) {
  const shoulder = new THREE.Group(); shoulder.position.y = side === 'left' ? 0.6 : -0.6; chest.add(shoulder);
  const x = joint(shoulder, `${side}_x`, [1, 0, 0], 0.4), z = joint(x, `${side}_z`, [0, 0, 1], 0.2);
  const tool = new THREE.Group(); tool.name = `tool_${side}`; z.add(tool);
  const camera = new THREE.Group(); camera.name = `zivid_${side}_optical_frame`; tool.add(camera);
}
const initial = readRobotJointValues(robot);
const sample = (side, z) => ({ id: `${side}-${z}`, name: `${side} target`, kind: 'keyframe', cameraPose: {
  position: { x: 0.15, y: side === 'left' ? 0.6 : -0.6, z }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
} });
const source = (left, right) => ({ id: 'simultaneous', name: 'Simultaneous', coordinateFrame: 'virtual_origin', map: {},
  mobileCapture: { id: 'capture', samples: [sample('left', left), sample('right', right)] } });
const options = { parkingMode: 'fixed', checkCollisions: false, allowTorsoHeight: false,
  positionTolerance: { x: 0.002, y: 0.002, z: 0.002 }, rotationTolerance: { roll: 0.5, pitch: 0.5, yaw: 0.5 } };
const task = source(1.5, 1.4), emitted = [];
const report = await solveMobileTeaching({ robot, task, mapPose: {}, options,
  onSample: ({ row }) => emitted.push(structuredClone(row)) });
assert.equal(report.feasibleCount, 2);
assert.equal(report.parkingCount, 1);
assert.equal(report.motionCount, 1);
assert.equal(report.dualMotionCount, 1);
assert.deepEqual(report.rows.map((row) => row.selectedSide), ['left', 'right']);
assert.deepEqual(report.rows, emitted, 'combined states are final when emitted, including when the worker pauses between rows');
assert.deepEqual(readRobotJointValues(robot), initial);
const [pair] = mobileMotionGroups(report);
const values = pair[0].solutions.left.jointValues;
assert.deepEqual(values, pair[1].solutions.right.jointValues);
applyRobotJointValues(robot, values); robot.updateMatrixWorld(true);
for (const row of pair) {
  const target = mobileSampleTarget(task.mobileCapture.samples.find((entry) => entry.id === row.sampleId), task);
  assert.ok(measureMobileTarget(robot.getObjectByName(`zivid_${row.selectedSide}_optical_frame`), target, report.options).withinTolerance);
}
assert.ok(values.shared_lift >= 0.298 && values.shared_lift <= 0.602, 'both targets must agree on a single feasible torso height');
const serialized = JSON.parse(JSON.stringify(report));
assert.deepEqual(normalizeMobileSolveReport(serialized), serialized);
const broken = JSON.parse(JSON.stringify(report)); broken.rows[1].solutions.right.jointValues.left_z += 0.1;
assert.equal(normalizeMobileSolveReport(broken), null, 'reject pairs containing two incompatible full-body states');
const wrongBase = JSON.parse(JSON.stringify(report)); wrongBase.rows[1].mapPose.position.x += 1;
assert.equal(normalizeMobileSolveReport(wrongBase), null);

const saved = normalizeTeachingTasks([buildMobileSolvedTask(task, report, {}, 'solved')])[0];
const pose = saved.parkingPoints[0].poses[0];
assert.equal(saved.parkingPoints[0].poses.length, 1);
assert.deepEqual(pose.mobileSampleIds, task.mobileCapture.samples.map((entry) => entry.id));
assert.deepEqual(Object.keys(pose.opticalTargets).sort(), ['left', 'right']);
const links = mobileRobotPoseLinks({ ...task, mobileSolve: { ...report, savedTaskId: saved.id } }, [saved]);
for (const entry of task.mobileCapture.samples) assert.equal(links.get(entry.id).pose.id, pose.id);
const exported = buildTeachingDataExport({ virtualTeaching: { tasks: [saved] } });
assert.deepEqual(exported.tasks[0].parkingPoints[0].poses[0].mobileSampleIds, pose.mobileSampleIds);

const trajectory = buildTeachingTaskTrajectory({ task: saved });
assert.equal(trajectory.poseCount, 1);
assert.deepEqual(trajectory.initialJointValues, initial);
const motions = trajectory.segments.filter((segment) => segment.phase === 'joints');
assert.equal(motions.length, 1, 'one joint segment moves both arms, with no intermediate one-arm hold');
assert.ok(motions[0].changedJointNames.includes('left_x') && motions[0].changedJointNames.includes('right_x'));
const middle = sampleTeachingTrajectorySegment(motions[0], 0.5);
for (const name of ['left_x', 'right_x']) {
  assert.ok(middle.robotJointValues[name] > initial[name] && middle.robotJointValues[name] < values[name]);
  assert.ok(Math.abs(middle.robotJointValues[name] - values[name] / 2) < 1e-10, 'both arms use the same motion clock');
}
const transform = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(2, 3, 0);
const relocated = transformTeachingTasks([saved], transform, 'map', { name: 'map' })[0];
assert.deepEqual(relocated.mobileSolveSource.initialMapPose.position, { x: 2, y: 3, z: 0 });
assert.deepEqual(buildTeachingTaskTrajectory({ task: relocated }).initialRobotPose.position, { x: 2, y: 3, z: 0 });

// Both heights are reachable separately, but their allowed shared-lift
// intervals do not intersect. Pairing must not invent a torso state or lose a
// target just to obtain simultaneous motion.
applyRobotJointValues(robot, initial);
const incompatible = source(1.7, 0.4);
const fallback = await solveMobileTeaching({ robot, task: incompatible, mapPose: {}, options });
assert.equal(fallback.feasibleCount, 2);
assert.equal(fallback.motionCount, 2);
assert.equal(fallback.dualMotionCount, 0);
for (const row of fallback.rows) {
  applyRobotJointValues(robot, row.solutions[row.selectedSide].jointValues); robot.updateMatrixWorld(true);
  const target = mobileSampleTarget(incompatible.mobileCapture.samples.find((entry) => entry.id === row.sampleId), incompatible);
  assert.ok(measureMobileTarget(robot.getObjectByName(`zivid_${row.selectedSide}_optical_frame`), target, fallback.options).withinTolerance);
}
const legacy = structuredClone(report); legacy.version = 4;
assert.ok(normalizeMobileSolveReport(legacy), 'v4 reports remain readable');
assert.equal(buildMobileSolvedTask(task, legacy, {}, 'legacy').parkingPoints[0].poses.length, 2, 'old reports are not silently paired');
console.log('Simultaneous motion: common-torso IK, incompatible-target fallback, paired-state validation, dual optical targets, source links, export, transformed start and concurrent playback passed.');
