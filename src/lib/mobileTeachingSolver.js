import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, normalizeRobotPose, readRobotJointValues, setRobotJointValue } from './robotLoader.js';
import { mobileCaptureMatrix } from './ipadCaptureDisplay.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from './mobileTeachingKinematics.js';
import { createMobileCollisionChecker } from './mobileTeachingCollision.js';
import { mobileParkingCandidates, mobileParkingKey, mobileSolutionMapPose } from './mobileTeachingParking.js';

const XYZ = ['x', 'y', 'z'];
const RPY = ['roll', 'pitch', 'yaw'];
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const plain = (v) => Object.fromEntries(XYZ.map((axis) => [axis, v[axis]]));
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const abort = (signal) => { if (signal?.aborted) throw new DOMException('计算已取消', 'AbortError'); };
const TORSO_PITCH_JOINTS = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'];
export const MOBILE_SOLVE_VERSION = 3;

export const DEFAULT_MOBILE_SOLVE_OPTIONS = Object.freeze({
  positionTolerance: Object.freeze({ x: 0.05, y: 0.05, z: 0.05 }),
  rotationTolerance: Object.freeze({ roll: 5, pitch: 5, yaw: 5 }),
  targetFrame: 'optical', armMode: 'both', allowSingleArm: true,
  allowTorsoHeight: true, lockChestVertical: true, respectJointLocks: true, keyframesOnly: true,
  parkingMode: 'auto', checkCollisions: true,
});

export function validateMobileSolveOptions(value = {}) {
  const options = { ...DEFAULT_MOBILE_SOLVE_OPTIONS, ...value };
  for (const [key, axes, maximum] of [['positionTolerance', XYZ, 1], ['rotationTolerance', RPY, 180]]) {
    options[key] = Object.fromEntries(axes.map((axis) => {
      const raw = options[key]?.[axis];
      const number = raw === '' || raw == null ? NaN : Number(raw);
      if (!Number.isFinite(number) || number <= 0 || number > maximum) {
        throw new Error(`${axis.toUpperCase()} 容差必须大于 0 且不超过 ${key === 'positionTolerance' ? '100 cm' : '180°'}`);
      }
      return [axis, number];
    }));
  }
  if (!['optical', 'tool'].includes(options.targetFrame) || !['both', 'left', 'right'].includes(options.armMode)) throw new Error('末端或机械臂配置无效');
  if (!['auto', 'per-pose', 'fixed'].includes(options.parkingMode)) throw new Error('停车点策略无效');
  for (const key of ['allowSingleArm', 'allowTorsoHeight', 'lockChestVertical', 'respectJointLocks', 'keyframesOnly', 'checkCollisions']) {
    if (typeof options[key] !== 'boolean') throw new Error('计算开关配置无效');
  }
  if (options.allowTorsoHeight && !options.lockChestVertical) throw new Error('自动调节胸部高度需要启用前胸垂直锁定');
  return options;
}

export function mobileReportSolveOptions(report) {
  return validateMobileSolveOptions({
    ...(report.version === 1 ? { parkingMode: 'fixed', checkCollisions: false } : {}),
    ...report.options,
    // Reports predating height control must not inherit the new default.
    ...(report.version < MOBILE_SOLVE_VERSION ? { allowTorsoHeight: false } : {}),
  });
}

export function normalizeMobileSolveReport(value) {
  if (!value || ![1, 2, MOBILE_SOLVE_VERSION].includes(value.version) || !Array.isArray(value.rows)) return null;
  try {
    const options = mobileReportSolveOptions(value);
    const validPose = (pose) => XYZ.every((axis) => Number.isFinite(pose?.position?.[axis]))
      && RPY.every((axis) => Number.isFinite(pose?.rpy?.[axis]));
    if (!validPose(value.mapPose)) return null;
    for (const row of value.rows) {
      if (typeof row.sampleId !== 'string' || !row.solutions) return null;
      if (value.version >= 2 && !validPose(row.mapPose)) return null;
      for (const solution of Object.values(row.solutions)) {
        if (!solution.jointValues) { if (solution.feasible) return null; continue; }
        if (!Object.values(solution.jointValues).every(Number.isFinite)
          || !XYZ.every((axis) => Number.isFinite(solution.positionError?.[axis]))
          || !RPY.every((axis) => Number.isFinite(solution.rotationError?.[axis]))) return null;
        if (value.version >= 2 && (!validPose(solution.mapPose)
          || (options.checkCollisions && solution.feasible && (!solution.collision?.checked || !solution.collision.clear)))) return null;
        if (value.version >= MOBILE_SOLVE_VERSION && solution.feasible && options.lockChestVertical
          && (!Number.isFinite(solution.chestTilt) || solution.chestTilt < 0 || solution.chestTilt > 0.25 + 1e-7
            || !Number.isFinite(solution.chestHeight))) return null;
      }
    }
    return structuredClone({ ...value, options });
  } catch { return null; }
}

export function mobileSampleTarget(sample, task) {
  const matrix = mobileCaptureMatrix(task);
  const source = sample.cameraPose;
  const position = new THREE.Vector3(source.position.x, source.position.y, source.position.z).applyMatrix4(matrix);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix).multiply(
    new THREE.Quaternion(source.quaternion.x, source.quaternion.y, source.quaternion.z, source.quaternion.w).normalize(),
  ).normalize();
  return { position, quaternion };
}

// XYZ is measured in the workspace. RPY is the relative orientation in the
// target frame (ZYX), avoiding subtraction of two discontinuous Euler angles.
export function measureMobileTarget(frame, target, options) {
  const position = frame.getWorldPosition(new THREE.Vector3());
  const quaternion = frame.getWorldQuaternion(new THREE.Quaternion());
  const relative = target.quaternion.clone().invert().multiply(quaternion).normalize();
  const angles = new THREE.Euler().setFromQuaternion(relative, 'ZYX');
  const positionError = plain(position.clone().sub(target.position));
  const rotationError = { roll: deg(angles.x), pitch: deg(angles.y), yaw: deg(angles.z) };
  return {
    positionError, rotationError,
    withinTolerance: XYZ.every((axis) => Math.abs(positionError[axis]) <= options.positionTolerance[axis] + 1e-9)
      && RPY.every((axis) => Math.abs(rotationError[axis]) <= options.rotationTolerance[axis] + 1e-7),
    actualPose: { position: plain(position), quaternion: { ...plain(quaternion), w: quaternion.w } },
  };
}

function solveLinear(matrix, vector) {
  const rows = matrix.map((row, i) => [...row, vector[i]]), size = vector.length;
  for (let c = 0; c < size; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < size; r += 1) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-14) return null;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const divisor = rows[c][c];
    for (let j = c; j <= size; j += 1) rows[c][j] /= divisor;
    for (let r = 0; r < size; r += 1) {
      if (r === c) continue;
      const factor = rows[r][c];
      for (let j = c; j <= size; j += 1) rows[r][j] -= factor * rows[c][j];
    }
  }
  return rows.map((row) => row[size]);
}

const rotationVector = (target, actual) => {
  const q = target.clone().multiply(actual.clone().invert()).normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const sine = Math.hypot(q.x, q.y, q.z);
  return sine < 1e-10 ? new THREE.Vector3() : new THREE.Vector3(q.x, q.y, q.z)
    .multiplyScalar(2 * Math.atan2(sine, q.w) / sine);
};

// BOTX's three parallel pitch axes control chest height together. Project a
// seed onto the upright pitch sum within all three limits, rather than keeping
// the initial chest tilt (or clipping a bend and accidentally adding tilt).
// Use world up, so a nonzero chassis pitch is included in the correction.
function seedUprightTorso(robot, chest, joints, start) {
  if (!chest || joints.length !== TORSO_PITCH_JOINTS.length) return;
  robot.parent.updateMatrixWorld(true);
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
  const axis = new THREE.Vector3().fromArray(joints[0].userData.jointAxis)
    .applyQuaternion(joints[0].getWorldQuaternion(new THREE.Quaternion())).normalize();
  const worldUp = new THREE.Vector3(0, 0, 1);
  const correction = Math.atan2(axis.dot(up.clone().cross(worldUp)), up.dot(worldUp) - up.dot(axis) * worldUp.dot(axis));
  const sum = joints.reduce((value, joint) => value + joint.userData.jointValue, 0) + correction;
  const bend = Math.max(0, start - 2) * 0.25;
  const values = joints.map((joint, i) => THREE.MathUtils.clamp(start < 2 ? joint.userData.jointValue : [bend, -2 * bend, bend][i],
    joint.userData.jointLimit.lower, joint.userData.jointLimit.upper));
  for (let iteration = 0; iteration < joints.length; iteration += 1) {
    const remaining = sum - values.reduce((total, value) => total + value, 0);
    if (Math.abs(remaining) < 1e-10) break;
    const free = joints.map((joint, i) => i).filter((i) => remaining > 0
      ? values[i] < joints[i].userData.jointLimit.upper - 1e-10 : values[i] > joints[i].userData.jointLimit.lower + 1e-10);
    if (!free.length) break;
    for (const i of free) values[i] = THREE.MathUtils.clamp(values[i] + remaining / free.length,
      joints[i].userData.jointLimit.lower, joints[i].userData.jointLimit.upper);
  }
  joints.forEach((joint, i) => setRobotJointValue(joint, values[i]));
}

// All computations use a private model. Joint limits are enforced on every
// update; chest verticality is a world-up constraint, independent of yaw.
async function solveArm({ controller, chest, target, options, locked, baseline, postureReference, seed, checkpoint, collisionChecker }) {
  const { robot, frame } = controller;
  const joints = controller.joints.filter((joint) => !locked.has(joint.name));
  const chestJoints = new Set();
  for (let node = chest; node && node !== robot; node = node.parent) chestJoints.add(node);
  const torsoJoints = TORSO_PITCH_JOINTS.map((name) => joints.find((joint) => joint.name === name)).filter(Boolean);
  const targetInverse = target.quaternion.clone().invert();
  const weights = [...XYZ.map((axis) => 0.05 / options.positionTolerance[axis]),
    ...RPY.map((axis) => 0.24 * 5 / options.rotationTolerance[axis])];
  const postureCost = () => joints.reduce((sum, joint) => {
    const { jointValue: value, jointType, jointLimit = {} } = joint.userData;
    const linear = jointType === 'prismatic', unit = linear ? 0.5 : Math.PI;
    const reference = linear ? (seed[joint.name] || 0) : rad(seed[joint.name] || 0);
    const origin = linear ? (postureReference[joint.name] || 0) : rad(postureReference[joint.name] || 0);
    const delta = (a, b) => jointType === 'continuous' ? Math.atan2(Math.sin(a - b), Math.cos(a - b)) : a - b;
    const range = jointLimit.upper - jointLimit.lower;
    const margin = Number.isFinite(range) && range > 0
      ? Math.min(value - jointLimit.lower, jointLimit.upper - value) / range : 1;
    return sum + (chestJoints.has(joint) ? 3 : 1) * ((delta(value, reference) / unit) ** 2
      + 0.2 * (delta(value, origin) / unit) ** 2) + 0.15 * (Math.max(0, 0.1 - margin) / 0.1) ** 2;
  }, 0) / Math.max(1, joints.length);
  const measure = () => {
    robot.parent.updateMatrixWorld(true);
    const actualPosition = frame.getWorldPosition(new THREE.Vector3());
    const actualQuaternion = frame.getWorldQuaternion(new THREE.Quaternion());
    const position = target.position.clone().sub(actualPosition);
    const rotation = rotationVector(target.quaternion, actualQuaternion).applyQuaternion(targetInverse);
    const up = chest ? new THREE.Vector3(0, 0, 1).applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion())) : null;
    const error = [...position.toArray(), ...rotation.toArray()].map((n, i) => n * weights[i]);
    if (up) error.push(-up.x * 2, -up.y * 2, (1 - up.z) * 2);
    const metrics = measureMobileTarget(frame, target, options);
    const chestTilt = up ? deg(up.angleTo(new THREE.Vector3(0, 0, 1))) : 0;
    const chestHeight = chest ? chest.getWorldPosition(new THREE.Vector3()).z - robot.parent.position.z : null;
    const feasible = metrics.withinTolerance && chestTilt <= 0.25;
    const cost = error.reduce((sum, n) => sum + n * n, 0);
    return { ...metrics, feasible, chestTilt, chestHeight, actualPosition, up, error, cost, score: postureCost() + cost * 0.2 };
  };
  let best = null;
  // Continuity seed first, followed by independent, deterministic restarts.
  for (let start = 0; start < 8; start += 1) {
    await checkpoint();
    applyRobotJointValues(robot, baseline);
    if (start === 0) joints.forEach((joint) => {
      if (Number.isFinite(seed[joint.name])) setRobotJointValue(joint,
        joint.userData.jointType === 'prismatic' ? seed[joint.name] : rad(seed[joint.name]));
    });
    if (start > 1) joints.forEach((joint, index) => {
      if (chestJoints.has(joint)) return;
      const wave = Math.sin((index + 1) * (start + 1) * 1.7);
      const { lower, upper } = joint.userData.jointLimit || {};
      const amount = (joint.userData.jointType === 'prismatic' ? 0.06 : 0.9) * wave;
      setRobotJointValue(joint, start >= 5 && Number.isFinite(lower) && Number.isFinite(upper)
        ? lower + (upper - lower) * (0.5 + 0.4 * wave) : joint.userData.jointValue + amount);
    });
    // Include standing and crouched seeds to escape the zero vertical
    // derivative at full extension, even when starting from a tilted chest.
    seedUprightTorso(robot, chest, torsoJoints, start);
    for (let iteration = 0; iteration <= 120; iteration += 1) {
      if (iteration % 12 === 0) await checkpoint();
      const state = measure();
      const kinematicallyFeasible = state.feasible;
      if (kinematicallyFeasible && collisionChecker) {
        state.collision = collisionChecker.check();
        state.feasible = state.collision.clear;
      }
      if (!best || (state.feasible && !best.feasible) || (state.feasible === best.feasible
        && (state.feasible ? state.score < best.score : state.cost < best.cost))) {
        best = { ...state, jointValues: readRobotJointValues(robot) };
      }
      if (kinematicallyFeasible || !joints.length || iteration === 120) break;
      const columns = joints.map((joint) => {
        const axis = new THREE.Vector3().fromArray(joint.userData.jointAxis || [0, 0, 1])
          .applyQuaternion(joint.getWorldQuaternion(new THREE.Quaternion())).normalize();
        const prismatic = joint.userData.jointType === 'prismatic';
        const dp = prismatic ? axis.clone() : axis.clone().cross(state.actualPosition.clone().sub(joint.getWorldPosition(new THREE.Vector3())));
        const dr = prismatic ? new THREE.Vector3() : axis.clone().applyQuaternion(targetInverse);
        const column = [...dp.toArray(), ...dr.toArray()].map((n, i) => n * weights[i]);
        if (state.up) column.push(...(chestJoints.has(joint) && !prismatic
          ? axis.clone().cross(state.up).multiplyScalar(2).toArray() : [0, 0, 0]));
        return column;
      });
      const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
      const before = joints.map((joint) => joint.userData.jointValue);
      let improved = false;
      for (const damping of [0.001, 0.02, 0.2]) {
        let active = joints.map((_, i) => i), step = null;
        // A joint blocked by its bound must leave the linear solve; merely
        // clipping its update can cancel progress for all remaining joints.
        while (active.length) {
          const values = solveLinear(active.map((i) => active.map((j) => dot(columns[i], columns[j]) + (i === j ? damping : 0))),
            active.map((i) => dot(columns[i], state.error)));
          if (!values) break;
          step = joints.map(() => 0); active.forEach((i, k) => { step[i] = values[k]; });
          const free = active.filter((i) => {
            const { lower, upper } = joints[i].userData.jointLimit || {};
            return !((before[i] <= lower + 1e-8 && step[i] < 0) || (before[i] >= upper - 1e-8 && step[i] > 0));
          });
          if (free.length === active.length) break;
          active = free; step = null;
        }
        if (!step) continue;
        const scale = Math.min(1, 0.25 / Math.max(...step.map(Math.abs), 1e-12));
        for (const line of [1, 0.5, 0.2, 0.05]) {
          joints.forEach((joint, i) => setRobotJointValue(joint, before[i] + step[i] * scale * line));
          if (measure().cost < state.cost - 1e-12) { improved = true; break; }
        }
        if (improved) break;
        joints.forEach((joint, i) => setRobotJointValue(joint, before[i]));
      }
      if (!improved) break;
    }
    if (best?.feasible && start >= 2 && best.score < 0.025) break;
  }
  applyRobotJointValues(robot, best.jointValues);
  const metrics = measure();
  const collision = metrics.feasible && collisionChecker ? collisionChecker.check() : null;
  const feasible = metrics.feasible && (!collision || collision.clear);
  const collisionReason = collision && !collision.clear
    ? [collision.selfPairs.length ? '机器人自身干涉' : '', collision.environmentLinks.length ? '机器人与工件干涉' : '', collision.groundLinks.length ? '机器人低于支撑平面' : ''].filter(Boolean).join('；') : '';
  return { feasible, frameName: frame.name, positionError: metrics.positionError,
    rotationError: metrics.rotationError, chestTilt: metrics.chestTilt, chestHeight: metrics.chestHeight, actualPose: metrics.actualPose,
    jointValues: best.jointValues, score: metrics.score, errorCost: metrics.cost,
    collision: collision || { checked: false, clear: false },
    reason: feasible ? '' : collisionReason || (metrics.chestTilt > 0.25
      ? options.allowTorsoHeight ? '前胸未满足垂直约束，请检查底盘倾斜或躯干行程' : '前胸未满足垂直约束，可开启自动调节胸部高度或检查关节锁定'
      : '当前停车点、关节限位或锁定下未找到容差内解') };
}

export async function solveMobileTeaching({ robot: liveRobot, task, mapPose, environment, options: rawOptions, lockedJointNames = [], signal, onProgress, onSample, waitIfPaused }) {
  const checkpoint = async () => {
    await pause();
    abort(signal);
    await waitIfPaused?.();
    abort(signal);
  };
  const options = validateMobileSolveOptions(rawOptions);
  const samples = (task.mobileCapture?.samples || []).filter((sample) => !options.keyframesOnly || sample.kind === 'keyframe');
  if (!samples.length) throw new Error('没有可计算的采样点，请检查采样范围');
  if (!liveRobot) throw new Error('请先加载机器人模型');
  abort(signal);
  const robot = restoreMobileTeachingRobot(serializeMobileTeachingRobot(liveRobot, { includeCollision: options.checkCollisions })), layer = new THREE.Group();
  layer.add(robot);
  const basePose = normalizeRobotPose(mapPose);
  const place = (pose) => {
    layer.position.set(...XYZ.map((axis) => pose.position[axis]));
    // Match the workbench's existing base-pose convention exactly.
    layer.rotation.set(...RPY.map((axis) => rad(pose.rpy[axis])), 'XYZ');
    layer.updateMatrixWorld(true);
  };
  place(basePose);
  try {
    const sides = options.armMode === 'both' ? ['left', 'right'] : [options.armMode];
    const controllers = Object.fromEntries(sides.map((side) => {
      const controller = getRobotEndEffector(robot, side);
      const frame = options.targetFrame === 'tool' ? controller?.frame : robot.getObjectByName(`zivid_${side}_optical_frame`);
      return [side, controller && frame ? { ...controller, frame } : null];
    }));
    if (!sides.some((side) => controllers[side])) throw new Error(options.targetFrame === 'optical' ? '模型缺少末端相机光学坐标系，可切换为工具末端' : '模型缺少可求解的工具末端');
    const chest = options.lockChestVertical ? robot.getObjectByName('waist_yaw_L') : null;
    if (options.lockChestVertical && !chest) throw new Error('当前模型不支持前胸垂直约束，请关闭此选项');
    let baseline = readRobotJointValues(robot);
    const postureReference = baseline;
    const seeds = { left: baseline, right: baseline };
    const locked = new Set(options.respectJointLocks ? lockedJointNames : []);
    const heightJoints = TORSO_PITCH_JOINTS.map((name) => robot.getObjectByName(name));
    const heightJointNames = options.allowTorsoHeight && heightJoints.every((joint) => joint?.userData.jointType === 'revolute')
      ? [...TORSO_PITCH_JOINTS] : [];
    // Explicit automatic height control overrides only these three locks.
    // Other body/arm locks and every URDF joint limit remain in effect.
    heightJointNames.forEach((name) => locked.delete(name));
    const collisionChecker = options.checkCollisions ? await createMobileCollisionChecker(robot, environment, checkpoint) : null;
    const rows = [];
    let feasibleCount = 0, parkingCount = 0, previousPose = null, previousSide = null;
    const positionInRange = (controller, target) => {
      const root = controller.joints.filter((joint) => !locked.has(joint.name)).at(-1);
      if (!root) return true;
      let reach = 0;
      for (let node = controller.frame; node && node !== root; node = node.parent) {
        reach += node.position.length();
        if (node.userData.jointType === 'prismatic') {
          const limit = node.userData.jointLimit;
          if (!Number.isFinite(limit?.lower) || !Number.isFinite(limit?.upper)) return true;
          reach += Math.abs(limit.upper - limit.lower);
        }
      }
      if (root.userData.jointType === 'prismatic') {
        const limit = root.userData.jointLimit;
        if (!Number.isFinite(limit?.lower) || !Number.isFinite(limit?.upper)) return true;
        reach += Math.abs(limit.upper - limit.lower);
      }
      // Account for URDF/model scale without assuming a one-metre arm.
      reach *= Math.max(...root.getWorldScale(new THREE.Vector3()).toArray().map(Math.abs));
      return root.getWorldPosition(new THREE.Vector3()).distanceTo(target.position)
        <= reach + Math.hypot(...XYZ.map((axis) => options.positionTolerance[axis])) + 1e-8;
    };
    for (const [index, sample] of samples.entries()) {
      await checkpoint();
      onProgress?.({ completed: index, total: samples.length, name: sample.name, feasibleCount });
      const target = mobileSampleTarget(sample, task);
      const candidates = mobileParkingCandidates(target, basePose, previousPose, options.parkingMode);
      let best = null, passingCandidates = 0;
      for (const [candidateIndex, candidatePose] of candidates.entries()) {
        const solutions = {};
        place(candidatePose);
        for (const side of sides) {
          await checkpoint();
          onProgress?.({ completed: index, total: samples.length, name: sample.name, side, feasibleCount,
            candidate: candidateIndex + 1, candidateCount: candidates.length });
          const controller = controllers[side];
          applyRobotJointValues(robot, baseline);
          const solution = !controller ? { feasible: false, reason: '该机械臂或目标坐标系不存在' }
            : !positionInRange(controller, target) ? { feasible: false, reason: '目标超出该停车点的机械臂位置范围' }
              : await solveArm({ controller, chest, target, options, locked, baseline, postureReference, seed: seeds[side], checkpoint, collisionChecker });
          solutions[side] = { ...solution, mapPose: candidatePose };
        }
        const feasibleSides = sides.filter((side) => solutions[side].feasible);
        const feasible = options.armMode === 'both' && !options.allowSingleArm ? feasibleSides.length === 2 : feasibleSides.length > 0;
        const sideScore = (side) => solutions[side].score + (previousSide && side !== previousSide ? 0.08 : 0);
        const selectedSide = feasibleSides.sort((a, b) => sideScore(a) - sideScore(b))[0] || null;
        const reference = previousPose || basePose;
        const travel = Math.hypot(candidatePose.position.x - reference.position.x, candidatePose.position.y - reference.position.y);
        const reused = mobileParkingKey(reference) === mobileParkingKey(candidatePose);
        const score = selectedSide ? sideScore(selectedSide) + Math.min(travel, 10) * 0.005 + (reused ? 0 : 0.025)
          : Math.min(...Object.values(solutions).map((solution) => solution.errorCost ?? Infinity));
        const result = { feasible, selectedSide, solutions, mapPose: candidatePose, score,
          reason: feasible ? '' : feasibleSides.length ? '仅单臂可达，当前要求左右臂在该停车点分别可达'
            : [...new Set(Object.values(solutions).map((solution) => solution.reason).filter(Boolean))].join('；') };
        if (!best || (feasible && !best.feasible) || (feasible === best.feasible && score < best.score)) best = result;
        if (feasible) {
          passingCandidates += 1;
          if ((reused && score < 0.12) || passingCandidates >= 3) break;
        }
      }
      await checkpoint();
      const row = { sampleId: sample.id, name: sample.name || `Pose ${index + 1}`, capturedAt: sample.capturedAt,
        ...best, score: Number.isFinite(best.score) ? best.score : null,
        target: { position: plain(target.position), quaternion: { ...plain(target.quaternion), w: target.quaternion.w } } };
      rows.push(row);
      if (row.feasible) {
        feasibleCount += 1;
        if (!previousPose || options.parkingMode === 'per-pose' || mobileParkingKey(previousPose) !== mobileParkingKey(row.mapPose)) parkingCount += 1;
        row.parkingId = `parking-${parkingCount}`;
        previousPose = row.mapPose; previousSide = row.selectedSide;
        baseline = row.solutions[row.selectedSide].jointValues;
        for (const side of sides) if (row.solutions[side].feasible) seeds[side] = row.solutions[side].jointValues;
      }
      onSample?.({ row, mapPose: row.mapPose, index, total: samples.length });
      onProgress?.({ completed: index + 1, total: samples.length, name: sample.name, feasibleCount });
    }
    await checkpoint();
    return { version: MOBILE_SOLVE_VERSION, taskId: task.id, captureId: task.mobileCapture.id, computedAt: new Date().toISOString(),
      coordinateFrame: task.coordinateFrame, mapPose: basePose, options, lockedJointNames: [...locked], rows,
      heightJointNames, initialJointValues: postureReference,
      sourceCount: task.mobileCapture.samples.length, feasibleCount, parkingCount,
      collisionScreening: collisionChecker ? { enabled: true, method: 'conservative-obb', proxyCount: collisionChecker.proxyCount,
        environmentKind: collisionChecker.environmentKind, environmentCount: collisionChecker.environmentCount } : { enabled: false } };
  } finally {
    layer.clear();
  }
}

export function buildMobileSolvedTask(source, report, robot, id) {
  const points = report.rows.filter((row) => row.feasible && row.solutions[row.selectedSide]?.feasible);
  if (!points.length) throw new Error('没有可保存的可达姿态');
  const parkingPoints = [];
  for (const [index, row] of points.entries()) {
    const solution = row.solutions[row.selectedSide];
    const mapPose = { ...mobileSolutionMapPose(report, row), frameId: source.coordinateFrame };
    let parking = parkingPoints.at(-1);
    if (!parking || report.options.parkingMode === 'per-pose' || mobileParkingKey(parking.mapPose) !== mobileParkingKey(mapPose)) {
      const sequence = parkingPoints.length + 1;
      parking = { id: `${id}-parking-${sequence}`, name: `计算停车点 P${String(sequence).padStart(2, '0')}`, sequence,
        createdAt: report.computedAt, updatedAt: report.computedAt, mapPose, poses: [] };
      parkingPoints.push(parking);
    }
    parking.poses.push({ id: `${id}-pose-${index}`, name: `${row.name} · ${row.selectedSide === 'left' ? '左臂' : '右臂'}`, sequence: parking.poses.length + 1,
      capturedAt: row.capturedAt, mapPose, fullBodyJoints: { angularUnit: 'degree', linearUnit: 'meter', values: solution.jointValues },
      ...(report.options.targetFrame === 'optical' ? { opticalTargets: { [row.selectedSide]: { ...row.target, frameName: solution.frameName, side: row.selectedSide } } } : {}),
      mobileSampleId: row.sampleId });
  }
  return {
    id, name: `${source.name} · 机器人解`, createdAt: report.computedAt, updatedAt: report.computedAt,
    coordinateFrame: source.coordinateFrame, map: { ...source.map },
    robot: { id: robot.id || robot.relativePath, name: robot.name, relativePath: robot.relativePath },
    mobileSolveSource: { taskId: source.id, captureId: report.captureId, computedAt: report.computedAt, options: report.options },
    parkingPoints,
  };
}
