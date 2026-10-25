import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { normalizePolyline, samplePolylinePlan, readPolylineTcp, isPolylinePlanExecutable, transformPolyline } from '../src/lib/polylineTeaching.js';
import { polylineJointExclusions } from '../src/lib/polylineTeachingJoints.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { planPolylineWithSuggestion } from '../src/lib/polylineTeachingSuggestion.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { isRobotBodyJoint } from '../src/lib/robotJointLocks.js';

const far = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
function fixture() {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  const joint = (parent, name, axis, origin, limit) => {
    const node = new THREE.Group(); node.name = name;
    node.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: axis, restPosition: origin,
      jointLimit: { lower: -limit, upper: limit, velocity: .1 } };
    parent.add(node); setRobotJointValue(node, 0); return node;
  };
  const waist = joint(robot, 'waist_lift_J', [0, 0, 1], [0, 0, 0], .25);
  for (const side of ['left', 'right']) {
    let parent = waist;
    for (let i = 0; i < 3; i += 1) parent = joint(parent, `${side}_J${i + 1}`,
      [0, 1, 2].map((axis) => Number(axis === i)), i ? [0, 0, 0] : [.4, side === 'left' ? .3 : -.3, .7], .12);
    const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool);
    const camera = new THREE.Object3D(); camera.position.z = .04; tool.add(camera);
    camera.userData.mobileCollision = { linkName: `zivid_${side}_link`, chain: ['waist_lift_J', `${side}_J1`, `${side}_J2`, `${side}_J3`],
      center: [0, 0, 0], halfSize: [.004, .004, .004] };
  }
  layer.updateMatrixWorld(true); return { robot, layer };
}
const path = (vertices, base = {}, side = 'left') => normalizePolyline({ side, base,
  points: vertices.map((position, i) => ({ id: `p${i}`, position })) });
const plan = async (action, environment = far, options = {}) => {
  const { robot, layer } = fixture();
  return planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: action, environment, ...options });
};
const obstacle = new THREE.BoxGeometry(.08, .08, .02).translate(.4, -.3, .94);
const wall = { kind: 'mesh', positions: obstacle.attributes.position.array, indices: obstacle.index.array };

async function verify(result, action, environment = far) {
  assert.ok(isPolylinePlanExecutable(result));
  const { robot, layer } = fixture(), base = layer.matrixWorld.clone();
  const checker = await createMobileCollisionChecker(robot, environment);
  const other = action.side === 'left' ? 'right' : 'left';
  const joints = readRobotJointValues(robot), orientation = getRobotEndEffector(robot, action.side).frame.getWorldQuaternion(new THREE.Quaternion());
  for (let i = 0; i <= 1000; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1000);
    assert.equal(sample.basePose, undefined, 'waist motion must not move or rotate the chassis');
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(layer.matrixWorld.equals(base));
    assert.ok(checker.check().clear, `whole-robot collision at sample ${i}`);
    assert.ok(readPolylineTcp(robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) < action.settings.tolerance * 1.01);
    assert.ok(getRobotEndEffector(robot, action.side).frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) < 1e-8);
    for (const [name, value] of Object.entries(sample.joints)) {
      if (name.startsWith(other)) assert.equal(value, joints[name], 'opposite arm joint angles stay fixed');
      assert.ok(Math.abs(value) <= (name.startsWith('waist') ? .25 : .12) + 1e-8);
    }
  }
  assert.equal(result.segments.at(-1).timing.at(-1).v1, 0);
}

for (const side of ['left', 'right']) {
  const y = side === 'left' ? .3 : -.3;
  const vertices = [[.4, y, .7], [.4, y, 1.05], [.45, y, 1.05]];
  const old = path(vertices, { allowPartial: true }, side), action = path(vertices, { allowPartial: true, waistAssist: true }, side);
  const without = await plan(old), withWaist = await plan(action);
  assert.equal(without.partial, true); assert.ok(without.distance < .125);
  assert.equal(withWaist.complete, true);
  assert.ok(Math.abs(withWaist.segments.at(-1).samples.at(-1).joints.waist_lift_J) > .2);
  await verify(withWaist, action);

  const globalLocks = Object.freeze(['waist_lift_J']);
  const assisted = await plan(action, far, { lockedJointNames: globalLocks });
  assert.equal(assisted.complete, true); await verify(assisted, action);
  assert.deepEqual(globalLocks, ['waist_lift_J'], 'temporary planner permission never changes the global lock list');
  const lockedAgain = await plan(old, far, { lockedJointNames: globalLocks });
  assert.equal(lockedAgain.partial, true); assert.equal(lockedAgain.distance, without.distance);
  assert.ok(lockedAgain.segments.every((segment) => segment.samples.every((sample) => sample.joints.waist_lift_J === 0)));
  const armLocked = await plan(action, far, { lockedJointNames: [...globalLocks, `${side}_J1`] });
  assert.equal(armLocked.partial, true, 'waist permission must not bypass an arm joint lock');
  assert.ok(armLocked.segments.every((segment) => segment.samples.every((sample) => sample.joints[`${side}_J1`] === 0)));

  const longer = path([[.4, y, .7], [.4, y, 1.3]], { allowPartial: true, waistAssist: true }, side);
  const partial = await plan(longer);
  assert.equal(partial.partial, true); assert.ok(partial.distance > .36 && partial.distance < .372);
  await verify(partial, longer);
}

// The carried opposite camera must still be checked when the waist moves.
const left = path([[.4, .3, .7], [.4, .3, 1.05]], { allowPartial: true, waistAssist: true });
const clipped = await plan(left, wall);
assert.equal(clipped.partial, true);
assert.ok(clipped.issue.collision.environmentLinks.includes('zivid_right_link'));
await verify(clipped, left, wall);
const approach = path([[.4, .3, 1.05], [.4, .3, 1.1]], { allowPartial: true, waistAssist: true });
const failed = await plan(approach, wall);
assert.equal(failed.issue.phase, 'approach'); assert.ok(failed.issue.distanceFromStart > .01);
assert.equal(isPolylinePlanExecutable(failed), false, 'a short approach cannot masquerade as a drawn prefix');

// A camera rigidly mounted on the drawing tool occupies the same world pose
// for the same TCP and orientation, whether or not the waist is involved.
const nearObstacle = new THREE.BoxGeometry(.08, .08, .02).translate(.4, -.3, .82);
const nearWall = { kind: 'mesh', positions: nearObstacle.attributes.position.array, indices: nearObstacle.index.array };
const collisionDistances = [];
for (const waistAssist of [false, true]) {
  const action = path([[.4, -.3, .92], [.4, -.3, .94]], { allowPartial: true, waistAssist }, 'right');
  const blocked = await plan(action, nearWall);
  assert.equal(blocked.issue.phase, 'approach'); assert.equal(isPolylinePlanExecutable(blocked), false);
  assert.ok(blocked.issue.collision.environmentLinks.includes('zivid_right_link'));
  collisionDistances.push(blocked.issue.distanceFromStart);
}
assert.ok(Math.abs(collisionDistances[0] - collisionDistances[1]) < .0041);

// Moving-base modes keep their existing constraints, even if the preference
// was retained when switching away from fixed-base teaching.
for (const mode of [{ sync: true }, { search: true }, { sync: true, search: true }]) {
  const { robot } = fixture(), controller = getRobotEndEffector(robot, 'left');
  const action = path(left.points.map((point) => point.position), { ...mode, waistAssist: true });
  assert.ok(polylineJointExclusions(controller, action).has(robot.getObjectByName('waist_lift_J')));
}
assert.equal(normalizePolyline({ points: left.points }).base.waistAssist, false);
assert.equal(normalizePolyline(JSON.parse(JSON.stringify(left))).base.waistAssist, true);
assert.equal(normalizePolyline(transformPolyline(left, new THREE.Matrix4().makeTranslation(1, 2, 3))).base.waistAssist, true);
// The worker/suggestion wrapper must apply the same joint policy as direct planning.
{
  const { robot, layer } = fixture();
  const result = await planPolylineWithSuggestion({ snapshot: serializeMobileTeachingRobot(robot, { includeCollision: true }),
    parentMatrix: layer.matrixWorld.toArray(), path: left, environment: far, lockedJointNames: ['waist_lift_J'] });
  assert.equal(result.complete, true); await verify(result, left);
}
await assert.rejects(plan(left, far, { checkpoint: async () => { throw new DOMException('stop', 'AbortError'); } }), { name: 'AbortError' });
// Actual BOTX: ankle/knee/waist changes participate in the timed trajectory,
// while the entire base transform and opposite arm's joint angles stay fixed.
const botx = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
for (const side of ['left', 'right']) {
  const robot = restoreMobileTeachingRobot(botx.robot), layer = new THREE.Group(); layer.add(robot);
  layer.position.set(.3, -.2, 0); layer.rotation.z = .3; layer.updateMatrixWorld(true);
  const matrix = layer.matrixWorld.clone(), controller = getRobotEndEffector(robot, side);
  const start = controller.frame.getWorldPosition(new THREE.Vector3()), orientation = controller.frame.getWorldQuaternion(new THREE.Quaternion());
  const action = path([start.toArray(), start.clone().add(new THREE.Vector3(.025, 0, 0).applyQuaternion(layer.quaternion)).toArray()], { waistAssist: true, allowPartial: true }, side);
  action.quaternion = orientation.toArray();
  const initial = readRobotJointValues(robot);
  const body = controller.joints.filter(isRobotBodyJoint);
  const globalLocks = Object.freeze(body.map((joint) => joint.name));
  const result = await planPolyline({ robot, parentMatrix: matrix.toArray(), path: action, environment: far, lockedJointNames: globalLocks });
  assert.ok(result.complete, result.issue?.message);
  assert.deepEqual(globalLocks, body.map((joint) => joint.name));
  assert.ok(body.some((joint) => Math.abs(result.segments.at(-1).samples.at(-1).joints[joint.name] - initial[joint.name]) > .1));
  const checker = await createMobileCollisionChecker(robot, far);
  let previous = null;
  const seconds = result.durationMs / 400 / 1000;
  for (let i = 0; i <= 400; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 400);
    applyRobotJointValues(robot, sample.joints); robot.parent.updateMatrixWorld(true);
    assert.ok(robot.parent.matrixWorld.equals(matrix));
    assert.ok(checker.check().clear);
    assert.ok(readPolylineTcp(robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) <= action.settings.tolerance * 1.01);
    assert.ok(controller.frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) <= THREE.MathUtils.degToRad(action.settings.rotationTolerance));
    for (const [name, value] of Object.entries(sample.joints)) if (name.startsWith(side === 'left' ? 'right_' : 'left_')) assert.equal(value, initial[name]);
    if (previous) for (const joint of body) {
      const limit = joint.userData.jointLimit?.velocity;
      if (limit) assert.ok(Math.abs(sample.joints[joint.name] - previous[joint.name]) / seconds < THREE.MathUtils.radToDeg(limit) * 1.02);
    }
    previous = sample.joints;
  }
}
obstacle.dispose(); nearObstacle.dispose();
console.log('Polyline waist: fixed chassis, both arms, longer prefixes, temporary waist permission with preserved global/arm locks, whole-robot/camera collisions, approach rejection, interpolation, persistence and worker policy passed.');
