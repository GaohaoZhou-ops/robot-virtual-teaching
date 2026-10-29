// Retiming changes only the speed along the already checked Hermite path.
// Approach/strict mode adapts locally; uniform drawing uses one safe cruise
// speed across the whole continuous block without stops at sampling knots.
const baseDefinitions = {
  x: { type: 'prismatic', velocity: 0.1 / Math.SQRT2, acceleration: 0.25 / Math.SQRT2 },
  y: { type: 'prismatic', velocity: 0.1 / Math.SQRT2, acceleration: 0.25 / Math.SQRT2 },
  yaw: { type: 'revolute', velocity: 15, acceleration: 30 },
};

function derivativeBounds(a, b, name, field, tangentField) {
  const h = b.u - a.u, delta = b[field][name] - a[field][name];
  const m = h * a[tangentField][name], n = h * b[tangentField][name];
  // Differences avoid cancellation from subtracting large absolute angles.
  const A = m + n - 2 * delta, B = 3 * delta - 2 * m - n, C = m;
  const extrema = [0, 1];
  if (Math.abs(A) > 1e-15 && -B / (3 * A) > 0 && -B / (3 * A) < 1) extrema.push(-B / (3 * A));
  return {
    first: Math.max(...extrema.map((t) => Math.abs((3 * A * t * t + 2 * B * t + C) / h))),
    second: Math.max(Math.abs(2 * B / h ** 2), Math.abs((6 * A + 2 * B) / h ** 2)),
  };
}

export function preparePolylineTiming(samples, distance, settings, definitions, { curvature = 0, arcMapping = null } = {}) {
  const knots = arcMapping?.samples || samples;
  let sourceIndex = 0;
  let intervals = knots.slice(1).map((b, i) => {
    const a = knots[i], h = b.u - a.u;
    if (arcMapping) while (sourceIndex < samples.length - 2 && a.joints.pathU >= samples[sourceIndex + 1].u - 1e-12) sourceIndex += 1;
    const inverse = arcMapping ? derivativeBounds(a, b, 'pathU', 'joints', 'tangents') : null;
    if (!(h > 0)) throw new Error('轨迹采样顺序无效，请重新检查');
    let speed = distance > 0 ? settings.speed / distance : Infinity;
    let acceleration = distance > 0 ? settings.acceleration / distance : Infinity;
    const constrain = (entries, field, tangentField) => {
      for (const [name, definition] of Object.entries(entries)) {
        const source = inverse ? derivativeBounds(samples[sourceIndex], samples[sourceIndex + 1], name, field, tangentField)
          : derivativeBounds(a, b, name, field, tangentField);
        // Chain rule for q(u(s)): include the inverse arc map's curvature in
        // the bounds, rather than assuming target speed equals actual speed.
        const first = inverse ? source.first * inverse.first : source.first;
        const second = inverse ? source.second * inverse.first ** 2 + source.first * inverse.second : source.second;
        const linear = definition.type === 'prismatic';
        const maxSpeed = Math.min(linear ? 0.1 : 36, definition.velocity > 0 ? definition.velocity : Infinity);
        const maxAcceleration = definition.acceleration || (linear ? 0.25 : 90);
        // q̈ = q″ u̇² + q′ ü. Reserve separate budgets for curvature and
        // acceleration so the bound holds throughout this entire interval.
        const curvatureBudget = second > 0 ? maxAcceleration / 2 : 0;
        if (first > 0) {
          speed = Math.min(speed, maxSpeed / first);
          acceleration = Math.min(acceleration, (maxAcceleration - curvatureBudget) / first);
        }
        if (second > 0) speed = Math.min(speed, Math.sqrt(curvatureBudget / second));
      }
    };
    constrain(definitions, 'joints', 'tangents');
    if (samples[0].base) constrain(baseDefinitions, 'base', 'baseTangents');
    // A zero-motion interval may still carry a progress coordinate.
    if (speed === Infinity) speed = 4;
    if (acceleration === Infinity) acceleration = 16;
    if (!(speed > 0 && acceleration > 0) || !Number.isFinite(speed + acceleration)) {
      throw new Error('无法为当前轨迹分配有效速度，请调整起始姿态后重新检查');
    }
    return { from: a.u, to: b.u, h, speed, acceleration };
  });

  if (!settings.uniformSpeed && arcMapping && curvature > 0) {
    // Spatial paths retain their curvature even when uniform cruising is off.
    // Reserve acceleration for turning as well as tangential speed changes.
    const turnSpeed = Math.sqrt(settings.acceleration / 2 / curvature) / distance;
    intervals = intervals.map((interval) => ({ ...interval, speed: Math.min(interval.speed, turnSpeed),
      acceleration: Math.min(interval.acceleration, settings.acceleration / 2 / distance) }));
  }
  if (settings.uniformSpeed) {
    // One cruise speed for the entire continuous drawing block. A restrictive
    // joint interval lowers this common speed instead of causing repeated ramps.
    // Reserve Cartesian acceleration for both turning and starting/stopping.
    const turnSpeed = curvature > 0 ? Math.sqrt(settings.acceleration / 2 / curvature) / distance : Infinity;
    intervals = [{ from: 0, to: 1, h: 1,
      speed: intervals.reduce((minimum, interval) => Math.min(minimum, interval.speed), turnSpeed),
      acceleration: intervals.reduce((minimum, interval) => Math.min(minimum, interval.acceleration),
        curvature > 0 ? settings.acceleration / 2 / distance : Infinity) }];
  }

  // Continuous speeds at IK knots; only actual polyline corners stop. Cubic
  // speed ramps have peak acceleration 1.5 Δv/T and distance .75 Δ(v²)/a.
  const speeds = [0, ...intervals.slice(1).map((interval, i) => Math.min(intervals[i].speed, interval.speed)), 0];
  intervals.forEach((interval, i) => {
    speeds[i + 1] = Math.min(speeds[i + 1], Math.sqrt(speeds[i] ** 2 + 4 / 3 * interval.acceleration * interval.h));
  });
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    speeds[i] = Math.min(speeds[i], Math.sqrt(speeds[i + 1] ** 2 + 4 / 3 * intervals[i].acceleration * intervals[i].h));
  }
  const timing = [];
  let durationMs = 0;
  intervals.forEach((interval, i) => {
    const { from, to, h, speed, acceleration } = interval, v0 = speeds[i], v1 = speeds[i + 1];
    const peak = Math.max(v0, v1, Math.min(speed, Math.sqrt(2 / 3 * acceleration * h + (v0 ** 2 + v1 ** 2) / 2)));
    const rise = Math.max(0, 0.75 * (peak ** 2 - v0 ** 2) / acceleration);
    const fall = Math.max(0, 0.75 * (peak ** 2 - v1 ** 2) / acceleration);
    const firstEnd = Math.min(to, from + rise), lastStart = Math.max(firstEnd, to - fall);
    for (const [u0, u1, before, after] of [[from, firstEnd, v0, peak], [firstEnd, lastStart, peak, peak], [lastStart, to, peak, v1]]) {
      if (u1 <= u0) continue;
      const milliseconds = 2000 * (u1 - u0) / (before + after);
      if (!Number.isFinite(milliseconds)) throw new Error('轨迹时间无效，请重新检查');
      timing.push({ u0, u1, v0: before, v1: after, startMs: durationMs, endMs: durationMs + milliseconds });
      durationMs += milliseconds;
    }
  });
  if (!timing.length || !(durationMs > 0)) throw new Error('轨迹没有有效运动，请调整折线后重新检查');
  if (durationMs < 250) {
    const factor = 250 / durationMs;
    for (const phase of timing) {
      phase.startMs *= factor; phase.endMs *= factor; phase.v0 /= factor; phase.v1 /= factor;
    }
    durationMs = 250;
  }
  return { durationMs, timing, ...(settings.uniformSpeed ? { uniformSpeed: true,
    cruiseSpeed: Math.max(...timing.map((phase) => Math.max(phase.v0, phase.v1))) * distance } : {}) };
}

export function samplePolylineProgress(segment, elapsedMs) {
  const elapsed = Math.max(0, Math.min(segment.durationMs, elapsedMs));
  if (elapsed <= 0) return 0;
  if (elapsed >= segment.durationMs) return 1;
  const phases = segment.timing;
  let lo = 0, hi = phases.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (elapsed < phases[mid].endMs) hi = mid; else lo = mid + 1;
  }
  const phase = phases[lo], duration = (phase.endMs - phase.startMs) / 1000;
  const t = Math.max(0, Math.min(1, (elapsed - phase.startMs) / (phase.endMs - phase.startMs)));
  // Integral of v0 + (v1-v0)(3t²-2t³): velocity and acceleration are
  // continuous at ramp/cruise boundaries, with zero acceleration at corners.
  return Math.max(phase.u0, Math.min(phase.u1, phase.u0 + duration
    * (phase.v0 * t + (phase.v1 - phase.v0) * (t ** 3 - 0.5 * t ** 4))));
}
