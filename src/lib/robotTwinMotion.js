// A short, bounded presentation buffer. Only interpolate observed telemetry;
// never predict motion beyond the latest sample or write back to the robot.
export const ROBOT_TWIN_DISPLAY_DELAY = 550;
// Average a short, finite part of the observed path. This softens velocity
// changes at packet boundaries (including a late packet/stop) without spring
// overshoot, prediction, frame-rate dependence or an unbounded filter tail.
// At constant speed this adds only half the window: 40 ms.
export const ROBOT_TWIN_BLEND_WINDOW = 80;
const RESET_GAP = 1000;
const angleDelta = (a, b) => ((b - a + 180) % 360 + 360) % 360 - 180;

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
    const start = time - ROBOT_TWIN_BLEND_WINDOW;
    while (this.samples.length > 2 && this.samples[1].time <= start) this.samples.shift();
    const samples = this.samples, first = samples[0], last = samples.at(-1);
    if (samples.length === 1 || time <= first.time) return (this.rendered = first);
    if (start >= last.time) return (this.rendered = last);

    // Exact integral of the piecewise-linear path over [start, time]. Outside
    // known samples the pose is held. All weights are nonnegative, so neither
    // positions nor measured joint values can overshoot the received path.
    const weights = samples.map(() => 0);
    weights[0] = Math.max(0, Math.min(time, first.time) - start);
    weights[weights.length - 1] += Math.max(0, time - Math.max(start, last.time));
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i], b = samples[i + 1];
      const left = Math.max(start, a.time), right = Math.min(time, b.time);
      if (right <= left) continue;
      const duration = right - left, fraction = ((left + right) / 2 - a.time) / (b.time - a.time);
      weights[i] += duration * (1 - fraction);
      weights[i + 1] += duration * fraction;
    }
    const average = (value) => samples.reduce((sum, sample, i) => sum + value(sample, i) * weights[i], 0) / ROBOT_TWIN_BLEND_WINDOW;
    const heading = (key) => {
      let unwrapped = first.pose.rpy[key];
      return average((sample, i) => {
        if (i) unwrapped += angleDelta(samples[i - 1].pose.rpy[key], sample.pose.rpy[key]);
        return unwrapped;
      });
    };
    this.rendered = {
      pose: {
        position: Object.fromEntries(['x', 'y', 'z'].map((key) => [key, average((sample) => sample.pose.position[key])])),
        rpy: Object.fromEntries(['roll', 'pitch', 'yaw'].map((key) => [key, heading(key)])),
      },
      // Joint values are measured coordinates, not compass headings. Preserve
      // bounded joints' actual path instead of wrapping them through a limit.
      joints: Object.fromEntries(Object.entries(last.joints).map(([key, value]) => [key,
        average((sample) => Number.isFinite(sample.joints[key]) ? sample.joints[key] : value)])),
    };
    return this.rendered;
  }
}
