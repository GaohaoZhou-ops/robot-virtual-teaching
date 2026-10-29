import * as THREE from 'three';
import { getRobotEndEffector } from "../../../robot/model/robotLoader.js";
import { restoreMobileTeachingRobot } from "../../mobile/model/mobileTeachingKinematics.js";
import { isPolylinePlanExecutable, normalizePolyline, readPolylineTcp } from "./polylineTeaching.js";
import { isPolylineWaistJoint, polylineJointExclusions } from "./polylineTeachingJoints.js";
import { planPolyline } from "./polylineTeachingSolver.js";
import { prepareMobileCollisionEnvironment } from "../../mobile/model/mobileTeachingCollision.js";
import { checkPolylineStartTool } from "./polylineTeachingToolCheck.js";
import { polylineApproachTrialKey,
  polylineApproachFailureSeed, polylineDeepApproachTrials } from "./polylineTeachingDeepSearch.js";

function postureTrials(controller, action, lockedJointNames, collision) {
  const excluded = polylineJointExclusions(controller, action, lockedJointNames);
  const movable = controller.joints.filter((joint) => !excluded.has(joint));
  const waist = movable.filter(isPolylineWaistJoint).map((joint) => joint.name);
  const groups = [waist, waist.filter((name) => /yaw/i.test(name)), waist.filter((name) => !/yaw/i.test(name))];
  // A redundant arm posture can cause workpiece interference too, especially
  // on an intermediate link. Include environment hits, not just self pairs.
  const links = new Set([...collision.selfPairs.flat(), ...collision.environmentLinks]);
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
export async function planPolylineWithApproach({ snapshot, approachGuides = [], successfulGuides = [], recoverLocal = true,
  deepBudgetMs,
  now = () => performance.now(), checkpoint = async () => {}, onProgress = () => {}, ...options }) {
  const started = now();
  const action = normalizePolyline(options.path);
  if (!action) throw new Error('折线或算法参数无效，请调整后重新检查');
  const preparedEnvironment = await prepareMobileCollisionEnvironment(options.environment, checkpoint);
  const validPoints = (points, allowEmpty = false) => Array.isArray(points) && (allowEmpty || points.length > 0) && points.length <= 64
    && points.every((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
  const memories = successfulGuides.filter((guide) => validPoints(guide?.waypoints, true)
    && Array.isArray(guide.referenceSamples) && guide.referenceSamples.length <= 256).slice(0, 3);
  const referenceSamples = memories.flatMap((guide) => guide.referenceSamples);
  const run = (trial = {}, progress = onProgress, visit = checkpoint) => planPolyline({ ...options, recoverLocal, referenceSamples, ...trial,
    robot: restoreMobileTeachingRobot(snapshot), preparedEnvironment, checkpoint: visit, onProgress: progress });
  const original = await run();
  if (isPolylinePlanExecutable(original) || action.base.sync || action.base.search
    || original.issue?.phase !== 'approach' || !original.issue.collision) return original;

  const robot = restoreMobileTeachingRobot(snapshot), layer = new THREE.Group();
  new THREE.Matrix4().fromArray(options.parentMatrix).decompose(layer.position, layer.quaternion, layer.scale);
  layer.add(robot); layer.updateMatrixWorld(true);
  const controller = getRobotEndEffector(robot, action.side);
  const checkTool = (path, certifyTolerance = true) => checkPolylineStartTool({ robot, frame: controller.frame, path,
    environment: options.environment, preparedEnvironment, checkpoint, certifyTolerance });
  const startToolCheck = await checkTool(action);
  if (startToolCheck?.blocked) {
    // Suggest a geometric comparison only. Never change the authored offset,
    // move the live robot or advertise this as an executable IK solution.
    let oppositeDirection = null;
    if (Math.abs(action.tcpOffset[2]) > 1e-9) {
      const tcpOffset = [...action.tcpOffset]; tcpOffset[2] *= -1;
      const alternative = await checkTool({ ...action, tcpOffset }, false);
      if (alternative?.allAttachmentsChecked && !alternative.blocked) oppositeDirection = { direction: Math.sign(tcpOffset[2]), tcpOffset };
    }
    return { ...original,
      issue: { code: 'tool-goal-collision', phase: 'approach', segmentIndex: -1, progress: 1,
        message: `固定安装部件与工件干涉：${startToolCheck.collision.environmentLinks.join('、')}。请调整工具轴方向、偏移或朝向`,
        collision: startToolCheck.collision },
      startToolCheck: { ...startToolCheck, oppositeDirection, originalIssue: original.issue, elapsedMs: Math.max(0, now() - started) } };
  }
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
  const guides = approachGuides.filter((guide) => validPoints(guide?.waypoints)).slice(0, 8);
  // Keep the original generic search budget. Saved paths add bounded hints;
  // they never replace collision checks or suppress existing detour options.
  const candidates = [...memories.map((memory) => ({ approachWaypoints: memory.waypoints, memory, referenceKey: memory.referenceKey,
    referenceSamples: memory.referenceSamples, preferReference: true })),
  ...guides.map((guide) => ({ approachWaypoints: guide.waypoints, guide })), ...trials.slice(0, 35)];
  const budget = Math.max(0, Math.min(60000, Number.isFinite(deepBudgetMs) ? deepBudgetMs : action.settings.deepSearchSeconds * 1000));
  const candidateLimit = action.settings.deepSearchCandidates;
  const budgetExpired = Symbol('approach-search-budget');
  const seen = new Set([polylineApproachTrialKey({})]);
  let attempts = 0, guideAttempts = 0, memoryAttempts = 0, quickAttempts = 0, deepAttempts = 0, best = null;
  let furthestFailure = original, reachedStart = false;
  let seed = polylineApproachFailureSeed(start, goal, {}, original.issue);
  let searchStage = 'quick', deepStarted = null, currentTrial = null, currentIndex = 0, currentTotal = candidates.length;
  let lastProgress = { fraction: 0 }, lastReported = started;
  const elapsed = () => ({ elapsedMs: Math.max(0, now() - started),
    deepElapsedMs: deepStarted === null ? 0 : Math.max(0, now() - deepStarted), deepBudgetMs: budget, deepCandidateLimit: candidateLimit });
  const progress = (value = lastProgress) => {
    lastProgress = value; lastReported = now();
    const stage = searchStage === 'deep'
      ? ({ 'axis-order': '分方向接近起点', 'local-detour': '碰撞附近多段绕行',
        'expanded-detour': '扩大绕行方向和距离', 'axis-posture': '调整关节配合接近' }[currentTrial?.deepStrategy] || '准备深入搜索')
      : currentTrial?.memory ? '参考最近成功姿态接近' : currentTrial?.guide ? '参考已保存折线接近'
        : currentTrial?.approachWaypoints ? '搜索绕行接近路线' : '尝试替代接近姿态';
    onProgress({ ...value, phase: 'approach-search', searchStage, stage, ...elapsed(),
      fraction: value.fraction ?? 0, candidate: currentIndex, candidates: currentTotal, attempts, quickAttempts, deepAttempts });
  };
  const visit = async () => {
    await checkpoint();
    if (now() - lastReported >= 250) progress();
    if (deepStarted !== null && now() - deepStarted >= budget) throw budgetExpired;
  };
  const finish = (result, stopReason) => ({ ...result, approachSearch: {
    ...result.approachSearch, found: isPolylinePlanExecutable(result), attempts, guideAttempts, memoryAttempts, quickAttempts, deepAttempts,
    lastStage: searchStage, reachedStart, stopReason, ...elapsed(), environmentBuildMs: preparedEnvironment.buildMs,
    environmentBuilds: 1, originalIssue: original.issue } });
  const evaluate = async (trial, index, total) => {
    currentTrial = trial; currentIndex = index; currentTotal = total;
    attempts += 1;
    if (searchStage === 'deep') deepAttempts += 1; else quickAttempts += 1;
    if (trial.guide) guideAttempts += 1;
    if (trial.memory) memoryAttempts += 1;
    progress({ fraction: 0 }); await visit();
    const result = await run(trial, progress, visit);
    if (result.issue?.phase === 'drawing') {
      reachedStart = true;
      // Do not keep saying P0 could not be reached when a checked transit did
      // reach it and the failure is actually in the new drawing segment.
      const score = (value) => value.issue.phase === 'drawing' ? value.issue.segmentIndex + value.issue.progress : -1;
      if (score(result) > score(furthestFailure)) furthestFailure = result;
    }
    const nextSeed = polylineApproachFailureSeed(start, goal, trial, result.issue);
    if (nextSeed && (!seed || nextSeed.remaining < seed.remaining - .005)) seed = nextSeed;
    if (!isPolylinePlanExecutable(result)) return null;
    reachedStart = true;
    const candidate = { ...result, approachSearch: { stage: searchStage, deepStrategy: trial.deepStrategy,
      mode: trial.memory ? 'successful-path' : trial.guide ? 'saved-path' : trial.approachWaypoints ? 'detour' : 'posture',
      ...(trial.memory || trial.guide ? { sourcePathId: (trial.memory || trial.guide).sourcePathId,
        sourcePathName: (trial.memory || trial.guide).sourcePathName } : {}),
      waypoints: trial.approachWaypoints || [], heldJoints: trial.approachLockedJointNames || [] } };
    // Only fully validated drawing prefixes are retained. A timeout inside a
    // later candidate cannot publish any of that candidate's unfinished work.
    if (!best || result.distance > best.distance + 1e-8) best = candidate;
    return candidate;
  };
  for (let i = 0; i < candidates.length; i += 1) {
    seen.add(polylineApproachTrialKey(candidates[i]));
    const result = await evaluate(candidates[i], i + 1, candidates.length);
    if (result?.complete) return finish(result, 'complete');
  }
  if (!budget) return finish(best || furthestFailure, 'disabled');
  searchStage = 'deep'; deepStarted = now(); currentTrial = null; currentIndex = 0; currentTotal = candidateLimit;
  progress({ fraction: 0 });
  let stopReason = 'exhausted';
  try {
    for (const trial of polylineDeepApproachTrials(start, goal, () => seed, postures)) {
      await visit();
      if (deepAttempts >= candidateLimit) { stopReason = 'candidate-limit'; break; }
      const key = polylineApproachTrialKey(trial);
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await evaluate(trial, deepAttempts + 1, candidateLimit);
      if (result?.complete) return finish(result, 'complete');
    }
  } catch (error) {
    if (error !== budgetExpired) throw error;
    stopReason = 'time-budget';
  }
  return finish(best || furthestFailure, stopReason);
}
