import assert from 'node:assert/strict';
import { RobotTwinMotion } from '../../src/features/robot-twin/model/robotTwinMotion.js';
import { RobotTwinPedestrianTracks, ROBOT_PEDESTRIAN_HOLD_MS, resolvePedestrianPose } from '../../src/features/robot-twin/model/robotTwinPedestrianTracks.js';
import { ROBOT_TWIN_DISPLAY_DELAY as D, ROBOT_TWIN_BLEND_WINDOW as W } from '../../src/features/robot-twin/model/robotTwinTimeline.js';
import { ROBOT_PEDESTRIAN_VISIBLE_MS, ROBOT_PEDESTRIAN_TRACK_TTL_MS } from '../../src/shared/protocols/robotTwinPedestrians.js';

const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const box = (x, y = 0, yaw = 0, height = 1.8) => ({ center: [x, y, height / 2], size: [.5, .6, height], yaw, score: .9 });
const robot = (time, { x = 0, y = 0, yaw = 0, age = 0, frame = null, generation = 1 } = {}) => ({ id: 'a', localizationFresh: true,
  motionSample: { time, sourceTime: time - age, id: time + 1 },
  pose: { position: { x, y, z: .1 }, rpy: { roll: 0, pitch: 0, yaw } }, joints: { arm: time / 10 },
  pedestrians: { enabled: true, phase: 'live', generation, frame } });
const detection = (time, boxes, age = 0) => ({ id: String(time), receivedAt: time, sourceTime: time - age, boxes });

// Every rendered frame, at three refresh rates: people walking with the robot
// must share its exact phase, despite independent polls and different ages.
for (const hz of [30, 60, 120]) {
  const tracks = new RobotTwinPedestrianTracks(), motion = new RobotTwinMotion();
  let poseTime = 0, detectionTime = 40, input, frame = null, previous;
  for (let tick = 0; tick <= hz * 5; tick++) {
    const now = tick * 1000 / hz;
    while (poseTime <= now) {
      input = robot(poseTime, { x: (poseTime - 80) / 1000, age: 80 });
      motion.push(input); poseTime += 500;
    }
    while (detectionTime <= now) {
      frame = detection(detectionTime, [box(2)], 120); detectionTime += 500;
    }
    tracks.observe({ ...input, pedestrians: { ...input.pedestrians, frame } }, now);
    const people = tracks.read(now, true), pose = motion.read(now);
    if (now > 1600) {
      assert.equal(people.length, 1);
      near(people[0].x - pose.pose.position.x, 2);
      near(people[0].x, 2 + (now - D - W / 2 - 80) / 1000);
      assert.ok(people[0].x > previous, 'movement continues between packets');
      assert.equal(people[0].held, false);
    }
    previous = people[0]?.x;
  }
}

// A standing pedestrian must stay fixed in the map while SLAM translation and
// yaw change. Resolve the pose at capture time, never at HTTP receive time.
const history = [
  { time: 100, sourceTime: 0, x: 0, y: 0, z: .1, yaw: 179 },
  { time: 600, sourceTime: 500, x: 1, y: 2, z: .1, yaw: -179 },
];
const mid = resolvePedestrianPose(history, 250);
near(mid.x, .5); near(mid.y, 1); near(mid.yaw, 180); near(mid.time, 350);
assert.equal(resolvePedestrianPose(history, 650), null, 'wait for the next pose instead of extrapolating');
const standing = new RobotTwinPedestrianTracks();
let frame = null;
for (let time = 0; time <= 3000; time += 50) {
  const poseTime = Math.floor(time / 500) * 500;
  if (time % 500 === 250) {
    const capture = time - 50, x = capture / 1000, yaw = capture / 1000 * 30 * Math.PI / 180;
    const dx = 3 - x, dy = 2;
    frame = detection(time, [box(Math.cos(yaw) * dx + Math.sin(yaw) * dy,
      -Math.sin(yaw) * dx + Math.cos(yaw) * dy, -yaw)], 50);
  }
  standing.observe(robot(poseTime, { x: poseTime / 1000, yaw: poseTime / 1000 * 30, frame }), time);
  for (const person of standing.read(time, true)) { near(person.x, 3); near(person.y, 2); near(person.yaw, 0); }
}

// Alternating present/empty results retain one identity and recover without a
// jump or fade; a true departure fades after the 1.2 second grace period.
const intermittent = new RobotTwinPedestrianTracks();
let input, id, lastX;
for (let now = 0; now <= 3500; now += 10) {
  if (now % 500 === 0) {
    const present = now === 0 || now === 1000 || now === 2000;
    input = robot(now, { frame: detection(now, present ? [box(2 + now / 2000)] : []) });
  }
  intermittent.observe(input, now);
  const people = intermittent.read(now, true);
  if (now >= D) {
    assert.equal(people.length, 1, 'one missed observation must not erase the model');
    id ??= people[0].id; assert.equal(people[0].id, id);
    if (lastX !== undefined) assert.ok(Math.abs(people[0].x - lastX) < .025, 'reacquisition does not teleport');
    lastX = people[0].x;
  }
  if (now === 1100) { assert.equal(people[0].held, false); near(people[0].opacity, 1); }
}
near(intermittent.read(2000 + D + ROBOT_PEDESTRIAN_HOLD_MS, true)[0].opacity, 1);
assert.equal(intermittent.read(2000 + D + ROBOT_PEDESTRIAN_VISIBLE_MS, true).length, 0);

// Presence is time based, independently of render rate. A missed observation
// does not dim the model; long misses fade continuously, then retain only ID.
for (const hz of [30, 60, 120]) {
  const presence = new RobotTwinPedestrianTracks();
  const times = [...new Set([0, 1200, 1700, 2200, 3000,
    ...Array.from({ length: hz * 3 }, (_, i) => i * 1000 / hz)])].sort((a, b) => a - b);
  let input, nextPoll = 0, previousOpacity = 1;
  for (const now of times) {
    while (nextPoll <= now) {
      input = robot(nextPoll, { frame: detection(nextPoll, nextPoll ? [] : [box(2)]) });
      nextPoll += 500;
    }
    presence.observe(input, now);
    const people = presence.read(now, false), opacity = people[0]?.opacity ?? 0;
    assert.ok(opacity <= previousOpacity, 'misses never brighten a fading person');
    if (now <= 1200) near(opacity, 1);
    if (now === 1700) near(opacity, .5);
    if (now >= 2200) assert.equal(people.length, 0);
    assert.equal(presence.tracks.size, now < 3000 ? 1 : 0, 'hidden identities have a separate bounded lifetime');
    previousOpacity = opacity;
  }
}

// Reacquisition during fade and after hiding preserves identity, begins at the
// current alpha/pose, and finishes within 200 ms without a discontinuity.
for (const returnAt of [2000, 2500]) {
  const returning = new RobotTwinPedestrianTracks();
  for (let time = 0; time < returnAt; time += 500) {
    returning.observe(robot(time, { frame: detection(time, time ? [] : [box(2)]) }), time);
    returning.read(time, false);
  }
  const originalId = [...returning.tracks.keys()][0];
  const before = returning.read(returnAt, false)[0]?.opacity ?? 0;
  returning.observe(robot(returnAt, { frame: detection(returnAt, [box(2.2)]) }), returnAt);
  near(returning.read(returnAt, false)[0]?.opacity ?? 0, before);
  let previousOpacity = before, previousX = 2;
  for (let time = returnAt + 10; time <= returnAt + 200; time += 10) {
    const person = returning.read(time, false)[0];
    assert.equal(person.id, originalId);
    assert.ok(person.opacity >= previousOpacity && person.opacity - previousOpacity < .08);
    assert.ok(person.x >= previousX && person.x - previousX < .016);
    previousOpacity = person.opacity; previousX = person.x;
  }
  near(previousOpacity, 1); near(previousX, 2.2);
}

// Buffered detections must not restore alpha before their display time. A
// camera-mode switch alone must not resurrect an already hidden observation.
const buffered = new RobotTwinPedestrianTracks();
for (let time = 0; time <= 2000; time += 500) {
  buffered.observe(robot(time, { frame: detection(time, time ? [] : [box(2)]) }), time);
  buffered.read(time, true);
}
buffered.observe(robot(2500, { frame: detection(2500, [box(2)]) }), 2500);
assert.ok(buffered.read(2500, true)[0].opacity < .2, 'future match is not visible yet');
assert.equal(buffered.read(2300 + D, true).length, 0);
near(buffered.read(2700 + D, true)[0].opacity, 1);
const hidden = new RobotTwinPedestrianTracks();
hidden.observe(robot(0, { frame: detection(0, [box(2)]) }), 0);
hidden.read(0, false); assert.equal(hidden.read(2300, false).length, 0);
assert.equal(hidden.read(2310, true).length, 0, 'follow switches do not renew stale presence');

// An ambiguous return between two dormant people must not guess an identity.
const ambiguous = new RobotTwinPedestrianTracks();
for (let time = 0; time <= 2000; time += 500) {
  ambiguous.observe(robot(time, { frame: detection(time, time ? [] : [box(-.2), box(.2)]) }), time);
  ambiguous.read(time, false);
}
ambiguous.read(2500, false);
ambiguous.observe(robot(2500, { frame: detection(2500, [box(0)]) }), 2500);
assert.equal(ambiguous.read(2500, false)[0].id, 3);

// Swapping detector order does not swap identities; gates reject remote jumps.
const association = new RobotTwinPedestrianTracks();
association.observe(robot(0, { frame: detection(0, [box(-1), box(1)]) }), 0);
const ids = association.read(0, false).map((p) => p.id);
association.observe(robot(500, { frame: detection(500, [box(1.05), box(-.95)]) }), 500);
const reordered = association.read(500, false);
assert.equal(reordered.find((p) => p.x < 0).id, ids[0]);
assert.equal(reordered.find((p) => p.x > 0).id, ids[1]);
association.observe(robot(1000, { frame: detection(1000, [box(10)]) }), 1000);
assert.ok(association.read(1000, false).find((p) => p.x === 10).id > Math.max(...ids));

// Repeated cached frames / statuses never renew tracks. Pause, reconnect,
// localization loss and relocalization must not revive old positions.
const lifecycle = new RobotTwinPedestrianTracks(), first = robot(0, { frame: detection(0, [box(2)]) });
lifecycle.observe(first, 0); assert.equal(lifecycle.read(0, false).length, 1);
for (let now = 100; now <= ROBOT_PEDESTRIAN_TRACK_TTL_MS; now += 100) {
  lifecycle.observe(first, now); lifecycle.read(now, false);
}
assert.equal(lifecycle.tracks.size, 0);
const renewed = robot(3500, { frame: detection(3500, [box(2)]) });
lifecycle.observe(renewed, 3500); // The long pose gap intentionally drops this old simultaneous frame.
const next = robot(4000, { frame: detection(4000, [box(2)]) });
lifecycle.observe(next, 4000); assert.equal(lifecycle.read(4000, false).length, 1);
lifecycle.observe({ ...next, localizationFresh: false }, 4010); assert.equal(lifecycle.read(4010, false).length, 0);
lifecycle.observe(next, 4020); assert.equal(lifecycle.read(4020, false).length, 0);
const connected = robot(4500, { frame: detection(4500, [box(2)]), generation: 2 });
lifecycle.observe(connected, 4500); assert.equal(lifecycle.read(4500, false).length, 1);
lifecycle.observe({ ...connected, pedestrians: { ...connected.pedestrians, enabled: false } }, 4510);
assert.equal(lifecycle.read(4510, false).length, 0);

// Follow switches use the robot's immediate/latest presentation outside follow,
// and seed the new buffer without playing an old path backwards.
const switching = new RobotTwinPedestrianTracks();
for (const time of [0, 500, 1000]) {
  switching.observe(robot(time, { frame: detection(time, [box(2 + time / 1000)]) }), time);
  switching.read(time, true);
}
near(switching.read(1000, false)[0].x, 3);
near(switching.read(1010, true)[0].x, 3);
const newlyVisible = new RobotTwinPedestrianTracks();
newlyVisible.observe(robot(1000, { frame: detection(1000, [box(2)]) }), 1000);
assert.equal(newlyVisible.read(1000, false).length, 1);
assert.equal(newlyVisible.read(1010, true).length, 1, 'entering follow must not hide an already visible person');
newlyVisible.observe(robot(1500, { frame: detection(1500, [box(2, 0, Math.PI)]) }), 1500);
near(newlyVisible.read(2100, true)[0].yaw, 0, 1e-6);

// Fixed memory/render limits despite crowded frames and changing identities.
const crowded = new RobotTwinPedestrianTracks();
for (let time = 0; time < 10000; time += 500) {
  crowded.observe(robot(time, { frame: detection(time, Array.from({ length: 128 }, (_, i) => box(i * 3 + time / 100, 0))) }), time);
  crowded.read(time, false);
  assert.ok(crowded.tracks.size <= 128 && crowded.pending.length <= 12 && crowded.poses.length <= 12);
  for (const track of crowded.tracks.values()) assert.ok(track.samples.length <= 12 && track.events.length <= 12);
}
console.log('Pedestrian tracks: shared robot phase at 30/60/120 Hz, source-time poses, misses, reacquisition, ordering, lifecycle and bounds passed.');
