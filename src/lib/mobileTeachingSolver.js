import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, normalizeRobotPose, readRobotJointValues, setRobotJointValue } from './robotLoader.js';
import { mobileCaptureMatrix } from './ipadCaptureDisplay.js';

const XYZ = ['x', 'y', 'z'];
const RPY = ['roll', 'pitch', 'yaw'];
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const plain = (v) => Object.fromEntries(XYZ.map((axis) => [axis, v[axis]]));
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const abort = (signal) => { if (signal?.aborted) throw new DOMException('计算已取消', 'AbortError'); };

export const DEFAULT_MOBILE_SOLVE_OPTIONS = Object.freeze({
  positionTolerance: Object.freeze({ x: 0.05, y: 0.05, z: 0.05 }),
  rotationTolerance: Object.freeze({ roll: 5, pitch: 5, yaw: 5 }),
  targetFrame: 'optical', armMode: 'both', allowSingleArm: true,
  lockChestVertical: true, respectJointLocks: true, keyframesOnly: true,
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
  return options;
}

export function normalizeMobileSolveReport(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.rows)) return null;
  try {
    validateMobileSolveOptions(value.options);
    if (!XYZ.every((axis) => Number.isFinite(value.mapPose?.position?.[axis]))
      || !RPY.every((axis) => Number.isFinite(value.mapPose?.rpy?.[axis]))) return null;
    for (const row of value.rows) {
      if (typeof row.sampleId !== 'string' || !row.solutions) return null;
      for (const solution of Object.values(row.solutions)) {
        if (!solution.jointValues) { if (solution.feasible) return null; continue; }
        if (!Object.values(solution.jointValues).every(Number.isFinite)
          || !XYZ.every((axis) => Number.isFinite(solution.positionError?.[axis]))
          || !RPY.every((axis) => Number.isFinite(solution.rotationError?.[axis]))) return null;
      }
    }
    return structuredClone(value);
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

// All computations use a private model. Joint limits are enforced on every
// update; chest verticality is a world-up constraint, independent of yaw.
async function solveArm({ controller, chest, target, options, locked, baseline, seed, checkpoint }) {
  const { robot, frame } = controller;
  const joints = controller.joints.filter((joint) => !locked.has(joint.name));
  const chestJoints = new Set();
  for (let node = chest; node && node !== robot; node = node.parent) chestJoints.add(node);
  const targetInverse = target.quaternion.clone().invert();
  const weights = [...XYZ.map((axis) => 0.05 / options.positionTolerance[axis]),
    ...RPY.map((axis) => 0.24 * 5 / options.rotationTolerance[axis])];
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
    const feasible = metrics.withinTolerance && chestTilt <= 0.25;
    return { ...metrics, feasible, chestTilt, actualPosition, up, error, cost: error.reduce((sum, n) => sum + n * n, 0) };
  };
  let best = null;
  // Continuity seed first, followed by independent, deterministic restarts.
  for (let start = 0; start < 5; start += 1) {
    await checkpoint();
    applyRobotJointValues(robot, baseline);
    if (start === 0) applyRobotJointValues(robot, seed);
    if (start > 1) joints.forEach((joint, index) => {
      if (chestJoints.has(joint)) return;
      const amount = (joint.userData.jointType === 'prismatic' ? 0.06 : 0.65) * Math.sin((index + 1) * (start + 1) * 1.7);
      setRobotJointValue(joint, joint.userData.jointValue + amount);
    });
    // Straight legs have no first-order vertical motion. Start from a bent,
    // upright torso as well, so a vertical chest can still lower its height.
    if (start > 1) ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'].forEach((name, index) => {
      const joint = robot.getObjectByName(name);
      if (joint && !locked.has(name)) setRobotJointValue(joint,
        joint.userData.jointValue + [1, -2, 1][index] * (start - 1) * 0.22);
    });
    for (let iteration = 0; iteration < 100; iteration += 1) {
      if (iteration % 12 === 0) await checkpoint();
      const state = measure();
      if (!best || (state.feasible && !best.feasible) || (state.feasible === best.feasible && state.cost < best.cost)) {
        best = { ...state, jointValues: readRobotJointValues(robot) };
      }
      if (state.feasible || !joints.length) break;
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
      const step = solveLinear(columns.map((a, i) => columns.map((b, j) => dot(a, b) + (i === j ? 0.001 : 0))), columns.map((column) => dot(column, state.error)));
      if (!step) break;
      const before = joints.map((joint) => joint.userData.jointValue);
      const scale = Math.min(1, 0.2 / Math.max(...step.map(Math.abs), 1e-12));
      let improved = false;
      for (const line of [1, 0.5, 0.2, 0.05]) {
        joints.forEach((joint, i) => setRobotJointValue(joint, before[i] + step[i] * scale * line));
        if (measure().cost < state.cost - 1e-12) { improved = true; break; }
      }
      if (!improved) break;
    }
    if (best?.feasible) break;
  }
  applyRobotJointValues(robot, best.jointValues);
  const metrics = measure();
  return { feasible: metrics.feasible, frameName: frame.name, positionError: metrics.positionError,
    rotationError: metrics.rotationError, chestTilt: metrics.chestTilt, actualPose: metrics.actualPose,
    jointValues: best.jointValues, score: metrics.cost,
    reason: metrics.feasible ? '' : metrics.chestTilt > 0.25 ? '前胸未满足垂直约束，请检查关节锁定' : '当前底盘位置、关节限位或锁定下未找到容差内解' };
}

export async function solveMobileTeaching({ robot: liveRobot, task, mapPose, options: rawOptions, lockedJointNames = [], signal, onProgress, onSample, waitIfPaused }) {
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
  const robot = liveRobot.clone(true), layer = new THREE.Group();
  layer.add(robot);
  const basePose = normalizeRobotPose(mapPose);
  layer.position.set(...XYZ.map((axis) => basePose.position[axis]));
  // Match the workbench's existing base-pose convention exactly.
  layer.rotation.set(...RPY.map((axis) => rad(basePose.rpy[axis])), 'XYZ');
  layer.updateMatrixWorld(true);
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
    const baseline = readRobotJointValues(robot), seeds = { left: baseline, right: baseline };
    const locked = new Set(options.respectJointLocks ? lockedJointNames : []);
    const rows = [];
    let feasibleCount = 0;
    for (const [index, sample] of samples.entries()) {
      await checkpoint();
      onProgress?.({ completed: index, total: samples.length, name: sample.name, feasibleCount });
      const target = mobileSampleTarget(sample, task), solutions = {};
      for (const side of sides) {
        await checkpoint();
        onProgress?.({ completed: index, total: samples.length, name: sample.name, side, feasibleCount });
        const controller = controllers[side];
        solutions[side] = controller ? await solveArm({ controller, chest, target, options, locked, baseline, seed: seeds[side], checkpoint })
          : { feasible: false, reason: '该机械臂或目标坐标系不存在' };
        if (solutions[side].feasible) seeds[side] = solutions[side].jointValues;
      }
      const feasibleSides = sides.filter((side) => solutions[side].feasible);
      const feasible = options.armMode === 'both' && !options.allowSingleArm ? feasibleSides.length === 2 : feasibleSides.length > 0;
      const selectedSide = feasibleSides.sort((a, b) => solutions[a].score - solutions[b].score)[0] || null;
      await checkpoint();
      const row = { sampleId: sample.id, name: sample.name || `Pose ${index + 1}`, capturedAt: sample.capturedAt,
        feasible, selectedSide, solutions, target: { position: plain(target.position), quaternion: { ...plain(target.quaternion), w: target.quaternion.w } },
        reason: feasible ? '' : feasibleSides.length ? '仅单臂可达，当前要求左右臂分别可达' : '未找到满足约束的解' };
      rows.push(row);
      if (feasible) feasibleCount += 1;
      onSample?.({ row, mapPose: basePose, index, total: samples.length });
      onProgress?.({ completed: index + 1, total: samples.length, name: sample.name, feasibleCount });
    }
    await checkpoint();
    return { version: 1, taskId: task.id, captureId: task.mobileCapture.id, computedAt: new Date().toISOString(),
      coordinateFrame: task.coordinateFrame, mapPose: basePose, options, lockedJointNames: [...locked], rows,
      sourceCount: task.mobileCapture.samples.length, feasibleCount };
  } finally {
    // The clone shares geometries/materials with the live robot: never dispose them.
    layer.clear();
  }
}

export function buildMobileSolvedTask(source, report, robot, id) {
  const points = report.rows.filter((row) => row.feasible && row.solutions[row.selectedSide]?.feasible);
  if (!points.length) throw new Error('没有可保存的可达姿态');
  const mapPose = { ...report.mapPose, frameId: source.coordinateFrame };
  return {
    id, name: `${source.name} · 机器人解`, createdAt: report.computedAt, updatedAt: report.computedAt,
    coordinateFrame: source.coordinateFrame, map: { ...source.map },
    robot: { id: robot.id || robot.relativePath, name: robot.name, relativePath: robot.relativePath },
    mobileSolveSource: { taskId: source.id, captureId: report.captureId, computedAt: report.computedAt, options: report.options },
    parkingPoints: [{ id: `${id}-parking`, name: '计算停车点 P01', sequence: 1, createdAt: report.computedAt, updatedAt: report.computedAt,
      mapPose, poses: points.map((row, index) => {
        const solution = row.solutions[row.selectedSide];
        return { id: `${id}-pose-${index}`, name: `${row.name} · ${row.selectedSide === 'left' ? '左臂' : '右臂'}`, sequence: index + 1,
          capturedAt: row.capturedAt, mapPose, fullBodyJoints: { angularUnit: 'degree', linearUnit: 'meter', values: solution.jointValues },
          ...(report.options.targetFrame === 'optical' ? { opticalTargets: { [row.selectedSide]: { ...row.target, frameName: solution.frameName, side: row.selectedSide } } } : {}),
          mobileSampleId: row.sampleId };
      }) }],
  };
}
