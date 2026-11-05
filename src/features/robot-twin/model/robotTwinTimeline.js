export const ROBOT_TWIN_DISPLAY_DELAY = 550;
// A finite 80 ms average adds 40 ms at constant speed; there is no unbounded
// low-pass tail, spring overshoot, or frame-rate-dependent easing duration.
export const ROBOT_TWIN_BLEND_WINDOW = 80;
export const robotTwinAngleDelta = (a, b) => ((b - a + 180) % 360 + 360) % 360 - 180;

// Integral of the observed, piecewise-linear path over one finite window.
// Robot joints and pedestrian transforms use identical weights and deadlines.
export function robotTwinTimelineWeights(samples, time, window = ROBOT_TWIN_BLEND_WINDOW) {
  const weights = samples.map(() => 0);
  if (!samples.length) return weights;
  if (samples.length === 1 || time <= samples[0].time) { weights[0] = 1; return weights; }
  if (window <= 0 || time - window >= samples.at(-1).time) { weights[weights.length - 1] = 1; return weights; }
  const start = time - window;
  weights[0] = Math.max(0, Math.min(time, samples[0].time) - start);
  weights[weights.length - 1] += Math.max(0, time - Math.max(start, samples.at(-1).time));
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const left = Math.max(start, a.time), right = Math.min(time, b.time);
    if (right <= left) continue;
    const duration = right - left, fraction = ((left + right) / 2 - a.time) / (b.time - a.time);
    weights[i] += duration * (1 - fraction); weights[i + 1] += duration * fraction;
  }
  return weights.map((weight) => weight / window);
}
