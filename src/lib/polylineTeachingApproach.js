import * as THREE from 'three';
import { getRobotEndEffector } from './robotLoader.js';
import { restoreMobileTeachingRobot } from './mobileTeachingKinematics.js';
import { isPolylinePlanExecutable, normalizePolyline, readPolylineTcp } from './polylineTeaching.js';
import { isPolylineWaistJoint, polylineJointExclusions } from './polylineTeachingJoints.js';
import { planPolyline } from './polylineTeachingSolver.js';

function postureTrials(controller, action, lockedJointNames, collision) {
  const excluded = polylineJointExclusions(controller, action, lockedJointNames);
  const movable = controller.joints.filter((joint) => !excluded.has(joint));
  const waist = movable.filter(isPolylineWaistJoint).map((joint) => joint.name);
  const groups = [waist, waist.filter((name) => /yaw/i.test(name)), waist.filter((name) => !/yaw/i.test(name))];
  const links = new Set(collision.selfPairs.flat());
  // Hold the implicated arm joint, or its preceding joint, to try a different
  // redundant posture without seeding a discontinuous jump in joint space.
  controller.robot.traverse((node) => {
    const proxy = node.userData.mobileCollision;
    if (!proxy || !links.has(proxy.linkName)) return;
    const chain = proxy.chain.filter((name) => movable.some((joint) => joint.name === name && !isPolylineWaistJoint(joint)));
    for (const name of chain.slice(-2).reverse()) groups.push([name]);
  });
  const seen = new Set();
  return groups.filter((names) => {
    const key = [...names].sort().join(',');
    if (!names.length || names.length >= movable.length || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 5);
}

function detourTrials(start, goal, origin, normal) {
  const direction = goal.clone().sub(start).normalize(), directions = [];
  const add = (vector) => {
    if (vector.lengthSq() < 1e-8) return;
    vector.normalize();
    if (!directions.some((other) => other.dot(vector) > .98)) directions.push(vector);
  };
  add(start.clone().add(goal).multiplyScalar(.5).sub(origin).setZ(0));
  add(new THREE.Vector3(0, 0, 1));
  const sideways = new THREE.Vector3(-direction.y, direction.x, 0);
  add(sideways.clone()); add(sideways.clone().negate());
  if (normal) { add(new THREE.Vector3().fromArray(normal)); add(new THREE.Vector3().fromArray(normal).negate()); }
  for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1]]) add(new THREE.Vector3(...axis));
  // These are approach-only corners. Authored drawing vertices stay exact.
  return [.08, .18, .32].flatMap((distance) => directions.slice(0, 6).map((vector) => {
    const offset = vector.clone().multiplyScalar(distance);
    return [start.clone().add(offset).toArray(), goal.clone().add(offset).toArray()];
  }));
}

// Bounded, deterministic recovery for fixed-base approach collisions. Each
// trial starts at the original pose and validates the entire transit, stroke
// (or allowed continuous prefix), and the interpolation actually played back.
export async function planPolylineWithApproach({ snapshot, checkpoint = async () => {}, onProgress = () => {}, ...options }) {
  const run = (trial = {}, progress = onProgress) => planPolyline({ ...options, ...trial,
    robot: restoreMobileTeachingRobot(snapshot), checkpoint, onProgress: progress });
  const original = await run();
  const action = normalizePolyline(options.path);
  if (isPolylinePlanExecutable(original) || action.base.sync || action.base.search
    || original.issue?.phase !== 'approach' || !original.issue.collision) return original;

  const robot = restoreMobileTeachingRobot(snapshot), layer = new THREE.Group();
  new THREE.Matrix4().fromArray(options.parentMatrix).decompose(layer.position, layer.quaternion, layer.scale);
  layer.add(robot); layer.updateMatrixWorld(true);
  const controller = getRobotEndEffector(robot, action.side);
  const postures = postureTrials(controller, action, options.lockedJointNames, original.issue.collision);
  const start = readPolylineTcp(robot, action), goal = new THREE.Vector3().fromArray(action.points[0].position);
  const detours = detourTrials(start, goal, layer.position, action.points[0].normal);
  const trials = postures.map((approachLockedJointNames) => ({ approachLockedJointNames }));
  for (const approachWaypoints of detours) trials.push({ approachWaypoints });
  // Also combine the detour with a restrained torso, if that is a distinct
  // available posture. Keep total work bounded and cancellation responsive.
  if (postures.length) for (const approachWaypoints of detours.filter((_, index) => index >= 6)) {
    trials.push({ approachWaypoints, approachLockedJointNames: postures[0] });
  }
  let attempts = 0, best = null;
  for (const trial of trials.slice(0, 35)) {
    await checkpoint(); attempts += 1;
    const progress = (value = {}) => onProgress({ ...value, phase: 'approach-search',
      stage: trial.approachWaypoints ? '搜索绕行接近路线' : '尝试替代接近姿态',
      fraction: value.fraction ?? 0, candidate: attempts, candidates: Math.min(35, trials.length) });
    progress();
    const result = await run(trial, progress);
    if (!isPolylinePlanExecutable(result)) continue;
    const candidate = { ...result, approachSearch: { attempts, found: true,
      mode: trial.approachWaypoints ? 'detour' : 'posture',
      waypoints: trial.approachWaypoints || [], heldJoints: trial.approachLockedJointNames || [],
      originalIssue: original.issue } };
    if (result.complete) return candidate;
    // With maximum protection, prefer the longest verified drawing prefix
    // among the bounded candidates. A short approach is never a drawn prefix.
    if (!best || result.distance > best.distance + 1e-8) best = candidate;
  }
  if (best) return { ...best, approachSearch: { ...best.approachSearch, attempts } };
  return { ...original, approachSearch: { attempts, found: false, originalIssue: original.issue } };
}
