// Display-only anchors follow each rendered direction without changing the route.
export function buildPathLabels(waypoints, edges) {
  const points = new Map(waypoints.map((point) => [point.id, point]));
  const directions = new Set(edges.map((edge) => JSON.stringify([edge.from, edge.to])));
  return edges.flatMap((edge) => {
    const source = points.get(edge.from), target = points.get(edge.to);
    if (!source?.pose || !target?.pose) return [];
    const a = source.pose, b = target.pose;
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (!Number.isFinite(length) || length < 0.001) return [];
    // Opposite directions use separate halves of the same line in the viewer.
    const fraction = edge.directed !== false && directions.has(JSON.stringify([edge.to, edge.from]))
      ? 0.75 : 0.5;
    return [{
      id: edge.id,
      name: `${source.name || source.id} ${edge.directed === false ? '↔' : '→'} ${target.name || target.id}`,
      pose: Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, a[axis] + (b[axis] - a[axis]) * fraction])),
    }];
  });
}
