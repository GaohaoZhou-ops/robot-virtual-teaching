import { createId, normalizeProject } from './io.js';
import { boundTeachingTransform, transferMatrix, transformTeachingPose } from './teachingTransfer.js';
import { TEMPORARY_MAP_ROUTE_SOURCE } from './teachingNavigation.js';

function syncContext(independentMap, independentTransfer, mapConfig) {
  const payload = mapConfig?.config?.project;
  if (!payload) return { available: false, reason: '请先打开地图示教并加载路径' };
  if (independentMap?.teachingSpaceMode !== 'independent') {
    return { available: false, reason: '请先打开独立示教模型' };
  }
  // Navigation only needs the graph and relation, not captured images or robot tasks.
  const project = normalizeProject({
    map: payload.map, workspace: payload.workspace, coordinateSystem: payload.coordinateSystem,
    waypoints: payload.waypoints, paths: payload.paths,
  });
  if (project.workspace.teachingSpaceMode !== 'map') {
    return { available: false, reason: '路径来源必须是地图示教工程' };
  }
  const localToMap = boundTeachingTransform(independentMap, independentTransfer,
    { ...project.map, mapId: mapConfig.mapId }, project.workspace.transfer);
  if (!localToMap) {
    return { available: false, reason: '请先将当前独立模型与地图示教建立转换关系' };
  }
  if (!project.waypoints.length) return { available: false, reason: '请先在地图示教中加载路径' };
  return { available: true, reason: '', localToMap, project,
    pointCount: project.waypoints.length, edgeCount: project.edges.length };
}

export function mapRouteSyncStatus(independentMap, independentTransfer, mapConfig) {
  const { project, localToMap, ...status } = syncContext(independentMap, independentTransfer, mapConfig);
  return status;
}

export function syncMapRouteToIndependent(independentMap, independentTransfer, mapConfig) {
  const context = syncContext(independentMap, independentTransfer, mapConfig);
  if (!context.available) throw new Error(context.reason);
  const inverse = transferMatrix(context.localToMap).invert();
  const prefix = createId('map-route');
  const ids = new Map(context.project.waypoints.map((point) => [point.id, `${prefix}:${point.id}`]));
  const waypoints = context.project.waypoints.map((point) => {
    const pose = transformTeachingPose({
      position: point.pose,
      rpy: { roll: point.pose.roll, pitch: point.pose.pitch, yaw: point.pose.yaw },
    }, inverse);
    // Do not retain ABX absolute-coordinate metadata or teaching-task links.
    return { id: ids.get(point.id), name: point.name, source: TEMPORARY_MAP_ROUTE_SOURCE,
      pose: { ...pose.position, ...pose.rpy } };
  });
  const edges = context.project.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => {
    const { abx, ...copy } = structuredClone(edge);
    return { ...copy, id: `${prefix}:${edge.id}`, from: ids.get(edge.from), to: ids.get(edge.to),
      source: TEMPORARY_MAP_ROUTE_SOURCE, status: 'unchecked' };
  });
  return { waypoints, edges };
}
