import { Line3, Vector3 } from 'three';
import { normalizePolyline, polylineGeometryVertices } from './polylineTeaching.js';

// Saved points are geometric hints, not trusted robot trajectories. Limit the
// worker payload and try both ends of up to four nearby, compatible strokes.
export function polylineApproachGuides(path, savedPaths, start) {
  const action = normalizePolyline(path);
  if (!action?.points.length || !start || action.base.sync || action.base.search) return [];
  const goal = new Vector3().fromArray(action.points[0].position), nearby = [];
  for (const value of savedPaths || []) {
    const saved = normalizePolyline(value);
    if (!saved || saved.points.length < 2 || saved.side !== action.side
      || saved.tcpOffset.some((offset, i) => Math.abs(offset - action.tcpOffset[i]) > 1e-6)) continue;
    const vertices = polylineGeometryVertices(saved);
    let nearest = null;
    for (let i = 0; i < vertices.length - 1; i += 1) {
      if (vertices[i].distanceToSquared(vertices[i + 1]) < 1e-12) continue;
      const point = new Line3(vertices[i], vertices[i + 1]).closestPointToPoint(goal, true, new Vector3());
      const distance = point.distanceTo(goal);
      if (!nearest || distance < nearest.distance) nearest = { index: i, point, distance };
    }
    if (nearest && nearest.distance <= .32) nearby.push({ saved, vertices, ...nearest });
  }
  nearby.sort((a, b) => a.distance - b.distance);
  const guides = [], seen = new Set();
  for (const entry of nearby.slice(0, 4)) {
    const { saved, vertices, index, point } = entry;
    for (const prefix of [vertices.slice(0, index + 1), vertices.slice(index + 1).reverse()]) {
      const route = [];
      for (const vertex of [...prefix, point]) {
        if (route.at(-1)?.distanceToSquared(vertex) < 1e-12) continue;
        // Remove only collinear intermediate points, preserving bends even in
        // dense saved strokes. The resulting approach is fully checked again.
        while (route.length >= 2) {
          const a = route.at(-2), b = route.at(-1);
          const line = new Line3(a, vertex);
          if (line.closestPointToPoint(b, true, new Vector3()).distanceToSquared(b) >= 1e-12) break;
          route.pop();
        }
        route.push(vertex);
      }
      if (route[0]?.distanceToSquared(start) < 1e-12) route.shift();
      if (route.at(-1)?.distanceToSquared(goal) < 1e-12) route.pop();
      if (!route.length || route.length > 64) continue;
      const waypoints = route.map((vertex) => vertex.toArray()), key = JSON.stringify(waypoints);
      if (seen.has(key)) continue;
      seen.add(key);
      const chain = [start, ...route, goal];
      const distance = chain.slice(1).reduce((sum, vertex, i) => sum + vertex.distanceTo(chain[i]), 0);
      guides.push({ sourcePathId: saved.id, sourcePathName: saved.name, waypoints, distance, gap: entry.distance });
    }
  }
  return guides.sort((a, b) => a.gap - b.gap || a.distance - b.distance);
}
