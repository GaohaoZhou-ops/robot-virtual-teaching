import { Matrix4, Vector3 } from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

const cache = new WeakMap();

// A convex hull still encloses the entire collision mesh (including its
// interior), but removes the empty corners of a single bounding box.
export function serializeCollisionHull(geometry) {
  const position = geometry?.getAttribute('position');
  if (!position || position.itemSize < 3 || position.count < 4) return null;
  const version = position.isInterleavedBufferAttribute ? position.data.version : position.version;
  const previous = cache.get(geometry);
  if (previous?.position === position && previous.version === version) return previous.hull;
  let result = null;
  try {
    const points = [], seen = new Set();
    for (let i = 0; i < position.count; i += 1) {
      const point = new Vector3().fromBufferAttribute(position, i);
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('Invalid collision vertex');
      const key = `${point.x},${point.y},${point.z}`;
      if (!seen.has(key)) { seen.add(key); points.push(point); }
    }
    const hull = new ConvexHull().setFromPoints(points);
    if (hull.faces.length >= 4) {
      const vertices = new Set(), planes = [], uniquePlanes = new Set();
      for (const face of hull.faces) {
        const plane = [...face.normal.toArray(), face.constant];
        if (!plane.every(Number.isFinite)) throw new Error('Invalid collision hull');
        // Omitting duplicate directions can only make separation harder to
        // establish. Keep the original, unrounded plane for the actual test.
        const key = plane.map((value) => value.toFixed(8)).join(',');
        if (!uniquePlanes.has(key)) { uniquePlanes.add(key); planes.push(...plane); }
        let edge = face.edge;
        do { vertices.add(edge.head().point); edge = edge.next; } while (edge !== face.edge);
      }
      result = { vertices: Float64Array.from([...vertices].flatMap((point) => point.toArray())),
        planes: Float64Array.from(planes), padding: Math.max(1e-7, hull.tolerance * 4) };
    }
  } catch {
    // Degenerate or malformed geometry keeps the original conservative box.
  }
  cache.set(geometry, { position, version, hull: result });
  return result;
}

// A separating face plane is a sufficient certificate of NO intersection.
// If none is found, retain the box collision; do not infer that arbitrary
// overlapping boxes are safe. This also preserves containment collisions.
export function collisionHullsSeparated(a, b, bToA) {
  if (!a?.vertices?.length || !a?.planes?.length || !b?.vertices?.length || !b?.planes?.length
    || !Number.isFinite(bToA.determinant()) || Math.abs(bToA.determinant()) < 1e-15) return false;
  const outsideFace = (hull, other, transform) => {
    const point = new Vector3(), transformed = new Float64Array(other.vertices.length);
    for (let i = 0; i < other.vertices.length; i += 3) {
      point.fromArray(other.vertices, i).applyMatrix4(transform).toArray(transformed, i);
    }
    const margin = (hull.padding || 1e-7) + (other.padding || 1e-7) * transform.getMaxScaleOnAxis();
    for (let i = 0; i < hull.planes.length; i += 4) {
      const [x, y, z, constant] = hull.planes.subarray(i, i + 4);
      let separated = true;
      for (let j = 0; j < transformed.length; j += 3) {
        const distance = x * transformed[j] + y * transformed[j + 1] + z * transformed[j + 2] - constant;
        if (!(distance > margin)) { separated = false; break; }
      }
      if (separated) return true;
    }
    return false;
  };
  return outsideFace(a, b, bToA) || outsideFace(b, a, new Matrix4().copy(bToA).invert());
}
