import assert from 'node:assert/strict';
import { RobotTwinMotion, ROBOT_TWIN_DISPLAY_DELAY } from '../src/lib/robotTwinMotion.js';
import { createRobotTwinFollowCamera } from '../src/lib/robotTwinFollowCamera.js';

const sample = (time, x = time / 1000, yaw = 0) => ({ motionSample: { time, id: time + 1 },
  pose: { position: { x, y: 0, z: .12 }, rpy: { roll: 0, pitch: 0, yaw } }, joints: { arm: time / 10 } });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
assert.ok(ROBOT_TWIN_DISPLAY_DELAY <= 350);

// Uneven packets, stable velocity: display must move on every render frame,
// with a bounded delay instead of restarting an easing animation each packet.
const arrivals = [0];
for (let i = 0; arrivals.at(-1) < 5000; i++) arrivals.push(arrivals.at(-1) + [180, 240, 190, 260, 200][i % 5]);
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
    if (now > 500) {
      near(value.pose.position.x, (now - ROBOT_TWIN_DISPLAY_DELAY) / 1000);
      near(value.joints.arm, (now - ROBOT_TWIN_DISPLAY_DELAY) / 10);
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
near(wrap.read(400).pose.rpy.yaw, 180);
near(wrap.read(400).joints.arm, 10);
wrap.push(sample(200, 99)); wrap.push(sample(100, 88));
near(wrap.read(500).pose.position.x, 1); // Duplicate / out-of-order packets.
wrap.push(sample(400, 2));
near(wrap.read(700).pose.position.x, 2);
wrap.read(800); // The buffer has run dry.
wrap.push(sample(850, 2.85));
near(wrap.read(850).pose.position.x, 2);
assert.ok(wrap.read(1000).pose.position.x > 2);
near(wrap.read(1150).pose.position.x, 2.85);
wrap.push(sample(2200, 3));
near(wrap.read(2200).pose.position.x, 3); // Long gaps discard old playback.
wrap.push(sample(2400, 20));
near(wrap.read(2400).pose.position.x, 20); // Relocalization is not a drive path.
const freshSession = new RobotTwinMotion();
freshSession.push(sample(0, -4));
near(freshSession.read(0).pose.position.x, -4);
assert.equal(new RobotTwinMotion().read(0), null);
console.log('Robot twin motion: bounded latency, continuous frames, joint interpolation, yaw wrap, stale holds and independent histories passed.');
