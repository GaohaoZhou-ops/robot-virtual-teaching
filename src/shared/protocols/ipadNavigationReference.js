import { Euler, Quaternion } from 'three';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const validText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const finite = (value, axes) => value && axes.every((axis) => Number.isFinite(value[axis]));

// A frozen, display-only graph, separate from editable camera samples and results.
export function validateIPadNavigationReference(reference) {
  if (reference == null) return undefined;
  check(reference.version === 1 && reference.coordinateFrame === 'virtual_origin'
    && reference.distanceUnit === 'meter' && reference.verticalAxis === 'Z', '停车点参考坐标系无效');
  check(Array.isArray(reference.parkingPoints) && reference.parkingPoints.length <= 10000
    && Array.isArray(reference.paths) && reference.paths.length <= 50000, '停车点或路网参考数量超出限制');
  const ids = new Set(), paths = new Set();
  const parkingPoints = reference.parkingPoints.map((point) => {
    check(validText(point?.id) && !ids.has(point.id) && validText(point.name), '停车点参考标识或名称无效');
    ids.add(point.id);
    check(finite(point.position, ['x', 'y', 'z']) && finite(point.quaternion, ['x', 'y', 'z', 'w']), '停车点参考位姿无效');
    const { x, y, z, w } = point.quaternion;
    check(Math.abs(Math.hypot(x, y, z, w) - 1) < 0.002, '停车点参考旋转未归一化');
    return { id: point.id, name: point.name,
      position: { x: point.position.x, y: point.position.y, z: point.position.z }, quaternion: { x, y, z, w } };
  });
  const connections = reference.paths.map((edge) => {
    check(validText(edge?.id) && !paths.has(edge.id) && ids.has(edge.from) && ids.has(edge.to)
      && edge.from !== edge.to && typeof edge.directed === 'boolean', '路网参考连接无效');
    paths.add(edge.id);
    return { id: edge.id, from: edge.from, to: edge.to, directed: edge.directed };
  });
  return { version: 1, coordinateFrame: 'virtual_origin', distanceUnit: 'meter', verticalAxis: 'Z',
    parkingPoints, paths: connections };
}

export function buildIPadNavigationReference(waypoints = [], edges = []) {
  if (!waypoints.length && !edges.length) return undefined;
  // App supplies the visible combined navigation graph. Temporary map routes
  // have already been transformed to this independent object's local frame.
  const parkingPoints = waypoints.map((point) => {
    check(finite(point.pose, ['x', 'y', 'z', 'roll', 'pitch', 'yaw']), `停车点「${point.name || point.id}」位姿无效`);
    const { x, y, z, roll, pitch, yaw } = point.pose;
    const q = new Quaternion().setFromEuler(new Euler(roll * Math.PI / 180,
      pitch * Math.PI / 180, yaw * Math.PI / 180, 'ZYX'));
    return { id: point.id, name: point.name || point.id, position: { x, y, z },
      quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } };
  });
  return validateIPadNavigationReference({ version: 1, coordinateFrame: 'virtual_origin',
    distanceUnit: 'meter', verticalAxis: 'Z', parkingPoints,
    paths: edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, directed: edge.directed !== false })) });
}
