import { CatmullRomCurve3, Line3, Vector3 } from 'three';

const cache = new WeakMap();
const vector = (value) => new Vector3().fromArray(value);
const EPSILON = 1e-8;

export function spatialPartPoint(part, t) {
  const a = vector(part.from), b = vector(part.controls[0]), c = vector(part.controls[1]), d = vector(part.to);
  // De Casteljau also remains stable for maps far from the coordinate origin.
  a.lerp(b, t); b.lerp(c, t); c.lerp(d, t);
  a.lerp(b, t); b.lerp(c, t);
  return a.lerp(b, t);
}

function curvatureAt(part, t) {
  const a = vector(part.from), b = vector(part.controls[0]), c = vector(part.controls[1]), d = vector(part.to);
  const velocity = b.clone().sub(a).multiplyScalar(3 * (1 - t) ** 2)
    .addScaledVector(c.clone().sub(b), 6 * (1 - t) * t).addScaledVector(d.clone().sub(c), 3 * t * t);
  const acceleration = c.clone().add(a).addScaledVector(b, -2).multiplyScalar(6 * (1 - t))
    .addScaledVector(d.clone().add(b).addScaledVector(c, -2), 6 * t);
  const speed = velocity.length();
  return speed > 1e-12 ? velocity.cross(acceleration).length() / speed ** 3 : 0;
}

function measurePart(part, settings, budget) {
  const arc = [[0, 0]], step = settings.step ?? .004;
  const tolerance = Math.min((settings.tolerance ?? .001) * .1, .00005);
  let length = 0, curvature = 0;
  const append = (a, b, ta, tb) => {
    length += a.distanceTo(b);
    arc.push([tb, length]); budget.count += 1;
    curvature = Math.max(curvature, curvatureAt(part, ta), curvatureAt(part, (ta + tb) / 2), curvatureAt(part, tb));
  };
  const subdivide = (a, b, c, d, ta, tb, depth = 0) => {
    const chord = new Line3(a, d);
    const error = Math.max(chord.closestPointToPoint(b, true, new Vector3()).distanceTo(b),
      chord.closestPointToPoint(c, true, new Vector3()).distanceTo(c));
    const needsSplit = depth < 3 || a.distanceTo(d) > step || error > tolerance;
    if (!needsSplit || depth >= 18 || budget.count >= 30000) {
      if (needsSplit) budget.limited = true;
      append(a, d, ta, tb); return;
    }
    const ab = a.clone().lerp(b, .5), bc = b.clone().lerp(c, .5), cd = c.clone().lerp(d, .5);
    const abc = ab.clone().lerp(bc, .5), bcd = bc.clone().lerp(cd, .5), mid = abc.clone().lerp(bcd, .5);
    const tm = (ta + tb) / 2;
    subdivide(a, ab, abc, mid, ta, tm, depth + 1);
    subdivide(mid, bcd, cd, d, tm, tb, depth + 1);
  };
  subdivide(vector(part.from), vector(part.controls[0]), vector(part.controls[1]), vector(part.to), 0, 1);
  return { ...part, arc, length, curvature };
}

// Authoring points stay intact. Consecutive coincident points have zero length
// and no extra stop/loop; original point indices still identify editable spans.
// The cached, plain-data geometry is shared by preview, planning and progress.
export function spatialCurveGeometry(path) {
  if (cache.has(path)) return cache.get(path);
  const nodes = [];
  path.points.forEach((point, index) => {
    const position = vector(point.position);
    if (!nodes.length || position.distanceTo(nodes.at(-1).position) > EPSILON) nodes.push({ position, index });
  });
  const closed = Boolean(path.closed && path.points.length > 2);
  let closingIndex = path.points.length - 1;
  if (closed && nodes.length > 1 && nodes[0].position.distanceTo(nodes.at(-1).position) <= EPSILON) {
    closingIndex = nodes.pop().index - 1;
  }
  const parts = [], budget = { count: 0, limited: false };
  const count = nodes.length < 2 ? 0 : nodes.length - Number(!closed);
  const curve = new CatmullRomCurve3(nodes.map((node) => node.position), closed, 'centripetal');
  let length = 0;
  for (let i = 0; i < count; i += 1) {
    const from = nodes[i].position, to = nodes[(i + 1) % nodes.length].position;
    const index = i === nodes.length - 1 ? closingIndex : nodes[i + 1].index - 1;
    let controlA = from.clone().lerp(to, 1 / 3), controlB = from.clone().lerp(to, 2 / 3);
    if (nodes.length > 2) {
      // Recover exact cubic Bezier coefficients from the installed Three.js
      // centripetal interpolant. Workers receive arrays, never class instances.
      const u = curve.getPoint((i + 1 / 3) / count).sub(controlA);
      const v = curve.getPoint((i + 2 / 3) / count).sub(controlB);
      controlA.addScaledVector(u, 3).addScaledVector(v, -1.5);
      controlB.addScaledVector(v, 3).addScaledVector(u, -1.5);
    }
    const part = measurePart({ index, from: from.toArray(), to: to.toArray(),
      controls: [controlA.toArray(), controlB.toArray()] }, path.settings || {}, budget);
    part.startS = length; length += part.length; part.endS = length;
    // A genuine reversal/zero tangent is a stopping boundary, not a tiny loop
    // traversed at a positive speed. Ordinary knots remain continuous.
    const next = nodes[(i + 2) % nodes.length]?.position;
    part.stopAfter = (closed || i < count - 1) && (to.distanceTo(controlB) < EPSILON
      || to.clone().sub(from).normalize().dot(next.clone().sub(to).normalize()) < -.995);
    parts.push(part);
  }
  const cumulative = [0], lengths = new Map(parts.map((part) => [part.index, part.length]));
  for (let i = 0; i < Math.max(0, path.points.length - Number(!closed)); i += 1) cumulative.push(cumulative.at(-1) + (lengths.get(i) || 0));
  const result = { kind: 'spatial', parts, length, cumulative, sourceOffset: 0,
    curvature: Math.max(0, ...parts.map((part) => part.curvature)), limited: budget.limited };
  cache.set(path, result);
  return result;
}

export function sampleSpatialPart(part, fraction) {
  const s = Math.max(0, Math.min(1, fraction)) * part.length;
  let lo = 0, hi = part.arc.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (part.arc[mid][1] > s) hi = mid; else lo = mid; }
  const a = part.arc[lo], b = part.arc[hi];
  const t = a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, (s - a[1]) / (b[1] - a[1] || 1)));
  return spatialPartPoint(part, t);
}

export function sampleSpatialCurve(curve, progress) {
  const distance = Math.max(0, Math.min(1, progress)) * curve.length;
  let lo = 0, hi = curve.parts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (distance < curve.parts[mid].endS) hi = mid; else lo = mid + 1; }
  const part = curve.parts[lo], segmentProgress = Math.max(0, Math.min(1, (distance - part.startS) / part.length));
  const target = sampleSpatialPart(part, segmentProgress);
  return { target, sourcePosition: target, sourceDistance: (curve.sourceOffset || 0) + distance,
    segmentIndex: part.index, segmentProgress };
}

export function spatialCurveDrawingEdges(path) {
  const geometry = spatialCurveGeometry(path);
  if (geometry.limited) throw new Error('空间曲线的细分数量超过预算，请拆分路线或减少密集点后重新检查');
  const result = [];
  let parts = [];
  const flush = () => {
    if (!parts.length) return;
    const sourceOffset = parts[0].startS, length = parts.at(-1).endS - sourceOffset;
    const localParts = parts.map((part) => ({ ...part, startS: part.startS - sourceOffset, endS: part.endS - sourceOffset }));
    const knots = [0];
    for (const part of localParts) for (const [, s] of part.arc.slice(1)) knots.push((part.startS + s) / length);
    knots[knots.length - 1] = 1;
    result.push({ index: parts[0].index, from: vector(parts[0].from), to: vector(parts.at(-1).to), distance: length,
      curve: { kind: 'spatial', parts: localParts, length, sourceOffset,
        curvature: Math.max(...parts.map((part) => part.curvature)) }, knots, sampleCount: knots.length - 1 });
    parts = [];
  };
  for (const part of geometry.parts) { parts.push(part); if (part.stopAfter) flush(); }
  flush(); return result;
}

export function spatialCurveVertices(path) {
  const geometry = spatialCurveGeometry(path);
  return geometry.parts.flatMap((part, index) => part.arc.slice(index ? 1 : 0).map(([t]) => spatialPartPoint(part, t)));
}

// Exact component extrema prevent a bowed curve from leaving a cropped
// workspace even when every authored point is inside its bounds.
export function spatialCurveBoundsPoints(path) {
  const parts = spatialCurveGeometry(path).parts;
  if (!parts.length) return path.points.map((point) => vector(point.position));
  return parts.flatMap((part) => {
    const times = new Set([0, 1]);
    for (let axis = 0; axis < 3; axis += 1) {
      const a = part.controls[0][axis] - part.from[axis], b = part.controls[1][axis] - part.controls[0][axis], c = part.to[axis] - part.controls[1][axis];
      const A = a - 2 * b + c, B = 2 * (b - a), C = a;
      const roots = Math.abs(A) < 1e-15 ? (Math.abs(B) < 1e-15 ? [] : [-C / B])
        : B * B - 4 * A * C < 0 ? [] : [(-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A), (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A)];
      roots.filter((t) => t > 0 && t < 1).forEach((t) => times.add(t));
    }
    return [...times].map((t) => spatialPartPoint(part, t));
  });
}
