import assert from 'node:assert/strict';
import * as THREE from 'three';
import { setRobotJointValue, applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { isPolylinePlanExecutable, normalizePolyline, readPolylineTcp, samplePolylinePlan, samplePolylineState } from '../src/lib/polylineTeaching.js';

const far = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
function fixture(wristSize = .004) {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  for (const side of ['left', 'right']) {
    let parent = robot;
    for (let i = 0; i < 3; i += 1) {
      const joint = new THREE.Group(); joint.name = `${side}_J${i + 1}`;
      joint.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: [0, 1, 2].map((axis) => Number(axis === i)),
        restPosition: i ? [0, 0, 0] : [.4, side === 'left' ? .3 : -.3, .7],
        jointLimit: { lower: -.12, upper: .12, velocity: .1 } };
      parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
    }
    const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool);
    if (side === 'left') tool.userData.mobileCollision = {
      linkName: 'left_wrist', chain: ['left_J1', 'left_J2', 'left_J3'], center: [0, 0, 0], halfSize: [wristSize, wristSize, wristSize],
    };
  }
  layer.updateMatrixWorld(true);
  return { robot, layer };
}
const path = (vertices, base = {}, closed = false) => normalizePolyline({
  base, closed, points: vertices.map((position, i) => ({ id: `p${i}`, position })),
});
const plan = async (action, environment = far, wristSize = .004, options = {}) => {
  const { robot, layer } = fixture(wristSize);
  return planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: action, environment, ...options });
};
const box = (size, center) => {
  const geometry = new THREE.BoxGeometry(...size); geometry.translate(...center);
  const environment = { kind: 'mesh', positions: geometry.attributes.position.array, indices: geometry.index.array };
  geometry.dispose(); return environment;
};
async function verifyMotion(result, action, environment = far, wristSize = .004) {
  assert.ok(isPolylinePlanExecutable(result));
  const { robot, layer } = fixture(wristSize), matrix = layer.matrixWorld.clone();
  const checker = await createMobileCollisionChecker(robot, environment);
  const initial = readRobotJointValues(robot);
  let previous = null, previousVelocity = null;
  const dt = result.durationMs / 1600 / 1000;
  for (let i = 0; i <= 1600; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1600);
    assert.equal(sample.basePose, undefined);
    applyRobotJointValues(robot, sample.joints);
    assert.ok(layer.matrixWorld.equals(matrix), 'the full base transform remains fixed');
    assert.ok(checker.check().clear, `collision in executable prefix at ${i}`);
    const tcp = readPolylineTcp(robot, action);
    assert.ok(tcp.distanceTo(new THREE.Vector3().fromArray(sample.target)) <= action.settings.tolerance * 1.01);
    for (const [name, value] of Object.entries(sample.joints)) {
      assert.ok(value >= -.12000001 && value <= .12000001);
      if (name.startsWith('right')) assert.equal(value, initial[name]);
    }
    if (previous) {
      assert.ok(tcp.distanceTo(previous) / dt < action.settings.speed * 1.02, 'TCP speed remains limited');
      const velocity = tcp.clone().sub(previous).divideScalar(dt);
      if (previousVelocity) assert.ok(velocity.clone().sub(previousVelocity).length() / dt < .251, 'stopping is retimed, not abrupt');
      previousVelocity = velocity;
    }
    previous = tcp.clone();
  }
  const last = samplePolylinePlan(result, result.durationMs + 1000);
  assert.equal(last.done, true);
  assert.deepEqual(last.joints, result.segments.at(-1).samples.at(-1).joints);
  assert.deepEqual(last.target, result.stoppedAt.position);
  assert.equal(result.segments.at(-1).timing.at(-1).v1, 0, 'the new endpoint stops at zero speed');
}

const vertices = [[.4, .3, .7], [.45, .3, .7], [.8, .3, .7], [.4, .35, .7]];
const strict = await plan(path(vertices));
assert.equal(strict.complete, false);
assert.equal(isPolylinePlanExecutable(strict), false, 'old/default behavior still requires the whole path');
assert.ok(strict.segments.some((segment) => segment.index === 0));

for (const points of [vertices, [vertices[0], vertices[2], vertices[3]]]) {
  const action = path(points, { allowPartial: true });
  const result = await plan(action);
  assert.equal(result.complete, false); assert.equal(result.partial, true);
  assert.ok(result.distance > .11 && result.distance < .122);
  assert.ok(result.coverage > 0 && result.coverage < 1);
  assert.ok(result.stoppedAt.progress < 1);
  assert.equal(result.stoppedAt.segmentIndex, points.length === 4 ? 1 : 0);
  assert.ok(result.segments.every((segment) => segment.index <= result.stoppedAt.segmentIndex), 'never skip a failure to a later reachable part');
  assert.deepEqual(action.points.map((point) => point.position), points, 'authored geometry stays intact');
  await verifyMotion(result, action);
}
for (const allowPartial of [false, true]) {
  const action = path([[.4, .3, .7], [.45, .35, .7]], { allowPartial });
  const result = await plan(action);
  assert.equal(result.complete, true); assert.equal(result.partial, false);
  await verifyMotion(result, action);
}
{
  const action = path([[.4, .3, .7], [50, .3, .7]], { allowPartial: true });
  const result = await plan(action);
  assert.equal(result.partial, true, 'a long first edge can still retain its short reachable prefix');
  assert.ok(result.distance > .11 && result.distance < .122);
  await verifyMotion(result, action);
}

const wall = box([.012, .03, .03], [.48, .3, .7]);
{
  const action = path([[.4, .3, .7], [.5, .3, .7]], { allowPartial: true });
  const result = await plan(action, wall);
  assert.equal(result.partial, true); assert.ok(result.issue.collision);
  assert.ok(result.stoppedAt.position[0] > .45 && result.stoppedAt.position[0] < .474);
  await verifyMotion(result, action, wall);
}
// An offset link on a rotating arm crosses a small obstacle BETWEEN IK samples.
// Recheck the trimmed Hermite tail, including its changed endpoint tangent.
{
  const rotaryFixture = () => {
    const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
    robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
    let parent = robot;
    for (let i = 0; i < 3; i += 1) {
      const joint = new THREE.Group(); joint.name = `left_J${i + 1}`;
      joint.userData = { jointType: 'revolute', jointValue: 0, jointAxis: [0, 0, 1],
        restPosition: i ? [.3, 0, 0] : [.4, .3, .7], jointLimit: { lower: -Math.PI, upper: Math.PI, velocity: 1 } };
      if (!i) joint.userData.mobileCollision = { linkName: 'offset_guard', chain: [joint.name], center: [0, 5, 0], halfSize: [.004, .004, .004] };
      parent.add(joint); parent = joint; setRobotJointValue(joint, THREE.MathUtils.degToRad([-30, 60, -30][i]));
    }
    const tool = new THREE.Object3D(); tool.name = 'tool_left'; parent.add(tool); layer.updateMatrixWorld(true);
    return { robot, layer };
  };
  const original = rotaryFixture(), p = readPolylineTcp(original.robot, { side: 'left' });
  const action = path([p.toArray(), p.clone().add(new THREE.Vector3(-.05, 0, 0)).toArray()], { allowPartial: true });
  const free = await planPolyline({ robot: original.robot, parentMatrix: original.layer.matrixWorld.toArray(), path: action, environment: far });
  assert.equal(free.complete, true);
  const samples = free.segments[0].samples, u = (samples[3].u + samples[4].u) / 2;
  applyRobotJointValues(original.robot, samplePolylineState(samples, u).joints);
  const center = new THREE.Vector3(0, 5, 0).applyMatrix4(original.robot.getObjectByName('left_J1').matrixWorld);
  const obstacle = box([.001, .001, .001], center.toArray());
  const check = await createMobileCollisionChecker(original.robot, obstacle);
  for (const sample of samples) {
    applyRobotJointValues(original.robot, sample.joints);
    assert.ok(check.check().clear, 'all sampled IK states must be clear in this regression');
  }
  const next = rotaryFixture();
  const result = await planPolyline({ robot: next.robot, parentMatrix: next.layer.matrixWorld.toArray(), path: action, environment: obstacle });
  assert.equal(result.partial, true); assert.ok(result.issue.collision);
  assert.ok(Math.abs(result.issue.progress - u) < 1e-8);
  assert.ok(result.stoppedAt.progress <= samples[3].u);
  assert.ok(isPolylinePlanExecutable(result));
  for (let i = 0; i <= 1600; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1600);
    applyRobotJointValues(original.robot, sample.joints);
    assert.ok(check.check().clear, 'the retimed, truncated curve remains collision-free');
    assert.ok(readPolylineTcp(original.robot, action).distanceTo(new THREE.Vector3().fromArray(sample.target)) < action.settings.tolerance);
  }
  assert.equal(result.segments.at(-1).timing.at(-1).v1, 0);
}
// Closing edges are part of the requested path and cannot jump across obstacles.
{
  const obstacle = box([.012, .012, .03], [.44, .34, .7]);
  const action = path([[.4, .3, .7], [.48, .3, .7], [.48, .38, .7]], { allowPartial: true }, true);
  const result = await plan(action, obstacle);
  assert.equal(result.partial, true); assert.equal(result.stoppedAt.segmentIndex, 2);
  assert.ok(result.distance > .16 && result.distance < result.requestedDistance);
  await verifyMotion(result, action, obstacle);
}

for (const [action, environment, phase] of [
  [path([[.8, .3, .7], [.4, .3, .7]], { allowPartial: true }), far, 'approach'],
  [path([[.5, .3, .7], [.51, .3, .7]], { allowPartial: true }), wall, 'approach'],
  [path([[.4, .3, .7], [.5, .3, .7]], { allowPartial: true }), box([.02, .02, .02], [.4, .3, .7]), 'initial'],
  [path([[.52, .3, .7], [.8, .3, .7]], { allowPartial: true }), far, 'drawing'],
]) {
  const result = await plan(action, environment);
  assert.equal(isPolylinePlanExecutable(result), false, 'failed approach/initial pose or zero-length prefix must not execute');
  assert.equal(result.partial, false); assert.equal(result.issue.phase, phase);
}
for (const mode of [{ sync: true }, { search: true }, { sync: true, search: true }]) {
  const result = await plan(path([[.4, .3, .7], [.8, .3, .7]], { ...mode, allowPartial: true, range: .05, yawRange: 0 }));
  assert.equal(result.complete, false);
  assert.equal(isPolylinePlanExecutable(result), false, 'maximum protection is strictly fixed-base only');
}
await assert.rejects(plan(path(vertices, { allowPartial: true }), far, .004,
  { lockedJointNames: ['left_J1', 'left_J2', 'left_J3'] }), /均被锁定/);
let checkpoints = 0;
await assert.rejects(plan(path(vertices, { allowPartial: true }), far, .004, {
  checkpoint: async () => { if (++checkpoints > 30) throw new DOMException('cancelled', 'AbortError'); },
}), { name: 'AbortError' });
console.log('Polyline partial planning: continuous prefix, mid-segment limits/collisions, interpolation, closing edge, safe approach, zero-length rejection, retimed stop, locks, cancellation and fixed-base isolation passed.');
