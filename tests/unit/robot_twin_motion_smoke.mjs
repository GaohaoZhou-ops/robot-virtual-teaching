import assert from 'node:assert/strict';
import { RobotTwinMotion, ROBOT_TWIN_DISPLAY_DELAY, ROBOT_TWIN_BLEND_WINDOW } from "../../src/features/robot-twin/model/robotTwinMotion.js";
import { createRobotTwinFollowCamera } from "../../src/features/robot-twin/model/robotTwinFollowCamera.js";

const sample = (time, x = time / 1000, yaw = 0) => ({ motionSample: { time, id: time + 1 },
  pose: { position: { x, y: 0, z: .12 }, rpy: { roll: 0, pitch: 0, yaw } }, joints: { arm: time / 10 } });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const D = ROBOT_TWIN_DISPLAY_DELAY, W = ROBOT_TWIN_BLEND_WINDOW, lag = D + W / 2;
assert.ok(lag <= 600);
assert.ok(D + W <= 650, 'finite smoothing settles promptly after a stop');

// Uneven packets, stable velocity: display must move on every render frame,
// with a bounded delay instead of restarting an easing animation each packet.
const arrivals = [0];
for (let i = 0; arrivals.at(-1) < 5000; i++) arrivals.push(arrivals.at(-1) + [480, 520, 490, 540, 470][i % 5]);
for (const hz of [30, 60, 120]) {
  const motion = new RobotTwinMotion();
  let index = 0, previous;
  const camera = createRobotTwinFollowCamera(sample(0).pose);
  const offset = camera.position.x;
  for (let frame = 0; frame <= hz * 4; frame++) {
    const now = frame * 1000 / hz;
    while (arrivals[index] <= now) {
      const input = sample(arrivals[index++]), copy = structuredClone(input);
      motion.push(input);
      assert.deepEqual(input, copy);
    }
    const value = motion.read(now);
    if (now > 700) {
      near(value.pose.position.x, (now - lag) / 1000);
      near(value.joints.arm, (now - lag) / 10);
      assert.ok(value.pose.position.x > previous, 'no sample-and-hold pauses at a stable velocity');
    }
    previous = value.pose.position.x;
    camera.update(value.pose);
    near(camera.position.x - value.pose.position.x, offset);
  }
  const last = sample(arrivals[index - 1]);
  assert.deepEqual(motion.read(9000).pose, last.pose, 'a missing packet cannot cause extrapolated movement');
  assert.deepEqual(motion.read(15000).pose, last.pose);
}

const wrap = new RobotTwinMotion();
wrap.push(sample(0, 0, 179)); wrap.push(sample(200, 1, -179));
near(wrap.read(lag + 100).pose.rpy.yaw, 180);
near(wrap.read(lag + 100).joints.arm, 10);
wrap.push(sample(200, 99)); wrap.push(sample(100, 88));
near(wrap.read(D + W + 200).pose.position.x, 1); // Duplicate / out-of-order packets.
wrap.push(sample(400, 2));
near(wrap.read(D + W + 400).pose.position.x, 2);
wrap.read(D + W + 500); // The buffer has run dry.
wrap.push(sample(1150, 2.85));
near(wrap.read(1150).pose.position.x, 2);
assert.ok(wrap.read(1150 + D / 2).pose.position.x > 2);
near(wrap.read(1150 + D + W).pose.position.x, 2.85);
wrap.push(sample(2600, 3));
near(wrap.read(2600).pose.position.x, 3); // Long gaps discard old playback.
wrap.push(sample(2800, 20));
near(wrap.read(2800).pose.position.x, 20); // Relocalization is not a drive path.
const freshSession = new RobotTwinMotion();
freshSession.push(sample(0, -4));
near(freshSession.read(0).pose.position.x, -4);
assert.equal(new RobotTwinMotion().read(0), null);

// Direction/speed changes must ramp through a packet boundary, instead of
// changing the following camera's linear/angular velocity in a single frame.
const turning = new RobotTwinMotion();
turning.push(sample(0, 0, 0)); turning.push(sample(500, .5, 30)); turning.push(sample(1000, .6, 0));
let previous, velocity;
for (let now = D + 450; now <= D + 650; now++) {
  const frame = turning.read(now);
  if (previous) {
    const next = { x: (frame.pose.position.x - previous.pose.position.x) * 1000,
      yaw: (frame.pose.rpy.yaw - previous.pose.rpy.yaw) * 1000 };
    if (velocity) {
      assert.ok(Math.abs(next.x - velocity.x) <= .011, 'linear velocity changes gradually');
      assert.ok(Math.abs(next.yaw - velocity.yaw) <= 1.51, 'angular velocity changes gradually');
    }
    velocity = next;
  }
  previous = frame;
}

// A late sample can exhaust the 550 ms buffer. Ease to the last observed
// pose, hold it exactly, and resume without jumping or extrapolating a path.
for (const hz of [30, 60, 120]) {
  const jitter = new RobotTwinMotion(), times = [0, 500, 1150, 1500, 2100, 2500, 3200, 3500];
  let index = 0, previous;
  for (let tick = 0; tick <= hz * 4; tick++) {
    const now = tick * 1000 / hz;
    while (times[index] <= now) jitter.push(sample(times[index++]));
    const x = jitter.read(now).pose.position.x;
    assert.ok(x <= times[index - 1] / 1000 + 1e-8, 'never move beyond received telemetry');
    if (previous !== undefined) {
      assert.ok(x >= previous - 1e-8);
      assert.ok(x - previous <= 1.3 / hz, 'late-packet recovery must not skip forward');
    }
    previous = x;
  }
  near(jitter.read(5000).pose.position.x, 3.5);
}
console.log('Robot twin motion: bounded latency, smooth speed/turn transitions, late-packet recovery, no overshoot/extrapolation, yaw wrap and independent histories passed.');
