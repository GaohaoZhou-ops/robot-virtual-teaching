import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { ARM_JOINT_COUPLING_LIMIT, configureRobotJointCoupling, getRobotJointCouplingPairs,
  normalizeArmJointCouplingEnabled, projectRobotJointCoupling, robotJointCouplingViolations } from '../src/lib/robotJointCoupling.js';
import { getRobotJointLimits } from '../src/lib/robotJointLimits.js';
import { solveEndEffectorIk } from '../src/lib/robotEndEffectorIk.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { buildMobileSolvedTask, normalizeMobileSolveReport, solveMobileTeaching } from '../src/lib/mobileTeachingSolver.js';
import { buildTeachingTaskTrajectory, sampleTeachingTrajectorySegment } from '../src/lib/teachingPlayback.js';
import { buildExport, normalizeProject } from '../src/lib/io.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const rad = THREE.MathUtils.degToRad;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// Two coaxial wrist joints give an analytical target: the tool's yaw equals
// J6 + J7. A 2.1 rad target is impossible with coupling and reachable without.
function wrist(side = 'left', separator = '_') {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  let parent = robot;
  for (const index of [6, 7]) {
    const joint = new THREE.Group(); joint.name = `${side}${separator}J${index}`;
    joint.userData = { jointType: 'revolute', jointValue: 0, jointAxis: [0, 0, 1],
      restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1], jointLimit: { lower: -2, upper: 2 } };
    parent.add(joint); parent = joint;
  }
  const tool = new THREE.Group(); tool.name = `tool_${side}`; parent.add(tool);
  const controller = getRobotEndEffector(robot, side);
  return { robot, controller, pair: getRobotJointCouplingPairs(robot)[0].joints };
}
const target = (angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);

for (const value of [undefined, null, 0, 'false', true]) assert.equal(normalizeArmJointCouplingEnabled(value), true);
assert.equal(normalizeArmJointCouplingEnabled(false), false);
for (const side of ['left', 'right']) for (const sign of [-1, 1]) {
  const { robot, controller, pair } = wrist(side, side === 'right' ? '-' : '_');
  const pairs = getRobotJointCouplingPairs(robot);
  setRobotJointValue(pair[0], sign * 0.8); setRobotJointValue(pair[1], sign);
  assert.equal(robotJointCouplingViolations(pairs).length, 1, 'equality at ±1.8 is invalid');
  setRobotJointValue(pair[0], sign * 0.8); setRobotJointValue(pair[1], -sign * 1.2);
  assert.equal(robotJointCouplingViolations(pairs).length, 0, 'use |J6+J7|, not |J6|+|J7|');
  setRobotJointValue(pair[0], sign * 0.8); setRobotJointValue(pair[1], sign * 1.3);
  assert.equal(projectRobotJointCoupling(pairs, new Set(), setRobotJointValue), false);
  const locked = pair[0].userData.jointValue;
  assert.equal(projectRobotJointCoupling(pairs, new Set([pair[1]]), setRobotJointValue), true);
  assert.equal(pair[0].userData.jointValue, locked);
  assert.ok(Math.abs(pair[0].userData.jointValue + pair[1].userData.jointValue) < 1.8);

  const result = solveEndEffectorIk(controller, new THREE.Vector3(), target(sign * 2.1));
  assert.equal(result.status, 'limited');
  assert.equal(robotJointCouplingViolations(pairs).length, 0);
  // A wrist on the coupled boundary must be able to return inward.
  const inward = solveEndEffectorIk(controller, new THREE.Vector3(), target(sign * 1.7));
  assert.equal(inward.status, 'tracking');
  assert.ok(inward.rotationError < 0.18);
  configureRobotJointCoupling(robot, false);
  assert.equal(solveEndEffectorIk(controller, new THREE.Vector3(), target(sign * 2.1)).status, 'tracking');
  assert.ok(Math.abs(pair[0].userData.jointValue + pair[1].userData.jointValue) > 1.8);
  const snapshot = serializeMobileTeachingRobot(robot);
  const copy = restoreMobileTeachingRobot(snapshot);
  configureRobotJointCoupling(robot, true);
  assert.equal(getRobotJointCouplingPairs(copy).length, 0, 'dispatched worker retains its setting');
  assert.equal(getRobotJointCouplingPairs(robot.clone(true)).length, 1);
}

// Actual BOTX joint ranges are asymmetric. Correct both arms at both signed
// extremes without violating the tighter J6 range or moving a locked J6.
for (const sign of [-1, 1]) {
  const robot = restoreMobileTeachingRobot(fixture.robot);
  const pairs = getRobotJointCouplingPairs(robot);
  assert.equal(pairs.length, 2);
  for (const { joints } of pairs) for (const joint of joints) setRobotJointValue(joint, sign * 999);
  const lockedValues = pairs.map(({ joints }) => joints[0].userData.jointValue);
  assert.ok(projectRobotJointCoupling(pairs, new Set(pairs.map(({ joints }) => joints[1])), setRobotJointValue));
  pairs.forEach(({ joints }, index) => {
    assert.equal(joints[0].userData.jointValue, lockedValues[index]);
    assert.ok(Math.abs(joints.reduce((sum, joint) => sum + joint.userData.jointValue, 0)) < ARM_JOINT_COUPLING_LIMIT);
    for (const joint of joints) {
      const { lower, upper } = getRobotJointLimits(joint);
      assert.ok(joint.userData.jointValue >= lower && joint.userData.jointValue <= upper);
    }
  });
  const serialized = readRobotJointValues(robot);
  for (const side of ['left', 'right']) assert.ok(Math.abs(rad(serialized[`${side}_J6`] + serialized[`${side}_J7`])) < 1.8);
}

for (const enabled of [undefined, true, false]) {
  const exported = buildExport({ mapData: { name: 'coupling.ply' }, heightRange: [0, 1], waypoints: [], edges: [],
    robot: { id: 'botx.urdf', relativePath: 'botx.urdf' }, robotArmJointCouplingEnabled: enabled });
  assert.equal(normalizeProject(JSON.parse(JSON.stringify(exported))).robot.armJointCouplingEnabled, enabled ?? true);
}
assert.equal(normalizeProject({ robot: { relativePath: 'legacy.urdf' } }).robot.armJointCouplingEnabled, true);

// Exercise the complete background planner on a private worker-equivalent
// snapshot, including an exact but invalid pose with both wrist joints locked.
for (const enabled of [true, false]) for (const start of ['zero', 'outside', 'locked']) {
  const locked = start === 'locked';
  const { robot, pair } = wrist();
  configureRobotJointCoupling(robot, enabled);
  if (start !== 'zero') pair.forEach((joint) => setRobotJointValue(joint, 1.05));
  const initial = readRobotJointValues(robot);
  const q = target(2.1);
  const task = { id: 'coupled-wrist', coordinateFrame: 'virtual_origin', mobileCapture: { id: 'capture', samples: [
    { id: 'target', kind: 'keyframe', cameraPose: { position: { x: 0, y: 0, z: 0 },
      quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } } },
  ] } };
  const report = await solveMobileTeaching({ robot: restoreMobileTeachingRobot(serializeMobileTeachingRobot(robot)), task, mapPose: {},
    lockedJointNames: locked ? pair.map((joint) => joint.name) : [],
    options: { targetFrame: 'tool', armMode: 'left', parkingMode: 'fixed', checkCollisions: false,
      allowTorsoHeight: false, lockChestVertical: false,
      positionTolerance: { x: 0.001, y: 0.001, z: 0.001 }, rotationTolerance: { roll: 0.1, pitch: 0.1, yaw: 0.1 } } });
  assert.equal(report.feasibleCount, enabled ? 0 : 1);
  assert.equal(report.armJointCouplingEnabled, enabled);
  if (enabled && !locked) assert.ok(Math.abs(rad(report.initialJointValues.left_J6 + report.initialJointValues.left_J7)) < 1.8,
    'the saved trajectory start must obey coupling as well as its destinations');
  assert.deepEqual(readRobotJointValues(robot), initial, 'planning never mutates the live model');
  assert.ok(normalizeMobileSolveReport(JSON.parse(JSON.stringify(report))));
  const solution = report.rows[0].solutions.left;
  if (enabled && locked) {
    assert.match(solution.reason, /关节6–7角度耦合超限/);
    assert.deepEqual(solution.jointValues, initial, 'locked joints remain unchanged even for an invalid seed');
  } else if (enabled) assert.ok(Math.abs(rad(solution.jointValues.left_J6 + solution.jointValues.left_J7)) < 1.8);
  if (!enabled && locked) close(solution.rotationError.yaw, 0);
}

// A new trajectory seeded from an invalid live wrist must remain inside the
// constraint from its recorded start through the interpolation and final pose.
{
  const { robot, pair } = wrist();
  pair.forEach((joint) => setRobotJointValue(joint, 1.05));
  const q = target(1.7);
  const task = { id: 'safe-start', name: 'Safe start', coordinateFrame: 'virtual_origin', map: {},
    mobileCapture: { id: 'capture', samples: [{ id: 'inward', kind: 'keyframe', cameraPose: {
      position: { x: 0, y: 0, z: 0 }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
    } }] } };
  const report = await solveMobileTeaching({ robot, task, mapPose: {}, options: {
    targetFrame: 'tool', armMode: 'left', parkingMode: 'fixed', checkCollisions: false,
    allowTorsoHeight: false, lockChestVertical: false,
    rotationTolerance: { roll: 0.1, pitch: 0.1, yaw: 0.1 },
  } });
  assert.equal(report.feasibleCount, 1);
  const solved = buildMobileSolvedTask(task, report, {}, 'solved');
  const trajectory = buildTeachingTaskTrajectory({ task: solved });
  for (const segment of trajectory.segments) for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const values = sampleTeachingTrajectorySegment(segment, progress).robotJointValues;
    assert.ok(Math.abs(rad(values.left_J6 + values.left_J7)) < 1.8, `${segment.phase} at ${progress}`);
  }
}

console.log('PASS coupling: strict signed boundaries, algebraic sum, locks, inward recovery, real BOTX bounds, IK/planner on/off, worker isolation, project persistence and trajectory interpolation');
