import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { preparePolylineInterpolation, samplePolylinePlan, normalizePolyline, readPolylineTcp } from "../src/features/teaching/polyline/model/polylineTeaching.js";
import { preparePolylineTiming } from "../src/features/teaching/polyline/model/polylineTeachingTiming.js";
import { planPolyline } from "../src/features/teaching/polyline/model/polylineTeachingSolver.js";
import { restoreMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { applyRobotJointValues, getRobotEndEffector } from "../src/features/robot/model/robotLoader.js";

function checkRates(plan, definitions, steps = 20000) {
  const dt = plan.durationMs / steps / 1000;
  let previous = null, previousVelocity = null;
  for (let i = 0; i <= steps; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / steps);
    const state = { ...sample.joints, ...Object.fromEntries(Object.entries(sample.base || {}).map(([key, value]) => [`base_${key}`, value])) };
    const velocity = {};
    for (const [name, value] of Object.entries(state)) {
      const limit = definitions[name];
      assert.ok(Number.isFinite(value));
      if (!previous || !limit) continue;
      velocity[name] = (value - previous[name]) / dt;
      assert.ok(Math.abs(velocity[name]) <= limit.speed * 1.001 + 1e-6, `${name}: speed ${velocity[name]} > ${limit.speed}`);
      if (previousVelocity) assert.ok(Math.abs((velocity[name] - previousVelocity[name]) / dt) <= limit.acceleration * 1.002 + 1e-5,
        `${name}: acceleration ${(velocity[name] - previousVelocity[name]) / dt} > ${limit.acceleration}`);
    }
    if (sample.base && previous) {
      assert.ok(Math.hypot(velocity.base_x, velocity.base_y) <= 0.10001);
      if (previousVelocity) assert.ok(Math.hypot(velocity.base_x - previousVelocity.base_x,
        velocity.base_y - previousVelocity.base_y) / dt <= 0.2501);
    }
    if (previous) previousVelocity = velocity;
    previous = state;
  }
}

// Nonuniform knots with a sharp local change, prismatic/revolute axes and base
// yaw. Measure rates from actual playback instead of repeating the retimer.
{
  const samples = preparePolylineInterpolation([0, 0.2, 0.499, 0.5, 0.501, 0.8, 1].map((u) => ({ u,
    joints: { angle: 160 + 10 * u + (u > 0.5 ? 0.2 : 0), slide: 0.04 * u },
    base: { x: 0.12 * u, y: 0.08 * u * u, yaw: 20 * u } })));
  const settings = { speed: 0.3, acceleration: 0.5 };
  const timing = preparePolylineTiming(samples, 0.3, settings, {
    angle: { type: 'revolute', velocity: 8 }, slide: { type: 'prismatic', velocity: 0.04 },
  });
  const segment = { index: 0, from: [0, 0, 0], to: [0.3, 0, 0], samples, ...timing, startMs: 0, endMs: timing.durationMs };
  const plan = { segments: [segment], durationMs: timing.durationMs, baseReference: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } };
  checkRates(plan, { angle: { speed: 8, acceleration: 90 }, slide: { speed: 0.04, acceleration: 0.25 },
    base_x: { speed: 0.1, acceleration: 0.25 }, base_y: { speed: 0.1, acceleration: 0.25 }, base_yaw: { speed: 15, acceleration: 30 } });
  const first = samplePolylinePlan(plan, 0), last = samplePolylinePlan(plan, plan.durationMs);
  assert.deepEqual(first.joints, samples[0].joints); assert.deepEqual(last.joints, samples.at(-1).joints);
  for (const phase of timing.timing) {
    const before = samplePolylinePlan(plan, Math.max(0, phase.endMs - 0.0001));
    const after = samplePolylinePlan(plan, Math.min(plan.durationMs, phase.endMs + 0.0001));
    assert.ok(Math.abs(before.joints.angle - after.joints.angle) < 0.00001, 'no jumps at timing boundaries');
  }
}

// Reproduce the apparent freeze on a real BOTX 0.5 m approach. Previously this
// segment took ~61 s, moving the chassis only ~0.25 mm in the first 3 seconds.
{
  const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
  const robot = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group(); layer.add(robot); layer.updateMatrixWorld(true);
  const p = readPolylineTcp(robot, { side: 'left', tcpOffset: [0, 0, -0.2] });
  const path = normalizePolyline({ base: { sync: true }, tcpOffset: [0, 0, -0.2],
    points: [[0.5, 0, 0], [0.5, 0.1, 0]].map((delta) => ({ position: p.clone().add(new THREE.Vector3(...delta)).toArray() })) });
  const environment = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
  const result = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.ok(result.complete, JSON.stringify(result.issue));
  assert.ok(result.segments[0].durationMs < 20000, `approach took ${result.segments[0].durationMs / 1000}s`);
  const early = samplePolylinePlan(result, 3000);
  assert.ok(Math.hypot(early.base.x, early.base.y) > 0.02, 'the chassis must visibly move during the first three seconds');
  assert.ok(new THREE.Vector3().fromArray(early.target).distanceTo(p) > 0.05, 'the tool must visibly advance too');
  const live = restoreMobileTeachingRobot(fixture.robot); layer.add(live);
  const controller = getRobotEndEffector(live, 'left');
  const definitions = Object.fromEntries(controller.joints.map((joint) => [joint.name, { speed: 36, acceleration: 90 }]));
  checkRates(result, { ...definitions, base_x: { speed: 0.1, acceleration: 0.25 }, base_y: { speed: 0.1, acceleration: 0.25 },
    base_yaw: { speed: 15, acceleration: 30 } });
  for (let i = 0; i <= 1000; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1000);
    layer.position.fromArray(sample.basePose.position); layer.quaternion.fromArray(sample.basePose.quaternion); layer.updateMatrixWorld(true);
    applyRobotJointValues(live, sample.joints);
    assert.ok(readPolylineTcp(live, path).distanceTo(new THREE.Vector3().fromArray(sample.target)) <= path.settings.tolerance * 1.02);
    assert.ok(controller.frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion().fromArray(result.quaternion)) <= path.settings.rotationTolerance * Math.PI / 180);
  }
  console.log(`BOTX approach: ${(result.segments[0].durationMs / 1000).toFixed(2)} s; chassis travel after 3 s: ${(Math.hypot(early.base.x, early.base.y) * 1000).toFixed(1)} mm.`);
}
console.log('Polyline timing: visible startup, local slowdown, joint/base speed and acceleration bounds, continuity and real FK passed.');
