import { Vector3 } from 'three';
import { preparePolylineInterpolation, samplePolylineState } from "./polylineTeaching.js";

// Parameterize the already checked joint curve by actual TCP arc length.
// Changing only traversal speed preserves every checked pose, including base
// motion and collisions. The inverse is C1, so joint velocity stays continuous.
export async function preparePolylineArcMapping(samples, applyState, frame, checkpoint) {
  const table = [{ pathU: 0, distance: 0 }];
  let previous = null, length = 0, curvature = 0;
  const points = [];
  applyState(samples[0]); previous = frame.getWorldPosition(new Vector3()); points.push(previous);
  const positionAt = (u) => { applyState(samplePolylineState(samples, u)); return frame.getWorldPosition(new Vector3()); };
  const append = (pathU, point) => {
    const distance = point.distanceTo(previous);
    // A truly stationary span cannot be traversed at a positive TCP speed.
    // Do not manufacture elapsed time or silently introduce a dwell.
    if (distance < 1e-12) throw new Error('匀速划线存在末端停滞，请调整姿态或取消“匀速划线”后重新检查');
    if (table.length > 240000) throw new Error('匀速轨迹过于复杂，请拆分折线或调整起始姿态后重新检查');
    length += distance; table.push({ pathU, distance: length });
    if (points.length > 1) {
      const a = previous.clone().sub(points[0]), b = point.clone().sub(previous), chord = point.distanceTo(points[0]);
      if (chord > 1e-12) curvature = Math.max(curvature, 2 * a.cross(b).length() / (previous.distanceTo(points[0]) * distance * chord));
    }
    points.push(point); if (points.length > 2) points.shift(); previous = point;
  };
  const refine = (a, b, from, to, depth = 0) => {
    const midU = (a + b) / 2, mid = positionAt(midU);
    const left = from.distanceTo(mid), right = mid.distanceTo(to), sum = left + right;
    // Resolve both geometric bending and rapid changes in du/ds, including
    // the low-speed portions of nearly singular joint interpolation.
    // Near a zero derivative, repeated bisection eventually resolves floating
    // point noise rather than motion. A nanometre is already far below every
    // supported path tolerance; genuine stationary intervals still fail above.
    if (depth < 12 && sum > 1e-9 && (Math.max(left, right) > 1.02 * Math.min(left, right)
      || sum - from.distanceTo(to) > Math.max(1e-11, sum * 1e-6))) {
      refine(a, midU, from, mid, depth + 1); refine(midU, b, mid, to, depth + 1);
    } else { append(midU, mid); append(b, to); }
  };
  for (let i = 0; i < samples.length - 1; i += 1) {
    await checkpoint();
    for (let j = 1; j <= 8; j += 1) {
      const u = samples[i].u + (samples[i + 1].u - samples[i].u) * j / 8;
      refine(table.at(-1).pathU, u, previous, positionAt(u));
    }
  }
  const inverse = preparePolylineInterpolation(table.map((point) => ({ u: point.distance / length, joints: { pathU: point.pathU } })));
  applyState(samples.at(-1));
  return { samples: inverse, length, curvature };
}
