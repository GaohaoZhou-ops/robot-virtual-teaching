import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMobileSolvedTask, measureMobileTarget, mobileSampleTarget, normalizeMobileSolveReport, solveMobileTeaching } from '../src/lib/mobileTeachingSolver.js';
import { applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';

// Disjoint left/right workspaces: neither arm can photograph the opposite
// side at the origin, but together they can cover the entire station.
const robot = new THREE.Group(), chest = new THREE.Group(); chest.name = 'waist_yaw_L'; robot.add(chest);
for (const side of ['left', 'right']) {
  const shoulder = new THREE.Group(); shoulder.position.y = side === 'left' ? 0.6 : -0.6; chest.add(shoulder);
  let parent = shoulder;
  for (const [i, axis] of [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]], [3, [0, 0, 1]], [4, [0, 1, 0]], [5, [1, 0, 0]]]) {
    const joint = new THREE.Group(), prismatic = i < 3;
    joint.name = `${side}_${i}`;
    joint.userData = { jointType: prismatic ? 'prismatic' : 'revolute', jointAxis: axis, jointValue: 0,
      restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1],
      jointLimit: { lower: prismatic ? -0.25 : -Math.PI, upper: prismatic ? 0.25 : Math.PI } };
    parent.add(joint); parent = joint;
  }
  const frame = new THREE.Group(); frame.name = `tool_${side}`; parent.add(frame);
}
const initial = readRobotJointValues(robot);
const sample = (id, x, y, z = 0.1) => ({ id, name: id, kind: 'keyframe', cameraPose: {
  position: { x, y, z }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
} });
const task = (samples) => ({ id: 'assignment', name: 'Assignment', coordinateFrame: 'virtual_origin', map: {},
  mobileCapture: { id: 'capture', samples } });
const options = { targetFrame: 'tool', checkCollisions: false, allowTorsoHeight: false };
const run = (source, overrides = {}, extra = {}) => solveMobileTeaching({ robot, task: source, mapPose: {}, options: { ...options, ...overrides }, ...extra });
const station = task([sample('left-1', 0.1, 0.6), sample('right-1', 0.1, -0.6), sample('left-2', -0.1, 0.7), sample('left-3', 0, 0.5)]);
const fixed = await run(station, { parkingMode: 'fixed' });
assert.equal(fixed.feasibleCount, 4);
assert.equal(fixed.parkingCount, 1);
assert.deepEqual(fixed.rows.map((row) => row.selectedSide), ['left', 'right', 'left', 'left'], 'work sharing must fall back when only one camera can reach');
assert.equal(fixed.rows[0].solutions.right.skipped, true, 'do not require a second IK solution for an already assigned target');
assert.equal((await run(station, { parkingMode: 'fixed', armMode: 'left' })).feasibleCount, 3);
assert.equal((await run(station, { parkingMode: 'fixed', armMode: 'right' })).feasibleCount, 1);

const sweeps = task(['left', 'right'].flatMap((side) => Array.from({ length: 8 }, (_, i) =>
  sample(`${side}-sweep-${i}`, 0.1 + i * 0.01, side === 'left' ? 0.6 : -0.6))));
const sweepReport = await run(sweeps, { parkingMode: 'fixed' });
assert.equal(sweepReport.feasibleCount, 16);
assert.equal(sweepReport.parkingCount, 1);
assert.equal(sweepReport.dualMotionCount, 8, 'opposite-arm targets beyond the batch boundary must still pair at the same stop');
assert.equal(new Set(sweepReport.rows.map((row) => row.sampleId)).size, 16);

// Captures visit A, B, A, B. The planner must gather both sides of A before
// moving to B, without editing the capture or duplicating any photograph.
const distributed = task([sample('A-left', 0.1, 0.6), sample('B-right', 5.1, -0.6), sample('A-right', 0.1, -0.6), sample('B-left', 5.1, 0.6)]);
const before = structuredClone(distributed), emitted = [];
const report = await run(distributed, {}, { onSample: ({ row, index }) => { assert.equal(index, emitted.length); emitted.push(structuredClone(row)); } });
assert.equal(report.feasibleCount, 4);
assert.equal(report.parkingCount, 2);
assert.deepEqual(report.rows.map((row) => row.sampleId), ['A-left', 'A-right', 'B-right', 'B-left']);
assert.deepEqual(emitted, report.rows, 'progressive results must not be reassigned after publication');
assert.deepEqual(distributed, before);
assert.deepEqual(readRobotJointValues(robot), initial);
const saved = buildMobileSolvedTask(distributed, report, {}, 'solved');
assert.equal(saved.parkingPoints.length, 2);
for (const parking of saved.parkingPoints) {
  assert.equal(parking.poses.length, 1, 'the two targets share a simultaneous whole-body motion');
  const assigned = report.rows.filter((row) => parking.poses.some((pose) => pose.mobileSampleIds.includes(row.sampleId)));
  assert.equal(new Set(assigned.map((row) => row.selectedSide)).size, 2);
}
const fk = restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot)), layer = new THREE.Group(); layer.add(fk);
let previous = initial;
for (const row of report.rows) {
  assert.equal(Object.values(row.solutions).filter((solution) => solution.feasible).length, 1);
  const solution = row.solutions[row.selectedSide], idle = row.selectedSide === 'left' ? 'right' : 'left';
  if (!row.pairedSampleId) for (const [name, value] of Object.entries(previous)) if (name.startsWith(idle)) assert.equal(solution.jointValues[name], value, 'single motions retain the idle arm');
  previous = solution.jointValues;
  layer.position.set(...['x', 'y', 'z'].map((axis) => row.mapPose.position[axis]));
  layer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(row.mapPose.rpy[axis])), 'XYZ');
  applyRobotJointValues(fk, solution.jointValues); layer.updateMatrixWorld(true);
  const source = distributed.mobileCapture.samples.find((entry) => entry.id === row.sampleId);
  assert.ok(measureMobileTarget(fk.getObjectByName(`tool_${row.selectedSide}`), mobileSampleTarget(source, distributed), report.options).withinTolerance);
}
// v3 already supported height control. Upgrading the assignment algorithm
// must neither disable that flag nor weaken v3 chest-upright validation.
const legacy = structuredClone(fixed); legacy.version = 3; legacy.options.allowTorsoHeight = true;
assert.equal(normalizeMobileSolveReport(legacy).options.allowTorsoHeight, true);
legacy.options.allowTorsoHeight = false;
assert.equal(normalizeMobileSolveReport(legacy).options.allowTorsoHeight, false);
legacy.rows[0].solutions.left.chestTilt = 2;
assert.equal(normalizeMobileSolveReport(legacy), null);
assert.deepEqual(normalizeMobileSolveReport(report), report);
console.log('Single-camera assignment: disjoint workspaces, fallback, paired shared stops, reordered coverage, immutable progress, independent FK, persistence and v3 migration passed.');
