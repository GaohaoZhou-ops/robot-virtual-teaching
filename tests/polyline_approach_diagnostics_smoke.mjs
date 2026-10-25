import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { planPolylineWithSuggestion } from '../src/lib/polylineTeachingSuggestion.js';
import { serializeMobileTeachingRobot, restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { normalizePolyline, samplePolylinePlan, readPolylineTcp, isPolylinePlanExecutable } from '../src/lib/polylineTeaching.js';

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
  const partial = await recover(path([vertices[0], [1.8, -.3, .7]]));
  assert.equal(partial.partial, true); assert.equal(partial.approachSearch.found, true);
  assert.ok(partial.distance > .45 && partial.distance < .51);
  assert.deepEqual(partial.segments.find((segment) => segment.index >= 0).from, vertices[0]);
  const blocked = await recover(path([[.7, -.3, .7], vertices[1]]));
  assert.equal(isPolylinePlanExecutable(blocked), false, 'a colliding P0 cannot be rescued by a short transit');
  assert.equal(blocked.approachSearch.found, false); assert.equal(blocked.issue.phase, 'approach');
  assert.ok(blocked.approachSearch.attempts <= 35);
  const initial = await recover(action, box([.04, .04, .04], [.4, -.3, cameraZ]));
  assert.equal(initial.issue.phase, 'initial'); assert.equal(initial.approachSearch, undefined, 'never search out of an initially colliding pose');
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
  const result = await planPolylineWithSuggestion({ ...options, snapshot });
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
console.log(`Approach diagnostics/recovery: collision categories preserved; direct approach fails at ${(direct.issue.distanceFromStart * 1000).toFixed(1)} mm, automatic detour and redundant waist/arm posture recovery pass; locks, original pose/stroke, playback, fixed base, prefix rules, blocked P0, invalid initial pose and cancellation verified.`);
