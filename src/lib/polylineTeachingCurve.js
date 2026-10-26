import { Vector3 } from 'three';
import { sampleSpatialCurve } from './polylineTeachingSpatialCurve.js';

const vector = (value) => new Vector3().fromArray(value);
const pointOnPart = (part, t) => part.control
  ? vector(part.from).multiplyScalar((1 - t) ** 2).addScaledVector(vector(part.control), 2 * t * (1 - t)).addScaledVector(vector(part.to), t ** 2)
  : vector(part.from).lerp(vector(part.to), t);

function measurePart(part) {
  if (!part.control) return { ...part, length: vector(part.from).distanceTo(vector(part.to)), curvature: 0 };
  const arc = [[0, 0]];
  let previous = vector(part.from), length = 0;
  for (let i = 1; i <= 256; i += 1) {
    const point = pointOnPart(part, i / 256); length += previous.distanceTo(point);
    arc.push([i / 256, length]); previous = point;
  }
  // Symmetric quadratic fillets have their greatest curvature at t = 1/2.
  const velocity = vector(part.to).sub(vector(part.from));
  const acceleration = vector(part.from).add(vector(part.to)).addScaledVector(vector(part.control), -2).multiplyScalar(2);
  const curvature = velocity.clone().cross(acceleration).length() / velocity.length() ** 3;
  return { ...part, length, arc, curvature };
}

function parameterAtDistance(part, distance) {
  if (!part.arc) return Math.max(0, Math.min(1, distance / part.length));
  let lo = 0, hi = part.arc.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (part.arc[mid][1] > distance) hi = mid; else lo = mid; }
  const a = part.arc[lo], b = part.arc[hi];
  return a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, (distance - a[1]) / (b[1] - a[1])));
}

// Serializable arc-length geometry, also used by playback and progress colors.
// Half the position tolerance is reserved for corner blending; IK/interpolation
// receives a separate budget. Authored vertices and their indices are retained.
export function buildPolylineDrawingEdges(vertices, settings) {
  const source = vertices.map((point) => point.toArray()), cumulative = [0];
  const edges = vertices.slice(1).map((to, index) => {
    const from = vertices[index], length = from.distanceTo(to);
    if (!Number.isFinite(length)) throw new Error('路线过长，请拆成多条折线后分别检查');
    cumulative.push(cumulative.at(-1) + length);
    return { from, to, length, index, direction: to.clone().sub(from).normalize() };
  }).filter((edge) => edge.length > 1e-9);
  const budget = settings.tolerance * .5;
  const corners = edges.slice(1).map((after, i) => {
    const before = edges[i], dot = Math.max(-1, Math.min(1, before.direction.dot(after.direction)));
    // A near-reversal requires a real stop instead of a vanishing-radius loop.
    if (dot < -.995) return { stop: true };
    if (dot > 1 - 1e-10) return null;
    const trim = Math.min(2 * budget / Math.sqrt((1 - dot) / 2), before.length * .45, after.length * .45);
    return { trim, part: {
      from: before.to.clone().addScaledVector(before.direction, -trim).toArray(), control: before.to.toArray(),
      to: after.from.clone().addScaledVector(after.direction, trim).toArray(),
      beforeIndex: before.index, afterIndex: after.index,
      beforeFraction: 1 - trim / before.length, afterFraction: trim / after.length,
    } };
  });
  const result = [];
  let parts = [];
  const flush = () => {
    if (!parts.length) return;
    let length = 0;
    const measured = parts.map((part) => {
      const value = measurePart(part), startS = length; length += value.length;
      return { ...value, startS, endS: length };
    });
    const curve = { parts: measured, length, vertices: source, cumulative, blendTolerance: budget,
      curvature: Math.max(...measured.map((part) => part.curvature)), roundedCorners: measured.filter((part) => part.control).length };
    const knots = [0];
    let sampleCount = 0;
    for (const part of measured) {
      const count = Math.max(part.control ? 32 : 1, Math.ceil(part.length / settings.step));
      sampleCount += count;
      for (let i = 1; i <= count && knots.length <= 30000; i += 1) knots.push((part.startS + part.length * i / count) / length);
    }
    if (sampleCount < knots.length) knots[knots.length - 1] = 1;
    result.push({ from: vector(measured[0].from), to: vector(measured.at(-1).to),
      index: measured[0].index, distance: length, curve, knots, sampleCount });
    parts = [];
  };
  edges.forEach((edge, i) => {
    const before = corners[i - 1], after = corners[i];
    const fromFraction = (before?.trim || 0) / edge.length, toFraction = 1 - (after?.trim || 0) / edge.length;
    parts.push({ from: edge.from.clone().lerp(edge.to, fromFraction).toArray(),
      to: edge.from.clone().lerp(edge.to, toFraction).toArray(), index: edge.index, fromFraction, toFraction });
    if (after?.part) parts.push(after.part);
    if (after?.stop) flush();
  });
  flush(); return result;
}

export function samplePolylineCurve(curve, progress) {
  if (curve.kind === 'spatial') return sampleSpatialCurve(curve, progress);
  const distance = Math.max(0, Math.min(1, progress)) * curve.length;
  let lo = 0, hi = curve.parts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (distance < curve.parts[mid].endS) hi = mid; else lo = mid + 1; }
  const part = curve.parts[lo], t = parameterAtDistance(part, distance - part.startS);
  const segmentIndex = !part.control ? part.index : t < .5 ? part.beforeIndex : part.afterIndex;
  const segmentProgress = !part.control ? part.fromFraction + (part.toFraction - part.fromFraction) * t
    : t < .5 ? part.beforeFraction + (1 - part.beforeFraction) * t * 2 : part.afterFraction * (t * 2 - 1);
  const sourcePosition = vector(curve.vertices[segmentIndex]).lerp(vector(curve.vertices[segmentIndex + 1]), segmentProgress);
  const sourceDistance = curve.cumulative[segmentIndex]
    + (curve.cumulative[segmentIndex + 1] - curve.cumulative[segmentIndex]) * segmentProgress;
  return { target: pointOnPart(part, t), segmentIndex, segmentProgress, sourcePosition, sourceDistance };
}
