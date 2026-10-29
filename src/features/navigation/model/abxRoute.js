import { sha256Bytes } from "../../../shared/utils/hash.js";
import { abxAssert as check, abxBytes, abxEqual, parseAbxJson } from "../../teaching/model/abxFormat.js";
import { Euler, Vector3 } from 'three';

const fields = (value, names, label) => check(value && !Array.isArray(value)
  && abxEqual(Object.keys(value).sort(), names.sort()), `${label}字段不匹配`);
const text = (value, label, limit, empty = false) => check(typeof value === 'string'
  && (empty || value.trim()) && abxBytes(value).length <= limit && !/[\x00-\x1f]/.test(value), `${label}无效`);
const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));

export const abxNodeName = (id, label) => label ? `N${id} · ${label}` : `N${id}`;
export const abxNodeLabel = (id, name) => {
  const prefix = `N${id} · `;
  return name === `N${id}` ? '' : name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

// Older independent navigation kept local X/Y while substituting the robot's
// calibrated Z. A saved placement proves the direction of that height offset.
// Use it only for named teaching stations, never as a larger distance tolerance.
export function abxStationHeightContext(payload, routeId) {
  const transfer = payload.workspace?.transfer;
  const placements = transfer?.kind === 'placement'
    ? [transfer, ...(Array.isArray(transfer.previousPlacements) ? transfer.previousPlacements : [])] : [];
  const directions = placements.flatMap((placement) => {
    const pose = placement?.localToMap;
    if (placement?.kind !== 'placement' || !['x', 'y', 'z'].every((axis) => Number.isFinite(pose?.position?.[axis]))
      || !['roll', 'pitch', 'yaw'].every((axis) => Number.isFinite(pose?.rpy?.[axis]))) return [];
    const up = new Vector3(0, 0, 1).applyEuler(new Euler(
      ...['roll', 'pitch', 'yaw'].map((axis) => pose.rpy[axis] * Math.PI / 180), 'ZYX'));
    return Math.abs(up.z) > 1e-6 ? [up] : [];
  });
  const heights = new Map((payload.waypoints || []).filter((point) => point.abx?.routeId === routeId)
    .map((point) => [point.abx.nodeId, point.pose?.z ?? 0]));
  return { directions, heights };
}

export function matchAbxStation(nodes, target, name = '', heightContext = null) {
  let matches = nodes.filter((node) => Math.hypot(node.x_m - target.x_m, node.y_m - target.y_m) <= 1e-4);
  const namedId = /^N(0|[1-9]\d*)(?: · |$)/.exec(name)?.[1];
  let heightAdjusted = false;
  if (!matches.length && namedId !== undefined && Number.isFinite(target.z_m) && heightContext) {
    const named = nodes.find((node) => String(node.id) === namedId);
    if (named && heightContext.directions.some((up) => {
      const offset = (target.z_m - (heightContext.heights.get(named.id) ?? 0)) / up.z;
      return Math.hypot(target.x_m - up.x * offset - named.x_m,
        target.y_m - up.y * offset - named.y_m) <= 1e-4;
    })) {
      matches = [named];
      heightAdjusted = true;
    }
  }
  const named = matches.find((node) => String(node.id) === namedId);
  const aligned = matches.filter((node) => node.yaw_rad === null || Math.abs(wrap(node.yaw_rad - target.yaw_rad)) <= 1e-6);
  return { matches, node: named || (matches.length === 1 ? matches[0] : aligned.length === 1 ? aligned[0] : null), heightAdjusted };
}

export function validateAbxRoute(route) {
  fields(route, ['schema_version', 'id', 'name', 'scene_name', 'nodes', 'edges'], '路网文件');
  check(route.schema_version === 1, '不支持的路网文件版本');
  check(typeof route.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(route.id), '路网标识无效');
  text(route.name, '路网名称', 128);
  text(route.scene_name, '定位场景名称', 256, true);
  check(Array.isArray(route.nodes) && route.nodes.length <= 256 && Array.isArray(route.edges)
    && route.edges.length <= 512, '每份路网最多 256 个节点、512 条有向边');
  const ids = new Set();
  const identity = (id) => {
    check(Number.isInteger(id) && id >= 0 && id <= 0xffffffff && !ids.has(id), '路网节点和边的 ID 必须是全局唯一的 uint32');
    ids.add(id);
  };
  for (const node of route.nodes) {
    fields(node, ['id', 'label', 'x_m', 'y_m', 'yaw_rad'], '路网节点');
    identity(node.id);
    text(node.label, '停车点名称', 128, true);
    check(['x_m', 'y_m'].every((key) => typeof node[key] === 'number' && Number.isFinite(node[key])
      && Math.abs(node[key]) <= 3.4028234663852886e38), '停车点坐标必须为有限数值');
    check(node.yaw_rad === null || (typeof node.yaw_rad === 'number' && Number.isFinite(node.yaw_rad)
      && Math.abs(node.yaw_rad) <= Math.PI), '停车点 Yaw 必须位于 -π 至 π rad');
  }
  const nodeIds = new Set(ids), links = new Set();
  for (const edge of route.edges) {
    fields(edge, ['id', 'start', 'end'], '路网边');
    identity(edge.id);
    check(nodeIds.has(edge.start) && nodeIds.has(edge.end), '路网边引用了不存在的节点');
    const link = `${edge.start}:${edge.end}`;
    check(edge.start !== edge.end && !links.has(link), '路网不接受自环或重复的有向连接');
    links.add(link);
  }
  check(abxBytes(JSON.stringify(route) + '\n').length <= 48 * 1024, '单份路网超过 48 KiB 上限');
  return route;
}

export function readAbxRoute(raw) {
  check(abxBytes(raw).length <= 48 * 1024, '路网文件不能超过 48 KiB');
  return validateAbxRoute(parseAbxJson(raw));
}

export function abxRouteToProject(document) {
  const route = structuredClone(validateAbxRoute(document));
  const pointId = (id) => `abx-route:${route.id}:N${id}`;
  return {
    abxRoutes: [route],
    waypoints: route.nodes.map((node) => ({
      id: pointId(node.id), name: abxNodeName(node.id, node.label), source: 'abx-route',
      pose: { x: node.x_m, y: node.y_m, z: 0, roll: 0, pitch: 0, yaw: (node.yaw_rad ?? 0) * 180 / Math.PI },
      abx: { routeId: route.id, nodeId: node.id },
    })),
    edges: route.edges.map((edge) => ({ id: `abx-route:${route.id}:E${edge.id}`,
      from: pointId(edge.start), to: pointId(edge.end), directed: true, status: 'unchecked',
      limits: { minSpeed: 0.2, maxSpeed: 1, minAcceleration: -0.8, maxAcceleration: 0.8 },
      motion: { direction: 'forward', enable3DObstacleAvoidance: true },
      abx: { routeId: route.id, edgeId: edge.id },
    })),
  };
}

// Keep imported IDs, nullable headings and scene bindings across editing and
// project saves. New Atlas points go into the single selected graph.
export async function buildAbxRouteDocuments(payload, { includeTeachingPoints = true } = {}) {
  const unit = payload.coordinateSystem?.angleUnit || 'degree';
  check(['degree', 'degrees', 'deg', 'radian', 'radians', 'rad'].includes(unit), '路网角度单位无效');
  check(['meter', 'm'].includes(payload.coordinateSystem?.distanceUnit || 'meter'), '路网需要米制坐标');
  check((payload.coordinateSystem?.frameId || 'map') === 'map', '机器人路径必须使用 map 坐标系');
  const imported = payload.abxRoutes || [];
  const documents = imported.map((doc) => ({ ...structuredClone(validateAbxRoute(doc)), nodes: [], edges: [] }));
  check(new Set(documents.map((doc) => doc.id)).size === documents.length, '路网 ID 重复');
  const addVirtualRoute = async () => {
    const id = (await sha256Bytes(abxBytes(JSON.stringify(['atlas-abx-route', payload.map?.sourceHash, payload.map?.fileName])))).slice(0, 32);
    let name = `地图示教 · ${payload.map?.fileName || '未命名地图'}`;
    while (abxBytes(name).length > 128) name = [...name].slice(0, -1).join('');
    let routeId = `atlas-${id}`, suffix = 0;
    while (documents.some((doc) => doc.id === routeId)) routeId = `atlas-${id}-virtual-${++suffix}`;
    const doc = { schema_version: 1, id: routeId, name, scene_name: '', nodes: [], edges: [] };
    documents.push(doc); return doc;
  };
  if (!documents.length) await addVirtualRoute();
  const points = (payload.waypoints || []).filter((p) => includeTeachingPoints || p.source !== 'teaching-parking-point');
  const sources = new Map(points.map((point) => [point.id, point]));
  check(sources.size === points.length, '导航点 ID 重复');
  const adjacency = new Map(points.map((point) => [point.id, []]));
  for (const edge of payload.paths || payload.edges || []) {
    check(sources.has(edge.from) && sources.has(edge.to), `路径 ${edge.id}引用了不存在的导航点`);
    adjacency.get(edge.from).push(edge.to); adjacency.get(edge.to).push(edge.from);
  }
  const ownership = new Map();
  let virtualRoute = null;
  // A new node connected to an imported graph belongs to that graph. Disjoint
  // virtual nodes get a separate graph when several imported routes coexist.
  for (const point of points) {
    if (ownership.has(point.id)) continue;
    const component = new Set([point.id]), routeIds = new Set();
    for (const id of component) {
      const routeId = sources.get(id).abx?.routeId;
      if (routeId) routeIds.add(routeId);
      for (const neighbor of adjacency.get(id)) component.add(neighbor);
    }
    check(routeIds.size <= 1, '机器人路网不支持跨路网连线');
    let doc;
    if (routeIds.size) doc = documents.find((route) => route.id === [...routeIds][0]);
    else if (documents.length === 1) doc = documents[0];
    else { virtualRoute ||= await addVirtualRoute(); doc = virtualRoute; }
    check(doc, '导航点关联的路网缺失');
    for (const id of component) ownership.set(id, doc);
  }
  const pointMap = new Map(), usedByRoute = new Map(documents.map((doc) => [doc.id, new Set(
    [...(imported.find((r) => r.id === doc.id)?.nodes || []), ...(imported.find((r) => r.id === doc.id)?.edges || [])].map((v) => v.id),
  )]));
  const allocate = (doc, start = 1) => {
    const used = usedByRoute.get(doc.id);
    let id = start;
    while (used.has(id)) id += 1;
    check(id <= 0xffffffff, '路网 ID 已耗尽');
    used.add(id); return id;
  };
  const addPoint = (point) => {
    check(!pointMap.has(point.id), '导航点 ID 重复');
    const doc = ownership.get(point.id);
    const original = imported.find((r) => r.id === doc.id)?.nodes.find((n) => n.id === point.abx?.nodeId);
    const pose = point.pose;
    check(pose && ['x', 'y', 'yaw'].every((k) => typeof pose[k] === 'number' && Number.isFinite(pose[k])), '导航点坐标必须是有限数值');
    const rad = ['degree', 'degrees', 'deg'].includes(unit) ? pose.yaw * Math.PI / 180 : pose.yaw;
    const yawUnchanged = original && Math.abs(wrap(rad - (original.yaw_rad ?? 0))) < 1e-14;
    const node = { id: original?.id ?? allocate(doc),
      label: original ? abxNodeLabel(original.id, point.name || '') : point.name || point.id,
      x_m: pose.x, y_m: pose.y, yaw_rad: yawUnchanged ? original.yaw_rad : wrap(rad) };
    doc.nodes.push(node);
    pointMap.set(point.id, { route: doc, node });
  };
  // Parking markers are projections of teaching records. When they coincide
  // with a native station, reuse that station rather than allocate a second
  // robot node merely because the marker has a different internal ID.
  for (const point of points.filter((point) => point.source !== 'teaching-parking-point')) addPoint(point);
  for (const point of points.filter((point) => point.source === 'teaching-parking-point')) {
    check(point.pose && ['x', 'y', 'yaw'].every((key) => typeof point.pose[key] === 'number'
      && Number.isFinite(point.pose[key])), '导航点坐标必须是有限数值');
    const doc = ownership.get(point.id), original = imported.find((route) => route.id === doc.id);
    const nativeIds = new Set(original?.nodes.map((node) => node.id));
    const yaw = point.pose.yaw * (['degree', 'degrees', 'deg'].includes(unit) ? Math.PI / 180 : 1);
    const { node } = matchAbxStation(doc.nodes.filter((node) => nativeIds.has(node.id)),
      { x_m: point.pose.x, y_m: point.pose.y, z_m: point.pose.z, yaw_rad: yaw }, point.name,
      abxStationHeightContext(payload, doc.id));
    if (node) pointMap.set(point.id, { route: doc, node });
    else addPoint(point);
  }
  for (const edge of payload.paths || payload.edges || []) {
    const from = pointMap.get(edge.from), to = pointMap.get(edge.to);
    check(from && to, `路径 ${edge.id}引用了不存在的导航点`);
    check(from.route === to.route, '机器人路网不支持跨路网连线');
    check(edge.directed === undefined || typeof edge.directed === 'boolean', '路径方向无效');
    const doc = from.route;
    const original = imported.find((r) => r.id === doc.id)?.edges.find((e) => e.id === edge.abx?.edgeId);
    doc.edges.push({ id: original?.id ?? allocate(doc, 257), start: from.node.id, end: to.node.id });
    if (edge.directed === false) doc.edges.push({ id: allocate(doc, 257), start: to.node.id, end: from.node.id });
  }
  documents.forEach(validateAbxRoute);
  return { routes: documents, pointMap };
}
