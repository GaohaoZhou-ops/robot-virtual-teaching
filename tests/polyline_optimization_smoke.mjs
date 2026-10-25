import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { createMobileCollisionChecker, prepareMobileCollisionEnvironment } from '../src/lib/mobileTeachingCollision.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { planPolylineWithApproach } from '../src/lib/polylineTeachingApproach.js';
import { serializeMobileTeachingRobot, restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { normalizePolyline, samplePolylinePlan, readPolylineTcp, isPolylinePlanExecutable } from '../src/lib/polylineTeaching.js';
import { createPolylineSuccessMemory, polylineMemoryContext } from '../src/lib/polylineTeachingMemory.js';

const box = (size, center, divisions = 1) => {
  const geometry = new THREE.BoxGeometry(...size, divisions, divisions, divisions).translate(...center);
  return { positions: geometry.attributes.position.array, indices: geometry.index.array, kind: 'mesh' };
};
const joint = (parent, name, axis, origin) => {
  const node = new THREE.Group(); node.name = name;
  node.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: axis, restPosition: origin,
    jointLimit: { lower: -1, upper: 1, velocity: .2 } };
  parent.add(node); setRobotJointValue(node, 0); return node;
};
function fixture(redundant = false) {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base_link', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  let parent = robot;
  if (redundant) {
    parent = joint(robot, 'waist_yaw_J', [1, 0, 0], [0, 0, 0]);
    parent.userData.mobileCollision = { linkName: 'waist_yaw_L', chain: ['waist_yaw_J'], center: [.28, 0, .7], halfSize: [.04, .04, .04] };
    for (const side of ['left', 'right']) {
      let branch = parent;
      for (let i = 0; i < 3; i += 1) branch = joint(branch, `${side}_J${i + 1}`,
        [0, 1, 2].map((axis) => Number(axis === i)), i ? [0, 0, 0] : [.4, side === 'left' ? 0 : -.3, .7]);
      const tool = new THREE.Object3D(); tool.name = `tool_${side}`; branch.add(tool);
      tool.userData.mobileCollision = { linkName: `${side}_L5`, chain: ['waist_yaw_J', `${side}_J1`, `${side}_J2`, `${side}_J3`],
        center: [0, 0, 0], halfSize: [.015, .015, .015] };
    }
  } else {
    for (let i = 0; i < 3; i += 1) parent = joint(parent, `right_J${i + 1}`,
      [0, 1, 2].map((axis) => Number(axis === i)), i ? [0, 0, 0] : [.4, -.3, .7]);
    const tool = new THREE.Object3D(); tool.name = 'tool_right'; parent.add(tool);
    const camera = new THREE.Object3D(); camera.position.z = .024; camera.rotation.z = -Math.PI / 2; tool.add(camera);
    camera.userData.mobileCollision = { linkName: 'zivid_right_link', chain: ['right_J1', 'right_J2', 'right_J3'],
      center: [0, 0, .0604604111], halfSize: [.0564999605 / 2, .1690060462 / 2, .1209208221 / 2] };
  }
  layer.updateMatrixWorld(true);
  return { robot, layer, snapshot: serializeMobileTeachingRobot(robot, { includeCollision: true }), parentMatrix: layer.matrixWorld.toArray() };
}
const path = (points, extra = {}) => normalizePolyline({ side: 'right', quaternion: [0, 0, 0, 1],
  base: { allowPartial: true }, points: points.map((position) => ({ position })), ...extra });

async function audit(result, options, frozen = []) {
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  const robot = restoreMobileTeachingRobot(options.snapshot), layer = new THREE.Group(); layer.add(robot); layer.updateMatrixWorld(true);
  const base = layer.matrixWorld.clone(), initial = readRobotJointValues(robot);
  const checker = await createMobileCollisionChecker(robot, options.environment);
  const step = result.durationMs / 1200 / 1000;
  let previous;
  assert.deepEqual(samplePolylinePlan(result, 0).joints, initial, 'the actual starting pose cannot be replaced with a remembered pose');
  for (let i = 0; i <= 1200; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1200);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(layer.matrixWorld.equals(base));
    assert.ok(checker.check().clear, `collision in real playback at ${i}`);
    assert.ok(readPolylineTcp(robot, options.path).distanceTo(new THREE.Vector3().fromArray(sample.target)) < options.path.settings.tolerance * 1.01);
    assert.ok(getRobotEndEffector(robot, options.path.side).frame.getWorldQuaternion(new THREE.Quaternion())
      .angleTo(new THREE.Quaternion().fromArray(options.path.quaternion)) < 1e-8);
    for (const name of frozen) assert.equal(sample.joints[name], initial[name]);
    for (const [name, value] of Object.entries(sample.joints)) {
      assert.ok(Math.abs(value) <= 1, 'joint limit');
      if (previous) assert.ok(Math.abs(value - previous[name]) / step <= .2 * 1.01, `no jump or velocity excess at ${name}, ${i}`);
    }
    previous = sample.joints;
  }
}

// Share only the workpiece index. Each checker retains its own robot state.
{
  const environment = box([.02, .3, .3], [.7, -.3, .7844604111], 8);
  let builds = 0;
  const preparedEnvironment = await prepareMobileCollisionEnvironment(environment, async () => { builds += 1; });
  assert.ok(builds > 0);
  const a = fixture(), b = fixture();
  const noBuild = async () => { assert.fail('a shared environment must not be rebuilt per robot or candidate'); };
  const one = await createMobileCollisionChecker(a.robot, environment, noBuild, { preparedEnvironment });
  const two = await createMobileCollisionChecker(b.robot, environment, noBuild, { preparedEnvironment });
  const ordinary = await createMobileCollisionChecker(a.robot, environment);
  for (const x of [0, .2, .3, .5, 0]) {
    applyRobotJointValues(a.robot, { right_J1: x }); a.layer.updateMatrixWorld(true);
    assert.deepEqual(one.check({ detailedEnvironment: true }), ordinary.check({ detailedEnvironment: true }));
    assert.equal(two.check().clear, true, 'another robot must not inherit a preceding candidate pose');
  }
  await assert.rejects(createMobileCollisionChecker(a.robot, { ...environment }, noBuild, { preparedEnvironment }), /不匹配/);
}

const metrics = {};
// A large wall needs a wide detour. Simulate a budget of just ten deep
// candidates; small-radius-first expansion cannot spend it on a useful route.
const wideOptions = { ...fixture(), path: path([[.9, -.3, .7], [.95, -.3, .7]]),
  environment: box([.02, .7, .7], [.7, -.3, .7844604111]) };
const limited = async (planner, options) => {
  let clock = 0;
  return planner({ ...options, deepBudgetMs: 10, now: () => clock,
    onProgress: (value) => { if (value.searchStage === 'deep') clock = value.candidate; } });
};
{
  const result = await limited(planPolylineWithApproach, wideOptions);
  await audit(result, wideOptions);
  assert.equal(result.approachSearch.stage, 'deep');
  assert.ok(result.approachSearch.deepAttempts < 10);
  assert.equal(result.approachSearch.environmentBuilds, 1);
  assert.equal(result.localRecovery, undefined, 'a rigid camera collision does not spend time on ineffective elbow retries');
  const repeat = await limited(planPolylineWithApproach, wideOptions);
  assert.deepEqual(repeat.approachSearch.waypoints, result.approachSearch.waypoints);
  metrics.wideWall = { complete: result.complete, quick: result.approachSearch.quickAttempts, deep: result.approachSearch.deepAttempts };
  const configured = (settings) => ({ ...wideOptions, path: { ...wideOptions.path, settings: { ...wideOptions.path.settings, ...settings } } });
  const capped = await planPolylineWithApproach(configured({ deepSearchCandidates: 2 }));
  assert.equal(isPolylinePlanExecutable(capped), false);
  assert.equal(capped.approachSearch.stopReason, 'candidate-limit');
  assert.equal(capped.approachSearch.deepAttempts, 2);
  assert.equal(capped.approachSearch.deepCandidateLimit, 2);
  const disabled = await planPolylineWithApproach(configured({ deepSearchSeconds: 0 }));
  assert.equal(disabled.approachSearch.deepAttempts, 0);
  assert.equal(disabled.approachSearch.stopReason, 'disabled');
  let clock = 0, deep = false;
  const timed = await planPolylineWithApproach({ ...configured({ deepSearchSeconds: 1 }), now: () => clock,
    onProgress: (value) => { deep ||= value.searchStage === 'deep'; }, checkpoint: async () => { if (deep) clock += 200; } });
  assert.equal(timed.approachSearch.deepBudgetMs, 1000);
  assert.equal(timed.approachSearch.stopReason, 'time-budget');
  assert.equal(isPolylinePlanExecutable(timed), false, 'a budget-interrupted candidate cannot be executed');
}

// Real branch recovery must include a checked transition from the original
// joints, preserve the other arm/locks and pass the full playback interpolation.
{
  const fixtureState = fixture(true), initial = readRobotJointValues(fixtureState.robot);
  const action = path([[.14, 0, .7], [.17, 0, .7]], { side: 'left', base: { waistAssist: true, allowPartial: true } });
  const options = { ...fixtureState, environment: box([.1, .1, .1], [10, 10, 10]), path: action,
    lockedJointNames: ['waist_yaw_J', 'left_J2', 'right_J1'] };
  const direct = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(options.snapshot) });
  assert.equal(direct.issue.phase, 'approach');
  const smallBudget = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(options.snapshot), recoverLocal: true,
    path: { ...action, settings: { ...action.settings, postureRetries: 1, postureSamples: 8 } } });
  assert.equal(isPolylinePlanExecutable(smallBudget), false);
  assert.equal(smallBudget.localRecovery.attempts, 1);
  assert.ok(smallBudget.localRecovery.checks > 0 && smallBudget.localRecovery.checks <= 8);
  const noRetry = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(options.snapshot), recoverLocal: true,
    path: { ...action, settings: { ...action.settings, postureRetries: 0 } } });
  assert.deepEqual(noRetry.issue, direct.issue);
  assert.equal(noRetry.localRecovery, undefined);
  const recovered = await planPolylineWithApproach(options);
  assert.ok(recovered.localRecovery.successes > 0);
  assert.ok(recovered.localRecovery.backtrackedSamples > 0);
  assert.ok(recovered.localRecovery.attempts <= 12 && recovered.localRecovery.checks <= 96);
  await audit(recovered, options, ['left_J2', 'right_J1', 'right_J2', 'right_J3']);
  assert.deepEqual(readRobotJointValues(fixtureState.robot), initial);
  const memory = createPolylineSuccessMemory();
  const source = await planPolyline({ ...options, robot: restoreMobileTeachingRobot(options.snapshot), approachLockedJointNames: ['left_J1'] });
  assert.equal(source.complete, true);
  memory.remember('scene', action, source);
  const nearby = path([[.142, 0, .7], [.172, 0, .7]], { side: 'left', base: action.base });
  const guides = memory.guides('scene', nearby, readPolylineTcp(fixtureState.robot, nearby));
  assert.equal(guides.length, 1);
  const reused = await planPolylineWithApproach({ ...options, path: nearby, successfulGuides: guides });
  await audit(reused, { ...options, path: nearby }, ['left_J2', 'right_J1', 'right_J2', 'right_J3']);
  assert.ok(reused.localRecovery?.referenceUses > 0 || reused.approachSearch?.mode === 'successful-path',
    'the validated earlier joint posture helps recover a nearby stroke');
  metrics.localRecovery = { withoutMemory: recovered.localRecovery, withMemory: reused.localRecovery || reused.approachSearch.mode };
  // Abort precisely when the solver enters recovery; never publish its prefix.
  let ordinaryVisits = 0, visits = 0;
  await planPolyline({ ...options, robot: restoreMobileTeachingRobot(options.snapshot), checkpoint: async () => { ordinaryVisits += 1; } });
  await assert.rejects(planPolyline({ ...options, robot: restoreMobileTeachingRobot(options.snapshot), recoverLocal: true,
    checkpoint: async () => { if (++visits > ordinaryVisits) throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
  assert.deepEqual(readRobotJointValues(fixtureState.robot), initial);
}

// Reuse a previously checked passage rather than repeatedly exploring routes
// that turn too soon. Hints cannot validate an actually colliding new P0.
{
  const positions = [], indices = [], cameraZ = .7844604111;
  for (const [size, center] of [
    [[.5, .02, .4], [.55, -.3 - (.0564999605 / 2 + .024), cameraZ]],
    [[.5, .02, .4], [.55, -.3 + (.0564999605 / 2 + .024), cameraZ]],
    [[.5, .5, .02], [.55, -.3, cameraZ - (.1209208221 / 2 + .024)]],
    [[.5, .5, .02], [.55, -.3, cameraZ + (.1209208221 / 2 + .024)]],
  ]) {
    const mesh = box(size, center), offset = positions.length / 3;
    positions.push(...mesh.positions); indices.push(...Array.from(mesh.indices, (i) => i + offset));
  }
  const environment = { positions: new Float32Array(positions), indices: new Uint32Array(indices), kind: 'mesh' };
  const state = fixture(), options = { ...state, environment, deepBudgetMs: 0 };
  const saved = path([[.92, -.3, .7], [.98, -.3, .7]], { id: 'old', name: '成功通道' });
  const nearby = path([[.92, -.25, .7], [.98, -.25, .7]]), start = readPolylineTcp(state.robot, nearby);
  const source = await planPolylineWithApproach({ ...options, path: saved });
  assert.equal(source.complete, true);
  assert.equal(isPolylinePlanExecutable(await planPolylineWithApproach({ ...options, path: nearby })), false);
  const memory = createPolylineSuccessMemory(); memory.remember('scene', saved, source);
  const successfulGuides = memory.guides('scene', nearby, start);
  assert.ok(successfulGuides[0].referenceSamples.length <= 256);
  const reused = await planPolylineWithApproach({ ...options, path: nearby, successfulGuides });
  assert.equal(reused.approachSearch.mode, 'successful-path');
  assert.equal(reused.approachSearch.memoryAttempts, 1);
  await audit(reused, { ...options, path: nearby });
  metrics.passage = { quickWithoutMemory: 'failed', withMemoryAttempts: reused.approachSearch.attempts };
  const blocked = path([[.7, -.25, .7], [.98, -.25, .7]]);
  assert.equal(isPolylinePlanExecutable(await planPolylineWithApproach({ ...options, path: blocked,
    successfulGuides: memory.guides('scene', blocked, start) })), false);
  successfulGuides[0].referenceSamples[0].joints.right_J1 = 123;
  assert.equal(memory.guides('scene', nearby, start)[0].referenceSamples[0].joints.right_J1, 0, 'hints are isolated copies');
  for (const changed of [{ side: 'left' }, { tcpOffset: [0, 0, -.2] }, { quaternion: [0, 0, 1, 0] },
    { base: { waistAssist: true } }, { base: { sync: true } }, { base: { search: true } }]) {
    assert.deepEqual(memory.guides('scene', { ...nearby, ...changed }, start), []);
  }
  memory.remember('scene', nearby, { complete: false });
  assert.equal(memory.guides('scene', nearby, start).length, 1, 'failed checks cannot train the cache');
  for (let i = 0; i < 10; i += 1) memory.remember('scene', path([[.92 + i * .0001, -.3, .7], [.98, -.3, .7]]), source);
  assert.equal(memory.guides('scene', nearby, start).length, 3, 'candidate count stays bounded');
  assert.deepEqual(memory.guides('different-scene', nearby, start), []);
  assert.deepEqual(memory.guides('scene', nearby, start), [], 'invalidated records cannot come back on a later context switch');
  const geometry = new THREE.BoxGeometry(), context = () => polylineMemoryContext(state.robot, geometry,
    serializeMobileTeachingRobot(state.robot, { includeCollision: true }), []);
  const key = context();
  applyRobotJointValues(state.robot, { right_J1: .05 }); state.layer.updateMatrixWorld(true);
  assert.equal(context(), key, 'a new starting joint pose is rechecked, without discarding useful hints');
  geometry.attributes.position.needsUpdate = true;
  assert.notEqual(context(), key, 'geometry edits invalidate memory');
  const geometryKey = context(); state.layer.position.x = .02; state.layer.updateMatrixWorld(true);
  assert.notEqual(context(), geometryKey, 'base/world transforms invalidate memory');
  assert.notEqual(polylineMemoryContext(state.robot, geometry, state.snapshot, ['right_J1']), context(), 'joint permissions invalidate memory');
  const beforeLimit = context(); state.robot.getObjectByName('right_J1').userData.jointLimit.upper = .8;
  assert.notEqual(context(), beforeLimit, 'kinematic edits invalidate memory');
}

// Optional, reproducible A/B against a pre-change source snapshot. Wall-clock
// measurements are reported, never used as flaky assertions in the test suite.
if (process.env.POLYLINE_BASELINE) {
  const before = (await import(pathToFileURL(process.env.POLYLINE_BASELINE))).planPolylineWithApproach;
  const oldLimited = await limited(before, wideOptions);
  assert.equal(isPolylinePlanExecutable(oldLimited), false);
  metrics.wideWall.beforeWithinSameBudget = oldLimited.approachSearch.stopReason;
  const dense = { ...wideOptions, environment: box([.02, .3, .3], [.7, -.3, .7844604111], 48) };
  metrics.denseMesh = { triangles: dense.environment.indices.length / 3 };
  for (const [name, planner] of [['before', before], ['after', planPolylineWithApproach]]) {
    const started = performance.now(), result = await planner({ ...dense, deepBudgetMs: 0 });
    assert.equal(result.complete, true);
    metrics.denseMesh[name] = { milliseconds: Math.round(performance.now() - started), attempts: result.approachSearch.attempts };
  }
}
console.log('Polyline optimization: shared-index isolation, bounded continuous branch recovery, locks/orientation/8 mm playback, cancellation, successful-pose memory, invalidation and deterministic diverse search passed.');
console.log(JSON.stringify(metrics));
