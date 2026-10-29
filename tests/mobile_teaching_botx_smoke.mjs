import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { restoreMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { applyRobotJointValues, readRobotJointValues, setRobotJointValue } from "../src/features/robot/model/robotLoader.js";
import { getRobotJointLimits } from "../src/features/robot/model/robotJointLimits.js";
import { getRobotJointCouplingPairs, projectRobotJointCoupling } from "../src/features/robot/model/robotJointCoupling.js";
import { solveMobileTeaching, buildMobileSolvedTask, mobileSampleTarget, measureMobileTarget, mobileMotionGroups } from "../src/features/teaching/mobile/model/mobileTeachingSolver.js";
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";
import { normalizeTeachingTasks } from "../src/features/workspace/model/io.js";
import { buildTeachingTaskTrajectory } from "../src/features/teaching/model/teachingPlayback.js";

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const robot = restoreMobileTeachingRobot(fixture.robot), baseline = readRobotJointValues(robot);
const locked = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J'];
const zero = { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
const far = { positions: new Float32Array([100, 100, 100]), kind: 'points' };
const task = { id: 'botx-capture', name: 'Distributed capture', coordinateFrame: 'virtual_origin', map: {},
  mobileCapture: { id: 'capture', samples: fixture.targets.map((cameraPose, i) => ({ id: `sample-${i}`, name: `Pose ${i + 1}`, kind: 'keyframe', cameraPose })) } };
const before = structuredClone(task);
// This regression exercises shared-stop planning. Upper-body preference may
// trade shared stops for a closer reference; its FK and pairing guarantees are
// covered separately by upper_body_smoke and the default height regression.
const report = await solveMobileTeaching({ robot, task, mapPose: zero, environment: far, lockedJointNames: locked,
  options: { allowTorsoHeight: false, referencePreference: 'whole-body' } });
assert.equal(report.feasibleCount, 16, report.rows.filter((r) => !r.feasible).map((r) => `${r.name}: ${r.reason}`).join('\n'));
assert.ok(report.parkingCount > 1 && report.parkingCount < fixture.targets.length,
  `Retain shared stops when comfortable, but allow more than the old 8 cramped stops: ${report.parkingCount}`);
assert.deepEqual(task, before);
assert.deepEqual(readRobotJointValues(robot), baseline);
const fk = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group(); layer.add(fk);
const checker = await createMobileCollisionChecker(fk, far, undefined, report.options);
const clearances = [];
const parkingSides = new Map();
for (const row of report.rows) {
  if (!parkingSides.has(row.parkingId)) parkingSides.set(row.parkingId, new Set());
  parkingSides.get(row.parkingId).add(row.selectedSide);
  assert.ok(['left', 'right'].includes(row.selectedSide) && row.solutions[row.selectedSide].feasible, 'each sample assigns one executing camera');
  for (const [side, solution] of Object.entries(row.solutions)) {
    if (!solution.feasible) continue;
    for (const arm of ['left', 'right']) {
      assert.ok(Math.abs(THREE.MathUtils.degToRad(solution.jointValues[`${arm}_J6`] + solution.jointValues[`${arm}_J7`])) < 1.8,
        `${row.name}: ${arm} wrist coupling must hold in the saved result, including the idle arm`);
    }
    assert.equal(solution.collision.clear, true);
    const { mapPose } = solution;
    layer.position.set(mapPose.position.x, mapPose.position.y, mapPose.position.z);
    layer.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(mapPose.rpy[axis])), 'XYZ');
    applyRobotJointValues(fk, solution.jointValues); layer.updateMatrixWorld(true);
    for (const name of locked) assert.equal(solution.jointValues[name], baseline[name]);
    assert.ok(measureMobileTarget(fk.getObjectByName(`zivid_${side}_optical_frame`), mobileSampleTarget(task.mobileCapture.samples.find((s) => s.id === row.sampleId), task), report.options).withinTolerance);
    const checked = checker.check();
    assert.equal(checked.clear, true, `${row.name} ${side}`);
    assert.ok(checked.armBodyClearance.minimum >= report.options.armBodyClearance - 1e-9,
      `${row.name}: both arms, including the idle one, must clear the torso`);
    assert.ok(Math.abs(checked.armBodyClearance.minimum - solution.collision.armBodyClearance.minimum) < 1e-8);
    if (side === row.selectedSide) clearances.push(checked.armBodyClearance.minimum);
    fk.traverse((node) => {
      if (!['revolute', 'prismatic'].includes(node.userData.jointType)) return;
      const { jointValue } = node.userData;
      const jointLimit = getRobotJointLimits(node);
      assert.ok(jointValue >= jointLimit.lower - 1e-9 && jointValue <= jointLimit.upper + 1e-9);
      const solvedValue = node.userData.jointType === 'prismatic' ? solution.jointValues[node.name]
        : THREE.MathUtils.degToRad(solution.jointValues[node.name]);
      assert.ok(solvedValue >= jointLimit.lower - 1e-9 && solvedValue <= jointLimit.upper + 1e-9,
        `${row.name} ${node.name}: the saved solver result must obey the operating limits before FK clamping`);
    });
  }
}
const sharedStops = [...parkingSides.values()].filter((sides) => sides.size === 2).length;
// The coupled wrist excludes some formerly feasible shared stops. Preserve
// full target coverage and at least one shared stop under the stricter model.
assert.ok(sharedStops >= 1, `both arms should still share a comfortable stop: ${sharedStops}`);
assert.ok(clearances.reduce((sum, value) => sum + value, 0) / clearances.length > 0.07,
  'seek comfort beyond merely scraping through the 5 cm hard minimum');
const saved = buildMobileSolvedTask(task, report, {}, 'botx-solved');
assert.equal(saved.parkingPoints.length, report.parkingCount);
const normalized = normalizeTeachingTasks([saved])[0];
assert.deepEqual(normalized.parkingPoints.map((p) => p.mapPose), saved.parkingPoints.map((p) => p.mapPose));
const savedIds = normalized.parkingPoints.flatMap((p) => p.poses.flatMap((pose) => pose.mobileSampleIds || [pose.mobileSampleId]));
assert.deepEqual(savedIds, report.rows.map((row) => row.sampleId), 'playback follows the planned shooting order');
assert.deepEqual([...savedIds].sort(), task.mobileCapture.samples.map((s) => s.id).sort(), 'each source sample is covered exactly once');
const trajectory = buildTeachingTaskTrajectory({ task: normalized });
const holds = trajectory.segments.filter((segment) => segment.phase === 'hold');
assert.ok(report.dualMotionCount >= 1, 'compatible left/right targets should produce simultaneous motions');
assert.equal(holds.length, report.motionCount);
assert.equal(report.motionCount + report.dualMotionCount, 16, 'two samples per dual motion, one per single motion');
for (const [i, segment] of holds.entries()) {
  const members = mobileMotionGroups(report)[i];
  for (const row of members) {
    assert.deepEqual(segment.toPose, row.mapPose, 'playback holds use each solved chassis pose');
    const jointValues = row.solutions[row.selectedSide].jointValues;
    assert.deepEqual(Object.keys(segment.toJointValues).sort(), Object.keys(jointValues).sort());
    // Serialization may round a degree/radian conversion by one ULP.
    for (const name of Object.keys(jointValues)) assert.ok(Math.abs(segment.toJointValues[name] - jointValues[name]) < 1e-9,
      `both targets use the same joint state: ${name}`);
  }
}

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
  applyRobotJointValues(fk, known.joints);
  // These seed fixtures predate the coupled wrist. Generate reachable targets
  // from poses satisfying today's mechanical constraints before testing IK.
  const couplingPairs = getRobotJointCouplingPairs(fk);
  assert.ok(projectRobotJointCoupling(couplingPairs, new Set(couplingPairs.flatMap(({ joints }) => joints)), setRobotJointValue));
  layer.position.set(0, 0, 0); layer.rotation.set(0, 0, 0); layer.updateMatrixWorld(true);
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
console.log(`BOTX regression: 16/16 targets, ${report.parkingCount} parking points, ${report.motionCount} motions (${report.dualMotionCount} simultaneous), minimum torso buffer ${(Math.min(...clearances) * 100).toFixed(2)} cm; independent FK, collision, limits, persistence and tight-tolerance targets passed.`);
