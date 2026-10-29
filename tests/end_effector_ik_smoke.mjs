import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { restoreMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { applyRobotJointValues, configureRobotArmSoftLimits, getRobotEndEffector,
  readRobotJointValues, setRobotJointValue } from "../src/features/robot/model/robotLoader.js";
import { getRobotJointLimits } from "../src/features/robot/model/robotJointLimits.js";
import { solveEndEffectorIk } from "../src/features/robot/model/robotEndEffectorIk.js";

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const comfortable = [-20, -30, 15, 45, -12, 5, 8];
const zero = [0, 0, 0, 0, 0, 0, 0];
const timings = [];
function setup(side = 'left', ratio = 0.95, values = comfortable) {
  const robot = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group();
  layer.add(robot);
  configureRobotArmSoftLimits(robot, ratio);
  applyRobotJointValues(robot, Object.fromEntries(values.map((value, i) => [`${side}_J${i + 1}`, side === 'left' ? value : -value])));
  layer.updateMatrixWorld(true);
  const controller = getRobotEndEffector(robot, side);
  const frozen = new Set(controller.joints.filter((joint) => !joint.name.startsWith(`${side}_J`)));
  const referenceJointValues = readRobotJointValues(robot);
  const position = controller.frame.getWorldPosition(new THREE.Vector3());
  const quaternion = controller.frame.getWorldQuaternion(new THREE.Quaternion());
  return { robot, layer, controller, frozen, referenceJointValues, position, quaternion };
}
function solve(state, position = state.position, quaternion = state.quaternion) {
  const before = readRobotJointValues(state.robot);
  const result = solveEndEffectorIk(state.controller, position, quaternion, state.frozen, {
    referenceJointValues: state.referenceJointValues,
  });
  timings.push(result.solveMs);
  const actual = state.controller.frame.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(actual.distanceTo(position) - result.positionError) < 1e-10);
  for (const joint of state.controller.joints) {
    const { lower, upper } = getRobotJointLimits(joint);
    assert.ok(Number.isFinite(joint.userData.jointValue));
    assert.ok(joint.userData.jointValue >= lower - 1e-10 && joint.userData.jointValue <= upper + 1e-10,
      `${joint.name} must obey the configured operating range`);
    if (state.frozen.has(joint)) assert.equal(readRobotJointValues(state.robot)[joint.name], before[joint.name]);
  }
  return result;
}
function drift(state) {
  const values = readRobotJointValues(state.robot);
  return Math.max(...state.controller.joints.map((joint) => Math.abs(values[joint.name] - state.referenceJointValues[joint.name])));
}

// A straight-arm out-and-back path formerly left J3/J5 counter-rotated by
// 103 degrees, despite sub-millimeter endpoint error. Exercise both mirrored
// chains and the asymmetric operating bounds, not just endpoint accuracy.
for (const side of ['left', 'right']) {
  for (const [ratio, allowedDrift] of [[0.95, 1], [0.8, 6], [0.5, 6], [0.01, 2], [1, 1]]) {
    const state = setup(side, ratio, zero);
    const reference = { ...state.referenceJointValues };
    let result;
    for (const i of [...Array.from({ length: 40 }, (_, i) => i + 1), ...Array.from({ length: 40 }, (_, i) => 39 - i)]) {
      const target = state.position.clone();
      target.y += (side === 'left' ? -0.2 : 0.2) * i / 40;
      result = solve(state, target);
    }
    assert.ok(result.positionError < 0.0005 && result.rotationError < 0.18);
    assert.ok(drift(state) < allowedDrift, `${side}, ${ratio}: drift ${drift(state)} degrees`);
    assert.deepEqual(state.referenceJointValues, reference, 'the drag anchor must not follow intermediate solutions');
  }
}

// Ordinary drag samples must converge in the same call, without a timer,
// accumulated velocity or an extra mouse event to finish following the target.
for (const side of ['left', 'right']) {
  for (const ratio of [0.95, 0.8, 0.5]) {
    const state = setup(side, ratio);
    let previous = readRobotJointValues(state.robot);
    for (let i = 1; i <= 60; i += 1) {
      const target = state.position.clone().add(new THREE.Vector3(-0.08 * i / 60, 0, 0));
      const result = solve(state, target);
      assert.equal(result.status, 'tracking');
      assert.ok(result.positionError < 0.001 && result.rotationError < 0.18);
      const values = readRobotJointValues(state.robot);
      assert.ok(Math.max(...Object.keys(previous).map((name) => Math.abs(values[name] - previous[name]))) < 1.5);
      previous = values;
    }
  }
  const state = setup(side);
  for (let i = 1; i <= 30; i += 1) {
    const target = state.quaternion.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), i / 30 * 0.07));
    const result = solve(state, state.position, target);
    assert.equal(result.status, 'tracking');
    assert.ok(result.positionError < 0.001 && result.rotationError < 0.18);
  }
}

// A large pointer or numeric-input change also solves immediately. Retain
// similar endpoint accuracy at sparse and dense mouse event rates.
for (const count of [1, 8, 80]) {
  const state = setup();
  let result;
  for (let i = 1; i <= count; i += 1) result = solve(state, state.position.clone().add(new THREE.Vector3(-0.1 * i / count, 0, 0)));
  assert.ok(result.positionError < 0.001 && result.rotationError < 0.18, `event count ${count}`);
}

// A joint already at a bound must be free to turn inward. Keeping all other
// joints frozen makes the reachable FK target unambiguous.
for (const ratio of [0.95, 0.8, 0.5, 0.01, 1]) {
  for (const side of ['left', 'right']) for (const boundary of ['lower', 'upper']) {
    const state = setup(side, ratio);
    const joint = state.robot.getObjectByName(`${side}_J2`);
    state.frozen = new Set(state.controller.joints.filter((candidate) => candidate !== joint));
    const limits = getRobotJointLimits(joint);
    const start = limits[boundary], inward = start + (boundary === 'lower' ? 1 : -1) * Math.min(0.03, (limits.upper - limits.lower) / 4);
    setRobotJointValue(joint, inward); state.robot.updateMatrixWorld(true);
    const p = state.controller.frame.getWorldPosition(new THREE.Vector3()), q = state.controller.frame.getWorldQuaternion(new THREE.Quaternion());
    setRobotJointValue(joint, start); state.robot.updateMatrixWorld(true);
    state.referenceJointValues = readRobotJointValues(state.robot);
    solve(state, p, q);
    assert.ok(Math.abs(joint.userData.jointValue - inward) < 0.001);
  }
}

// Reconfigure the same loaded model while retaining an old reference. Bounds
// are recomputed from the original URDF, including at 1%, without double shrink.
{
  const state = setup();
  for (const ratio of [0.8, 0.5, 0.01, 1, 0.95]) {
    configureRobotArmSoftLimits(state.robot, ratio);
    solve(state, state.position.clone().add(new THREE.Vector3(0.8, -0.5, 0.3)));
    for (const joint of state.controller.joints.filter((joint) => /^left_J/.test(joint.name))) {
      assert.equal(getRobotJointLimits(joint).softLimitRatio, ratio);
    }
  }
  state.frozen = new Set(state.controller.joints);
  const before = readRobotJointValues(state.robot);
  assert.equal(solve(state).status, 'limited');
  assert.deepEqual(readRobotJointValues(state.robot), before);
}

// Repeated requests to an unreachable target settle, rather than wind the arm
// indefinitely or return a failed trial step.
{
  const state = setup();
  const target = state.position.clone().add(new THREE.Vector3(2, 0, 0));
  for (let i = 0; i < 20; i += 1) assert.equal(solve(state, target).status, 'limited');
  const before = readRobotJointValues(state.robot);
  for (let i = 0; i < 20; i += 1) solve(state, target);
  const after = readRobotJointValues(state.robot);
  assert.ok(Math.max(...Object.keys(before).map((key) => Math.abs(after[key] - before[key]))) < 0.1);
}

// Optical +Z points outward at full extension. The old solver moved 18 mm
// sideways and increased position error beyond the requested 70 mm. An
// unreachable camera command must settle, while the opposite direction tracks.
for (const direction of [-1, 1]) {
  const state = setup('left', 0.95, zero);
  state.controller = { ...state.controller, frame: state.robot.getObjectByName('zivid_left_optical_frame') };
  state.position = state.controller.frame.getWorldPosition(new THREE.Vector3());
  state.quaternion = state.controller.frame.getWorldQuaternion(new THREE.Quaternion());
  const target = state.position.clone().add(new THREE.Vector3(0, 0, direction * 0.07).applyQuaternion(state.quaternion));
  const result = solve(state, target);
  if (direction > 0) {
    assert.equal(result.status, 'limited');
    assert.ok(result.positionError ** 2 + (0.24 * THREE.MathUtils.degToRad(result.rotationError)) ** 2 <= 0.07 ** 2);
    assert.ok(state.controller.frame.getWorldPosition(new THREE.Vector3()).distanceTo(state.position) < 0.003);
  } else {
    assert.equal(result.status, 'tracking');
    assert.ok(result.positionError < 0.001 && result.rotationError < 0.18);
  }
}

timings.sort((a, b) => a - b);
console.log(`Interactive IK passed: mirrored arms, posture drift, smooth translation/rotation, sparse input, locked joints, inward recovery and live 1–100% soft limits. ${timings.length} solves; p95 ${timings[Math.floor(timings.length * 0.95)].toFixed(3)} ms.`);
