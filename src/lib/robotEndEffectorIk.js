import * as THREE from 'three';
import { setRobotJointValue } from './robotLoader.js';
import { getRobotJointLimits } from './robotJointLimits.js';

const ORIENTATION_SCALE = 0.24;
const MAX_ITERATIONS = 24;
const MAX_CORRECTION_ITERATIONS = 3;
const POSTURE_WEIGHT = 0.0001;
const LIMIT_WEIGHT = 0.00005;
const POSITION_TOLERANCE = 0.00045;
const ROTATION_TOLERANCE = THREE.MathUtils.degToRad(0.18);

function writeRotationError(target, current, result, scratch) {
  scratch.copy(current).invert().premultiply(target).normalize();
  if (scratch.w < 0) scratch.set(-scratch.x, -scratch.y, -scratch.z, -scratch.w);
  const sine = Math.hypot(scratch.x, scratch.y, scratch.z);
  return sine < 1e-10 ? result.set(0, 0, 0) : result.set(scratch.x, scratch.y, scratch.z)
    .multiplyScalar(2 * Math.atan2(sine, THREE.MathUtils.clamp(scratch.w, -1, 1)) / sine);
}

// Small positive-definite systems (normally seven arm joints). Cholesky avoids
// an SVD, allocations for scene clones, and additional solver dependencies.
function solvePositiveSystem(matrix, rhs) {
  const size = rhs.length;
  const lower = new Float64Array(size * size);
  const result = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let k = 0; k < column; k += 1) value -= lower[row * size + k] * lower[column * size + k];
      if (row === column) {
        if (!(value > 1e-14)) return null;
        lower[row * size + column] = Math.sqrt(value);
      } else lower[row * size + column] = value / lower[column * size + column];
    }
    let value = rhs[row];
    for (let k = 0; k < row; k += 1) value -= lower[row * size + k] * result[k];
    result[row] = value / lower[row * size + row];
  }
  for (let row = size - 1; row >= 0; row -= 1) {
    for (let k = row + 1; k < size; k += 1) result[row] -= lower[k * size + row] * result[k];
    result[row] /= lower[row * size + row];
  }
  return result;
}

// Solve the bounded increment, including the contribution of joints at their
// bounds. Post-clipping an unconstrained solution loses that contribution.
// Release a bound if its multiplier points inward, so a joint can move away
// from a limit on the very next pointer event.
function boundedStep(matrix, rhs, lower, upper) {
  const size = rhs.length;
  const step = new Float64Array(size);
  const active = new Int8Array(size);
  for (let pass = 0; pass < size * 3 + 3; pass += 1) {
    const free = Array.from({ length: size }, (_, i) => i).filter((i) => !active[i]);
    if (free.length) {
      const values = solvePositiveSystem(free.map((i) => free.map((j) => matrix[i][j])), free.map((i) => {
        let value = rhs[i];
        for (let j = 0; j < size; j += 1) if (active[j]) value -= matrix[i][j] * step[j];
        return value;
      }));
      if (!values) return null;
      let fraction = 1, hit = -1, direction = 0;
      free.forEach((i, k) => {
        const delta = values[k] - step[i];
        const limit = delta > 0 ? upper[i] : lower[i];
        if (Math.abs(delta) < 1e-14) return;
        const ratio = (limit - step[i]) / delta;
        if (ratio < fraction) { fraction = Math.max(0, ratio); hit = i; direction = delta > 0 ? 1 : -1; }
      });
      free.forEach((i, k) => { step[i] += fraction * (values[k] - step[i]); });
      if (hit >= 0) {
        step[hit] = direction > 0 ? upper[hit] : lower[hit];
        active[hit] = direction;
        continue;
      }
    }
    let release = -1, violation = 1e-10;
    for (let i = 0; i < size; i += 1) {
      if (!active[i]) continue;
      let gradient = -rhs[i];
      for (let j = 0; j < size; j += 1) gradient += matrix[i][j] * step[j];
      const inward = gradient * active[i];
      if (inward > violation) { violation = inward; release = i; }
    }
    if (release < 0) break;
    active[release] = 0;
  }
  return step;
}

const angleDifference = (value, reference, continuous) => continuous
  ? Math.atan2(Math.sin(value - reference), Math.cos(value - reference)) : value - reference;

/**
 * Local, synchronous IK for interactive teaching. referenceJointValues uses
 * the same degree/meter representation as readRobotJointValues(). It stays
 * fixed for an adjustment session; the live pose remains the numerical seed.
 * No event throttling, delayed interpolation or random branch restarts.
 */
export function solveEndEffectorIk(controller, targetPosition, targetQuaternion, excludedJoints = new Set(), {
  referenceJointValues = null,
} = {}) {
  if (!controller?.frame || !controller.joints?.length) return null;
  const started = performance.now();
  const { robot, frame } = controller;
  const joints = controller.joints.filter((joint) => !excludedJoints.has(joint));
  // Read the configured limits on every solve. Never cache a ratio or shrink
  // the URDF bounds again; custom ratios must also work on cloned robots.
  const definitions = joints.map((joint) => {
    const limits = getRobotJointLimits(joint);
    const linear = joint.userData.jointType === 'prismatic';
    const continuous = joint.userData.jointType === 'continuous';
    const value = Number(joint.userData.jointValue) || 0;
    const requested = referenceJointValues?.[joint.name];
    const reference = Number.isFinite(requested) ? (linear ? requested : THREE.MathUtils.degToRad(requested)) : value;
    const proximal = /^(left|right)[_-]J[123]$/i.test(joint.name);
    return { ...limits, linear, continuous,
      reference: THREE.MathUtils.clamp(reference, limits.lower, limits.upper),
      weight: (proximal ? 1.5 : 1) * (linear ? 16 : 1),
      margin: Number.isFinite(limits.upper - limits.lower)
        ? Math.min((limits.upper - limits.lower) * 0.08, linear ? 0.03 : 0.25) : 0 };
  });
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  const deltaPosition = new THREE.Vector3(), deltaRotation = new THREE.Vector3();
  const scratchQuaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  const jointPosition = new THREE.Vector3(), jointQuaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3(), radius = new THREE.Vector3(), derivative = new THREE.Vector3();
  let positionError = 0, rotationError = 0, iterations = 0;
  let correcting = false, correctionIterations = 0;
  const limitOffset = (value, definition) => definition.margin
    ? value - THREE.MathUtils.clamp(value, definition.lower + definition.margin, definition.upper - definition.margin) : 0;
  const measure = () => {
    // Only ancestors of the controlled frame need FK during the solve. Visual
    // meshes, the other arm, and collision proxies are updated once at the end.
    frame.updateWorldMatrix(true, false);
    frame.matrixWorld.decompose(position, quaternion, scale);
    deltaPosition.copy(targetPosition).sub(position);
    writeRotationError(targetQuaternion, quaternion, deltaRotation, scratchQuaternion);
    positionError = deltaPosition.length(); rotationError = deltaRotation.length();
    let cost = positionError ** 2 + (rotationError * ORIENTATION_SCALE) ** 2;
    joints.forEach((joint, i) => {
      const definition = definitions[i], value = joint.userData.jointValue;
      if (!correcting) cost += POSTURE_WEIGHT * definition.weight * angleDifference(value, definition.reference, definition.continuous) ** 2
        + LIMIT_WEIGHT * definition.weight * limitOffset(value, definition) ** 2;
    });
    return cost;
  };
  // A caller may have tightened limits on a live model. Respect them before
  // computing a feasible bounded increment, without moving locked joints.
  joints.forEach((joint) => setRobotJointValue(joint, joint.userData.jointValue));
  let cost = measure(), damping = 0.025;
  const canCorrect = () => !correcting && positionError < 0.006 && rotationError < THREE.MathUtils.degToRad(2);
  const startCorrection = () => {
    // Reference regularization chooses a stable posture, but may leave a small
    // Cartesian bias. Correct only that residual with a few bounded local steps
    // so posture preference never becomes a new tracking-accuracy deadband.
    correcting = true;
    cost = measure();
    damping = 0.025;
  };
  for (; iterations < MAX_ITERATIONS + MAX_CORRECTION_ITERATIONS && joints.length; iterations += 1) {
    if (positionError < POSITION_TOLERANCE && rotationError < ROTATION_TOLERANCE) break;
    if (!correcting && iterations >= MAX_ITERATIONS) {
      if (!canCorrect()) break;
      startCorrection();
    }
    if (correcting && correctionIterations++ >= MAX_CORRECTION_ITERATIONS) break;
    const postureWeight = correcting ? 0 : POSTURE_WEIGHT;
    const limitWeight = correcting ? 0 : LIMIT_WEIGHT;
    const columns = joints.map((joint, i) => {
      joint.matrixWorld.decompose(jointPosition, jointQuaternion, scale);
      axis.fromArray(joint.userData.jointAxis || [0, 0, 1]).applyQuaternion(jointQuaternion).normalize();
      if (definitions[i].linear) derivative.copy(axis);
      else derivative.crossVectors(axis, radius.copy(position).sub(jointPosition));
      return [derivative.x, derivative.y, derivative.z,
        ...axis.toArray().map((value) => definitions[i].linear ? 0 : value * ORIENTATION_SCALE)];
    });
    const translationScale = Math.min(1, 0.05 / Math.max(positionError, 1e-12));
    const rotationScale = ORIENTATION_SCALE * Math.min(1, 0.15 / Math.max(rotationError, 1e-12));
    const error = [...deltaPosition.toArray().map((value) => value * translationScale),
      ...deltaRotation.toArray().map((value) => value * rotationScale)];
    const before = joints.map((joint) => joint.userData.jointValue);
    const lower = before.map((value, i) => Math.max(definitions[i].lower - value, definitions[i].linear ? -0.025 : -0.13));
    const upper = before.map((value, i) => Math.min(definitions[i].upper - value, definitions[i].linear ? 0.025 : 0.13));
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    const gram = columns.map((a) => columns.map((b) => dot(a, b)));
    const rhs = columns.map((column, i) => dot(column, error)
      - postureWeight * definitions[i].weight * angleDifference(before[i], definitions[i].reference, definitions[i].continuous)
      - limitWeight * definitions[i].weight * limitOffset(before[i], definitions[i]));
    let improved = false, largestStep = 0;
    for (let attempt = 0; attempt < 2 && !improved; attempt += 1) {
      const matrix = gram.map((row, i) => row.map((value, j) => value + (i === j
        ? definitions[i].weight * (damping ** 2 + postureWeight + (limitOffset(before[i], definitions[i]) ? limitWeight : 0)) : 0)));
      const step = boundedStep(matrix, rhs, lower, upper);
      if (!step) break;
      for (const fraction of [1, 0.5, 0.25]) {
        joints.forEach((joint, i) => setRobotJointValue(joint, before[i] + step[i] * fraction));
        const candidateCost = measure();
        if (candidateCost < cost - 1e-12) {
          cost = candidateCost; improved = true;
          largestStep = Math.max(...step.map((value) => Math.abs(value * fraction)));
          damping = Math.max(0.008, damping * 0.7);
          break;
        }
      }
      if (!improved) {
        joints.forEach((joint, i) => setRobotJointValue(joint, before[i]));
        measure();
        damping = Math.min(0.2, damping * 4);
      }
    }
    if (!improved || largestStep < 1e-6) {
      if (!canCorrect()) break;
      startCorrection();
    }
  }
  robot.updateMatrixWorld(true);
  measure();
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'ZYX');
  const degrees = (radians) => {
    const wrapped = THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(radians) + 180, 360) - 180;
    return Math.abs(wrapped) < 1e-12 ? 0 : wrapped;
  };
  return {
    actualPose: { position: { x: position.x, y: position.y, z: position.z },
      rpy: { roll: degrees(euler.x), pitch: degrees(euler.y), yaw: degrees(euler.z) } },
    positionError,
    rotationError: THREE.MathUtils.radToDeg(rotationError),
    status: joints.length && positionError < 0.006 && rotationError < THREE.MathUtils.degToRad(2) ? 'tracking' : 'limited',
    frozenJointCount: controller.joints.length - joints.length,
    iterations,
    solveMs: performance.now() - started,
  };
}
