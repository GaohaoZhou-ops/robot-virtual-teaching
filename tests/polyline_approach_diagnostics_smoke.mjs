import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { planPolylineWithSuggestion } from '../src/lib/polylineTeachingSuggestion.js';
import { serializeMobileTeachingRobot, restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { normalizePolyline, samplePolylinePlan, readPolylineTcp, isPolylinePlanExecutable } from '../src/lib/polylineTeaching.js';
import { polylineApproachGuides } from '../src/lib/polylineTeachingGuides.js';

function fixture() {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base_link', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  let parent = robot;
  for (let i = 0; i < 3; i += 1) {
    const joint = new THREE.Group(); joint.name = `right_J${i + 1}`;
    joint.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: [0, 1, 2].map((axis) => Number(axis === i)),
      restPosition: i ? [0, 0, 0] : [.4, -.3, .7], jointLimit: { lower: -1, upper: 1, velocity: .3 } };
    parent.add(joint); setRobotJointValue(joint, 0); parent = joint;
  }
  const tool = new THREE.Object3D(); tool.name = 'tool_right'; parent.add(tool);
  // The current BOTX URDF camera collision box and fixed mounting transform.
  const camera = new THREE.Object3D(); camera.position.z = .024; camera.rotation.z = -Math.PI / 2; tool.add(camera);
  camera.userData.mobileCollision = { linkName: 'zivid_right_link', chain: ['right_J1', 'right_J2', 'right_J3'],
    center: [0, 0, .0604604111], halfSize: [.0564999605 / 2, .1690060462 / 2, .1209208221 / 2] };
  layer.updateMatrixWorld(true); return { robot, layer };
}
const path = (vertices) => normalizePolyline({ side: 'right', base: { allowPartial: true },
  points: vertices.map((position, i) => ({ id: `p${i}`, position })) });
const box = (size, center) => {
  const geometry = new THREE.BoxGeometry(...size).translate(...center);
  const environment = { positions: geometry.attributes.position.array, indices: geometry.index.array, kind: 'mesh' };
  geometry.dispose(); return environment;
};
const plan = (robot, layer, action, environment) => planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: action, environment });
const cameraXMax = .4 + .1690060462 / 2, cameraZ = .7 + .024 + .0604604111;

// A 5 mm physical gap triggers the padded check; it is not a collision of
// the unpadded collision boxes. Diagnosis must not silently relax the check.
for (const [gap, category] of [[.005, 'clearance'], [-.003, 'intersection'], [.02, 'clear']]) {
  const { robot } = fixture();
  const environment = box([.001, .2, .2], [cameraXMax + gap + .0005, -.3, cameraZ]);
  const checker = await createMobileCollisionChecker(robot, environment);
  const before = checker.check(), detailed = checker.check({ detailedEnvironment: true });
  assert.equal(detailed.clear, before.clear);
  assert.deepEqual(detailed.environmentLinks, before.environmentLinks);
  assert.equal(detailed.environmentMargin, .008);
  assert.deepEqual(detailed.environmentIntersectingLinks, category === 'intersection' ? ['zivid_right_link'] : []);
  assert.deepEqual(detailed.environmentClearanceLinks, category === 'clearance' ? ['zivid_right_link'] : []);
  assert.equal(detailed.clear, category === 'clear');
}
{
  const { robot } = fixture();
  const checker = await createMobileCollisionChecker(robot, box([.6, .6, .6], [.4, -.3, cameraZ]));
  const result = checker.check({ detailedEnvironment: true });
  assert.ok(result.environmentIntersectingLinks.includes('zivid_right_link'), 'a camera fully inside a solid is not merely in its margin');
  assert.deepEqual(result.environmentClearanceLinks, []);
}

// P0 and the subsequent stroke are feasible, but the fixed-orientation direct
// approach hits a wall. An explicitly specified detour is fully validated.
// The low-level direct validator must still reject it; the production entry
// point now searches for a detour without changing the authored stroke.
const wall = box([.02, .30, .30], [.7, -.3, cameraZ]);
const vertices = [[.9, -.3, .7], [.95, -.3, .7]], action = path(vertices);
const { robot, layer } = fixture();
const direct = await plan(robot, layer, action, wall);
assert.equal(direct.complete, false); assert.equal(direct.executable, false);
assert.equal(direct.issue.phase, 'approach');
assert.ok(direct.issue.distanceFromStart > .1 && direct.issue.distanceFromStart < .4);
assert.ok(direct.issue.collision.environmentClearanceLinks.includes('zivid_right_link'));
assert.match(direct.issue.message, /8 mm 预留区/);
{
  const { robot, layer } = fixture();
  applyRobotJointValues(robot, { right_J1: .5 }); layer.updateMatrixWorld(true);
  const fromP0 = await plan(robot, layer, action, wall);
  assert.equal(fromP0.complete, true, fromP0.issue?.message);
}
{
  const { robot, layer } = fixture(), base = layer.matrixWorld.clone();
  const detour = path([[.4, -.3, .7], [.4, .1, .7], [.9, .1, .7], ...vertices]);
  const result = await plan(robot, layer, detour, wall);
  assert.equal(result.complete, true, result.issue?.message);
  const checker = await createMobileCollisionChecker(robot, wall);
  const orientation = new THREE.Quaternion();
  for (let i = 0; i <= 1500; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1500);
    applyRobotJointValues(robot, sample.joints); robot.parent.updateMatrixWorld(true);
    assert.ok(robot.parent.matrixWorld.equals(base));
    assert.ok(checker.check().clear, `detour collision at ${i}`);
    assert.ok(readPolylineTcp(robot, detour).distanceTo(new THREE.Vector3().fromArray(sample.target)) < detour.settings.tolerance * 1.01);
    assert.ok(getRobotEndEffector(robot, 'right').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) < 1e-8);
  }
}

const recover = async (action, environment = wall, extra = {}) => {
  const { robot, layer } = fixture();
  return planPolylineWithSuggestion({ snapshot: serializeMobileTeachingRobot(robot, { includeCollision: true }),
    parentMatrix: layer.matrixWorld.toArray(), path: action, environment, ...extra });
};
{
  const before = structuredClone(action), progress = [], locks = Object.freeze([]);
  const result = await recover(action, wall, { lockedJointNames: locks, onProgress: (value) => progress.push(value) });
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  assert.equal(result.approachSearch.mode, 'detour');
  assert.ok(result.approachSearch.attempts > 0 && result.approachSearch.attempts <= 35);
  assert.ok(progress.some((value) => value.phase === 'approach-search' && Number.isFinite(value.fraction)));
  assert.deepEqual(action, before); assert.deepEqual(locks, []);
  assert.deepEqual(result.segments.filter((segment) => segment.index >= 0).map((segment) => [segment.from, segment.to]), [[...vertices]]);
  const { robot, layer } = fixture(), base = layer.matrixWorld.clone();
  const checker = await createMobileCollisionChecker(robot, wall), orientation = new THREE.Quaternion();
  const firstDrawing = result.segments.find((segment) => segment.index >= 0);
  assert.equal(samplePolylinePlan(result, 0).joints.right_J1, 0, 'recovery must start at the original pose');
  for (let i = 0; i <= 2000; i += 1) {
    const time = result.durationMs * i / 2000, sample = samplePolylinePlan(result, time);
    assert.equal(sample.drawing, time >= firstDrawing.startMs, 'approach never counts as drawing progress');
    assert.equal(sample.basePose, undefined);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(layer.matrixWorld.equals(base)); assert.ok(checker.check().clear, `recovered collision at ${i}`);
    assert.ok(readPolylineTcp(robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) < action.settings.tolerance * 1.01);
    assert.ok(getRobotEndEffector(robot, 'right').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) < 1e-8);
    assert.ok(Object.values(sample.joints).every((value) => Math.abs(value) <= 1 + 1e-9));
  }
  for (const segment of result.segments) assert.equal(segment.timing.at(-1).v1, 0, 'detour corners stop smoothly');
}
{
  const partialPath = path([vertices[0], [1.8, -.3, .7]]);
  const quickPartial = await recover(partialPath, wall, { deepBudgetMs: 0 });
  let clock = 0, deep = false;
  const partial = await recover(partialPath, wall, { deepBudgetMs: 3, now: () => clock,
    onProgress: (value) => { deep ||= value.searchStage === 'deep'; },
    checkpoint: async () => { if (deep) clock += 1; } });
  assert.equal(partial.partial, true); assert.equal(partial.approachSearch.found, true);
  assert.equal(partial.approachSearch.stopReason, 'time-budget');
  assert.equal(partial.approachSearch.stage, 'quick', 'do not replace a validated prefix with a timed-out candidate');
  assert.deepEqual(partial.segments, quickPartial.segments);
  assert.equal(partial.distance, quickPartial.distance);
  assert.ok(partial.distance > .45 && partial.distance < .51);
  assert.deepEqual(partial.segments.find((segment) => segment.index >= 0).from, vertices[0]);
  const strict = await recover({ ...partialPath, base: { allowPartial: false } }, wall, { deepBudgetMs: 0 });
  assert.equal(isPolylinePlanExecutable(strict), false);
  assert.equal(strict.issue.phase, 'drawing', 'report a checked transit reaching P0 instead of the earlier direct collision');
  assert.equal(strict.approachSearch.reachedStart, true);
  const blocked = await recover(path([[.7, -.3, .7], vertices[1]]));
  assert.equal(isPolylinePlanExecutable(blocked), false, 'a colliding P0 cannot be rescued by a short transit');
  assert.equal(blocked.issue.code, 'tool-goal-collision'); assert.equal(blocked.issue.phase, 'approach');
  assert.equal(blocked.approachSearch, undefined, 'do not search detours when the rigid tool is blocked at P0');
  const initial = await recover(action, box([.04, .04, .04], [.4, -.3, cameraZ]));
  assert.equal(initial.issue.phase, 'initial'); assert.equal(initial.approachSearch, undefined, 'never search out of an initially colliding pose');
}

// This larger wall requires more than the old 320 mm offsets in every free
// direction. Deep expansion must find a genuinely new, fully checked route.
{
  const environment = box([.02, .7, .7], [.7, -.3, cameraZ]);
  const quick = await recover(action, environment, { deepBudgetMs: 0 });
  assert.equal(isPolylinePlanExecutable(quick), false);
  const result = await recover(action, environment);
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  assert.equal(result.approachSearch.stage, 'deep');
  assert.ok(result.approachSearch.deepAttempts > 0 && result.approachSearch.deepAttempts <= 128);
  assert.ok(result.approachSearch.waypoints.some((point) => Math.hypot(point[1] + .3, point[2] - .7) > .32));
  const { robot, layer } = fixture(), base = layer.matrixWorld.clone();
  const checker = await createMobileCollisionChecker(robot, environment);
  for (let i = 0; i <= 1600; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1600);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(checker.check().clear, `expanded approach collision at ${i}`);
    assert.ok(layer.matrixWorld.equals(base));
    assert.ok(readPolylineTcp(robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) < action.settings.tolerance * 1.01);
    assert.ok(getRobotEndEffector(robot, 'right').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion()) < 1e-8);
  }
}
{
  let searching = false;
  await assert.rejects(recover(action, wall, { onProgress: (value) => { searching ||= value.phase === 'approach-search'; },
    checkpoint: async () => { if (searching) throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
}

// A deliberately redundant test robot isolates waist/arm posture selection:
// splitting an inward X move between waist and arm causes self-collision;
// letting the waist carry the arm reaches the SAME TCP and orientation safely.
// This is not a reconstruction of a user's live BOTX pose.
{
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  const joint = (parent, name, axis, origin) => {
    const node = new THREE.Group(); node.name = name;
    node.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: axis, restPosition: origin,
      jointLimit: { lower: -1, upper: 1, velocity: .2 } };
    parent.add(node); setRobotJointValue(node, 0); return node;
  };
  const waist = joint(robot, 'waist_yaw_J', [1, 0, 0], [0, 0, 0]);
  waist.userData.mobileCollision = { linkName: 'waist_yaw_L', chain: ['waist_yaw_J'], center: [.28, 0, .7], halfSize: [.04, .04, .04] };
  for (const side of ['left', 'right']) {
    let parent = waist;
    for (let i = 0; i < 3; i += 1) parent = joint(parent, `${side}_J${i + 1}`,
      [0, 1, 2].map((axis) => Number(axis === i)), i ? [0, 0, 0] : [.4, side === 'left' ? 0 : -.3, .7]);
    const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool);
    tool.userData.mobileCollision = { linkName: side === 'left' ? 'left_L5' : 'zivid_right_link',
      chain: ['waist_yaw_J', `${side}_J1`, `${side}_J2`, `${side}_J3`], center: [0, 0, 0], halfSize: [.015, .015, .015] };
  }
  layer.updateMatrixWorld(true);
  const base = layer.matrixWorld.clone(), initial = readRobotJointValues(robot);
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true });
  const far = box([.1, .1, .1], [10, 10, 10]);
  const action = normalizePolyline({ side: 'left', base: { waistAssist: true, allowPartial: true },
    points: [[.14, 0, .7], [.17, 0, .7]].map((position) => ({ position })) });
  const locks = Object.freeze(['waist_yaw_J', 'left_J2', 'right_J1']);
  const options = { parentMatrix: base.toArray(), environment: far, path: action, lockedJointNames: locks };
  const direct = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(snapshot) });
  assert.equal(direct.issue.phase, 'approach');
  assert.ok(direct.issue.collision.selfPairs.some((pair) => pair.includes('waist_yaw_L') && pair.includes('left_L5')));
  const local = await planPolylineWithSuggestion({ ...options, snapshot });
  assert.equal(local.complete, true);
  assert.ok(local.localRecovery.successes > 0, 'the new planner can recover this continuous posture before trying a new approach route');
  const result = await planPolylineWithSuggestion({ ...options, snapshot, recoverLocal: false });
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  assert.equal(result.approachSearch.mode, 'posture');
  assert.ok(result.approachSearch.heldJoints.includes('left_J1'));
  assert.deepEqual(locks, ['waist_yaw_J', 'left_J2', 'right_J1']);
  assert.deepEqual(readRobotJointValues(robot), initial, 'planning never moves the original robot');
  const approach = result.segments.filter((segment) => segment.index < 0);
  assert.ok(approach.every((segment) => segment.samples.every((sample) => sample.joints.left_J1 === initial.left_J1)));
  assert.ok(result.segments.at(-1).samples.at(-1).joints.left_J1 > .005, 'approach-only hold is released for drawing');
  assert.deepEqual(approach.at(-1).samples.at(-1).joints, result.segments.find((segment) => segment.index >= 0).samples[0].joints);
  const checker = await createMobileCollisionChecker(robot, far);
  let previous;
  for (let i = 0; i <= 1200; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1200);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(layer.matrixWorld.equals(base)); assert.ok(checker.check().clear);
    assert.ok(readPolylineTcp(robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) < action.settings.tolerance * 1.01);
    for (const name of ['left_J2', 'right_J1', 'right_J2', 'right_J3']) assert.equal(sample.joints[name], initial[name]);
    if (previous) for (const name of Object.keys(sample.joints)) {
      assert.ok(Math.abs(sample.joints[name] - previous[name]) / (result.durationMs / 1200 / 1000) <= .1 * 1.02, 'no abrupt posture reset at P0');
    }
    previous = sample.joints;
  }
}
// An environment collision needs the same redundant-arm recovery as a self
// collision. The first X carriage hits the workpiece when IK shares X travel
// between two joints; holding it lets the second carriage complete the SAME
// approach and stroke. TCP detours alone cannot fix the first carriage's X.
for (const side of ['left', 'right']) {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base_link', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  let parent = robot;
  for (let i = 0; i < 4; i += 1) {
    const joint = new THREE.Group(); joint.name = `${side}_J${i + 1}`;
    joint.userData = { jointType: 'prismatic', jointValue: 0,
      jointAxis: [0, 1, 2].map((axis) => Number(axis === Math.max(0, i - 1))),
      restPosition: i ? [0, 0, 0] : [.4, -.3, .7], jointLimit: { lower: -1, upper: 1, velocity: .2 } };
    if (!i) joint.userData.mobileCollision = { linkName: `${side}_L1`, chain: [joint.name],
      center: [0, 0, 0], halfSize: [.015, .015, .015] };
    parent.add(joint); setRobotJointValue(joint, 0); parent = joint;
  }
  const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool); layer.updateMatrixWorld(true);
  const initial = readRobotJointValues(robot), base = layer.matrixWorld.clone();
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true });
  const action = normalizePolyline({ side, base: { allowPartial: true },
    points: [[.65, -.3, .7], [.68, -.3, .7]].map((position) => ({ position })) });
  const environment = box([.025, .1, .1], [.5, -.3, .7]);
  const options = { snapshot, parentMatrix: base.toArray(), path: action, environment };
  const direct = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(snapshot) });
  assert.equal(direct.issue.phase, 'approach');
  assert.deepEqual(direct.issue.collision.selfPairs, []);
  assert.deepEqual(direct.issue.collision.environmentClearanceLinks, [`${side}_L1`]);
  const specified = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(snapshot), approachLockedJointNames: [`${side}_J1`] });
  assert.equal(specified.complete, true, 'a continuous collision-free solution exists without changing the base, orientation or stroke');
  const result = await planPolylineWithSuggestion({ ...options, recoverLocal: false });
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  assert.equal(result.approachSearch.mode, 'posture');
  assert.deepEqual(result.approachSearch.heldJoints, [`${side}_J1`]);
  assert.deepEqual(result.initialJoints, initial);
  assert.deepEqual(readRobotJointValues(robot), initial);
  const checker = await createMobileCollisionChecker(robot, environment);
  for (let i = 0; i <= 1000; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1000);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(checker.check().clear, `environment recovery collides at ${side} sample ${i}`);
    assert.ok(layer.matrixWorld.equals(base));
    assert.ok(readPolylineTcp(robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) < action.settings.tolerance * 1.01);
    assert.ok(tool.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion()) < 1e-8);
    if (!sample.drawing) assert.equal(sample.joints[`${side}_J1`], initial[`${side}_J1`]);
  }
  assert.ok(result.segments.at(-1).samples.at(-1).joints[`${side}_J1`] > .001, 'release temporary approach restrictions for drawing');
  const blocked = await planPolylineWithSuggestion({ ...options, lockedJointNames: [`${side}_J2`] });
  assert.equal(isPolylinePlanExecutable(blocked), false, 'recovery must not unlock the only other joint that can move X');
}
// A narrow passage reproduces the key contrast: a saved stroke works from
// this exact initial pose, while a new parallel stroke just 50 mm away defeats
// all generic detours. Reach the saved stroke first, then turn toward new P0.
{
  const positions = [], indices = [];
  for (const [size, center] of [
    [[.5, .02, .4], [.55, -.3 + .0564999605 / 2 + .024, cameraZ]],
    [[.5, .02, .4], [.55, -.3 - .0564999605 / 2 - .024, cameraZ]],
    [[.5, .5, .02], [.55, -.3, cameraZ + .1209208221 / 2 + .024]],
    [[.5, .5, .02], [.55, -.3, cameraZ - .1209208221 / 2 - .024]],
  ]) {
    const part = box(size, center), offset = positions.length / 3;
    positions.push(...part.positions); indices.push(...Array.from(part.indices, (value) => value + offset));
  }
  const environment = { kind: 'mesh', positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  const saved = { ...path([[.92, -.3, .7], [.98, -.3, .7]]), id: 'saved-passage', name: '已保存通道折线' };
  const nearby = path([[.92, -.25, .7], [.98, -.25, .7]]);
  const { robot, layer } = fixture(), initial = readRobotJointValues(robot), base = layer.matrixWorld.clone();
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true });
  const options = { snapshot, parentMatrix: base.toArray(), environment };
  const savedBefore = structuredClone(saved), nearbyBefore = structuredClone(nearby);
  const baseline = await planPolylineWithSuggestion({ ...options, path: saved });
  assert.equal(baseline.complete, true, JSON.stringify(baseline.issue));
  const generic = await planPolylineWithSuggestion({ ...options, path: nearby, deepBudgetMs: 0 });
  assert.equal(isPolylinePlanExecutable(generic), false, 'generic offsets cannot leave the narrow passage toward nearby P0');
  assert.equal(generic.issue.phase, 'approach');
  assert.ok(generic.issue.collision.environmentLinks.includes('zivid_right_link'));
  const start = readPolylineTcp(robot, nearby);
  // No saved path is needed once deeper search can finish the narrow passage
  // before making a lateral turn. Repeat nearby strokes from the SAME pose.
  for (const delta of [0, -.002, .002]) {
    const shifted = path(nearby.points.map(({ position }) => [position[0] + delta, position[1] + delta, position[2]]));
    const progress = [];
    const result = await planPolylineWithSuggestion({ ...options, path: shifted, onProgress: (value) => progress.push(value) });
    assert.equal(result.complete, true, JSON.stringify(result.issue));
    assert.equal(result.approachSearch.stage, 'deep');
    assert.equal(result.approachSearch.stopReason, 'complete');
    assert.equal(result.approachSearch.deepStrategy, 'axis-order');
    assert.ok(progress.some((value) => value.searchStage === 'quick'));
    assert.ok(progress.some((value) => value.searchStage === 'deep' && value.candidate > 0 && value.deepBudgetMs === 15000));
    const repeat = await planPolylineWithSuggestion({ ...options, path: shifted });
    assert.equal(repeat.complete, true);
    assert.deepEqual(repeat.approachSearch.waypoints, result.approachSearch.waypoints, 'candidate choice is deterministic');
    assert.equal(repeat.approachSearch.attempts, result.approachSearch.attempts);
    const auditRobot = restoreMobileTeachingRobot(snapshot), auditLayer = new THREE.Group(); auditLayer.add(auditRobot);
    const checker = await createMobileCollisionChecker(auditRobot, environment);
    const firstDrawing = result.segments.find((segment) => segment.index >= 0);
    assert.deepEqual(firstDrawing.from, shifted.points[0].position);
    for (let i = 0; i <= 800; i += 1) {
      const time = result.durationMs * i / 800, sample = samplePolylinePlan(result, time);
      applyRobotJointValues(auditRobot, sample.joints); auditLayer.updateMatrixWorld(true);
      assert.ok(checker.check().clear, `deep passage collision at ${delta}, ${i}`);
      assert.ok(auditLayer.matrixWorld.equals(base));
      assert.ok(readPolylineTcp(auditRobot, shifted).distanceTo(new THREE.Vector3().fromArray(sample.target)) < shifted.settings.tolerance * 1.01);
      assert.equal(sample.drawing, time >= firstDrawing.startMs);
    }
  }
  let clock = 0, insideDeepTrial = false;
  const timedOut = await planPolylineWithSuggestion({ ...options, path: nearby, deepBudgetMs: 4, now: () => clock,
    onProgress: (value) => { insideDeepTrial ||= value.searchStage === 'deep' && value.candidate > 0; },
    checkpoint: async () => { if (insideDeepTrial) clock += 1; } });
  assert.equal(timedOut.approachSearch.stopReason, 'time-budget');
  assert.equal(timedOut.approachSearch.deepAttempts, 1);
  assert.equal(isPolylinePlanExecutable(timedOut), false, 'an interrupted candidate cannot become executable');
  assert.deepEqual(readRobotJointValues(robot), initial);
  let deep = false;
  await assert.rejects(planPolylineWithSuggestion({ ...options, path: nearby,
    onProgress: (value) => { deep ||= value.searchStage === 'deep'; },
    checkpoint: async () => { if (deep) throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
  const guides = polylineApproachGuides(nearby, [saved], start);
  assert.equal(guides.length, 2, 'both traversal directions may help');
  const result = await planPolylineWithSuggestion({ ...options, path: nearby, approachGuides: guides });
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  assert.equal(result.approachSearch.mode, 'saved-path');
  assert.equal(result.approachSearch.sourcePathId, saved.id);
  assert.equal(result.approachSearch.guideAttempts, 1);
  assert.ok(result.approachSearch.attempts <= 43);
  assert.ok(Math.abs(result.distance - .06) < 1e-8, 'saved-path transit is not counted as drawing');
  assert.deepEqual(saved, savedBefore); assert.deepEqual(nearby, nearbyBefore);
  assert.deepEqual(readRobotJointValues(robot), initial);
  const checker = await createMobileCollisionChecker(robot, environment);
  const firstDrawing = result.segments.find((segment) => segment.index >= 0);
  assert.deepEqual(firstDrawing.from, nearby.points[0].position);
  for (let i = 0; i <= 1600; i += 1) {
    const time = result.durationMs * i / 1600, sample = samplePolylinePlan(result, time);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(layer.matrixWorld.equals(base));
    assert.ok(checker.check().clear, `saved-path approach collision at ${i}`);
    assert.ok(readPolylineTcp(robot, nearby).distanceTo(new THREE.Vector3().fromArray(sample.target)) < nearby.settings.tolerance * 1.01);
    assert.ok(getRobotEndEffector(robot, 'right').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion()) < 1e-8);
    assert.equal(sample.drawing, time >= firstDrawing.startMs);
  }
  const partialPath = path([nearby.points[0].position, [1.8, -.25, .7]]);
  const partial = await planPolylineWithSuggestion({ ...options, path: partialPath,
    approachGuides: polylineApproachGuides(partialPath, [saved], start) });
  assert.equal(partial.partial, true); assert.ok(partial.distance > .4);
  const blockedPath = path([[.7, -.25, .7], [.98, -.25, .7]]);
  const blocked = await planPolylineWithSuggestion({ ...options, path: blockedPath,
    approachGuides: polylineApproachGuides(blockedPath, [saved], start) });
  assert.equal(isPolylinePlanExecutable(blocked), false, 'a valid saved route cannot make a colliding new P0 executable');
  assert.equal(blocked.issue.code, 'tool-goal-collision');
  assert.equal(blocked.approachSearch, undefined, 'saved guides cannot change the rigid tool pose at P0');
  let searching = false;
  await assert.rejects(planPolylineWithSuggestion({ ...options, path: nearby, approachGuides: guides,
    onProgress: (value) => { searching ||= value.stage === '参考已保存折线接近'; },
    checkpoint: async () => { if (searching) throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
  assert.deepEqual(polylineApproachGuides(nearby, [{ ...saved, side: 'left' }, { ...saved, tcpOffset: [0, 0, -.2] }], start), []);
  assert.deepEqual(polylineApproachGuides({ ...nearby, base: { sync: true } }, [saved], start), []);
  assert.deepEqual(polylineApproachGuides(path([[10, 0, 0], [11, 0, 0]]), [saved], start), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...saved, id: `saved-${i}`,
    points: saved.points.map((point) => ({ ...point, position: [point.position[0], point.position[1] + i * .001, point.position[2]] })) }));
  assert.ok(polylineApproachGuides(nearby, many, start).length <= 8, 'saved library size cannot make the search unbounded');
}
console.log(`Approach diagnostics/recovery: quick/deep search, expanded detours, nearby narrow-passage strokes, deterministic repeats, deadlines, prefix retention, truthful drawing failures, posture recovery and saved-path guides pass; unchanged 8 mm screening, original pose/stroke, fixed-base playback, blocked P0, limits and cancellation verified.`);
