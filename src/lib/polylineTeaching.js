import { Matrix4, Quaternion, Vector3 } from 'three';
import { samplePolylineProgress } from './polylineTeachingTiming.js';
import { samplePolylineCurve } from './polylineTeachingCurve.js';
import { spatialCurveGeometry, spatialCurveVertices, spatialCurveBoundsPoints } from './polylineTeachingSpatialCurve.js';
import { POLYLINE_ALGORITHM_DEFAULTS, POLYLINE_ALGORITHM_FIELDS } from './polylineTeachingParameters.js';

export const POLYLINE_MAX_SPEED = 0.3;
export const POLYLINE_DEFAULTS = Object.freeze({ speed: 0.3, uniformSpeed: true, perpendicularTool: false, ...POLYLINE_ALGORITHM_DEFAULTS });
export const POLYLINE_MAX_POINTS = 500;
export const POLYLINE_BASE_DEFAULTS = Object.freeze({ sync: false, search: false, allowPartial: false, waistAssist: false, range: 2, yawRange: 180 });
const finiteVector = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);

// Only authoring data is persisted. A computed trajectory must be checked again
// against the current robot, limits, start posture and environment on reopening.
export function normalizePolyline(value) {
  if (!value || !Array.isArray(value.points) || value.points.length > POLYLINE_MAX_POINTS) return null;
  if (value.pathType != null && !['polyline', 'spline'].includes(value.pathType)) return null;
  if (!value.points.every((point) => finiteVector(point.position, 3))) return null;
  const quaternion = finiteVector(value.quaternion, 4) ? new Quaternion().fromArray(value.quaternion) : null;
  if (quaternion && quaternion.lengthSq() < 1e-12) return null;
  const tcpOffset = value.tcpOffset ?? [0, 0, 0];
  if (!finiteVector(tcpOffset, 3) || tcpOffset.some((value) => Math.abs(value) > 1)) return null;
  const settings = { uniformSpeed: value.settings?.uniformSpeed !== false, perpendicularTool: value.settings?.perpendicularTool === true };
  const base = { sync: Boolean(value.base?.sync), search: Boolean(value.base?.search),
    allowPartial: value.base?.allowPartial === true,
    waistAssist: value.base?.waistAssist === true,
    range: Number(value.base?.range ?? POLYLINE_BASE_DEFAULTS.range),
    yawRange: Number(value.base?.yawRange ?? POLYLINE_BASE_DEFAULTS.yawRange) };
  if (!Number.isFinite(base.range) || base.range < 0.05 || base.range > 10
    || !Number.isFinite(base.yawRange) || base.yawRange < 0 || base.yawRange > 180) return null;
  for (const { key, min: low, max: high, integer } of [{ key: 'speed', min: .001, max: POLYLINE_MAX_SPEED }, ...POLYLINE_ALGORITHM_FIELDS]) {
    const number = Number(value.settings?.[key] ?? POLYLINE_DEFAULTS[key]);
    if (!Number.isFinite(number) || number < low || number > high || (integer && !Number.isInteger(number))) return null;
    settings[key] = number;
  }
  const pathType = value.pathType === 'spline' ? 'spline' : 'polyline';
  return { id: String(value.id || ''), name: String(value.name || (pathType === 'spline' ? '空间曲线' : '表面折线')),
    version: pathType === 'spline' ? 2 : 1, pathType,
    side: value.side === 'right' ? 'right' : 'left', closed: Boolean(value.closed),
    tcpOffset: [...tcpOffset],
    // The sign of Z is authoritative for old records; retain the selected
    // direction explicitly when the distance is zero.
    toolAxisDirection: Math.sign(tcpOffset[2]) || (value.toolAxisDirection === 1 ? 1 : -1),
    // Retain the archive field, but all offsets are now explicit tool-local
    // settings. Old camera-mode records keep their exact saved offset.
    toolAxisMode: 'manual',
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

export const polylineGeometryVertices = (value) => value.pathType === 'spline' ? spatialCurveVertices(value) : polylineVertices(value);
export const polylineBoundsPoints = (value) => value.pathType === 'spline' ? spatialCurveBoundsPoints(value) : polylineVertices(value);

// Measure authored spans by length, including the closing span and spline arcs.
// Approach/return motion contributes nothing, and a partial plan still uses
// the full requested line as its denominator. Rounded paths retain edge progress.
export function polylineDrawingProgress(path, playback = null) {
  const vertices = polylineVertices(path);
  const cumulative = path.pathType === 'spline' ? spatialCurveGeometry(path).cumulative : null;
  let total = 0, completed = 0;
  for (let i = 1; i < vertices.length; i += 1) {
    const length = cumulative ? cumulative[i] - cumulative[i - 1] : vertices[i].distanceTo(vertices[i - 1]);
    total += length;
    if (playback?.drawing) completed += length * (i - 1 < playback.segmentIndex ? 1
      : i - 1 === playback.segmentIndex ? Math.max(0, Math.min(1, playback.segmentProgress)) : 0);
  }
  return { total, completed, fraction: total > 0 ? Math.min(1, completed / total) : 0 };
}

export function isPolylinePlanExecutable(plan) {
  return Boolean((plan?.complete || (plan?.partial && plan?.executable))
    && plan.segments?.some((segment) => segment.index >= 0 && !segment.rotationOnly)
    && Number.isFinite(plan.durationMs) && plan.durationMs > 0);
}

// Explicit virtual placement at a searched starting pose. Keep the checked
// drawing samples, timing and ORIGINAL base reference: rebasing those offsets
// to the selected parking pose would translate the robot a second time.
export function polylinePlanFromSearchPosition(plan) {
  if (!isPolylinePlanExecutable(plan) || !(plan.baseSearch?.feasible > 0)
    || !finiteVector(plan.baseReference?.position, 3) || !finiteVector(plan.baseReference?.quaternion, 4)) return null;
  const drawing = plan.segments.slice(plan.segments.findIndex(segment => segment.index >= 0));
  const first = drawing[0]?.samples?.[0];
  if (!first?.joints || !first.base || !['x', 'y', 'yaw'].every(axis => Number.isFinite(first.base[axis]))
    || drawing.some(segment => segment.index < 0 || segment.reverse)) return null;
  let durationMs = 0;
  const segments = drawing.map(segment => {
    const startMs = durationMs; durationMs += segment.durationMs;
    return { ...segment, startMs, endMs: durationMs };
  });
  return { ...plan, initialJoints: { ...first.joints }, segments, durationMs };
}

// Reuse the checked poses and timing after a completed run. Return along the
// same drawing trajectory in reverse, without marking it, then draw forward.
// No new IK, shortcut through space or jump back to the original pose.
export function repeatPolylinePlan(plan) {
  if (!isPolylinePlanExecutable(plan)) return null;
  const drawing = plan.segments.filter((segment) => segment.index >= 0);
  const first = drawing[0].samples[0], last = drawing.at(-1).samples.at(-1);
  const equalValues = (a = {}, b = {}) => Object.keys({ ...a, ...b }).every((key) => Math.abs(a[key] - b[key]) < 1e-9);
  const atStart = equalValues(first.joints, last.joints) && equalValues(first.base, last.base);
  const returning = atStart ? [] : [...drawing].reverse().map((segment) => ({ ...segment, index: -1, phase: 'returning', reverse: true }));
  let durationMs = 0;
  const segments = [...returning, ...drawing].map((segment) => {
    const startMs = durationMs; durationMs += segment.durationMs;
    return { ...segment, startMs, endMs: durationMs };
  });
  return { ...plan, initialJoints: last.joints, segments, durationMs };
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
  const localElapsed = segment.reverse ? segment.durationMs - (elapsed - segment.startMs) : elapsed - segment.startMs;
  const timedProgress = segment.timing ? samplePolylineProgress(segment, localElapsed)
    : smoothProgress(localElapsed / segment.durationMs);
  const progress = segment.arcMapping ? samplePolylineJoints(segment.arcMapping.samples, timedProgress).pathU : timedProgress;
  const state = samplePolylineState(segment.samples, progress);
  const curve = segment.curve ? samplePolylineCurve(segment.curve, progress * (segment.endFraction ?? 1)) : null;
  return { ...state, ...(state.base ? { basePose: polylineBasePose(plan.baseReference, state.base) } : {}),
    phase: segment.phase || (segment.index < 0 ? 'approach' : 'drawing'), segmentIndex: curve?.segmentIndex ?? segment.index,
    segmentProgress: segment.rotationOnly ? 0 : curve?.segmentProgress ?? progress * (segment.endFraction ?? 1),
    drawing: segment.index >= 0, done: elapsed >= plan.durationMs,
    target: curve ? curve.target.toArray() : new Vector3().fromArray(segment.from).lerp(new Vector3().fromArray(segment.to), progress).toArray() };
}

// Snapshot each authored edge at its exact playback boundary. A rounded block
// can contain many edges, and a display frame can skip a short edge entirely.
// Sampling the checked interpolation avoids capturing a late animation frame
// or doing new IK. Return/approach legs are deliberately excluded.
export function polylineSegmentStartPoses(plan, fixedBasePose) {
  if (!isPolylinePlanExecutable(plan)) return [];
  const poses = [];
  for (const segment of plan.segments.filter((part) => part.index >= 0)) {
    const local = { ...plan, segments: [segment], durationMs: segment.endMs };
    const first = samplePolylinePlan(local, segment.startMs), last = samplePolylinePlan(local, segment.endMs);
    for (let index = first.segmentIndex; index <= last.segmentIndex; index += 1) {
      let low = segment.startMs, high = segment.endMs;
      if (index === first.segmentIndex) high = low;
      else for (let i = 0; i < 42; i += 1) {
        const mid = (low + high) / 2;
        if (samplePolylinePlan(local, mid).segmentIndex < index) low = mid; else high = mid;
      }
      const sample = samplePolylinePlan(local, high);
      if (sample.segmentIndex !== index || (index === last.segmentIndex && last.segmentProgress <= 0)) continue;
      poses.push({ segmentIndex: index, startMs: high, joints: { ...sample.joints },
        basePose: structuredClone(sample.basePose || fixedBasePose), target: [...sample.target] });
    }
  }
  return poses;
}
