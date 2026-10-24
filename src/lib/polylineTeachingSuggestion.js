import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues } from './robotLoader.js';
import { restoreMobileTeachingRobot } from './mobileTeachingKinematics.js';
import { getRobotJointLimits } from './robotJointLimits.js';
import { isRobotBodyJoint } from './robotJointLocks.js';
import { solveEndEffectorIk } from './robotEndEffectorIk.js';
import { createMobileCollisionChecker } from './mobileTeachingCollision.js';
import { normalizePolyline, polylineBasePose, polylineVertices } from './polylineTeaching.js';
import { polylineBaseCandidates } from './polylineTeachingBase.js';
import { planPolyline } from './polylineTeachingSolver.js';

const halton = (index, base) => {
  let value = 0, fraction = 1;
  while (index > 0) { fraction /= base; value += fraction * (index % base); index = Math.floor(index / base); }
  return value;
};

function postureSeeds(joints, initial) {
  const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29];
  return [initial, ...Array.from({ length: 15 }, (_, index) => Object.fromEntries(joints.map((joint, axis) => {
    const linear = joint.userData.jointType === 'prismatic';
    const { lower, upper } = getRobotJointLimits(joint);
    const value = joint.userData.jointValue || 0;
    const low = Number.isFinite(lower) ? lower : value - (linear ? .5 : Math.PI);
    const high = Number.isFinite(upper) ? upper : value + (linear ? .5 : Math.PI);
    const fraction = index === 0 ? .5 : .1 + .8 * halton(index, primes[axis % primes.length]);
    const next = low + (high - low) * fraction;
    return [joint.name, linear ? next : THREE.MathUtils.radToDeg(next)];
  })))];
}

function toolOrientations(current, point) {
  const values = [current.clone()];
  const add = (q) => { if (!values.some((value) => value.angleTo(q) < 1e-5)) values.push(q.normalize()); };
  if (point.normal) {
    const normal = new THREE.Vector3().fromArray(point.normal);
    if (normal.lengthSq() > 1e-10) for (const sign of [1, -1]) {
      add(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1).applyQuaternion(current),
        normal.clone().normalize().multiplyScalar(sign)).multiply(current));
    }
  }
  for (const angle of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
    for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]) {
      add(current.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)));
    }
  }
  return values;
}

// Suggestions are independently checked starting poses, never executable
// transit plans from the user's current robot. Keep the original failure.
export async function planPolylineWithSuggestion({ snapshot, checkpoint = async () => {}, onProgress = () => {}, ...options }) {
  const result = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(snapshot), checkpoint, onProgress });
  if (result.complete || result.partial || result.issue?.phase !== 'approach' || result.issue.code !== 'continuous-ik') return result;

  const action = normalizePolyline(options.path);
  const robot = restoreMobileTeachingRobot(snapshot), layer = new THREE.Group();
  const originalMatrix = new THREE.Matrix4().fromArray(options.parentMatrix);
  originalMatrix.decompose(layer.position, layer.quaternion, layer.scale);
  layer.add(robot); layer.updateMatrixWorld(true);
  const controller = getRobotEndEffector(robot, action.side);
  const opposite = getRobotEndEffector(robot, action.side === 'left' ? 'right' : 'left');
  const locked = new Set(options.lockedJointNames || []);
  const excluded = new Set(controller.joints.filter((joint) => locked.has(joint.name)
    || opposite?.joints.includes(joint) || isRobotBodyJoint(joint) || /torso|chest|head/i.test(joint.name)));
  const movable = controller.joints.filter((joint) => !excluded.has(joint));
  const initial = readRobotJointValues(robot), seeds = postureSeeds(movable, initial);
  const tcp = new THREE.Object3D(); tcp.position.fromArray(action.tcpOffset); controller.frame.add(tcp); controller.frame = tcp;
  layer.updateMatrixWorld(true);
  const currentQuaternion = tcp.getWorldQuaternion(new THREE.Quaternion());
  // If fixed direction seeds fail, a position-only solve can propose a new
  // tool direction. That achieved direction is then FIXED for full validation.
  const orientations = [...toolOrientations(currentQuaternion, action.points[0]), null];
  const target = new THREE.Vector3().fromArray(action.points[0].position);
  const reference = { position: layer.position.toArray(), quaternion: layer.quaternion.toArray() };
  const scale = layer.scale.clone();
  const candidates = polylineBaseCandidates(polylineVertices(action), tcp.getWorldPosition(new THREE.Vector3()), reference, action.base)
    .filter((candidate) => Math.hypot(candidate.x, candidate.y) > 1e-8 || Math.abs(candidate.yaw) > 1e-8)
    .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || Math.abs(a.yaw) - Math.abs(b.yaw)).slice(0, 24);
  const checker = await createMobileCollisionChecker(robot, options.environment, checkpoint);
  const seen = new Set();
  let attempts = 0, checked = 0;
  for (const movedBase of [false, true]) {
    let stageChecks = 0;
    const trials = movedBase
      ? candidates.flatMap((base) => [orientations[0], null].flatMap((quaternion) => seeds.slice(0, 4).map((seed) => ({ base, quaternion, seed }))))
      : orientations.flatMap((quaternion, index) => seeds.slice(0, index ? 4 : seeds.length).map((seed) => ({ base: { x: 0, y: 0, yaw: 0 }, quaternion, seed })));
    for (let index = 0; index < trials.length && stageChecks < 12; index += 1) {
      await checkpoint(); attempts += 1;
      const trial = trials[index];
      onProgress({ phase: 'suggestion', stage: movedBase ? '搜索参考底盘位置' : '保持底盘寻找参考姿态',
        candidate: index + 1, candidates: trials.length, fraction: (index + 1) / trials.length });
      const basePose = movedBase ? polylineBasePose(reference, trial.base) : reference;
      layer.position.fromArray(basePose.position); layer.quaternion.fromArray(basePose.quaternion); layer.scale.copy(scale);
      applyRobotJointValues(robot, { ...initial, ...trial.seed }); layer.updateMatrixWorld(true);
      for (let repeat = 0; repeat < 5; repeat += 1) {
        await checkpoint();
        const solved = solveEndEffectorIk(controller, target, trial.quaternion, excluded,
          { referenceJointValues: trial.seed, positionOnly: !trial.quaternion });
        if (solved.positionError <= action.settings.tolerance && solved.rotationError <= action.settings.rotationTolerance) break;
      }
      layer.updateMatrixWorld(true);
      if (tcp.getWorldPosition(new THREE.Vector3()).distanceTo(target) > action.settings.tolerance
        || (trial.quaternion && THREE.MathUtils.radToDeg(tcp.getWorldQuaternion(new THREE.Quaternion()).angleTo(trial.quaternion)) > action.settings.rotationTolerance)
        || !checker.check().clear) continue;
      const joints = readRobotJointValues(robot);
      const quaternion = tcp.getWorldQuaternion(new THREE.Quaternion()).toArray();
      const key = JSON.stringify([basePose, Object.values(joints).map((value) => Number(value.toFixed(3)))]);
      if (seen.has(key)) continue;
      seen.add(key); stageChecks += 1; checked += 1;
      // Check every segment and its actual playback interpolation. A reachable
      // P0 alone must never be advertised as a solution for the whole stroke.
      // Use the achieved orientation, just as a later user-initiated check will.
      const validationRobot = restoreMobileTeachingRobot(snapshot);
      applyRobotJointValues(validationRobot, joints);
      const verified = await planPolyline({ ...options, robot: validationRobot, parentMatrix: layer.matrixWorld.toArray(), checkpoint,
        path: { ...action, quaternion, base: { ...action.base, search: false, allowPartial: false } },
        onProgress: (progress) => onProgress({ ...progress, phase: 'suggestion', stage: '验证参考姿态的完整路线',
          candidate: checked, candidates: checked }) });
      if (!verified.complete) continue;
      return { ...result, suggestion: { joints, basePose, movedBase, quaternion,
        baseDelta: { ...trial.base }, orientationChange: THREE.MathUtils.radToDeg(currentQuaternion.angleTo(new THREE.Quaternion().fromArray(quaternion))),
        distance: verified.distance, durationMs: verified.durationMs, maximumError: verified.maximumError,
        checks: verified.checks, warnings: verified.warnings, transitChecked: false },
      suggestionSearch: { attempts, checked, found: true } };
    }
  }
  return { ...result, suggestion: null, suggestionSearch: { attempts, checked, found: false } };
}
