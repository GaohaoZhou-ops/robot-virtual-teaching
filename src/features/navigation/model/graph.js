export function pathExists(adjacency, start, target) {
  if (start === target) return true;
  const seen = new Set([start]);
  const queue = [start];

  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export function connectivityTopology(waypoints, edges) {
  return JSON.stringify([
    waypoints.map((point) => point.id),
    edges.map((edge) => [edge.id, edge.from, edge.to, edge.directed !== false]),
  ]);
}

export function inspectConnectivity(waypoints, edges) {
  const ids = [...new Set(waypoints.map((point) => point.id))];
  const adjacency = new Map(ids.map((id) => [id, []]));
  const neighbours = new Map(ids.map((id) => [id, new Set()]));
  const invalidEdgeIds = [];

  edges.forEach((edge) => {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      adjacency.get(edge.from).push(edge.to);
      if (edge.directed === false) adjacency.get(edge.to).push(edge.from);
      if (edge.from !== edge.to) {
        neighbours.get(edge.from).add(edge.to);
        neighbours.get(edge.to).add(edge.from);
      }
    } else {
      invalidEdgeIds.push(edge.id);
    }
  });

  const edgeStatus = new Map();
  const unreachableEdgeIds = [];
  edges.forEach((edge) => {
    const valid = adjacency.has(edge.from) && adjacency.has(edge.to);
    const mutual = valid && pathExists(adjacency, edge.to, edge.from);
    edgeStatus.set(edge.id, mutual ? 'connected' : 'unreachable');
    if (valid && !mutual) unreachableEdgeIds.push(edge.id);
  });

  // Separate disconnected road networks and standalone points from one-way
  // paths. Closed loops can all be green while the whole graph is disconnected.
  const components = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const component = [id];
    seen.add(id);
    for (let index = 0; index < component.length; index += 1) {
      for (const next of neighbours.get(component[index])) {
        if (seen.has(next)) continue;
        seen.add(next);
        component.push(next);
      }
    }
    components.push(component);
  }
  const isolatedWaypointIds = ids.filter((id) => neighbours.get(id).size === 0);

  let stronglyConnected = ids.length > 0;
  if (ids.length > 1) {
    const origin = ids[0];
    stronglyConnected = ids.every(
      (id) =>
        pathExists(adjacency, origin, id) &&
        pathExists(adjacency, id, origin),
    );
  }

  return {
    stronglyConnected,
    edgeStatus,
    validation: {
      status: stronglyConnected && !invalidEdgeIds.length ? 'connected' : 'partial',
      topology: connectivityTopology(waypoints, edges),
      unreachableCount: unreachableEdgeIds.length,
      unreachableEdgeIds,
      invalidEdgeIds,
      isolatedWaypointIds,
      components,
      checkedAt: null,
    },
  };
}

export function connectivityCopy(validation) {
  if (validation.status === 'connected') {
    return { title: '全图强连通', detail: '所有导航点均可往返到达' };
  }
  if (validation.status !== 'partial') return { title: '等待连通性检测', detail: '' };
  const reasons = [];
  if (validation.unreachableCount > 0) reasons.push(`${validation.unreachableCount} 条路径无法往返（黄色）`);
  if (validation.isolatedWaypointIds?.length) reasons.push(`${validation.isolatedWaypointIds.length} 个孤立导航点未接入路网`);
  const networks = (validation.components || []).filter((ids) => ids.length > 1);
  if (networks.length > 1) reasons.push(`${networks.length} 组路网互不相连`);
  if (validation.invalidEdgeIds?.length) reasons.push(`${validation.invalidEdgeIds.length} 条路径端点缺失，无法显示`);
  return { title: '全图尚未互通', detail: reasons.join('；') || '请重新运行路径测试以定位原因' };
}
