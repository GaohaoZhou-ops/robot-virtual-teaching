// A short, bounded presentation buffer. Only interpolate observed telemetry;
// never predict motion beyond the latest sample or write back to the robot.
export const ROBOT_TWIN_DISPLAY_DELAY = 300;
const RESET_GAP = 1000;
const angle = (a, b, t) => a + (((b - a + 180) % 360 + 360) % 360 - 180) * t;
const mix = (a, b, t) => a + (b - a) * t;

export class RobotTwinMotion {
  constructor() { this.samples = []; }

  push({ pose, joints, motionSample }) {
    if (!motionSample || !Number.isFinite(motionSample.time)) return;
    const { time, id } = motionSample;
    if (this.latest && (time <= this.latest.time || (id != null && id <= this.latest.id))) return;
    const sample = { time, id, pose: structuredClone(pose), joints: { ...joints } };
    const previous = this.latest;
    this.latest = sample;
    const jump = previous && Math.hypot(...['x', 'y', 'z'].map((key) => pose.position[key] - previous.pose.position[key]));
    if (!previous || time - previous.time > RESET_GAP || jump > 5) {
      // Reconnects, relocalization and long background pauses must not replay
      // an old path across the map. Each robot owns its own sample history.
      this.samples = [sample]; this.rendered = sample; this.readAt = undefined;
      return;
    }
    if (this.readAt > previous.time + ROBOT_TWIN_DISPLAY_DELAY && this.rendered) {
      // A late packet after buffer starvation starts at the held display pose,
      // rather than skipping forward through the missing part of the motion.
      this.samples = [{ ...this.rendered, time: time - ROBOT_TWIN_DISPLAY_DELAY }];
    }
    this.samples.push(sample);
    if (this.samples.length > 12) this.samples.shift();
  }

  read(now) {
    if (!this.samples.length) return null;
    this.readAt = now;
    const time = now - ROBOT_TWIN_DISPLAY_DELAY;
    while (this.samples.length > 2 && this.samples[1].time <= time) this.samples.shift();
    const a = this.samples[0], b = this.samples[1];
    if (!b || time <= a.time) return (this.rendered = a);
    if (time >= b.time) return (this.rendered = b);
    const t = (time - a.time) / (b.time - a.time);
    this.rendered = {
      pose: {
        position: Object.fromEntries(['x', 'y', 'z'].map((key) => [key, mix(a.pose.position[key], b.pose.position[key], t)])),
        rpy: Object.fromEntries(['roll', 'pitch', 'yaw'].map((key) => [key, angle(a.pose.rpy[key], b.pose.rpy[key], t)])),
      },
      // Joint values are measured coordinates, not compass headings. Preserve
      // bounded joints' actual path instead of wrapping them through a limit.
      joints: Object.fromEntries(Object.entries(b.joints).map(([key, value]) => [key,
        Number.isFinite(a.joints[key]) ? mix(a.joints[key], value, t) : value])),
    };
    return this.rendered;
  }
}
