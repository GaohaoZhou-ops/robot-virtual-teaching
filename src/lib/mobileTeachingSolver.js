import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, normalizeRobotPose, readRobotJointValues, setRobotJointValue } from './robotLoader.js';
import { getRobotJointLimits } from './robotJointLimits.js';
import { getRobotJointCouplingPairs, normalizeArmJointCouplingEnabled, projectRobotJointCoupling, robotJointCouplingViolations } from './robotJointCoupling.js';
import { mobileCaptureMatrix } from './ipadCaptureDisplay.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from './mobileTeachingKinematics.js';
import { createMobileCollisionChecker } from './mobileTeachingCollision.js';
import { mobileCooperativeParkingCandidates, mobileParkingCandidates, mobileParkingKey, mobileParkingSupportPose, mobileSolutionMapPose } from './mobileTeachingParking.js';
import { applyMobileReferencePose, mobileReferenceMetrics, mobileUpperBodyJoints, normalizeMobileReferencePose } from './mobileTeachingReference.js';
import { MOBILE_CHEST_TILT_LIMIT, mobileChestWithinTolerance, mobileRowFailureReason, mobileSolutionFailureReasons, mobileTargetWithinTolerance } from './mobileTeachingDiagnostics.js';
import { MOBILE_TORSO_PITCH_JOINTS, mobileChestTiltLowerBound } from './mobileTeachingChest.js';

const XYZ = ['x', 'y', 'z'];
const RPY = ['roll', 'pitch', 'yaw'];
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const plain = (v) => Object.fromEntries(XYZ.map((axis) => [axis, v[axis]]));
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const abort = (signal) => { if (signal?.aborted) throw new DOMException('计算已取消', 'AbortError'); };
const TORSO_PITCH_JOINTS = MOBILE_TORSO_PITCH_JOINTS;
export const MOBILE_SOLVE_VERSION = 12;

export const DEFAULT_MOBILE_SOLVE_OPTIONS = Object.freeze({
  positionTolerance: Object.freeze({ x: 0.05, y: 0.05, z: 0.05 }),
  rotationTolerance: Object.freeze({ roll: 5, pitch: 5, yaw: 5 }),
  targetFrame: 'optical', armMode: 'both', allowSingleArm: true,
  allowTorsoHeight: true, lockChestVertical: true, chestTiltTolerance: MOBILE_CHEST_TILT_LIMIT,
  respectJointLocks: true, keyframesOnly: true,
  parkingMode: 'auto', checkCollisions: true, armBodyClearance: 0.05,
  referencePreference: 'upper-body', baseSupport: 'level',
  referencePose: Object.freeze({ type: 'current' }),
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
  if (!['optical', 'tool'].includes(options.targetFrame) || !['both', 'cooperative', 'left', 'right'].includes(options.armMode)) throw new Error('末端或机械臂配置无效');
  if (!['auto', 'per-pose', 'fixed'].includes(options.parkingMode)) throw new Error('停车点策略无效');
  if (!['upper-body', 'whole-body'].includes(options.referencePreference)) throw new Error('参考姿态偏好无效');
  if (!['level', 'current'].includes(options.baseSupport)) throw new Error('地面支撑设置无效');
  const clearance = options.armBodyClearance === '' || options.armBodyClearance == null ? NaN : Number(options.armBodyClearance);
  if (!Number.isFinite(clearance) || clearance < 0 || clearance > 0.3) throw new Error('机械臂与躯干的最小间距必须在 0–30 cm 之间');
  options.armBodyClearance = clearance;
  const chestTolerance = options.chestTiltTolerance === '' || options.chestTiltTolerance == null ? NaN : Number(options.chestTiltTolerance);
  if (!Number.isFinite(chestTolerance) || chestTolerance <= 0 || chestTolerance > 10) throw new Error('前胸垂直容差必须大于 0° 且不超过 10°');
  options.chestTiltTolerance = chestTolerance;
  for (const key of ['allowSingleArm', 'allowTorsoHeight', 'lockChestVertical', 'respectJointLocks', 'keyframesOnly', 'checkCollisions']) {
    if (typeof options[key] !== 'boolean') throw new Error('计算开关配置无效');
  }
  if (options.allowTorsoHeight && !options.lockChestVertical) throw new Error('自动调节胸部高度需要启用前胸垂直锁定');
  options.referencePose = normalizeMobileReferencePose(options.referencePose);
  return options;
}

export function mobileReportSolveOptions(report) {
  return validateMobileSolveOptions({
    ...(report.version === 1 ? { parkingMode: 'fixed', checkCollisions: false } : {}),
    ...report.options,
    // Reports predating height control must not inherit the new default.
    ...(report.version < 3 ? { allowTorsoHeight: false } : {}),
    ...(report.version < 6 ? { armBodyClearance: 0 } : {}),
    ...(report.version < 8 ? { chestTiltTolerance: MOBILE_CHEST_TILT_LIMIT } : {}),
    ...(report.version < 9 ? { referencePreference: 'whole-body', baseSupport: 'current' } : {}),
  });
}

export function normalizeMobileSolveReport(value) {
  if (!value || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, MOBILE_SOLVE_VERSION].includes(value.version) || !Array.isArray(value.rows)) return null;
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
        if (value.version >= 9 && solution.feasible && options.parkingMode !== 'fixed' && options.baseSupport === 'level'
          && (Math.abs(solution.mapPose.rpy.roll) > 1e-7 || Math.abs(solution.mapPose.rpy.pitch) > 1e-7
            || Math.abs(solution.mapPose.position.z - value.mapPose.position.z) > 1e-7)) return null;
        if (value.version >= 3 && solution.feasible && options.lockChestVertical
          && (!mobileChestWithinTolerance(solution.chestTilt, options)
            || !Number.isFinite(solution.chestHeight))) return null;
        if (value.version >= 6 && solution.feasible && options.checkCollisions && options.armBodyClearance > 0) {
          const clearance = solution.collision?.armBodyClearance;
          if (!clearance?.checked || !clearance.clear || !Number.isFinite(clearance.minimum)
            || clearance.minimum + 1e-9 < options.armBodyClearance || clearance.required !== options.armBodyClearance
            || !clearance.bySide || !['left', 'right'].every((side) => clearance.bySide[side] === null
              || (Number.isFinite(clearance.bySide[side]) && clearance.bySide[side] + 1e-9 >= clearance.minimum))) return null;
        }
      }
    }
    if (value.version >= 5) {
      const motions = mobileMotionGroups(value), ids = new Set(), sampleIds = new Set();
      for (const members of motions) {
        const first = members[0], solution = first.solutions[first.selectedSide];
        if (typeof first.motionGroupId !== 'string' || !first.motionGroupId || ids.has(first.motionGroupId) || members.length > 2 || !solution?.feasible) return null;
        ids.add(first.motionGroupId);
        for (const row of members) {
          if (sampleIds.has(row.sampleId) || !row.solutions[row.selectedSide]?.feasible
            || mobileParkingKey(row.mapPose) !== mobileParkingKey(row.solutions[row.selectedSide].mapPose)) return null;
          sampleIds.add(row.sampleId);
        }
        if (members.length === 1 && first.pairedSampleId) return null;
        if (members.length === 2) {
          const other = members[1], otherSolution = other.solutions[other.selectedSide];
          if (options.parkingMode === 'per-pose' || first.selectedSide === other.selectedSide
            || first.parkingId !== other.parkingId || mobileParkingKey(first.mapPose) !== mobileParkingKey(other.mapPose)
            || first.pairedSampleId !== other.sampleId || other.pairedSampleId !== first.sampleId
            || Object.keys(solution.jointValues).length !== Object.keys(otherSolution.jointValues).length
            || !Object.entries(solution.jointValues).every(([name, joint]) => otherSolution.jointValues[name] === joint)) return null;
        }
      }
      if (sampleIds.size !== value.feasibleCount || sampleIds.size !== value.rows.filter((row) => row.feasible).length
        || value.motionCount !== motions.length || value.dualMotionCount !== motions.filter((members) => members.length === 2).length
        || !value.initialJointValues || !Object.values(value.initialJointValues).every(Number.isFinite)) return null;
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
    withinTolerance: mobileTargetWithinTolerance({ positionError, rotationError }, options),
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
  const limits = joints.map(getRobotJointLimits);
  const values = joints.map((joint, i) => THREE.MathUtils.clamp(start < 2 ? joint.userData.jointValue : [bend, -2 * bend, bend][i],
    limits[i].lower, limits[i].upper));
  for (let iteration = 0; iteration < joints.length; iteration += 1) {
    const remaining = sum - values.reduce((total, value) => total + value, 0);
    if (Math.abs(remaining) < 1e-10) break;
    const free = joints.map((joint, i) => i).filter((i) => remaining > 0
      ? values[i] < limits[i].upper - 1e-10 : values[i] > limits[i].lower + 1e-10);
    if (!free.length) break;
    for (const i of free) values[i] = THREE.MathUtils.clamp(values[i] + remaining / free.length,
      limits[i].lower, limits[i].upper);
  }
  joints.forEach((joint, i) => setRobotJointValue(joint, values[i]));
}

// All computations use a private model. Joint limits are enforced on every
// update; chest verticality is a world-up constraint, independent of yaw.
async function solveTargets({ goals, chest, options, locked, baseline, postureReference, seed, checkpoint, collisionChecker }) {
  const { robot } = goals[0].controller;
  const preferUpperBody = options.referencePreference === 'upper-body';
  const upperBodyJoints = mobileUpperBodyJoints(robot);
  const avoidBody = Boolean(collisionChecker && options.armBodyClearance > 0);
  const preferredClearance = options.armBodyClearance + 0.03;
  const clearanceWeight = 1.5;
  const constraints = goals.map(({ controller, target }) => ({ frame: controller.frame, target,
    chain: new Set(controller.joints), inverse: target.quaternion.clone().invert() }));
  // An idle arm also needs room from the torso. Let its unlocked joints move
  // away when necessary, while continuity still penalizes needless motion.
  const clearanceJoints = avoidBody ? ['left', 'right'].flatMap((side) => getRobotEndEffector(robot, side)?.joints || []) : [];
  const joints = [...new Set([...goals.flatMap(({ controller }) => controller.joints), ...clearanceJoints])].filter((joint) => !locked.has(joint.name));
  const couplingPairs = getRobotJointCouplingPairs(robot);
  const movable = new Set(joints);
  const projectCoupling = () => projectRobotJointCoupling(couplingPairs, movable, setRobotJointValue);
  const chestJoints = new Set();
  for (let node = chest; node && node !== robot; node = node.parent) chestJoints.add(node);
  const torsoJoints = TORSO_PITCH_JOINTS.map((name) => joints.find((joint) => joint.name === name)).filter(Boolean);
  const chestTiltLowerBound = mobileChestTiltLowerBound(robot, chest);
  const weights = [...XYZ.map((axis) => 0.05 / options.positionTolerance[axis]),
    ...RPY.map((axis) => 0.24 * 5 / options.rotationTolerance[axis])];
  const postureCost = () => joints.reduce((sum, joint) => {
    const { jointValue: value, jointType } = joint.userData;
    const jointLimit = getRobotJointLimits(joint);
    const linear = jointType === 'prismatic', unit = linear ? 0.5 : Math.PI;
    const reference = linear ? (seed[joint.name] || 0) : rad(seed[joint.name] || 0);
    const origin = linear ? (postureReference[joint.name] || 0) : rad(postureReference[joint.name] || 0);
    const delta = (a, b) => jointType === 'continuous' ? Math.atan2(Math.sin(a - b), Math.cos(a - b)) : a - b;
    const range = jointLimit.upper - jointLimit.lower;
    const margin = Number.isFinite(range) && range > 0
      ? Math.min(value - jointLimit.lower, jointLimit.upper - value) / range : 1;
    const marginCost = (Math.max(0, 0.1 - margin) / 0.1) ** 2;
    if (preferUpperBody) return sum + 0.15 * (delta(value, reference) / unit) ** 2 + 0.03 * marginCost;
    return sum + (chestJoints.has(joint) ? 3 : 1) * ((delta(value, reference) / unit) ** 2
      + 0.2 * (delta(value, origin) / unit) ** 2) + 0.15 * marginCost;
  }, 0) / Math.max(1, joints.length);
  const measure = () => {
    robot.parent.updateMatrixWorld(true);
    const targets = constraints.map(({ frame, target, inverse }) => {
      const actualPosition = frame.getWorldPosition(new THREE.Vector3());
      const actualQuaternion = frame.getWorldQuaternion(new THREE.Quaternion());
      const position = target.position.clone().sub(actualPosition);
      const rotation = rotationVector(target.quaternion, actualQuaternion).applyQuaternion(inverse);
      return { ...measureMobileTarget(frame, target, options), actualPosition,
        error: [...position.toArray(), ...rotation.toArray()].map((n, i) => n * weights[i]) };
    });
    const up = chest ? new THREE.Vector3(0, 0, 1).applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion())) : null;
    const error = targets.flatMap((metrics) => metrics.error);
    if (up) error.push(-up.x * 2, -up.y * 2, (1 - up.z) * 2);
    const clearance = avoidBody ? collisionChecker.measurePostureClearance(preferredClearance) : null;
    const clearanceErrors = clearance ? ['left', 'right'].map((side) => Math.max(0, preferredClearance - (clearance.bySide[side] ?? preferredClearance))) : [];
    error.push(...clearanceErrors.map((value) => value * clearanceWeight));
    if (clearance) error.push(Math.max(0, 0.001 - clearance.selfSeparation) * 3);
    const chestTilt = up ? deg(up.angleTo(new THREE.Vector3(0, 0, 1))) : 0;
    const chestHeight = chest ? chest.getWorldPosition(new THREE.Vector3()).z - robot.parent.position.z : null;
    const jointCouplingViolations = robotJointCouplingViolations(couplingPairs);
    const feasible = !jointCouplingViolations.length && targets.every((metrics) => metrics.withinTolerance) && mobileChestWithinTolerance(chestTilt, options);
    const cost = error.reduce((sum, n) => sum + n * n, 0);
    const comfortCost = clearanceErrors.reduce((sum, value) => sum + (value / 0.03) ** 2, 0) / 2;
    const referenceDeviation = mobileReferenceMetrics(upperBodyJoints, postureReference);
    return { targets, feasible, jointCouplingViolations, chestTilt, chestHeight, up, error, cost, clearance,
      referenceDeviation, score: postureCost() + (preferUpperBody ? referenceDeviation.cost * 4 : 0) + comfortCost * 2 + cost * 0.2 };
  };
  let best = null;
  // Upper-body mode starts from the reference; whole-body mode starts from
  // the preceding motion. Both also try the other seed before broader restarts.
  for (let start = 0; start < 8; start += 1) {
    await checkpoint();
    applyRobotJointValues(robot, baseline);
    if (start < 2 || preferUpperBody) {
      const initial = preferUpperBody ? (start === 1 ? seed : postureReference) : start === 0 ? seed : postureReference;
      joints.forEach((joint) => {
        if (Number.isFinite(initial[joint.name])) setRobotJointValue(joint,
          joint.userData.jointType === 'prismatic' ? initial[joint.name] : rad(initial[joint.name]));
      });
    }
    if (start > 1) joints.forEach((joint, index) => {
      if (chestJoints.has(joint)) return;
      const wave = Math.sin((index + 1) * (start + 1) * 1.7);
      const { lower, upper } = getRobotJointLimits(joint);
      const amount = (joint.userData.jointType === 'prismatic' ? 0.06 : 0.9) * wave;
      setRobotJointValue(joint, start >= 5 && Number.isFinite(lower) && Number.isFinite(upper)
        ? lower + (upper - lower) * (0.5 + 0.4 * wave) : joint.userData.jointValue + amount);
    });
    // Include standing and crouched seeds to escape the zero vertical
    // derivative at full extension, even when starting from a tilted chest.
    seedUprightTorso(robot, chest, torsoJoints, start);
    projectCoupling();
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
      if ((kinematicallyFeasible && (!avoidBody || (state.feasible && state.clearance.minimum >= preferredClearance - 0.001)))
        || !joints.length || iteration === 120) break;
      const columns = joints.map((joint) => {
        const axis = new THREE.Vector3().fromArray(joint.userData.jointAxis || [0, 0, 1])
          .applyQuaternion(joint.getWorldQuaternion(new THREE.Quaternion())).normalize();
        const prismatic = joint.userData.jointType === 'prismatic';
        const column = constraints.flatMap(({ chain, inverse }, i) => {
          // Shared torso joints affect both cameras; an arm joint only
          // contributes to its own camera's six constraint rows.
          if (!chain.has(joint)) return [0, 0, 0, 0, 0, 0];
          const dp = prismatic ? axis.clone() : axis.clone().cross(state.targets[i].actualPosition.clone().sub(joint.getWorldPosition(new THREE.Vector3())));
          const dr = prismatic ? new THREE.Vector3() : axis.clone().applyQuaternion(inverse);
          return [...dp.toArray(), ...dr.toArray()].map((n, j) => n * weights[j]);
        });
        if (state.up) column.push(...(chestJoints.has(joint) && !prismatic
          ? axis.clone().cross(state.up).multiplyScalar(2).toArray() : [0, 0, 0]));
        if (avoidBody) {
          const before = joint.userData.jointValue, epsilon = prismatic ? 1e-5 : 1e-4;
          const direction = before + epsilon > getRobotJointLimits(joint).upper ? -1 : 1;
          setRobotJointValue(joint, before + direction * epsilon);
          const moved = joint.userData.jointValue - before;
          const clearance = collisionChecker.measurePostureClearance(preferredClearance);
          column.push(...['left', 'right'].map((side) => moved && state.clearance.bySide[side] !== null
            ? ((clearance.bySide[side] ?? preferredClearance) - state.clearance.bySide[side]) / moved * clearanceWeight : 0));
          column.push(moved ? (clearance.selfSeparation - state.clearance.selfSeparation) / moved * 3 : 0);
          setRobotJointValue(joint, before);
        }
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
            const { lower, upper } = getRobotJointLimits(joints[i]);
            return !((before[i] <= lower + 1e-8 && step[i] < 0) || (before[i] >= upper - 1e-8 && step[i] > 0));
          });
          if (free.length === active.length) break;
          active = free; step = null;
        }
        if (!step) continue;
        const scale = Math.min(1, 0.25 / Math.max(...step.map(Math.abs), 1e-12));
        for (const line of [1, 0.5, 0.2, 0.05]) {
          joints.forEach((joint, i) => setRobotJointValue(joint, before[i] + step[i] * scale * line));
          projectCoupling();
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
  return metrics.targets.map((target, i) => {
    const armJoints = upperBodyJoints.filter((joint) => constraints[i].chain.has(joint));
    const solution = { feasible, jointCouplingViolations: metrics.jointCouplingViolations,
      frameName: constraints[i].frame.name, positionError: target.positionError,
      rotationError: target.rotationError, chestTilt: metrics.chestTilt, chestTiltLowerBound, chestHeight: metrics.chestHeight, actualPose: target.actualPose,
      referenceDeviation: metrics.referenceDeviation, armReferenceCost: mobileReferenceMetrics(armJoints, postureReference).cost,
      jointValues: best.jointValues, score: metrics.score, errorCost: metrics.cost,
      collision: collision || { checked: false, clear: false } };
    return { ...solution, reason: mobileSolutionFailureReasons(solution, options).join('；') };
  });
}

const solveArm = async ({ controller, target, ...rest }) => (await solveTargets({ ...rest, goals: [{ controller, target }] }))[0];

export async function solveMobileTeaching({ robot: liveRobot, task, mapPose, environment, options: rawOptions, lockedJointNames = [], signal, onProgress, onSample, waitIfPaused }) {
  const checkpoint = async () => {
    await pause();
    abort(signal);
    await waitIfPaused?.();
    abort(signal);
  };
  // Keep the old flag readable in stored reports, but every new calculation
  // (including reruns from an old report) requires only one camera per target.
  const options = { ...validateMobileSolveOptions(rawOptions), allowSingleArm: true };
  const samples = (task.mobileCapture?.samples || []).filter((sample) => !options.keyframesOnly || sample.kind === 'keyframe');
  if (!samples.length) throw new Error('没有可计算的采样点，请检查采样范围');
  if (!liveRobot) throw new Error('请先加载机器人模型');
  abort(signal);
  const robot = restoreMobileTeachingRobot(serializeMobileTeachingRobot(liveRobot, { includeCollision: options.checkCollisions })), layer = new THREE.Group();
  layer.add(robot);
  const initialMapPose = normalizeRobotPose(mapPose);
  const basePose = mobileParkingSupportPose(initialMapPose, options);
  const place = (pose) => {
    layer.position.set(...XYZ.map((axis) => pose.position[axis]));
    // Match the workbench's existing base-pose convention exactly.
    layer.rotation.set(...RPY.map((axis) => rad(pose.rpy[axis])), 'XYZ');
    layer.updateMatrixWorld(true);
  };
  place(basePose);
  try {
    const cooperative = options.armMode === 'cooperative';
    const sides = ['both', 'cooperative'].includes(options.armMode) ? ['left', 'right'] : [options.armMode];
    const controllers = Object.fromEntries(sides.map((side) => {
      const controller = getRobotEndEffector(robot, side);
      const frame = options.targetFrame === 'tool' ? controller?.frame : robot.getObjectByName(`zivid_${side}_optical_frame`);
      return [side, controller && frame ? { ...controller, frame } : null];
    }));
    if (!sides.some((side) => controllers[side])) throw new Error(options.targetFrame === 'optical' ? '模型缺少末端相机光学坐标系，可切换为工具末端' : '模型缺少可求解的工具末端');
    const chest = options.lockChestVertical ? robot.getObjectByName('waist_yaw_L') : null;
    if (options.lockChestVertical && !chest) throw new Error('当前模型不支持前胸垂直约束，请关闭此选项');
    const locked = new Set(options.respectJointLocks ? lockedJointNames : []);
    const heightJoints = TORSO_PITCH_JOINTS.map((name) => robot.getObjectByName(name));
    const heightJointNames = options.allowTorsoHeight && heightJoints.every((joint) => joint?.userData.jointType === 'revolute')
      ? [...TORSO_PITCH_JOINTS] : [];
    // Explicit automatic height control overrides only these three locks.
    // Other body/arm locks and every URDF joint limit remain in effect.
    heightJointNames.forEach((name) => locked.delete(name));
    applyMobileReferencePose(robot, options.referencePose, locked);
    // The saved trajectory also starts at this private reference pose. Bring
    // unlocked wrists into the feasible region before recording that start,
    // so interpolation to a valid result cannot start outside the constraint.
    const initialCouplingPairs = getRobotJointCouplingPairs(robot);
    projectRobotJointCoupling(initialCouplingPairs,
      new Set(initialCouplingPairs.flatMap(({ joints }) => joints.filter((joint) => !locked.has(joint.name)))), setRobotJointValue);
    const postureReference = readRobotJointValues(robot);
    const preferUpperBody = options.referencePreference === 'upper-body';
    const referenceFrames = [];
    if ((preferUpperBody || cooperative) && options.parkingMode !== 'fixed') {
      const freeTorso = heightJoints.filter((joint) => joint && !locked.has(joint.name));
      seedUprightTorso(robot, chest, freeTorso, 0);
      layer.updateMatrixWorld(true);
      const inverse = layer.getWorldQuaternion(new THREE.Quaternion()).invert();
      for (const side of sides) if (controllers[side]) {
        const frame = controllers[side].frame;
        referenceFrames.push({ side, position: layer.worldToLocal(frame.getWorldPosition(new THREE.Vector3())),
          quaternion: inverse.clone().multiply(frame.getWorldQuaternion(new THREE.Quaternion())) });
      }
      applyRobotJointValues(robot, postureReference);
    }
    const referenceFit = (side, pose, target) => {
      const frame = referenceFrames.find((entry) => entry.side === side);
      if (!frame) return Infinity;
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...RPY.map((axis) => rad(pose.rpy[axis])), 'XYZ'));
      const position = frame.position.clone().applyQuaternion(quaternion).add(new THREE.Vector3(...XYZ.map((axis) => pose.position[axis])));
      return position.distanceTo(target.position) + 0.25 * quaternion.multiply(frame.quaternion).angleTo(target.quaternion);
    };
    let state = { joints: postureReference, counts: { left: 0, right: 0 } };
    const collisionChecker = options.checkCollisions ? await createMobileCollisionChecker(robot, environment, checkpoint, options) : null;
    const refineClearance = Boolean(collisionChecker && options.armBodyClearance > 0);
    const comfortable = (solution) => !refineClearance
      || solution.collision?.armBodyClearance?.minimum >= options.armBodyClearance + 0.025;
    const comfortableResult = (result) => result.feasible && comfortable(result.solutions[result.selectedSide]);
    const rows = [];
    let feasibleCount = 0, parkingCount = 0, motionCount = 0, dualMotionCount = 0, previousPose = null;
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
    const entries = samples.map((sample, sourceIndex) => ({ sample, sourceIndex, target: mobileSampleTarget(sample, task) }));
    // Assign one camera per target first, then jointly solve compatible pairs
    // before publishing their whole-body states. Never splice independent IKs.
    const advance = (current, result) => ({ joints: result.solutions[result.selectedSide].jointValues,
      counts: { ...current.counts, [result.selectedSide]: current.counts[result.selectedSide] + 1 } });
    const progress = (entry, extra = {}) => onProgress?.({ completed: rows.length, total: samples.length,
      name: entry.sample.name, feasibleCount, ...extra });
    const solveAt = async (entry, pose, current, candidateProgress = {}) => {
      const { target } = entry, solutions = {};
      place(pose); applyRobotJointValues(robot, current.joints);
      // Cooperation gives the less-used arm first refusal; otherwise reference
      // fit comes first. Both modes fall back when that arm cannot reach.
      const distance = (side) => controllers[side]?.frame.getWorldPosition(new THREE.Vector3()).distanceTo(target.position) ?? Infinity;
      const distances = Object.fromEntries(sides.map((side) => [side, distance(side)]));
      const fits = Object.fromEntries(sides.map((side) => [side, referenceFit(side, pose, target)]));
      const ordered = [...sides].sort((a, b) => (cooperative ? current.counts[a] - current.counts[b] : 0)
        || (referenceFrames.length && Math.abs(fits[a] - fits[b]) > 1e-6 ? fits[a] - fits[b] : 0)
        || current.counts[a] - current.counts[b] || distances[a] - distances[b]);
      for (const side of ordered) {
        await checkpoint(); progress(entry, { side, ...candidateProgress });
        const controller = controllers[side];
        applyRobotJointValues(robot, current.joints);
        const solution = !controller ? { feasible: false, reason: '该机械臂或目标坐标系不存在' }
          : !positionInRange(controller, target) ? { feasible: false, reason: '目标超出该停车点的机械臂位置范围' }
            : await solveArm({ controller, chest, target, options, locked, baseline: current.joints,
              postureReference, seed: current.joints, checkpoint, collisionChecker });
        solutions[side] = { ...solution, mapPose: pose };
        if (solution.feasible && comfortable(solution)) break;
      }
      const feasibleSides = ordered.filter((side) => solutions[side]?.feasible);
      const selectedSide = feasibleSides.sort((a, b) => (cooperative
        ? Number(comfortable(solutions[b])) - Number(comfortable(solutions[a])) || current.counts[a] - current.counts[b] : 0)
        || solutions[a].score - solutions[b].score)[0] || null;
      for (const side of sides) if (!solutions[side]) solutions[side] = {
        feasible: false, skipped: true, mapPose: pose,
        reason: `此姿态已分配给${selectedSide === 'left' ? '左臂' : '右臂'}，无需另一相机重复到达`,
      };
      const feasible = feasibleSides.length > 0;
      return { feasible, selectedSide, solutions, mapPose: pose,
        score: selectedSide ? solutions[selectedSide].score : Math.min(...Object.values(solutions).map((solution) => solution.errorCost ?? Infinity)),
        reason: mobileRowFailureReason({ feasible, solutions }, options) };
    };
    const emit = async (entry, result) => {
      await checkpoint();
      const { sample, sourceIndex, target } = entry;
      const row = { sampleId: sample.id, name: sample.name || `Pose ${sourceIndex + 1}`, capturedAt: sample.capturedAt,
        sourceIndex, ...result, score: Number.isFinite(result.score) ? result.score : null,
        target: { position: plain(target.position), quaternion: { ...plain(target.quaternion), w: target.quaternion.w } } };
      rows.push(row);
      if (row.feasible) {
        feasibleCount += 1;
        if (!previousPose || options.parkingMode === 'per-pose' || mobileParkingKey(previousPose) !== mobileParkingKey(row.mapPose)) {
          parkingCount += 1;
          state = { ...state, counts: { left: 0, right: 0 } };
        }
        row.parkingId = `parking-${parkingCount}`;
        previousPose = row.mapPose;
        state = advance(state, row);
      }
      onSample?.({ row, mapPose: row.mapPose, index: rows.length - 1, total: samples.length });
      progress(entry);
    };
    const emitPlan = async (steps) => {
      const remaining = [...steps];
      while (remaining.length) {
        const first = remaining.shift();
        if (!first.result.feasible) { await emit(first.entry, first.result); continue; }
        let paired = null;
        if (sides.length === 2 && options.parkingMode !== 'per-pose') {
          // Try up to three opposite-arm partners in this bounded batch.
          // Both six-axis camera goals share the same torso and collision
          // check. A failed pair leaves both independently feasible targets.
          const partners = remaining.filter((step) => step.result.feasible
            && step.result.selectedSide !== first.result.selectedSide
            && mobileParkingKey(step.result.mapPose) === mobileParkingKey(first.result.mapPose)).slice(0, 3);
          // A capture may contain an entire left-side sweep before any right
          // targets. Look beyond the current batch so that capture order alone
          // cannot force two serial arm sweeps at the same parking point.
          if (partners.length < 3) {
            const side = first.result.selectedSide === 'left' ? 'right' : 'left', controller = controllers[side];
            if (controller) {
              place(first.result.mapPose);
              applyRobotJointValues(robot, first.result.solutions[first.result.selectedSide].jointValues);
              const origin = controller.frame.getWorldPosition(new THREE.Vector3());
              const candidates = [...pending.values()].filter((entry) => positionInRange(controller, entry.target))
                .sort((a, b) => a.target.position.distanceToSquared(origin) - b.target.position.distanceToSquared(origin))
                .slice(0, 3 - partners.length);
              partners.push(...candidates.map((entry) => ({ entry, result: { selectedSide: side, mapPose: first.result.mapPose,
                solutions: { [first.result.selectedSide]: { feasible: false, skipped: true, mapPose: first.result.mapPose,
                  reason: `此姿态由${side === 'left' ? '左臂' : '右臂'}执行，无需另一相机重复到达` } } } })));
            }
          }
          for (const partner of partners) {
            await checkpoint(); progress(first.entry, { side: 'both' });
            const members = [first, partner];
            const goals = members.map((step) => ({ controller: controllers[step.result.selectedSide], target: step.entry.target }));
            const seed = { ...(partner.result.solutions[partner.result.selectedSide]?.jointValues
              || first.result.solutions[first.result.selectedSide].jointValues) };
            const shared = new Set(goals[1].controller.joints);
            for (const joint of goals[0].controller.joints) if (!shared.has(joint)) {
              seed[joint.name] = first.result.solutions[first.result.selectedSide].jointValues[joint.name];
            }
            place(first.result.mapPose);
            const solutions = await solveTargets({ goals, chest, options, locked, baseline: state.joints,
              postureReference, seed, checkpoint, collisionChecker });
            const preservesReference = members.every((step, index) => {
              const before = step.result.solutions[step.result.selectedSide]?.armReferenceCost;
              return !Number.isFinite(before) || solutions[index].armReferenceCost <= before + 0.005;
            });
            if (solutions.every((solution) => solution.feasible) && comfortable(solutions[0])
              && (!preferUpperBody || options.parkingMode === 'fixed' || preservesReference)) {
              paired = { partner, members, solutions }; break;
            }
          }
        }
        const motionGroupId = `motion-${++motionCount}`;
        if (paired) {
          dualMotionCount += 1;
          const partnerIndex = remaining.indexOf(paired.partner);
          if (partnerIndex >= 0) remaining.splice(partnerIndex, 1);
          else pending.delete(paired.partner.entry.sourceIndex);
          for (const [index, step] of paired.members.entries()) {
            const solution = { ...paired.solutions[index], mapPose: step.result.mapPose };
            await emit(step.entry, { ...step.result, feasible: true, reason: '', motionGroupId,
              pairedSampleId: paired.members[1 - index].entry.sample.id,
              score: solution.score, solutions: { ...step.result.solutions, [step.result.selectedSide]: solution } });
          }
        } else await emit(first.entry, { ...first.result, motionGroupId });
      }
    };
    const canReach = (entry) => sides.some((side) => controllers[side] && positionInRange(controllers[side], entry.target));
    const travel = (pose) => {
      const reference = previousPose || basePose;
      return Math.hypot(pose.position.x - reference.position.x, pose.position.y - reference.position.y);
    };
    const pending = new Map(entries.map((entry) => [entry.sourceIndex, entry]));
    while (pending.size) {
      const anchor = pending.values().next().value;
      await checkpoint(); progress(anchor);
      if (options.parkingMode === 'fixed') {
        const steps = [];
        let plannedState = state;
        for (const entry of [...pending.values()].slice(0, 8)) {
          const result = await solveAt(entry, basePose, plannedState);
          steps.push({ entry, result }); pending.delete(entry.sourceIndex);
          if (result.feasible) plannedState = advance(plannedState, result);
        }
        await emitPlan(steps); continue;
      }
      const auto = options.parkingMode === 'auto';
      // Bound lookahead to eight nearby samples. Once a comfortable stop is
      // found, compare up to eight feasible candidates for cooperation, or
      // four otherwise (three without the buffer). Every accepted
      // sample must still pass IK and the complete collision checker.
      const pool = auto ? [anchor, ...[...pending.values()].filter((entry) => entry !== anchor)
        .sort((a, b) => a.target.position.distanceToSquared(anchor.target.position) - b.target.position.distanceToSquared(anchor.target.position))
        .slice(0, 7)] : [anchor];
      let candidates = mobileParkingCandidates(anchor.target, basePose, previousPose, options.parkingMode,
        { refineClearance, baseSupport: options.baseSupport, referenceFrames });
      if (auto) {
        // Include bases between targets, not just bases centred on one camera
        // pose. This lets opposite arms cover opposite sides of a workpiece.
        for (const neighbour of pool.slice(1, 3)) {
          if (cooperative) candidates.push(...mobileCooperativeParkingCandidates(anchor.target, neighbour.target, basePose,
            { baseSupport: options.baseSupport, referenceFrames }));
          const centre = { position: anchor.target.position.clone().add(neighbour.target.position).multiplyScalar(0.5),
            quaternion: anchor.target.quaternion };
          candidates.push(...mobileParkingCandidates(centre, basePose, null, 'per-pose',
            { baseSupport: options.baseSupport, referenceFrames }).slice(0, 3));
        }
        candidates = [...new Map(candidates.map((pose) => [mobileParkingKey(pose), pose])).values()];
        candidates = candidates.map((pose, index) => {
          place(pose); applyRobotJointValues(robot, state.joints);
          const reach = cooperative ? sides.map((side) => pool.filter((entry) => controllers[side]
            && positionInRange(controllers[side], entry.target))) : [];
          const potential = pool.filter(canReach).length;
          return { pose, index, potential,
            sharedPotential: cooperative ? Math.min(...reach.map((entries) => entries.length), Math.floor(potential / 2)) : 0,
            sharedFit: cooperative ? Math.min(...pool.slice(1).flatMap((entry) => sides.map((side) => Math.max(
              referenceFit(side, pose, anchor.target), referenceFit(side === 'left' ? 'right' : 'left', pose, entry.target))))) : Infinity,
            fit: Math.min(...sides.map((side) => referenceFit(side, pose, anchor.target))),
            reused: previousPose && mobileParkingKey(previousPose) === mobileParkingKey(pose) ? 1 : 0 };
        }).sort((a, b) => (cooperative ? Number(b.sharedPotential > 0) - Number(a.sharedPotential > 0)
          || b.potential - a.potential || b.sharedPotential - a.sharedPotential
          || (Math.abs(a.sharedFit - b.sharedFit) > 1e-6 ? a.sharedFit - b.sharedFit : 0) : 0) || (preferUpperBody
          ? (Math.abs(a.fit - b.fit) > 1e-6 ? a.fit - b.fit : 0) || b.potential - a.potential || b.reused - a.reused || a.index - b.index
          : b.reused - a.reused || b.potential - a.potential || a.index - b.index)).map(({ pose }) => pose);
      }
      let bestPlan = null, failure = null, passingCandidates = 0;
      for (const [candidateIndex, pose] of candidates.entries()) {
        const sameStop = previousPose && mobileParkingKey(previousPose) === mobileParkingKey(pose);
        let plannedState = { joints: state.joints, counts: sameStop && auto ? { ...state.counts } : { left: 0, right: 0 } };
        const candidateProgress = { candidate: candidateIndex + 1, candidateCount: candidates.length };
        const result = await solveAt(anchor, pose, plannedState, candidateProgress);
        if (!result.feasible) {
          if (!failure || result.score < failure.score) failure = result;
          continue;
        }
        const plan = { steps: [{ entry: anchor, result }], attempted: new Map([[anchor.sourceIndex, plannedState.joints]]) };
        plannedState = advance(plannedState, result);
        for (const entry of pool.slice(1)) {
          const next = await solveAt(entry, pose, plannedState, candidateProgress);
          plan.attempted.set(entry.sourceIndex, plannedState.joints);
          if (next.feasible && (!auto || comfortableResult(next))) { plan.steps.push({ entry, result: next }); plannedState = advance(plannedState, next); }
        }
        plan.shared = Math.min(plannedState.counts.left, plannedState.counts.right);
        plan.cost = plan.steps.reduce((sum, step) => sum + step.result.score, 0) / plan.steps.length + travel(pose) * 0.005;
        plan.referenceCost = plan.steps.reduce((sum, step) => sum + step.result.solutions[step.result.selectedSide].referenceDeviation.cost, 0) / plan.steps.length;
        if (preferUpperBody) plan.cost -= (plan.steps.length - 1) * 0.005 + plan.shared * 0.003;
        plan.comfortable = comfortableResult(result);
        // Cooperation first seeks a stop used by both arms. Among shared
        // stops, upper-body preference still takes priority over coverage.
        const cooperationOrder = bestPlan && cooperative
          ? Number(plan.shared > 0) - Number(bestPlan.shared > 0)
            || (!preferUpperBody ? plan.steps.length - bestPlan.steps.length || plan.shared - bestPlan.shared : 0) : 0;
        const betterPreference = bestPlan && (cooperationOrder ? cooperationOrder > 0 : preferUpperBody ? plan.cost < bestPlan.cost
          : plan.steps.length > bestPlan.steps.length
            || (plan.steps.length === bestPlan.steps.length && (plan.shared > bestPlan.shared
              || (plan.shared === bestPlan.shared && plan.cost < bestPlan.cost))));
        if (!bestPlan || (plan.comfortable && !bestPlan.comfortable)
          || (plan.comfortable === bestPlan.comfortable && betterPreference)) bestPlan = plan;
        passingCandidates += 1;
        if (sameStop && auto && plan.comfortable && !preferUpperBody && (!cooperative || plan.shared > 0)) { bestPlan = plan; break; }
        if ((passingCandidates >= (cooperative ? 8 : refineClearance ? 4 : 3) && bestPlan.comfortable)
          || (auto && plan.comfortable && plan.steps.length === pool.length
            && (!preferUpperBody ? !cooperative || passingCandidates >= 2 : passingCandidates >= 2 && plan.referenceCost < 0.0025)
            && (sides.length === 1 || plan.shared >= Math.floor(pool.length / 2)))) break;
      }
      if (!bestPlan) {
        await emit(anchor, failure); pending.delete(anchor.sourceIndex); continue;
      }
      for (const { entry } of bestPlan.steps) pending.delete(entry.sourceIndex);
      await emitPlan(bestPlan.steps);
      if (auto && !preferUpperBody) {
        // Drain other comfortable targets before leaving the selected stop,
        // including non-adjacent captures. Never rewrite an emitted preview.
        let batch = [], plannedState = state;
        for (const entry of pending.values()) {
          await checkpoint();
          // A previous failure may become feasible after the other arm or
          // shared torso moved. Reuse failures only for the same body state.
          if (bestPlan.attempted.get(entry.sourceIndex) === plannedState.joints) continue;
          place(previousPose); applyRobotJointValues(robot, plannedState.joints);
          if (!canReach(entry)) continue;
          const result = await solveAt(entry, previousPose, plannedState);
          if (comfortableResult(result)) {
            batch.push({ entry, result }); plannedState = advance(plannedState, result); pending.delete(entry.sourceIndex);
          }
          if (batch.length === 8) { await emitPlan(batch); batch = []; plannedState = state; }
        }
        await emitPlan(batch);
      }
    }
    await checkpoint();
    return { version: MOBILE_SOLVE_VERSION, taskId: task.id, captureId: task.mobileCapture.id, computedAt: new Date().toISOString(),
      coordinateFrame: task.coordinateFrame, mapPose: initialMapPose, options, lockedJointNames: [...locked], rows,
      heightJointNames, initialJointValues: postureReference,
      armJointCouplingEnabled: normalizeArmJointCouplingEnabled(robot.userData.armJointCouplingEnabled),
      sourceCount: task.mobileCapture.samples.length, feasibleCount, parkingCount, motionCount, dualMotionCount,
      collisionScreening: collisionChecker ? { enabled: true, method: 'conservative-obb', proxyCount: collisionChecker.proxyCount,
        environmentKind: collisionChecker.environmentKind, environmentCount: collisionChecker.environmentCount } : { enabled: false } };
  } finally {
    layer.clear();
  }
}

// Sharing a stop does not imply simultaneous motion: two individually valid
// motions may use different torso heights at the same chassis pose.
export function mobileParkingArmUsage(report) {
  const parking = new Map();
  for (const row of report.rows) {
    if (!row.feasible || !row.parkingId || !['left', 'right'].includes(row.selectedSide)) continue;
    if (!parking.has(row.parkingId)) parking.set(row.parkingId, { parkingId: row.parkingId, sides: [] });
    const entry = parking.get(row.parkingId);
    if (!entry.sides.includes(row.selectedSide)) entry.sides.push(row.selectedSide);
  }
  return [...parking.values()];
}

// Older reports remain one target per motion. v5 publishes adjacent rows with
// an explicitly validated shared full-body state for each simultaneous pair.
export function mobileMotionGroups(report) {
  const groups = [];
  for (const row of report.rows) {
    if (!row.feasible || !row.solutions[row.selectedSide]?.feasible) continue;
    const previous = groups.at(-1);
    if (report.version >= 5 && row.motionGroupId && previous?.[0].motionGroupId === row.motionGroupId) previous.push(row);
    else groups.push([row]);
  }
  return groups;
}

export function buildMobileSolvedTask(source, report, robot, id) {
  const motions = mobileMotionGroups(report);
  if (!motions.length) throw new Error('没有可保存的可达姿态');
  const parkingPoints = [];
  for (const [index, members] of motions.entries()) {
    const row = members[0];
    const solution = row.solutions[row.selectedSide];
    const mapPose = { ...mobileSolutionMapPose(report, row), frameId: source.coordinateFrame };
    let parking = parkingPoints.at(-1);
    if (!parking || report.options.parkingMode === 'per-pose' || mobileParkingKey(parking.mapPose) !== mobileParkingKey(mapPose)) {
      const sequence = parkingPoints.length + 1;
      parking = { id: `${id}-parking-${sequence}`, name: `计算停车点 P${String(sequence).padStart(2, '0')}`, sequence,
        createdAt: report.computedAt, updatedAt: report.computedAt, mapPose, poses: [] };
      parkingPoints.push(parking);
    }
    parking.poses.push({ id: `${id}-pose-${index}`, name: members.length === 2 ? `${members.map((member) => member.name).join(' + ')} · 双臂同步`
      : `${row.name} · ${row.selectedSide === 'left' ? '左臂' : '右臂'}`, sequence: parking.poses.length + 1,
      capturedAt: row.capturedAt, mapPose, fullBodyJoints: { angularUnit: 'degree', linearUnit: 'meter', values: solution.jointValues },
      ...(report.options.targetFrame === 'optical' ? { opticalTargets: Object.fromEntries(members.map((member) => [member.selectedSide,
        { ...member.target, frameName: member.solutions[member.selectedSide].frameName, side: member.selectedSide }])) } : {}),
      mobileSampleId: row.sampleId, ...(members.length === 2 ? { mobileSampleIds: members.map((member) => member.sampleId) } : {}) });
  }
  return {
    id, name: `${source.name} · 机器人解`, createdAt: report.computedAt, updatedAt: report.computedAt,
    coordinateFrame: source.coordinateFrame, map: { ...source.map },
    robot: { id: robot.id || robot.relativePath, name: robot.name, relativePath: robot.relativePath },
    mobileSolveSource: { taskId: source.id, captureId: report.captureId, computedAt: report.computedAt, options: report.options,
      ...(report.version >= 5 ? { solverVersion: report.version, initialMapPose: report.mapPose, initialJointValues: report.initialJointValues } : {}) },
    parkingPoints,
  };
}
