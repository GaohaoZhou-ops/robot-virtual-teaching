import { ROBOT_PEDESTRIANS_MAX_BOXES, ROBOT_PEDESTRIAN_HOLD_MS, ROBOT_PEDESTRIAN_FADE_MS,
  ROBOT_PEDESTRIAN_RECOVER_MS, ROBOT_PEDESTRIAN_VISIBLE_MS, ROBOT_PEDESTRIAN_TRACK_TTL_MS } from '../../../shared/protocols/robotTwinPedestrians.js';
import { ROBOT_TWIN_DISPLAY_DELAY, ROBOT_TWIN_BLEND_WINDOW, robotTwinAngleDelta, robotTwinTimelineWeights } from './robotTwinTimeline.js';

export { ROBOT_PEDESTRIAN_HOLD_MS } from '../../../shared/protocols/robotTwinPedestrians.js';
const HISTORY = 12;
const POSITION_SLOP_MS = 100;
const degrees = (radians) => radians * 180 / Math.PI;
const lerp = (a, b, t) => a + (b - a) * t;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const smooth = (value) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

// Only a new matched observation renews presence. Empty frames and network
// status changes do not reset this clock. Evaluate on the display timeline so
// a buffered future match cannot brighten a person before its position arrives.
function opacityAt(track, time) {
  const event = track.events.findLast((event) => event.seen && event.time <= time);
  if (!event) return 0;
  const freshness = 1 - smooth((time - event.observedAt - ROBOT_PEDESTRIAN_HOLD_MS) / ROBOT_PEDESTRIAN_FADE_MS);
  const recovery = lerp(event.opacity, 1, smooth((time - event.time) / ROBOT_PEDESTRIAN_RECOVER_MS));
  return Math.min(freshness, recovery);
}

// Detection age and SLAM age use durations, not synchronized machine clocks.
// Interpolate the capture-time SLAM pose, then map that instant onto the same
// receive-time timeline used by RobotTwinMotion. Never transform old detections
// using the already delayed, rendered robot pose (which would add lag twice).
export function resolvePedestrianPose(poses, sourceTime) {
  if (!poses.length) return null;
  const right = poses.findIndex((pose) => pose.sourceTime >= sourceTime);
  if (right > 0) {
    const a = poses[right - 1], b = poses[right];
    const t = (sourceTime - a.sourceTime) / (b.sourceTime - a.sourceTime);
    return { time: lerp(a.time, b.time, t),
      x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
      yaw: a.yaw + robotTwinAngleDelta(a.yaw, b.yaw) * t };
  }
  const nearest = right === 0 ? poses[0] : poses.at(-1);
  const offset = sourceTime - nearest.sourceTime;
  // Only tolerate a small sampling skew at the edges. Otherwise wait for the
  // next existing SLAM sample, inside the shared presentation buffer.
  return Math.abs(offset) <= POSITION_SLOP_MS ? { ...nearest, time: nearest.time + offset } : null;
}

export class RobotTwinPedestrianTracks {
  constructor() {
    this.poses = []; this.nextId = 1; this.following = false; this.clearTracks();
  }

  clearTracks() {
    this.tracks = new Map(); this.pending = []; this.seenFrame = null;
    this.lastSourceTime = -Infinity; this.lastFrameTime = -Infinity;
  }

  observe(robot, now) {
    const data = robot.pedestrians;
    if (!robot.localizationFresh) {
      this.poses = []; this.clearTracks(); this.seenFrame = data?.frame; this.generation = data?.generation; return;
    }
    const sample = robot.motionSample;
    if (sample && Number.isFinite(sample.sourceTime) && Number.isFinite(sample.time)
      && sample.id !== this.poses.at(-1)?.id) {
      const pose = { ...robot.pose.position, yaw: robot.pose.rpy.yaw,
        sourceTime: sample.sourceTime, time: sample.time, id: sample.id };
      const last = this.poses.at(-1);
      if (last && (pose.time - last.time > 1000 || distance(last, pose) > 5)) {
        this.poses = []; this.clearTracks(); this.seenFrame = data?.frame;
      }
      if (!this.poses.length || (pose.time > this.poses.at(-1).time && pose.sourceTime > this.poses.at(-1).sourceTime)) {
        this.poses.push(pose); this.poses = this.poses.slice(-HISTORY);
      }
    }
    if (data?.generation !== this.generation) {
      this.clearTracks(); this.generation = data?.generation;
    }
    if (!data?.enabled || ['idle', 'paused', 'unavailable'].includes(data.phase)) {
      if (this.tracks.size || this.pending.length) this.clearTracks();
      this.seenFrame = data?.frame; return;
    }
    const frame = data.frame;
    if (frame && frame !== this.seenFrame) {
      this.seenFrame = frame;
      if (frame.sourceTime > this.lastSourceTime && now - frame.receivedAt <= ROBOT_PEDESTRIAN_HOLD_MS) {
        this.pending.push(frame); this.pending = this.pending.slice(-HISTORY);
      }
    }
    const remaining = [];
    for (const item of this.pending) {
      if (item.sourceTime <= this.lastSourceTime || now - item.receivedAt > ROBOT_PEDESTRIAN_HOLD_MS) continue;
      const pose = resolvePedestrianPose(this.poses, item.sourceTime);
      if (!pose) { remaining.push(item); continue; }
      if (pose.time <= this.lastFrameTime) continue;
      const yaw = pose.yaw * Math.PI / 180, cos = Math.cos(yaw), sin = Math.sin(yaw);
      const boxes = item.boxes.map((box) => ({ time: pose.time, size: [...box.size], yaw: pose.yaw + degrees(box.yaw),
        x: pose.x + cos * box.center[0] - sin * box.center[1],
        y: pose.y + sin * box.center[0] + cos * box.center[1], z: pose.z + box.center[2] - box.size[2] / 2 }));
      this.consume(boxes, pose.time);
      this.lastSourceTime = item.sourceTime; this.lastFrameTime = pose.time;
    }
    this.pending = remaining;
  }

  consume(boxes, time) {
    const candidates = [];
    for (const track of this.tracks.values()) {
      const dt = (time - track.last.time) / 1000;
      if (dt <= 0 || dt * 1000 >= ROBOT_PEDESTRIAN_TRACK_TTL_MS) continue;
      const hidden = dt * 1000 >= ROBOT_PEDESTRIAN_VISIBLE_MS;
      const gate = hidden ? .75 : Math.min(2.5, .4 + 2.2 * dt);
      // Short velocity estimates only disambiguate association. They never
      // advance a displayed person beyond received observations.
      const horizon = Math.min(dt, ROBOT_PEDESTRIAN_HOLD_MS / 1000);
      const predicted = { x: track.last.x + track.velocity.x * horizon, y: track.last.y + track.velocity.y * horizon };
      boxes.forEach((box, index) => {
        const d = distance(predicted, box), heightDifference = Math.abs(track.last.size[2] - box.size[2]);
        if (d <= gate && heightDifference <= (hidden ? .35 : .7) && Math.abs(box.z - track.last.z) <= (hidden ? .4 : .8)) {
          candidates.push({ track, index, hidden, cost: d + heightDifference * .15 });
        }
      });
    }
    candidates.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.cost - b.cost || a.track.id - b.track.id || a.index - b.index);
    const assigned = new Set(), used = new Set();
    for (const candidate of candidates) {
      const { track, index, hidden, cost } = candidate;
      if (assigned.has(track.id) || used.has(index)) continue;
      // Dormant identities must not steal visible tracks or guess between
      // nearby people after an occlusion. Ambiguous returns start a new track.
      if (hidden && candidates.some((other) => other !== candidate
        && (other.track === track || other.index === index) && Math.abs(other.cost - cost) < .2)) continue;
      assigned.add(track.id); used.add(index); this.append(track, boxes[index]);
    }
    for (const track of this.tracks.values()) {
      if (!assigned.has(track.id)) track.events.push({ time, seen: false });
      track.events = track.events.slice(-HISTORY);
    }
    boxes.forEach((box, index) => {
      if (used.has(index)) return;
      if (this.tracks.size >= ROBOT_PEDESTRIANS_MAX_BOXES) {
        const oldest = [...this.tracks.values()].filter((track) => !assigned.has(track.id))
          .sort((a, b) => a.last.time - b.last.time)[0];
        if (!oldest) return;
        this.tracks.delete(oldest.id);
      }
      const track = { id: this.nextId++, bornAt: time, last: box, samples: [box], velocity: { x: 0, y: 0 },
        events: [{ time, observedAt: time, seen: true, opacity: 1 }] };
      this.tracks.set(track.id, track); assigned.add(track.id);
    });
  }

  append(track, box) {
    const visibleAt = Math.max(box.time, track.readAt ?? box.time);
    const opacity = opacityAt(track, visibleAt);
    // A detection rectangle has no reliable front/back heading. The simple
    // human is symmetric: use the nearest equivalent orientation, so a 180°
    // detector flip cannot spin an otherwise stationary person.
    const delta = robotTwinAngleDelta(track.last.yaw, box.yaw);
    box = { ...box, yaw: track.last.yaw + (Math.abs(delta) > 90 ? delta - Math.sign(delta) * 180 : delta) };
    const dt = (box.time - track.last.time) / 1000;
    const vx = (box.x - track.last.x) / dt, vy = (box.y - track.last.y) / dt;
    const speed = Math.hypot(vx, vy), factor = speed > 2.5 ? 2.5 / speed : 1;
    track.velocity = { x: vx * factor, y: vy * factor };
    track.recoveryMotion = !this.following && track.rendered && opacity < 1
      ? { from: track.rendered, time: visibleAt } : null;
    // Reacquisition after an empty/late frame starts at the held display pose.
    // It catches up by the new sample's existing display deadline; no second
    // easing timer or accumulating low-pass delay is added.
    let next = box;
    if (this.following && track.rendered && track.readAt > track.last.time) {
      track.samples = [{ ...track.rendered, time: track.readAt }];
      next = { ...box, time: Math.max(box.time, track.readAt + ROBOT_TWIN_BLEND_WINDOW) };
    }
    track.samples.push(next); track.samples = track.samples.slice(-HISTORY); track.last = box;
    track.events.push({ time: visibleAt, observedAt: box.time, seen: true, opacity });
  }

  read(now, following) {
    const time = now - (following ? ROBOT_TWIN_DISPLAY_DELAY : 0);
    if (this.following !== following) {
      this.following = following;
      for (const track of this.tracks.values()) {
        if (track.rendered) {
          track.bornAt = Math.min(track.bornAt, time);
          const opacity = track.opacity;
          const lastVisible = track.events.findLast((event) => event.seen && event.time <= track.readAt);
          const observedAt = (lastVisible?.observedAt ?? track.last.time) + time - track.readAt;
          track.events = [{ time, observedAt, seen: true, opacity }];
        }
        track.recoveryMotion = null;
        track.samples = [track.last]; track.rendered = null; track.readAt = undefined;
      }
    }
    const result = [];
    for (const [id, track] of this.tracks) {
      if (time - track.last.time >= ROBOT_PEDESTRIAN_TRACK_TTL_MS) { this.tracks.delete(id); continue; }
      if (time < track.bornAt) continue;
      while (track.samples.length > 2 && track.samples[1].time <= time - ROBOT_TWIN_BLEND_WINDOW) track.samples.shift();
      const samples = track.samples, weights = robotTwinTimelineWeights(samples, time, following ? ROBOT_TWIN_BLEND_WINDOW : 0);
      const mean = (value) => samples.reduce((sum, sample, i) => sum + value(sample, i) * weights[i], 0);
      let yaw = samples[0].yaw;
      const rendered = { time, x: mean((s) => s.x), y: mean((s) => s.y), z: mean((s) => s.z),
        size: [0, 1, 2].map((axis) => mean((s) => s.size[axis])),
        yaw: mean((s, i) => { if (i) yaw += robotTwinAngleDelta(samples[i - 1].yaw, s.yaw); return yaw; }) };
      if (track.recoveryMotion) {
        const { from, time: start } = track.recoveryMotion;
        const t = smooth((time - start) / ROBOT_PEDESTRIAN_RECOVER_MS);
        for (const axis of ['x', 'y', 'z']) rendered[axis] = lerp(from[axis], rendered[axis], t);
        rendered.yaw = from.yaw + robotTwinAngleDelta(from.yaw, rendered.yaw) * t;
        rendered.size = rendered.size.map((value, i) => lerp(from.size[i], value, t));
        if (t === 1) track.recoveryMotion = null;
      }
      track.rendered = rendered; track.readAt = time;
      track.opacity = opacityAt(track, time);
      if (track.opacity > 0) result.push({ ...rendered, id, opacity: track.opacity, held: track.opacity < 1 });
    }
    return result;
  }
}
