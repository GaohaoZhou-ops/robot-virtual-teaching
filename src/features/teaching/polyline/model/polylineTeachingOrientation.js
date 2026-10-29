import { Quaternion, Vector3 } from 'three';
import { buildPolylineDrawingEdges, samplePolylineCurve } from "./polylineTeachingCurve.js";
import { spatialCurveDrawingEdges } from "./polylineTeachingSpatialCurve.js";

const vector = (value) => new Vector3().fromArray(value);
const pointVector = (value) => value.isVector3 ? value.clone() : vector(value);
const axisZ = (quaternion) => new Vector3(0, 0, 1).applyQuaternion(quaternion);
const MAX_TURN = Math.PI / 90;

export const polylineEdgeTarget = (edge, u) => edge.curve
  ? samplePolylineCurve(edge.curve, u).target : pointVector(edge.from).lerp(pointVector(edge.to), u);
export const polylineEdgeTangent = (edge, u) => edge.curve
  ? samplePolylineCurve(edge.curve, u).tangent : pointVector(edge.to).sub(pointVector(edge.from)).normalize();

// A line has an entire plane of perpendicular directions. Start with the
// closest direction to the user's tool Z, preserving its roll where possible.
// +/-Z describe the same perpendicularity constraint, including zero offsets.
export function perpendicularToolQuaternion(reference, tangent) {
  const z = axisZ(reference);
  let normal = z.clone().addScaledVector(tangent, -z.dot(tangent));
  if (normal.lengthSq() < 1e-12) {
    normal = new Vector3(1, 0, 0).applyQuaternion(reference);
    normal.addScaledVector(tangent, -normal.dot(tangent));
  }
  return new Quaternion().setFromUnitVectors(z, normal.normalize()).multiply(reference).normalize();
}

// Transport the perpendicular axis between nearby tangents. Rotate the tool
// only as much as its axis needs; a planar curve with an already perpendicular
// tool does not introduce an unnecessary spin around that tool's own axis.
function transport(reference, from, to) {
  const z = axisZ(reference);
  if (from.dot(to) < -.995) return perpendicularToolQuaternion(reference, to);
  const normal = z.clone().applyQuaternion(new Quaternion().setFromUnitVectors(from, to));
  return new Quaternion().setFromUnitVectors(z, normal.normalize()).multiply(reference).normalize();
}

export function samplePolylineOrientation(edge, u, fallback = new Quaternion()) {
  if (!edge.orientation) return fallback.clone();
  if (edge.orientation.from) return new Quaternion().fromArray(edge.orientation.from)
    .slerp(new Quaternion().fromArray(edge.orientation.to), Math.max(0, Math.min(1, u)));
  const samples = edge.orientation.samples;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (samples[mid].u > u) hi = mid; else lo = mid; }
  const sample = u >= 1 ? samples.at(-1) : samples[lo];
  return transport(new Quaternion().fromArray(sample.quaternion), vector(sample.tangent), polylineEdgeTangent(edge, u));
}

export function polylineDrawingEdges(path, reference = new Quaternion().fromArray(path.quaternion || [0, 0, 0, 1])) {
  const vertices = path.points.map((point) => vector(point.position));
  if (path.closed && vertices.length > 2) vertices.push(vertices[0].clone());
  const edges = (path.pathType === 'spline' ? spatialCurveDrawingEdges(path)
    : path.settings.uniformSpeed ? buildPolylineDrawingEdges(vertices, path.settings)
      : vertices.slice(1).map((to, index) => ({ from: vertices[index], to, index })))
    .filter((edge) => (edge.distance ?? edge.from.distanceTo(edge.to)) > 1e-9);
  if (!path.settings.perpendicularTool) return edges;
  let previous = reference.clone();
  for (const edge of edges) {
    const count = edge.sampleCount ?? Math.max(1, Math.ceil(edge.from.distanceTo(edge.to) / path.settings.step));
    if (count > 30000) throw new Error('垂直姿态采样超过预算，请拆分路线后重新检查');
    const source = edge.knots || Array.from({ length: count + 1 }, (_, i) => i / count);
    const knots = [0];
    const refine = (a, b, ta, tb, depth = 0) => {
      const mid = (a + b) / 2, tm = polylineEdgeTangent(edge, mid);
      if (Math.max(ta.angleTo(tb), ta.angleTo(tm), tm.angleTo(tb)) > MAX_TURN) {
        if (depth >= 18 || knots.length >= 30000) throw new Error('路线方向变化过快，无法连续跟随垂直姿态，请调整或拆分路线');
        refine(a, mid, ta, tm, depth + 1); refine(mid, b, tm, tb, depth + 1);
      } else knots.push(b);
    };
    for (let i = 1; i < source.length; i += 1) {
      if (knots.length >= 30000) throw new Error('垂直姿态采样超过预算，请拆分路线后重新检查');
      refine(source[i - 1], source[i], polylineEdgeTangent(edge, source[i - 1]), polylineEdgeTangent(edge, source[i]));
    }
    let tangent = polylineEdgeTangent(edge, 0);
    previous = perpendicularToolQuaternion(previous, tangent);
    const samples = [{ u: 0, tangent: tangent.toArray(), quaternion: previous.toArray() }];
    for (const u of knots.slice(1)) {
      const next = polylineEdgeTangent(edge, u);
      previous = transport(previous, tangent, next); tangent = next;
      samples.push({ u, tangent: tangent.toArray(), quaternion: previous.toArray() });
    }
    edge.orientation = { samples }; edge.knots = knots; edge.sampleCount = knots.length - 1;
  }
  return edges;
}

export function polylineStartQuaternion(path, reference = new Quaternion().fromArray(path.quaternion || [0, 0, 0, 1])) {
  const first = polylineDrawingEdges(path, reference)[0];
  return first ? samplePolylineOrientation(first, 0, reference) : reference.clone();
}
