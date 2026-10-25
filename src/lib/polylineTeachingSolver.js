import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues } from './robotLoader.js';
import { getRobotJointLimits } from './robotJointLimits.js';
import { getRobotJointCouplingPairs, robotJointCouplingViolations } from './robotJointCoupling.js';
import { polylineJointExclusions } from './polylineTeachingJoints.js';
import { solveEndEffectorIk } from './robotEndEffectorIk.js';
import { createMobileCollisionChecker } from './mobileTeachingCollision.js';
import { normalizePolyline, polylineVertices, preparePolylineInterpolation, samplePolylineState } from './polylineTeaching.js';
import { preparePolylineTiming } from './polylineTeachingTiming.js';
import { buildPolylineDrawingEdges, samplePolylineCurve } from './polylineTeachingCurve.js';
import { preparePolylineArcMapping } from './polylineTeachingSpeed.js';
import { createPolylineBase, polylineBaseCandidates, polylinePostureCost } from './polylineTeachingBase.js';

export async function planPolyline({ robot, parentMatrix, path, environment, lockedJointNames = [],
  approachWaypoints = [], approachLockedJointNames = [], checkpoint = async () => {}, onProgress = () => {} }) {
  const action = normalizePolyline(path);
  if (!action || action.points.length < 2) throw new Error('请至少选择两个有效的表面点');
  if (approachWaypoints.length && (action.base.sync || action.base.search)) throw new Error('接近绕行仅支持底盘静止');
  if (approachWaypoints.some((point) => point.length !== 3 || !point.every(Number.isFinite))) throw new Error('接近路线包含无效坐标');
  const layer = new THREE.Group();
  new THREE.Matrix4().fromArray(parentMatrix).decompose(layer.position, layer.quaternion, layer.scale);
  layer.add(robot); layer.updateMatrixWorld(true);
  const controller = getRobotEndEffector(robot, action.side);
  if (!controller) throw new Error('当前机器人缺少所选侧的 tool 工具坐标系');
  const toolFrame = controller.frame;
  const tcpFrame = new THREE.Object3D(); tcpFrame.position.fromArray(action.tcpOffset);
  toolFrame.add(tcpFrame); controller.frame = tcpFrame; layer.updateMatrixWorld(true);
  const excluded = polylineJointExclusions(controller, action, lockedJointNames);
  const movable = controller.joints.filter((joint) => !excluded.has(joint));
  if (!movable.length && !action.base.sync) throw new Error('所选机械臂的关节均被锁定');
  const initialJoints = readRobotJointValues(robot);
  const base = action.base.sync || action.base.search ? createPolylineBase(layer, action.base) : null;
  if (base) controller.joints.push(...base.joints);
  const zeroBase = { x: 0, y: 0, yaw: 0 };
  const root = base?.root || layer;
  const readState = () => ({ joints: readRobotJointValues(robot), ...(base ? { base: base.read() } : {}) });
  const initialState = readState();
  const applyState = (state) => {
    if (base) base.apply(state.base);
    applyRobotJointValues(robot, state.joints); root.updateMatrixWorld(true);
  };
  const fixedBaseExcluded = new Set([...excluded, ...(base?.joints || [])]);
  const solvingExcluded = action.base.sync ? excluded : fixedBaseExcluded;
  // Recovery trials can temporarily hold redundant joints on the way to P0.
  // Release these additional restrictions for drawing; user locks still apply.
  const approachLocks = new Set(approachLockedJointNames);
  const approachExcluded = new Set([...solvingExcluded, ...controller.joints.filter((joint) => approachLocks.has(joint.name))]);
  const targetQuaternion = action.quaternion ? new THREE.Quaternion().fromArray(action.quaternion)
    : controller.frame.getWorldQuaternion(new THREE.Quaternion());
  const settings = action.settings, coupling = getRobotJointCouplingPairs(robot);
  const definitions = Object.fromEntries(movable.map((joint) => [joint.name, {
    type: joint.userData.jointType,
    velocity: (joint.userData.jointLimit?.velocity || 0) * (joint.userData.jointType === 'prismatic' ? 1 : 180 / Math.PI),
  }]));
  const checker = await createMobileCollisionChecker(robot, environment, checkpoint);
  const vertices = polylineVertices(action);
  const allowPartial = action.base.allowPartial && !action.base.sync && !action.base.search;
  const requestedDistance = vertices.slice(1).reduce((sum, point, i) => sum + point.distanceTo(vertices[i]), 0);
  const start = controller.frame.getWorldPosition(new THREE.Vector3());
  let approachOffset = 0, approachLength = start.distanceTo(vertices[0]), activeCurve = null;
  const issue = (message, index, u, details = {}) => {
    const point = index >= 0 && activeCurve ? samplePolylineCurve(activeCurve, u) : null;
    return { message, segmentIndex: point?.segmentIndex ?? index, progress: point?.segmentProgress ?? u,
      phase: index === -2 ? 'positioning' : index < 0 ? 'approach' : 'drawing',
      ...(point ? { curveProgress: u } : {}),
      ...(index < 0 ? { distanceFromStart: approachOffset + approachLength * u } : {}), ...details };
  };
  const collisionIssue = (index, u) => {
    const collision = checker.check({ detailedEnvironment: true });
    if (collision.clear) return null;
    const reasons = [];
    if (collision.selfPairs.length) reasons.push(`机器人自身碰撞：${collision.selfPairs.map((pair) => pair.join(' ↔ ')).join('；')}`);
    if (collision.environmentIntersectingLinks.length) reasons.push(`机器人与模型碰撞：${collision.environmentIntersectingLinks.join('、')}（碰撞体重叠）`);
    if (collision.environmentClearanceLinks.length) reasons.push(`机器人碰撞体的 ${(collision.environmentMargin * 1000).toFixed(0)} mm 预留区与模型相交：${collision.environmentClearanceLinks.join('、')}`);
    if (collision.groundLinks.length) reasons.push(`部件低于支撑平面：${collision.groundLinks.join('、')}`);
    return issue(reasons.join('；') || '碰撞检查未通过', index, u, { collision });
  };
  const referenceValues = (state) => ({ ...initialJoints, ...state.joints, ...(base ? Object.fromEntries(base.joints.map((joint, i) =>
    [joint.name, state.base[['x', 'y', 'yaw'][i]]])) : {}) });
  const solveTarget = (target, exclusions, reference, repeats = 1, precise = false) => {
    const positionTolerance = precise ? 2e-7 : undefined;
    for (let i = 0; i < repeats; i += 1) {
      const result = solveEndEffectorIk(controller, target, targetQuaternion, exclusions, {
        referenceJointValues: reference, positionTolerance, refineOnly: precise,
      });
      if (result.positionError <= (positionTolerance ?? settings.tolerance) && result.rotationError <= settings.rotationTolerance) break;
    }
    root.updateMatrixWorld(true);
  };
  if (THREE.MathUtils.radToDeg(controller.frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(targetQuaternion)) > settings.rotationTolerance) {
    return { complete: false, warnings: [], issue: issue('工具朝向已变化，请重新检查路径以采用当前朝向', -1, 0) };
  }

  const buildPlan = async (candidate = zeroBase, reportProgress = onProgress) => {
    applyState(initialState);
    activeCurve = null;
    approachOffset = 0; approachLength = start.distanceTo(vertices[0]);
    const segments = [];
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    let maximumError = 0, checks = 0, durationMs = 0;
    const warnings = [], warningKeys = new Set();
    const warn = (code, message, index, u, phase = index === -2 ? 'positioning' : index < 0 ? 'approach' : 'drawing') => {
      // Sampling and interpolation may hit the same surface many times. Keep
      // one visible warning per kind and segment, with its first location.
      const warning = issue(message, index, u, { code, phase });
      const key = `${phase}:${warning.segmentIndex}:${code}`;
      if (warningKeys.has(key)) return;
      warningKeys.add(key); warnings.push(warning);
    };
    const validState = (target, index, u, phase) => {
      root.updateMatrixWorld(true);
      if (base && Math.hypot(base.read().x, base.read().y) > action.base.range + 1e-7) return issue('底盘超出允许的水平移动范围，请增大范围后重新检查', index, u);
      for (const joint of controller.joints) {
        const { lower, upper } = getRobotJointLimits(joint), value = joint.userData.jointValue || 0;
        if (value < lower - 1e-8 || value > upper + 1e-8) return issue(`关节 ${joint.name} 超出当前限位`, index, u);
      }
      if (robotJointCouplingViolations(coupling).length) return issue('关节耦合约束不满足', index, u);
      const joints = readRobotJointValues(robot);
      if (Object.keys(joints).some((name) => (!movable.some((joint) => joint.name === name) || (index < 0 && approachLocks.has(name)))
        && Math.abs(joints[name] - initialJoints[name]) > 1e-7)) return issue('求解改变了不允许参与规划的关节', index, u);
      controller.frame.getWorldPosition(position); controller.frame.getWorldQuaternion(quaternion);
      const error = position.distanceTo(target);
      const sourcePosition = index >= 0 && activeCurve ? samplePolylineCurve(activeCurve, u).sourcePosition : target;
      const sourceError = position.distanceTo(sourcePosition);
      const angular = THREE.MathUtils.radToDeg(quaternion.angleTo(targetQuaternion));
      const trackingTolerance = settings.tolerance - target.distanceTo(sourcePosition);
      if (error > trackingTolerance || sourceError > settings.tolerance || angular > settings.rotationTolerance) return issue('未找到满足沿线精度和固定朝向的连续逆解', index, u,
        { code: 'continuous-ik', positionError: error, sourceError, rotationError: angular });
      maximumError = Math.max(maximumError, sourceError);
      // Surface imperfections and intended tip contact are advisory in virtual
      // drawing. Continue checking IK, joints and physical robot collisions.
      // Require a neighbourhood inside the mesh to avoid noisy face parity.
      if (checker.containsPoint(position) && [0, 1, 2].every((axis) => [-1, 1].every((sign) => {
        const probe = position.clone(); probe.setComponent(axis, probe.getComponent(axis) + sign * 0.0002);
        return checker.containsPoint(probe);
      }))) warn('tip-inside-surface', '笔尖路径进入模型内部', index, u, phase);
      const toolOrigin = toolFrame.getWorldPosition(new THREE.Vector3());
      if (checker.intersectsSegment(toolOrigin, position)) warn('pen-crosses-surface', '虚拟笔杆穿过模型表面', index, u, phase);
      checks += 1;
      return collisionIssue(index, u);
    };
    const fail = (problem) => ({ complete: false, executable: false, partial: false,
      issue: problem, warnings, segments, checks, maximumError });
    const initialIssue = validState(start, -1, 0, 'initial');
    if (initialIssue) return fail({ ...initialIssue, phase: 'initial',
      message: `${initialIssue.message}。请先调整机器人姿态或位置，再重新检查。` });
    const addSegment = async (edge, samples, distance, endFraction = 1) => {
      const arcMapping = edge.curve ? await preparePolylineArcMapping(samples, applyState, controller.frame, checkpoint) : null;
      const { durationMs: segmentDuration, ...timed } = preparePolylineTiming(samples, arcMapping?.length ?? distance,
        { ...settings, uniformSpeed: Boolean(edge.curve) }, definitions,
        { curvature: Math.max(edge.curve?.curvature || 0, arcMapping?.curvature || 0), arcMapping });
      segments.push({ index: edge.index, phase: edge.index === -2 ? 'positioning' : edge.index < 0 ? 'approach' : 'drawing',
        from: edge.from.toArray(), to: edge.to.toArray(), samples, ...timed, endFraction,
        ...(edge.curve ? { curve: edge.curve, arcMapping } : {}),
        durationMs: segmentDuration, startMs: durationMs, endMs: durationMs + segmentDuration });
      durationMs += segmentDuration;
    };
    const finish = (problem = null) => {
      const drawing = segments.filter((segment) => segment.index >= 0);
      if (problem && (!allowPartial || problem.phase !== 'drawing' || !drawing.length)) return fail(problem);
      if (!drawing.length) throw new Error('折线点重合，请增加有长度的线段');
      if (settings.uniformSpeed && drawing.length > 1) {
        // Reversals require stops, but their continuous blocks still share the
        // same attainable cruise speed throughout this drawing operation.
        const speed = Math.min(...drawing.map((segment) => segment.cruiseSpeed));
        durationMs = 0;
        for (const segment of segments) {
          if (segment.uniformSpeed) Object.assign(segment, preparePolylineTiming(segment.samples, segment.arcMapping.length,
            { ...settings, speed }, definitions, { curvature: Math.max(segment.curve.curvature, segment.arcMapping.curvature), arcMapping: segment.arcMapping }));
          segment.startMs = durationMs; durationMs += segment.durationMs; segment.endMs = durationMs;
        }
      }
      const last = drawing.at(-1);
      const distance = drawing.reduce((sum, segment) => sum + (segment.curve
        ? samplePolylineCurve(segment.curve, segment.endFraction).sourceDistance - samplePolylineCurve(segment.curve, 0).sourceDistance
        : new THREE.Vector3().fromArray(segment.from).distanceTo(new THREE.Vector3().fromArray(segment.to))), 0);
      const lastPoint = last.curve ? samplePolylineCurve(last.curve, last.endFraction) : null;
      return { complete: !problem, executable: true, partial: Boolean(problem), ...(problem ? { issue: problem } : {}),
        warnings, segments, durationMs, initialJoints, quaternion: targetQuaternion.toArray(),
        ...(base ? { baseReference: base.reference, selectedBase: drawing[0].samples[0].base } : {}),
        maximumError, checks, distance, requestedDistance, coverage: Math.min(1, distance / requestedDistance),
        ...(settings.uniformSpeed ? { speedProfile: { mode: 'uniform', cruiseSpeed: Math.min(...drawing.map((segment) => segment.cruiseSpeed)),
          requestedSpeed: settings.speed, blendTolerance: settings.tolerance * .5, cornerStops: drawing.length - 1 } } : {}),
        stoppedAt: { segmentIndex: lastPoint?.segmentIndex ?? last.index, progress: lastPoint?.segmentProgress ?? last.endFraction, position: [...last.to] } };
    };
    const reposition = base && (Math.hypot(candidate.x, candidate.y) > 1e-8 || Math.abs(candidate.yaw) > 1e-8);
    let reference = referenceValues({ base: candidate });
    // Prescribe a continuous base transit and solve the arm along the matching
    // TCP line to P0. This keeps world tool orientation even during positioning.
    // Its interpolation receives the same refinement/collision checks as drawing.
    const approach = [start, ...approachWaypoints.map((point) => new THREE.Vector3().fromArray(point)), vertices[0]];
    const edges = [...approach.slice(1).map((to, index) => ({ from: approach[index], to, index: reposition ? -2 : -1,
      ...(reposition ? { baseTarget: candidate } : {}) })),
      ...(settings.uniformSpeed ? buildPolylineDrawingEdges(vertices, settings)
        : vertices.slice(1).map((to, index) => ({ from: vertices[index], to, index })))];
    let approachTravel = 0;
    for (const edge of edges) {
      const { from, to, index } = edge, distance = edge.distance ?? from.distanceTo(to);
      activeCurve = edge.curve || null;
      const targetAt = (u) => edge.curve ? samplePolylineCurve(edge.curve, u).target : from.clone().lerp(to, u);
      // Once recovery reaches P0, keep its achieved posture as the drawing
      // reference. Releasing held joints must not pull them abruptly back
      // toward the pre-approach configuration via IK regularization.
      if (index === 0 && (approachLocks.size || approachWaypoints.length)) reference = referenceValues(readState());
      if (distance < 0.00001 && !edge.baseTarget) continue;
      if (index < 0) { approachOffset = approachTravel; approachLength = distance; approachTravel += distance; }
      if (!edge.curve && checker.intersectsSegment(from, to)) warn('path-crosses-surface', '直线穿过物体表面', index, 0.5);
      const count = edge.sampleCount ?? Math.max(1, Math.ceil(Math.max(distance / settings.step, edge.baseTarget
        ? Math.max(Math.hypot(candidate.x, candidate.y) / 0.002, Math.abs(candidate.yaw) / 0.5) : 0)));
      const sampleLimit = Math.min(count, edge.curve ? 30000 : 10000, 30000 - segments.reduce((sum, item) => sum + item.samples.length, 0));
      if (count > sampleLimit && (!allowPartial || index < 0 || !Number.isFinite(count) || sampleLimit < 1)) {
        return finish(issue('路线过长，请拆成多条折线后分别检查', index, 0));
      }
      let samples = [{ u: 0, ...readState() }];
      const jumpIssue = (state, seed, u) => movable.some((joint) => Math.abs(state.joints[joint.name] - seed.joints[joint.name])
        > (joint.userData.jointType === 'prismatic' ? 0.01 : 8))
        ? issue('相邻采样点的关节变化过大，请调整起始姿态或补点', index, u)
        : base && (Math.hypot(state.base.x - seed.base.x, state.base.y - seed.base.y) > 0.01 || Math.abs(state.base.yaw - seed.base.yaw) > 3)
          ? issue('底盘相邻采样变化过大，请缩短采样间距或调整起始位置', index, u) : null;
      const solve = (u, seed) => {
        const resetSeed = () => {
          applyState(seed);
          if (edge.baseTarget) base.apply(Object.fromEntries(Object.entries(edge.baseTarget).map(([axis, value]) => [axis, value * u])));
        };
        resetSeed();
        const target = targetAt(u), precise = settings.uniformSpeed && (index >= 0 || u === 1);
        const exclusions = edge.baseTarget ? fixedBaseExcluded : index < 0 ? approachExcluded : solvingExcluded;
        solveTarget(target, exclusions, reference, precise ? 3 : 1, precise);
        // Extra numerical precision is a preference, never a reason to reject
        // an otherwise valid posture within the user's geometric tolerance.
        // A residual correction near a singularity may choose a colliding pose;
        // retry the regularized seed and subject it to all the same checks.
        if (precise && (jumpIssue(readState(), seed, u) || collisionIssue(index, u))) {
          resetSeed(); solveTarget(target, exclusions, reference);
        }
        const problem = validState(target, index, u);
        if (problem) return { problem };
        return { sample: { u, ...readState() } };
      };
      let stopIssue = null;
      for (let i = 1; i <= sampleLimit; i += 1) {
        await checkpoint();
        const u = edge.knots ? edge.knots[i] : i / count;
        if (edge.curve && checker.intersectsSegment(targetAt(samples.at(-1).u), targetAt(u))) {
          warn('path-crosses-surface', '笔尖路线穿过物体表面', index, u);
        }
        const result = solve(u, samples.at(-1));
        const problem = result.problem || jumpIssue(result.sample, samples.at(-1), u);
        if (problem) {
          if (!allowPartial || index < 0) return fail(problem);
          stopIssue = problem; break;
        }
        samples.push(result.sample);
        if (i % 20 === 0 || i === sampleLimit) {
          const point = edge.curve ? samplePolylineCurve(edge.curve, u) : null;
          reportProgress({ phase: index === -2 ? 'positioning' : index < 0 ? 'approach' : 'drawing',
            segmentIndex: point?.segmentIndex ?? index, fraction: point?.segmentProgress ?? u, total: vertices.length - 1 });
        }
      }
      if (!stopIssue && sampleLimit < count) stopIssue = issue('路线过长，请拆成多条折线后分别检查', index, samples.at(-1).u);
      // A successful IK endpoint alone is insufficient: check the same Hermite
      // interpolation used by playback. A shortened tail changes its tangents,
      // so EVERY retained interval is checked again after trimming.
      const validateInterpolation = async (input) => {
        let checked = input;
        for (let pass = 0; pass < 7; pass += 1) {
          preparePolylineInterpolation(checked);
          const additions = [];
          let firstRefinement = null;
          for (let i = 0; i < checked.length - 1; i += 1) {
            await checkpoint();
            for (const fraction of [0.25, 0.5, 0.75]) {
              const u = checked[i].u + (checked[i + 1].u - checked[i].u) * fraction;
              applyState(samplePolylineState(checked, u));
              const problem = validState(targetAt(u), index, u);
              if (!problem) continue;
              if (problem.collision || !problem.positionError || pass === 6) {
                return { samples: checked, problem, beforeU: checked[i].u };
              }
              const result = solve(u, checked[i]);
              if (result.problem) return { samples: checked, problem: result.problem, beforeU: checked[i].u };
              firstRefinement ??= checked[i].u;
              additions.push(result.sample);
            }
          }
          if (!additions.length) return { samples: checked };
          if (checked.length + additions.length > (edge.curve ? 30000 : 15000)) return { samples: checked, beforeU: firstRefinement,
            problem: issue('当前路线无法在计算预算内满足精度，请拆分或调整', index, firstRefinement) };
          checked = [...checked, ...additions].sort((a, b) => a.u - b.u);
        }
      };
      while (samples.length > 1) {
        const checked = await validateInterpolation(samples);
        samples = checked.samples;
        if (!checked.problem) break;
        if (!allowPartial || index < 0) return fail(checked.problem);
        if (!stopIssue || (checked.problem.curveProgress ?? checked.problem.progress) < (stopIssue.curveProgress ?? stopIssue.progress)) stopIssue = checked.problem;
        samples = samples.filter((sample) => sample.u <= checked.beforeU);
      }
      if (samples.length < 2) return finish(stopIssue);
      const endFraction = samples.at(-1).u;
      const endpoint = targetAt(endFraction);
      // Reparameterization preserves the checked curve; retiming then brings
      // the robot smoothly to rest at the end of the executable prefix.
      samples = samples.map((sample) => ({ ...sample, u: sample.u / endFraction }));
      preparePolylineInterpolation(samples);
      applyState(samples.at(-1));
      await addSegment({ ...edge, to: endpoint }, samples, distance * endFraction, endFraction);
      if (stopIssue) return finish(stopIssue);
    }
    return finish();
  };

  if (!action.base.search) return buildPlan();
  // A search cannot repair an invalid current pose by teleporting out of it.
  const initialCollision = collisionIssue(-1, 0);
  if (initialCollision) return { complete: false, warnings: [], issue: { ...initialCollision, phase: 'initial',
    message: `${initialCollision.message}。请先调整机器人姿态或位置，再重新检查。` } };
  const candidates = polylineBaseCandidates(vertices, start, base.reference, action.base);
  const ranked = [];
  const probePoints = vertices.filter((_, i) => i === 0 || i === vertices.length - 1 || i % Math.max(1, Math.ceil(vertices.length / 16)) === 0);
  for (let i = 0; i < candidates.length; i += 1) {
    await checkpoint(); applyState(initialState); base.apply(candidates[i]);
    const reference = referenceValues({ base: candidates[i] });
    let cost = 0, valid = true;
    for (let j = 0; j < probePoints.length; j += 1) {
      await checkpoint();
      // Even in combined mode P0 must be reachable at the selected parking
      // pose. After that, synchronized probes may use all three base axes.
      solveTarget(probePoints[j], j === 0 ? fixedBaseExcluded : solvingExcluded, reference, 6);
      const positionError = controller.frame.getWorldPosition(new THREE.Vector3()).distanceTo(probePoints[j]);
      const rotationError = THREE.MathUtils.radToDeg(controller.frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(targetQuaternion));
      if (positionError > settings.tolerance || rotationError > settings.rotationTolerance
        || Math.hypot(base.read().x, base.read().y) > action.base.range + 1e-7 || collisionIssue(-2, 1)) { valid = false; break; }
      cost += polylinePostureCost(movable) / probePoints.length;
    }
    if (valid) ranked.push({ candidate: candidates[i], score: cost + 0.35 * Math.hypot(candidates[i].x, candidates[i].y) / action.base.range
      + 0.15 * Math.abs(candidates[i].yaw) / 180 });
    onProgress({ phase: 'search', stage: '筛选位置', candidate: i + 1, candidates: candidates.length, fraction: (i + 1) / candidates.length });
  }
  ranked.sort((a, b) => a.score - b.score);
  let best = null, failure = null, tried = 0, feasible = 0;
  // Full interpolation/transit verification is expensive on large maps. Rank
  // the seeds, then compare up to three valid plans among eight finalists.
  const finalists = ranked.slice(0, 8);
  // Keep the current placement as a fallback: failed parking transits must
  // not discard a route that already works from the user's present pose.
  if (!finalists.some(({ candidate }) => candidate.x === 0 && candidate.y === 0 && candidate.yaw === 0)) {
    finalists.splice(7, 1, { candidate: zeroBase, score: Infinity });
  }
  for (const entry of finalists) {
    tried += 1;
    const result = await buildPlan(entry.candidate, (progress) => onProgress({ ...progress, phase: 'search',
      stage: '检查完整路线', candidate: tried, candidates: finalists.length }));
    if (!result.complete) { failure ||= result; continue; }
    feasible += 1;
    let postureCost = 0, samples = 0, baseDistance = 0, previous = zeroBase;
    for (const segment of result.segments) for (const sample of segment.samples) {
      baseDistance += Math.hypot(sample.base.x - previous.x, sample.base.y - previous.y); previous = sample.base;
      if (segment.index < 0) continue;
      applyState(sample); postureCost += polylinePostureCost(movable); samples += 1;
    }
    const score = postureCost / Math.max(1, samples) + 0.35 * baseDistance / action.base.range
      + 0.15 * Math.abs(result.selectedBase.yaw) / 180;
    if (!best || score < best.score) best = { result, score };
    if (feasible >= 3) break;
  }
  if (best) return { ...best.result, baseSearch: { candidates: candidates.length, checked: tried, feasible, score: best.score } };
  if (failure) return { ...failure, issue: { ...failure.issue,
    message: `本次底盘候选位置未通过完整路线检查：${failure.issue.message}` } };
  return { complete: false, warnings: [], issue: issue('在当前范围内未找到可用底盘位置，请增大搜索范围、调整工具朝向或折线位置', -2, 0) };
}
