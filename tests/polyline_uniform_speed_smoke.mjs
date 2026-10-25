import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { normalizePolyline, polylineVertices, readPolylineTcp, samplePolylinePlan, transformPolyline } from '../src/lib/polylineTeaching.js';
import { buildPolylineDrawingEdges, samplePolylineCurve } from '../src/lib/polylineTeachingCurve.js';
import { polylinePreviewParts } from '../src/lib/polylineTeachingPreview.js';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';

const environment = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
const makePath = (vertices, extra = {}) => normalizePolyline({ points: vertices.map((position) => ({ position })), ...extra });
const fixture = () => {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  for (const side of ['left', 'right']) {
    let parent = robot;
    for (let i = 0; i < 3; i += 1) {
      const joint = new THREE.Group(); joint.name = `${side}_J${i + 1}`;
      joint.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: [0, 1, 2].map((axis) => Number(axis === i)),
        restPosition: i ? [0, 0, 0] : [.4, side === 'left' ? .3 : -.3, .7], jointLimit: { lower: -.12, upper: .12, velocity: .1 } };
      parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
    }
    const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool);
  }
  layer.updateMatrixWorld(true); return { robot, layer };
};
async function solve(path, state = fixture(), options = {}) {
  const initial = readRobotJointValues(state.robot);
  const plan = await planPolyline({ ...state, parentMatrix: state.layer.matrixWorld.toArray(), path, environment, ...options });
  assert.equal(plan.executable, true, JSON.stringify(plan.issue));
  state.layer.add(state.robot); applyRobotJointValues(state.robot, initial); state.layer.updateMatrixWorld(true);
  return { plan, ...state, initial };
}

// Measure actual FK speed (not target or time-parameter speed), and verify
// acceleration/velocity bounds through the inverse arc-length mapping.
async function audit({ plan, robot, layer, initial }, path) {
  const controller = getRobotEndEffector(robot, path.side), orientation = new THREE.Quaternion().fromArray(plan.quaternion);
  const checker = await createMobileCollisionChecker(robot, environment), vertices = polylineVertices(path);
  const steps = 12000, dt = plan.durationMs / steps / 1000;
  let previous = null, velocity = null, previousProgress = -1, cruiseSamples = 0, minimumRatio = Infinity, maximumRatio = 0;
  const limits = Object.fromEntries(controller.joints.map((joint) => [joint.name, joint.userData.jointType === 'prismatic' ? [.1, .25] : [36, 90]]));
  for (let i = 0; i <= steps; i += 1) {
    const time = plan.durationMs * i / steps, sample = samplePolylinePlan(plan, time);
    if (sample.basePose) { layer.position.fromArray(sample.basePose.position); layer.quaternion.fromArray(sample.basePose.quaternion); }
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    const actual = readPolylineTcp(robot, path), target = new THREE.Vector3().fromArray(sample.target);
    assert.ok(actual.distanceTo(target) < path.settings.tolerance * 1.01);
    assert.ok(controller.frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) <= THREE.MathUtils.degToRad(path.settings.rotationTolerance));
    if (i % 20 === 0) assert.equal(checker.check().clear, true);
    if (sample.drawing) {
      const source = vertices[sample.segmentIndex].clone().lerp(vertices[sample.segmentIndex + 1], sample.segmentProgress);
      assert.ok(actual.distanceTo(source) < path.settings.tolerance * 1.01, 'total fillet + IK + interpolation error stays within original tolerance');
      const progress = sample.segmentIndex + sample.segmentProgress;
      assert.ok(progress >= previousProgress - 1e-9, 'orange progress follows authored edge order'); previousProgress = progress;
    }
    for (const [name, value] of Object.entries(sample.joints)) if (name.startsWith(path.side === 'left' ? 'right_' : 'left_')) assert.ok(Math.abs(value - initial[name]) < 1e-9);
    const coordinates = { ...sample.joints, ...sample.base };
    if (previous) {
      const nextVelocity = {};
      for (const [name, [speed, acceleration]] of Object.entries({ ...limits, x: [.1, .25], y: [.1, .25], yaw: [15, 30] })) {
        if (coordinates[name] === undefined) continue;
        nextVelocity[name] = (coordinates[name] - previous.coordinates[name]) / dt;
        assert.ok(Math.abs(nextVelocity[name]) <= speed * 1.002 + 1e-6, `${name} exceeds velocity limit`);
        if (velocity) assert.ok(Math.abs(nextVelocity[name] - velocity[name]) / dt <= acceleration * 1.01 + 1e-5, `${name} exceeds acceleration limit`);
      }
      velocity = nextVelocity;
      const segment = plan.segments.find((part) => time < part.endMs) || plan.segments.at(-1);
      const cruise = segment.uniformSpeed && segment.timing.find((part) => part.v0 > 0 && part.v0 === part.v1);
      if (cruise && time - segment.startMs > cruise.startMs + dt * 1000 && time - segment.startMs < cruise.endMs) {
        // A short chord measures instantaneous speed even at very tight bends.
        const delta = Math.min(.0001, dt / 32);
        const near = samplePolylinePlan(plan, time - delta * 1000);
        if (near.basePose) { layer.position.fromArray(near.basePose.position); layer.quaternion.fromArray(near.basePose.quaternion); }
        applyRobotJointValues(robot, near.joints); layer.updateMatrixWorld(true);
        const ratio = actual.distanceTo(readPolylineTcp(robot, path)) / delta / segment.cruiseSpeed;
        minimumRatio = Math.min(minimumRatio, ratio); maximumRatio = Math.max(maximumRatio, ratio); cruiseSamples += 1;
        assert.ok(ratio > .98 && ratio < 1.02, `actual TCP cruise ratio ${ratio}`);
      }
    }
    previous = { actual, coordinates };
  }
  assert.ok(cruiseSamples > 100);
  assert.deepEqual(samplePolylinePlan(plan, plan.durationMs).target, plan.stoppedAt.position);
  for (const segment of plan.segments) { assert.equal(segment.timing[0].v0, 0); assert.equal(segment.timing.at(-1).v1, 0); }
  return [minimumRatio, maximumRatio];
}

for (const vertices of [
  [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
  [[0, 0, 0], [.1, 0, 0], [.005, .02, .03], [.1, .04, .05]],
  [[0, 0, 0], [0, 0, 0], [.0001, 0, 0], [.0001, .0001, 0]],
]) for (const tolerance of [.0002, .001, .003]) {
  const path = makePath(vertices, { settings: { tolerance } }), copy = structuredClone(path.points);
  const blocks = buildPolylineDrawingEdges(polylineVertices(path), path.settings);
  let previous = 0;
  for (const block of blocks) for (let i = 0; i <= 4000; i += 1) {
    const point = samplePolylineCurve(block.curve, i / 4000);
    assert.ok(point.target.distanceTo(point.sourcePosition) <= tolerance / 2 + 1e-10);
    assert.ok(point.sourceDistance >= previous - 1e-10); previous = point.sourceDistance;
  }
  assert.deepEqual(path.points, copy);
}

const bent = [[.4, .3, .7], [.45, .3, .7], [.45, .35, .7], [.49, .35, .73]];
for (const sync of [false, true]) {
  const path = makePath(bent, { base: { sync } }), result = await solve(path);
  assert.equal(result.plan.segments.length, 1, 'ordinary corners share one continuous cruise');
  assert.equal(result.plan.segments[0].curve.roundedCorners, 2);
  assert.ok(result.plan.speedProfile.cruiseSpeed < path.settings.speed, 'tight corners lower the single cruise speed');
  assert.ok(Math.abs(result.plan.coverage - 1) < 1e-10);
  await audit(result, path);
}
{
  const path = makePath([bent[0], [.5, .3, .7]]), result = await solve(path);
  assert.ok(Math.abs(result.plan.speedProfile.cruiseSpeed - path.settings.speed) < 1e-5, 'a simple reachable line achieves the selected speed');
  await audit(result, path);
}
{
  const path = makePath([...bent.slice(0, 3), [.8, .35, .7]], { base: { allowPartial: true } }), result = await solve(path);
  assert.equal(result.plan.partial, true); assert.equal(result.plan.stoppedAt.segmentIndex, 2);
  assert.ok(result.plan.stoppedAt.progress < 1);
  await audit(result, path);
  const finished = samplePolylinePlan(result.plan, result.plan.durationMs);
  const preview = polylinePreviewParts(path, result.plan, finished);
  assert.ok(Math.abs(preview.filter((part) => part.completed).reduce((sum, part) => sum + part.length, 0) - result.plan.distance) < 1e-8);
  assert.ok(preview.some((part) => part.color === 0xff796b), 'unreachable tail remains red');
}
{
  const path = makePath(bent.slice(0, 3), { closed: true }), result = await solve(path);
  assert.equal(result.plan.stoppedAt.segmentIndex, 2);
  assert.deepEqual(result.plan.stoppedAt.position, bent[0]);
  await audit(result, path);
}
{
  const path = makePath([bent[0], bent[1], bent[0]]), result = await solve(path);
  assert.equal(result.plan.segments.length, 2); assert.equal(result.plan.speedProfile.cornerStops, 1);
  await audit(result, path);
}
{
  const path = makePath(bent, { settings: { uniformSpeed: false } }), result = await solve(path);
  assert.equal(result.plan.segments.length, 3); assert.equal(result.plan.speedProfile, undefined);
  assert.ok(result.plan.segments.every((segment) => !segment.arcMapping && !segment.curve));
  const restored = normalizePolyline(JSON.parse(JSON.stringify(path)));
  assert.equal(restored.settings.uniformSpeed, false);
  assert.equal(transformPolyline(restored, new THREE.Matrix4().makeTranslation(1, 2, 3)).settings.uniformSpeed, false);
  assert.equal(normalizePolyline({ points: path.points }).settings.uniformSpeed, true, 'missing old preference defaults on');
}

// Actual BOTX model, both arms, including the nearly singular straight pose
// where constant target progress alone produced >50% velocity ripple.
const botx = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8')).robot;
for (const values of [[0, 0, 0, 0, 0, 0, 0], [0, -80, 10, 70, -10, 5, 0]]) for (const side of ['left', 'right']) {
  const robot = restoreMobileTeachingRobot(botx), layer = new THREE.Group(); layer.add(robot);
  applyRobotJointValues(robot, Object.fromEntries(['left', 'right'].flatMap((s) => values.map((value, i) => [`${s}_J${i + 1}`, s === 'left' ? value : -value]))));
  layer.updateMatrixWorld(true);
  const tcpOffset = [0, 0, side === 'left' ? -.2 : .2], p = readPolylineTcp(robot, { side, tcpOffset });
  const path = makePath([[0, 0, 0], [-.015, 0, 0], [-.015, side === 'left' ? .015 : -.015, 0]]
    .map((delta) => p.clone().add(new THREE.Vector3(...delta)).toArray()), { side, tcpOffset });
  const result = await solve(path, { robot, layer }), ratios = await audit(result, path);
  console.log(`BOTX ${side} ${values[1] ? 'bent' : 'straight'}: ${(result.plan.speedProfile.cruiseSpeed * 1000).toFixed(2)} mm/s, measured cruise ${(ratios[0] * 100).toFixed(2)}–${(ratios[1] * 100).toFixed(2)}%.`);
}
console.log('Uniform polyline: actual FK cruise, rounded 3D corners, tolerance, joint/base rates, both arms, closed/partial progress, reversal stops, strict fallback and persistence passed.');
