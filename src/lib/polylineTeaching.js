import { Matrix4, Quaternion, Vector3 } from 'three';
import { samplePolylineProgress } from './polylineTeachingTiming.js';

export const POLYLINE_DEFAULTS = Object.freeze({ speed: 0.05, acceleration: 0.2,
  step: 0.004, tolerance: 0.001, rotationTolerance: 0.5 });
export const POLYLINE_MAX_POINTS = 500;
export const POLYLINE_BASE_DEFAULTS = Object.freeze({ sync: false, search: false, allowPartial: false, range: 2, yawRange: 180 });
const finiteVector = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);

// Only authoring data is persisted. A computed trajectory must be checked again
// against the current robot, limits, start posture and environment on reopening.
export function normalizePolyline(value) {
  if (!value || !Array.isArray(value.points) || value.points.length > POLYLINE_MAX_POINTS) return null;
  if (!value.points.every((point) => finiteVector(point.position, 3))) return null;
  const quaternion = finiteVector(value.quaternion, 4) ? new Quaternion().fromArray(value.quaternion) : null;
  if (quaternion && quaternion.lengthSq() < 1e-12) return null;
  const tcpOffset = value.tcpOffset ?? [0, 0, 0];
  if (!finiteVector(tcpOffset, 3) || tcpOffset.some((value) => Math.abs(value) > 1)) return null;
  const settings = {};
  const base = { sync: Boolean(value.base?.sync), search: Boolean(value.base?.search),
    allowPartial: value.base?.allowPartial === true,
    range: Number(value.base?.range ?? POLYLINE_BASE_DEFAULTS.range),
    yawRange: Number(value.base?.yawRange ?? POLYLINE_BASE_DEFAULTS.yawRange) };
  if (!Number.isFinite(base.range) || base.range < 0.05 || base.range > 10
    || !Number.isFinite(base.yawRange) || base.yawRange < 0 || base.yawRange > 180) return null;
  for (const [key, low, high] of [['speed', 0.001, 0.2], ['acceleration', 0.01, 0.5],
    ['step', 0.0005, 0.01], ['tolerance', 0.0002, 0.003], ['rotationTolerance', 0.1, 1]]) {
    const number = Number(value.settings?.[key] ?? POLYLINE_DEFAULTS[key]);
    if (!Number.isFinite(number) || number < low || number > high) return null;
    settings[key] = number;
  }
  return { id: String(value.id || ''), name: String(value.name || '表面折线'), version: 1,
    side: value.side === 'right' ? 'right' : 'left', closed: Boolean(value.closed),
    tcpOffset: [...tcpOffset],
    // The sign of Z is authoritative for old records; retain the selected
    // direction explicitly when the distance is zero.
    toolAxisDirection: Math.sign(tcpOffset[2]) || (value.toolAxisDirection === 1 ? 1 : -1),
    points: value.points.map((point, index) => ({ id: String(point.id || `p${index}`),
      position: [...point.position], ...(finiteVector(point.normal, 3) ? { normal: [...point.normal] } : {}) })),
    quaternion: quaternion?.normalize().toArray() || null, settings, base,
    createdAt: String(value.createdAt || ''), updatedAt: String(value.updatedAt || '') };
}

export function readPolylineTcp(robot, path) {
  const frame = robot?.getObjectByName(`tool_${path.side}`);
  if (!frame) return null;
  frame.updateWorldMatrix(true, false);
  return new Vector3().fromArray(path.tcpOffset || [0, 0, 0]).applyMatrix4(frame.matrixWorld);
}

export function transformPolyline(value, matrix) {
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(matrix));
  return { ...value, points: value.points.map((point) => ({ ...point,
    position: new Vector3().fromArray(point.position).applyMatrix4(matrix).toArray(),
    ...(point.normal ? { normal: new Vector3().fromArray(point.normal).transformDirection(matrix).toArray() } : {}) })),
    quaternion: value.quaternion ? rotation.multiply(new Quaternion().fromArray(value.quaternion)).normalize().toArray() : null };
}

export function polylineVertices(value) {
  const points = value.points.map((point) => new Vector3().fromArray(point.position));
  return value.closed && points.length > 2 ? [...points, points[0].clone()] : points;
}

export function isPolylinePlanExecutable(plan) {
  return Boolean((plan?.complete || (plan?.partial && plan?.executable))
    && plan.segments?.some((segment) => segment.index >= 0)
    && Number.isFinite(plan.durationMs) && plan.durationMs > 0);
}

export const smoothProgress = (t) => { const u = Math.max(0, Math.min(1, t)); return u ** 3 * (10 - 15 * u + 6 * u * u); };

// Monotone Hermite interpolation keeps joint positions within the sampled
// bounds and makes joint velocity continuous across the internal IK samples.
export function preparePolylineInterpolation(samples, field = 'joints', tangentField = 'tangents') {
  const names = Object.keys(samples[0][field]);
  for (const sample of samples) sample[tangentField] = {};
  for (const name of names) {
    const slopes = samples.slice(1).map((sample, i) => (sample[field][name] - samples[i][field][name]) / (sample.u - samples[i].u));
    samples.forEach((sample, i) => {
      if (!i) sample[tangentField][name] = slopes[0];
      else if (i === samples.length - 1) sample[tangentField][name] = slopes.at(-1);
      else {
        const a = slopes[i - 1], b = slopes[i], h0 = sample.u - samples[i - 1].u, h1 = samples[i + 1].u - sample.u;
        sample[tangentField][name] = a * b <= 0 ? 0 : 3 * (h0 + h1) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b);
      }
    });
  }
  if (field === 'joints' && samples[0].base) preparePolylineInterpolation(samples, 'base', 'baseTangents');
  return samples;
}

export function samplePolylineJoints(samples, progress, field = 'joints', tangentField = 'tangents') {
  const u = Math.max(0, Math.min(1, progress));
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (samples[mid].u > u) hi = mid; else lo = mid; }
  const a = samples[lo], b = samples[hi], h = b.u - a.u, t = (u - a.u) / h;
  return Object.fromEntries(Object.keys(a[field]).map((name) => [name,
    (2 * t ** 3 - 3 * t * t + 1) * a[field][name] + (t ** 3 - 2 * t * t + t) * h * a[tangentField][name]
      + (-2 * t ** 3 + 3 * t * t) * b[field][name] + (t ** 3 - t * t) * h * b[tangentField][name]]));
}

export function samplePolylineState(samples, progress) {
  return { joints: samplePolylineJoints(samples, progress), ...(samples[0].base
    ? { base: samplePolylineJoints(samples, progress, 'base', 'baseTangents') } : {}) };
}

// X/Y are world-plane offsets and yaw is an unwrapped turn about world Z.
// Premultiplication retains support height and tilt, including on tilted bases.
export function polylineBasePose(reference, base) {
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), base.yaw * Math.PI / 180)
    .multiply(new Quaternion().fromArray(reference.quaternion));
  return { position: [reference.position[0] + base.x, reference.position[1] + base.y, reference.position[2]],
    quaternion: quaternion.toArray() };
}

export function samplePolylinePlan(plan, elapsedMs) {
  const elapsed = Math.max(0, Math.min(plan.durationMs, elapsedMs));
  const segment = plan.segments.find((item) => elapsed < item.endMs) || plan.segments.at(-1);
  const progress = segment.timing ? samplePolylineProgress(segment, elapsed - segment.startMs)
    : smoothProgress((elapsed - segment.startMs) / segment.durationMs);
  const state = samplePolylineState(segment.samples, progress);
  return { ...state, ...(state.base ? { basePose: polylineBasePose(plan.baseReference, state.base) } : {}),
    phase: segment.phase || (segment.index < 0 ? 'approach' : 'drawing'), segmentIndex: segment.index,
    segmentProgress: progress * (segment.endFraction ?? 1),
    drawing: segment.index >= 0, done: elapsed >= plan.durationMs,
    target: new Vector3().fromArray(segment.from).lerp(new Vector3().fromArray(segment.to), progress).toArray() };
}
