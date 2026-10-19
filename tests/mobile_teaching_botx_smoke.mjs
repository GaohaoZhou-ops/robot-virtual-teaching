import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { solveMobileTeaching, buildMobileSolvedTask, mobileSampleTarget, measureMobileTarget } from '../src/lib/mobileTeachingSolver.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { normalizeTeachingTasks } from '../src/lib/io.js';
import { buildTeachingTaskTrajectory } from '../src/lib/teachingPlayback.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const robot = restoreMobileTeachingRobot(fixture.robot), baseline = readRobotJointValues(robot);
const locked = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J'];
const zero = { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
const far = { positions: new Float32Array([100, 100, 100]), kind: 'points' };
const task = { id: 'botx-capture', name: 'Distributed capture', coordinateFrame: 'virtual_origin', map: {},
  mobileCapture: { id: 'capture', samples: fixture.targets.map((cameraPose, i) => ({ id: `sample-${i}`, name: `Pose ${i + 1}`, kind: 'keyframe', cameraPose })) } };
const before = structuredClone(task);
const report = await solveMobileTeaching({ robot, task, mapPose: zero, environment: far, lockedJointNames: locked, options: { allowTorsoHeight: false } });
assert.equal(report.feasibleCount, 16, report.rows.filter((r) => !r.feasible).map((r) => `${r.name}: ${r.reason}`).join('\n'));
assert.ok(report.parkingCount > 1);
assert.deepEqual(task, before);
assert.deepEqual(readRobotJointValues(robot), baseline);
const fk = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group(); layer.add(fk);
const checker = await createMobileCollisionChecker(fk, far);
let switches = 0, previousSide;
for (const row of report.rows) {
  if (previousSide && previousSide !== row.selectedSide) switches += 1;
  previousSide = row.selectedSide;
  for (const [side, solution] of Object.entries(row.solutions)) {
    if (!solution.feasible) continue;
    assert.equal(solution.collision.clear, true);
    const { mapPose } = solution;
    layer.position.set(mapPose.position.x, mapPose.position.y, mapPose.position.z);
    layer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(mapPose.rpy[axis])), 'XYZ');
    applyRobotJointValues(fk, solution.jointValues); layer.updateMatrixWorld(true);
    for (const name of locked) assert.equal(solution.jointValues[name], baseline[name]);
    assert.ok(measureMobileTarget(fk.getObjectByName(`zivid_${side}_optical_frame`), mobileSampleTarget(task.mobileCapture.samples.find((s) => s.id === row.sampleId), task), report.options).withinTolerance);
    assert.equal(checker.check().clear, true, `${row.name} ${side}`);
    fk.traverse((node) => {
      if (!['revolute', 'prismatic'].includes(node.userData.jointType)) return;
      const { jointValue, jointLimit } = node.userData;
      assert.ok(jointValue >= jointLimit.lower - 1e-9 && jointValue <= jointLimit.upper + 1e-9);
    });
  }
}
assert.ok(switches <= 2, `Unnecessary arm switches: ${switches}`);
const saved = buildMobileSolvedTask(task, report, {}, 'botx-solved');
assert.equal(saved.parkingPoints.length, report.parkingCount);
const normalized = normalizeTeachingTasks([saved])[0];
assert.deepEqual(normalized.parkingPoints.map((p) => p.mapPose), saved.parkingPoints.map((p) => p.mapPose));
assert.deepEqual(normalized.parkingPoints.flatMap((p) => p.poses.map((pose) => pose.mobileSampleId)), task.mobileCapture.samples.map((s) => s.id));
const trajectory = buildTeachingTaskTrajectory({ task: normalized });
const holds = trajectory.segments.filter((segment) => segment.phase === 'hold');
assert.equal(holds.length, 16);
for (const [i, segment] of holds.entries()) assert.deepEqual(segment.toPose, report.rows[i].mapPose, 'playback holds use each solved chassis pose');

// A reachable FK target must be rejected when the robot is inside an obstacle,
// and the rejected row must never become a saved robot pose.
applyRobotJointValues(fk, baseline); layer.position.set(0, 0, 0); layer.rotation.set(0, 0, 0); layer.updateMatrixWorld(true);
const frame = fk.getObjectByName('zivid_left_optical_frame');
const p = frame.getWorldPosition(new THREE.Vector3()), q = frame.getWorldQuaternion(new THREE.Quaternion());
const obstructedTask = { ...task, mobileCapture: { ...task.mobileCapture, samples: [{ id: 'obstructed', kind: 'keyframe', cameraPose: {
  position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
} }] } };
const obstacle = new THREE.BoxGeometry(20, 20, 20);
const rejected = await solveMobileTeaching({ robot, task: obstructedTask, mapPose: zero, lockedJointNames: locked,
  environment: { positions: obstacle.attributes.position.array, indices: obstacle.index.array, kind: 'mesh' },
  options: { parkingMode: 'fixed', armMode: 'left', allowTorsoHeight: false } });
assert.equal(rejected.feasibleCount, 0);
assert.match(rejected.rows[0].solutions.left.reason, /工件干涉/);
assert.throws(() => buildMobileSolvedTask(obstructedTask, rejected, {}, 'blocked'), /没有可保存/);
await assert.rejects(() => solveMobileTeaching({ robot, task: obstructedTask, mapPose: zero }), /缺少当前工件/);
obstacle.dispose();

// Tight-tolerance regressions generated by real FK, not by assumptions about
// reach. These previously failed with the old clipped local DLS solver.
for (const [i, known] of fixture.knownReachable.entries()) {
  applyRobotJointValues(fk, known.joints); layer.position.set(0, 0, 0); layer.rotation.set(0, 0, 0); layer.updateMatrixWorld(true);
  const frame = fk.getObjectByName(`zivid_${known.side}_optical_frame`);
  const position = frame.getWorldPosition(new THREE.Vector3()), q = frame.getWorldQuaternion(new THREE.Quaternion());
  const hardTask = { ...task, mobileCapture: { ...task.mobileCapture, samples: [{ id: `hard-${i}`, kind: 'keyframe', cameraPose: {
    position: { x: position.x, y: position.y, z: position.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  } }] } };
  const hard = await solveMobileTeaching({ robot, task: hardTask, mapPose: zero, lockedJointNames: locked,
    options: { parkingMode: 'fixed', checkCollisions: false, armMode: known.side, allowTorsoHeight: false,
      positionTolerance: { x: 0.01, y: 0.01, z: 0.01 }, rotationTolerance: { roll: 1, pitch: 1, yaw: 1 } } });
  assert.equal(hard.feasibleCount, 1, `Known reachable ${known.side} target ${i}`);
}
console.log(`BOTX regression: 16/16 targets, ${report.parkingCount} parking points, ${switches} arm switches; independent FK, collision, limits, persistence and tight-tolerance targets passed.`);
