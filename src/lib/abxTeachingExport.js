import { sha256Bytes } from './hash.js';
import { zipSync } from 'fflate';
import { abxNodeName, buildAbxRouteDocuments, matchAbxStation } from './abxRoute.js';
import { appendImportedAbxTasks } from './abxTeachingRoundtrip.js';
import { buildAbxV11Files } from './abxTeachingV11.js';
import { ABX_VERSION as VERSION, ABX_JOINT_ORDER as JOINT_ORDER, ABX_JOINT_NAMES as JOINT_NAMES } from './abxFormat.js';

// Contract: workspace.zip / ABXBrainSystem, teaching_store.py v23.
const MAX_LINE_BYTES = 12000;
const NAVIGATION_CHUNK_BYTES = 4096;
const POSITION_TOLERANCE_M = 1e-6;
const YAW_TOLERANCE_RAD = 1e-6;
const BODY_JOINTS = new Set(Object.values(JOINT_NAMES).flat());
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value);
const jsonBytes = (value) => bytes(`${JSON.stringify(value, null, 2)}\n`);

class AbxExportError extends Error {}

const requireExport = (condition, message) => {
  if (!condition) throw new AbxExportError(message);
};

const finite = (value, label) => {
  requireExport(typeof value === 'number' && Number.isFinite(value), `${label}必须是有限数值`);
  return value;
};

const text = (value, label, limit = 120) => {
  requireExport(typeof value === 'string' && value.trim()
    && [...value].length <= limit && !/[\x00-\x1f\x7f]/.test(value),
  `${label}不能为空、超过 ${limit} 个字符或包含控制字符`);
  return value;
};

const radians = (value, unit, label) => {
  finite(value, label);
  if (['degree', 'degrees', 'deg'].includes(unit)) return value * (Math.PI / 180);
  requireExport(['radian', 'radians', 'rad'].includes(unit), `${label}的角度单位不受支持：${unit}`);
  return value;
};

const yawDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const wrapYaw = (value) => Math.atan2(Math.sin(value), Math.cos(value));

const timestamp = (value, fallback, label) => {
  const ms = Date.parse(value || fallback);
  requireExport(Number.isSafeInteger(ms) && ms > 0, `${label}时间无效`);
  const ns = BigInt(ms) * 1000000n;
  requireExport(ns <= 9223372036854775807n, `${label}时间超出 ABX 范围`);
  return String(ns);
};

const stableId = async (...parts) => (await sha256Bytes(bytes(JSON.stringify(parts)))).slice(0, 32);

const ordered = (items, label) => {
  requireExport(Array.isArray(items), `${label}列表无效`);
  const ids = new Set();
  return items.map((item, index) => {
    requireExport(item && typeof item.id === 'string' && item.id && !ids.has(item.id), `${label} ID 缺失或重复`);
    ids.add(item.id);
    const sequence = item.sequence ?? index + 1;
    requireExport(Number.isSafeInteger(sequence) && sequence > 0, `${label}顺序无效`);
    return { item, sequence, index };
  }).sort((a, b) => a.sequence - b.sequence || a.index - b.index).map(({ item }) => item);
};

const targetPose = (pose, unit, label) => {
  requireExport(pose && (pose.frameId || 'map') === 'map', `${label}必须使用 map 坐标系`);
  const position = pose.position || pose;
  const rpy = pose.rpy || pose;
  const x = finite(position.x, `${label} X`);
  const y = finite(position.y, `${label} Y`);
  requireExport(Math.abs(x) <= 3.4028234663852886e38 && Math.abs(y) <= 3.4028234663852886e38,
    `${label}坐标超出 ABX 范围`);
  return { x, y, yaw: wrapYaw(radians(rpy.yaw, unit, `${label} yaw`)) };
};

const freeTarget = (pose, unit, label) => {
  const { x, y, yaw } = targetPose(pose, unit, label);
  return { x_m: x, y_m: y, yaw_rad: yaw };
};

const sameTarget = (a, b) => a && b
  && Math.hypot(a.x_m - b.x_m, a.y_m - b.y_m) <= POSITION_TOLERANCE_M
  && yawDistance(a.yaw_rad, b.yaw_rad) <= YAW_TOLERANCE_RAD;

const navigationNotice = '导航与 Pose 按示教顺序导入。执行前请在机器人路网管理中核对连线、定位地图并切换使用导入的路网。';

// Route text limits are UTF-8 bytes, unlike teaching labels (Unicode characters).
const routeLabel = (value) => {
  requireExport(typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value), '路网名称不能为空或包含控制字符');
  let result = '';
  for (const character of value) {
    if (bytes(result + character).length > 128) break;
    result += character;
  }
  return result;
};

const navigationLines = (context) => {
  if (!context) return [];
  const data = bytes(JSON.stringify(context));
  requireExport(data.length <= NAVIGATION_CHUNK_BYTES * 2048, '任务路网和地图信息超过 ABX 8 MiB 上限');
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += NAVIGATION_CHUNK_BYTES) {
    chunks.push({ type: 'navigation_chunk', seq: String(chunks.length + 1),
      data: btoa(String.fromCharCode(...data.subarray(offset, offset + NAVIGATION_CHUNK_BYTES))) });
  }
  return chunks;
};

// One shared route keeps all tasks on the same graph. Only source edges are
// exported: proximity or teaching order is not evidence of a traversable path.
const createRoute = async (payload, waypoints) => {
  requireExport(payload.abxRoutes?.length || !(payload.waypoints || []).some((point) => point.abx?.routeId),
    '导航点保留了机器人站点编号，但关联路网缺失，请重新导入原始路网后导出，不能按列表顺序重新编号');
  if (payload.abxRoutes?.length) {
    const { routes, pointMap } = await buildAbxRouteDocuments(payload);
    requireExport(routes.length === 1 || !payload.virtualTeaching?.tasks?.length,
      '包含多个路网时，请分别创建新的虚拟任务；已导入的原生任务可以一起导出');
    const route = routes[0];
    for (const point of waypoints) point.nodeId = `N${pointMap.get(point.sourceId).node.id}`;
    const originalIds = new Set(payload.abxRoutes.find((item) => item.id === route.id)?.nodes.map((node) => node.id));
    const stations = route.nodes.filter((node) => originalIds.has(node.id));
    return { route, routes, pathMappings: [],
      nameFor: (nodeId) => {
        const node = stations.find((node) => `N${node.id}` === nodeId);
        return abxNodeName(node.id, node.label);
      },
      targetFor: (nodeId) => {
        const node = stations.find((node) => `N${node.id}` === nodeId);
        return { x_m: node.x_m, y_m: node.y_m, yaw_rad: node.yaw_rad };
      },
      nodeFor(name, target, parkingName = name) {
        // Never let a synthesized teaching marker or array index become a
        // station ID in an existing robot graph. Height and tiny heading
        // differences do not change the identity of a unique XY station.
        const { matches, node: existing } = matchAbxStation(stations, target, parkingName);
        requireExport(matches.length, `「${parkingName} / ${name}」未匹配到已导入路网的站点，请在对应导航点重新记录或更新路网后导入；不会自动新建导航编号`);
        requireExport(existing, `「${parkingName} / ${name}」对应多个同坐标站点，请使用路网中的 N 编号命名停车点以明确目标`);
        requireExport(existing.yaw_rad === null || yawDistance(existing.yaw_rad, target.yaw_rad) <= Math.PI / 1800,
          `「${parkingName} / ${name}」的底盘朝向与 N${existing.id} 相差超过 0.1°，请对齐路网站点后记录，或更新对应路网朝向`);
        return `N${existing.id}`;
      } };
  }
  const route = { schema_version: 1,
    id: `atlas-${await stableId('atlas-abx-route', payload.map?.sourceHash, payload.map?.fileName)}`,
    name: routeLabel(`地图示教 · ${payload.map?.fileName || '未命名地图'}`),
    scene_name: '', nodes: [], edges: [] };
  const nodeIds = new Map();
  const addNode = (name, target) => {
    const id = route.nodes.length + 1;
    route.nodes.push({ id, label: routeLabel(name), ...target });
    requireExport(route.nodes.length <= 256, '地图路网超过 ABX 256 个节点上限，请拆分工程后导出');
    return `N${id}`;
  };
  for (const point of waypoints) {
    point.nodeId = addNode(text(point.name, '导航点名称'), point.target);
    nodeIds.set(point.sourceId, Number(point.nodeId.slice(1)));
  }
  const edges = new Set();
  const pathMappings = [];
  const link = (start, end) => {
    const key = `${start}:${end}`;
    requireExport(start !== end, 'ABX 路网不支持自环连线');
    if (edges.has(key)) return;
    edges.add(key);
    // Node and edge IDs share a uint32 namespace. Reserve 1..256 for nodes.
    route.edges.push({ id: 257 + route.edges.length, start, end });
    requireExport(route.edges.length <= 512, '地图路网超过 ABX 512 条有向边上限');
  };
  for (const path of ordered(payload.paths || [], '路径')) {
    const start = nodeIds.get(path.from), end = nodeIds.get(path.to);
    requireExport(start !== undefined && end !== undefined, `路径 ${path.id}引用了不存在的导航点`);
    requireExport(path.directed === undefined || typeof path.directed === 'boolean', `路径 ${path.id}方向无效`);
    link(start, end);
    if (path.directed === false) link(end, start);
    pathMappings.push({ sourceId: path.id, start: `N${start}`, end: `N${end}`, directed: path.directed !== false });
  }
  return { route, routes: [route], pathMappings, nodeFor(name, target) {
    const existing = route.nodes.find((node) => sameTarget(node, target));
    return existing ? `N${existing.id}` : addNode(name, target);
  } };
};

export const abxRobotModel = (robotPackage) => {
  requireExport(robotPackage?.format === 'urdf', 'ABX 示教导出需要完整 URDF 机器人资源');
  const primary = robotPackage.files?.find((file) => file.path === robotPackage.relativePath);
  requireExport(primary, 'ABX 示教导出缺少机器人 URDF');
  const source = new TextDecoder().decode(primary.bytes).replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<robot\b[^>]*>/.exec(source)?.[0];
  const name = tag && /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  return text(name?.[1] || name?.[2], 'URDF 机器人名称', 200);
};

const bodyJoints = (pose, label) => {
  const joints = pose.fullBodyJoints;
  requireExport(joints?.values && typeof joints.values === 'object', `${label}缺少全身关节`);
  const extra = Object.keys(joints.values).filter((name) => !BODY_JOINTS.has(name) && !/^wheel_(LF|LR|RF|RR)_J$/.test(name));
  requireExport(!extra.length, `${label}包含 ABX 20 关节格式无法表达的关节：${extra.join('、')}`);
  return Object.fromEntries(Object.entries(JOINT_NAMES).map(([group, names]) => [group,
    names.map((name) => radians(joints.values[name], joints.angularUnit || 'degree', `${label}关节 ${name}`)),
  ]));
};

const line = (value) => {
  const result = JSON.stringify(value);
  requireExport(bytes(result).length <= MAX_LINE_BYTES, 'ABX 示教记录超过单行 12000 字节上限');
  return `${result}\n`;
};

const instructions = [
  'ABX 扩展示教记录（工程备份）',
  '',
  '1. 此 abx/ 目录保留扩展记录，适用于支持 v23 的机器人程序。',
  '   使用 380B 平地巡检 v11 格式的机器人，请通过「导出机器人示教」生成专用 robot-teaching-*.zip。',
  '   原生任务使用 abx-teaching-task v23，导出清单使用 abx-teaching-export v1。',
  '2. ' + navigationNotice,
  '   每个非空停车点的首个 Pose 前，以及同一停车点内底盘目标变化处，插入 route_navigation 步骤。',
  '   路网以 navigation_chunk 内嵌在任务文件中；routes/ 为副本，navigation.json 保存节点及步骤映射。',
  '   导入器自动分配新任务/路网 ID，不覆盖已存在的路网，也不激活路网或切换定位地图。',
  '   导出路网的 scene_name 留空；点云文件名不能冒充现场定位场景名称，切换使用时由机器人绑定。',
  '   连线只来自工程中已有路径，新增 Pose 目标不会自动连线；未连通的目标需在路网管理中补齐可通行路径。',
  '3. 坐标使用机器人 map 坐标系，X/Y 单位 m，yaw 单位 rad，范围 [-π, π]，逆时针为正。',
  '   现场地图须与虚拟工程地图对齐；原始 Z/roll/pitch、路径及逐边速度约束保存在 source-mapping.json。',
  '   逐边速度、加速度、倒车和 3D 避障开关不属于机器人路网格式，仅保留为源数据，不作为执行配置。',
  '   free-navigation.json 是兼容旧工具的坐标参考清单；原生任务实际使用随包路网站点导航。',
  '4. 20 个关节按实际 URDF 名称匹配，head、torso、left_arm、right_arm 转为 rad。',
  '   component=auto 由大脑根据实况判断执行部位；轮组不作为上身关节执行，缺失关节不会补零。',
  '   虚拟 Pose 没有实测定位，parking.location=null，不伪造 SLAM 或里程计。',
  '   robot_received_ns=1 为原生格式占位，robot_sequence 为导出序号，不代表硬件反馈。',
  '5. 基础姿态库不额外新增模板；任务、停车点与 Pose 的名称、顺序以及关节目标保留。',
  '   导入由大脑分配新任务 ID，source-mapping.json 记录源项目到包内任务和 Pose 的对应关系。',
  '   RGB/XYZ 视觉参考仍在完整工程中，不作为真机拍摄记录，也不自动触发相机。',
  '   移动设备 Pose（iPad / Vision Pro） 须先求解为机器人关节姿态，独立示教须先转换到地图坐标后再导出。',
  '6. 导出为当前快照；修改示教数据后请重新导出。原工程 ZIP 继续用于完整备份和恢复。',
  '',
];

const compileExport = async (payload, robotPackage) => {
  const angleUnit = payload.coordinateSystem?.angleUnit || payload.virtualTeaching?.angularUnit || 'degree';
  requireExport(['meter', 'm'].includes(payload.coordinateSystem?.distanceUnit || 'meter'), 'ABX 导出需要米制地图坐标');
  requireExport((payload.coordinateSystem?.frameId || 'map') === 'map', 'ABX 导出需要 map 坐标系');
  const waypoints = ordered(payload.waypoints || [], '导航点').map((point, index) => ({
    sourceId: point.id, name: point.name || point.id, sequence: index + 1,
    target: freeTarget(point.pose, angleUnit, `导航点 ${point.name || point.id}`),
    sourcePose: point.pose,
  }));
  const { route, routes, nodeFor, nameFor, targetFor, pathMappings } = await createRoute(payload, waypoints);
  const files = {};
  const exportedAt = payload.exportedAt || new Date().toISOString();
  const tasks = [];
  const taskMappings = [];
  let navigationCount = 0;
  let poseCount = 0;
  const navigationTasks = [];
  const nativeTasks = [];
  for (const task of ordered(payload.virtualTeaching?.tasks || [], '任务')) {
    const name = text(task.name, '任务名称');
    requireExport(!task.mobileCapture?.samples?.length, `任务 ${name}包含 ${task.mobileCapture?.device?.platform === 'visionOS' ? 'Vision Pro 头显 Pose' : 'iPad 相机 Pose'}，尚未转换成机器人关节姿态`);
    requireExport((task.coordinateFrame || 'map') === 'map' && task.map?.teachingSpaceMode !== 'independent', `任务 ${name}不是地图示教`);
    requireExport(!task.map?.sourceHash || !payload.map?.sourceHash || task.map.sourceHash === payload.map.sourceHash,
      `任务 ${name}与当前地图摘要不一致`);
    requireExport(!task.map?.fileName || !payload.map?.fileName || task.map.fileName === payload.map.fileName,
      `任务 ${name}与当前地图文件不一致`);
    const id = await stableId('atlas-abx-task', task.id);
    const parkings = [];
    const points = [];
    const parkingMappings = [];
    const navigationSequence = [];
    let model = null;
    for (const parking of ordered(task.parkingPoints || [], `任务 ${name}的停车点`)) {
      const parkingName = text(parking.name, '停车点名称');
      const label = `${name} / ${parkingName}`;
      const parkingTarget = freeTarget(parking.mapPose, angleUnit, label);
      const parkingNodeId = nodeFor(parkingName, parkingTarget);
      const exportedParkingName = nameFor ? nameFor(parkingNodeId) : parkingName;
      const parkingId = await stableId('atlas-abx-parking', task.id, parking.id);
      const parkingPoints = [];
      const poseMappings = [];
      let previousNodeId = null;
      const append = (record, pointLabel) => {
        const point = { type: 'point', seq: String(points.length + 1), label: pointLabel, record,
          parking_id: parkingId, parking_seq: String(parkingPoints.length + 1) };
        points.push(point);
        parkingPoints.push(point);
        return point;
      };
      for (const pose of ordered(parking.poses || [], `${label}的姿态`)) {
        const poseName = text(pose.name, '姿态名称');
        const poseLabel = `${label} / ${poseName}`;
        const target = freeTarget(pose.mapPose, angleUnit, poseLabel);
        const nodeId = nodeFor(poseName, target, exportedParkingName);
        const navigationTarget = targetFor ? targetFor(nodeId) : target;
        if (!model) {
          const sourceRobot = task.robot?.relativePath || task.robot?.id;
          requireExport(sourceRobot && sourceRobot === robotPackage?.relativePath, `任务 ${name}的机器人与当前 URDF 不一致`);
          model = abxRobotModel(robotPackage);
        }
        const joints = bodyJoints(pose, poseLabel);
        if (previousNodeId !== nodeId) {
          const navigationPoint = append({ type: 'route_navigation', route_id: route.id, node_id: nodeId },
            `导航 ${nameFor ? nameFor(nodeId) : nodeId}`);
          navigationSequence.push({ type: 'route_navigation', mode: 'route', parkingId,
            seq: navigationPoint.seq, nodeId, routeId: route.id,
            beforePoseSeq: String(points.length + 1), target: navigationTarget,
            stationName: nameFor ? nameFor(nodeId) : nodeId });
          previousNodeId = nodeId;
          navigationCount += 1;
        }
        const point = append({
          captured_ns: timestamp(pose.capturedAt, exportedAt, poseLabel),
          robot_model: model,
          robot_sequence: String(points.length + 1),
          robot_received_ns: '1',
          joints_rad: joints,
          component: 'auto',
        }, poseName);
        poseCount += 1;
        navigationSequence.push({ type: 'pose', parkingId, seq: point.seq, name: poseName, sourceId: pose.id });
        poseMappings.push({ sourceId: pose.id, name: poseName, seq: point.seq, nodeId, target, mapPose: pose.mapPose });
      }
      parkings.push({ type: 'parking', id: parkingId, seq: String(parkings.length + 1), name: exportedParkingName,
        created_ns: timestamp(parking.createdAt, task.createdAt || exportedAt, label),
        point_count: String(parkingPoints.length), location: null });
      parkingMappings.push({ sourceId: parking.id, id: parkingId, name: exportedParkingName, sourceName: parkingName, nodeId: parkingNodeId,
        target: parkingTarget, mapPose: parking.mapPose, poses: poseMappings });
    }
    requireExport(points.length <= 2000 && parkings.filter((parking) => parking.point_count !== '0').length <= 128,
      `任务 ${name}超过 ABX 单次执行的 2000 步骤或 128 个非空停车点上限`);
    const counts = { point_count: String(points.length), parking_count: String(parkings.length), basic_pose_count: '0' };
    const created = timestamp(task.createdAt, exportedAt, name);
    const file = `tasks/${id}.abxteach.ndjson`;
    nativeTasks.push({ id, file, name, created, counts, parkings, points,
      hasNavigation: navigationSequence.some((step) => step.type === 'route_navigation') });
    tasks.push({ id, name, created_ns: created, updated_ns: timestamp(task.updatedAt, task.createdAt || exportedAt, name),
      ...counts, file, image_count: 0 });
    taskMappings.push({ sourceId: task.id, id, file, robotModel: model, parkings: parkingMappings });
    navigationTasks.push({ sourceId: task.id, id, name, file, sequence: navigationSequence, parkings: parkingMappings });
  }
  // Finish the shared route before embedding it in any task. ABX assigns its
  // own stable content ID on import, reusing identical routes across tasks.
  // Reserve room for Python numeric serialization, the imported ID and the
  // measured scene name bound later by the robot's route activation flow.
  requireExport(routes.every((doc) => bytes(JSON.stringify(doc)).length + (payload.abxRoutes?.length ? 1 : 2048) <= 48 * 1024), '地图路网超过 ABX 48 KiB 上限（含导入和地图绑定预留），请拆分工程后导出');
  const context = { routes: [route], maps: null, default_route_id: null };
  const chunks = navigationLines(context);
  for (const [index, task] of nativeTasks.entries()) {
    const taskChunks = task.hasNavigation ? chunks : [];
    const body = [...task.parkings, ...task.points, ...taskChunks].map(line).join('');
    const header = { type: 'abx-teaching-task', version: VERSION, name: task.name, created_ns: task.created,
      ...task.counts, joint_order: JOINT_ORDER, units: { joints: 'rad', position: 'm' },
      navigation: task.hasNavigation ? { chunks: String(taskChunks.length) } : null };
    const footer = { type: 'end', ...task.counts, sha256: await sha256Bytes(bytes(body)) };
    files[`abx/${task.file}`] = bytes(line(header) + body + line(footer));
    const routeFile = `routes/${task.id}/1.route.json`;
    tasks[index].navigation = task.hasNavigation ? { routes: [routeFile], maps: null } : null;
    if (task.hasNavigation) files[`abx/${routeFile}`] = bytes(`${JSON.stringify(route)}\n`);
  }
  const warnings = [];
  if (navigationCount) {
    const incoming = new Set(route.edges.map((edge) => edge.end));
    const targets = new Set(navigationTasks.flatMap((task) => task.sequence
      .filter((step) => step.type === 'route_navigation').map((step) => Number(step.nodeId.slice(1)))));
    const unlinked = [...targets].filter((id) => !incoming.has(id));
    if (unlinked.length) warnings.push(`${unlinked.length} 个导航目标没有入向连线，请在机器人路网管理中核对并补齐可通行路径。`);
    const outgoing = new Map(route.nodes.map((node) => [node.id, []]));
    for (const edge of route.edges) outgoing.get(edge.start).push(edge.end);
    const reachableFrom = new Map();
    const reachable = (start, end) => {
      if (!reachableFrom.has(start)) {
        const visited = new Set([start]);
        for (const id of visited) for (const next of outgoing.get(id)) visited.add(next);
        reachableFrom.set(start, visited);
      }
      return reachableFrom.get(start).has(end);
    };
    let disconnected = 0;
    for (const task of navigationTasks) {
      const steps = task.sequence.filter((step) => step.type === 'route_navigation');
      for (let index = 1; index < steps.length; index += 1) {
        if (!reachable(Number(steps[index - 1].nodeId.slice(1)), Number(steps[index].nodeId.slice(1)))) disconnected += 1;
      }
    }
    if (disconnected) warnings.push(`${disconnected} 处相邻导航步骤之间没有有向通路，执行前需补齐连线。`);
  }
  if ((payload.paths || []).some((path) => path.limits || path.motion)) {
    warnings.push('逐边速度、加速度、倒车和 3D 避障设置保留在完整工程中，机器人路网不支持导入这些约束。');
  }
  files['abx/manifest.json'] = jsonBytes({ schema: 'abx-teaching-export', version: 1, exported_utc: exportedAt,
    include_images: false, tasks, images: [], pending_captures: 0 });
  files['abx/navigation.json'] = jsonBytes({ schema: 'atlas-abx-route-navigation', version: 1,
    exportedAt, mode: 'route', coordinateFrame: 'map', units: { position: 'm', yaw: 'rad' },
    nativeTaskNavigationSupported: true, notice: navigationNotice, warnings,
    map: payload.map, route, routes, waypoints, tasks: navigationTasks });
  files['abx/free-navigation.json'] = jsonBytes({ schema: 'atlas-abx-free-navigation-targets', version: 1,
    exportedAt, mode: 'free', coordinateFrame: 'map', units: { position: 'm', yaw: 'rad' },
    nativeTaskNavigationSupported: false, nativeTaskNavigationMode: 'route',
    notice: '此文件仅供坐标参考；包内任务使用 navigation.json 所述的路网站点导航。',
    map: payload.map, waypoints, tasks: navigationTasks.map((task) => ({ ...task,
      sequence: task.sequence.map((step) => step.type === 'route_navigation'
        ? { type: 'free_navigation', mode: 'free', parkingId: step.parkingId, beforePoseSeq: step.beforePoseSeq, target: step.target }
        : step) })) });
  files['abx/source-mapping.json'] = jsonBytes({ schema: 'atlas-abx-export-mapping', version: 3,
    exportedAt, sourceProject: 'config/project.json', map: payload.map,
    navigationMode: 'route', routeId: route.id, waypoints, paths: payload.paths || [], pathMappings, tasks: taskMappings });
  files['abx/README.txt'] = bytes(instructions.join('\n'));
  return { files, summary: { status: 'ready', navigationMode: 'route', navigationImportSupported: true,
    taskCount: tasks.length, poseCount, waypointCount: waypoints.length, navigationCount,
    nodeCount: routes.reduce((sum, doc) => sum + doc.nodes.length, 0),
    edgeCount: routes.reduce((sum, doc) => sum + doc.edges.length, 0), warnings,
    notice: navigationNotice, manifestFile: 'abx/manifest.json', navigationFile: 'abx/navigation.json' } };
};

// Conversion is atomic: an incompatible task never leaves a partial native
// bundle, while the existing Atlas backup remains available to the operator.
export async function buildAbxTeachingExport(payload, { robotPackage = null } = {}) {
  const mode = payload.teachingSpace?.mode || payload.workspace?.teachingSpaceMode || payload.map?.teachingSpaceMode || 'map';
  if (mode !== 'map') return null;
  try {
    const virtualPayload = { ...payload, virtualTeaching: { ...payload.virtualTeaching,
      tasks: (payload.virtualTeaching?.tasks || []).filter((task) => !task.abx) } };
    return await appendImportedAbxTasks(await compileExport(virtualPayload, robotPackage), payload);
  } catch (error) {
    const summary = { status: 'blocked', message: error.message };
    return { summary, files: {
      'abx/export-status.json': jsonBytes(summary),
      'abx/README.txt': bytes(`ABX 任务文件未生成：${error.message}\n\n原始工程备份完整保留。修正数据后重新点击「导出 ZIP」。\n`),
    } };
  }
}

// The deployed robot uses the v11 exchange package supplied by the user.
// Rich native records remain in project backups; only the supported v11
// contract goes into this directly importable robot ZIP.
export async function buildAbxTeachingArchive(payload, options = {}) {
  const result = await buildAbxTeachingExport(payload, options);
  requireExport(result, '请先将独立示教转换到地图示教，再导出机器人示教数据');
  requireExport(result.summary.status === 'ready', result.summary.message);
  requireExport(result.summary.taskCount >= 1 && result.summary.taskCount <= 100, '机器人示教导入包需要包含 1–100 个任务');
  const compatible = await buildAbxV11Files(result);
  const archiveBytes = zipSync(compatible.files, { level: 0 });
  return { ...compatible, bytes: archiveBytes, byteLength: archiveBytes.length,
    blob: new Blob([archiveBytes], { type: 'application/zip' }) };
}

// Only the primary URDF is needed for the model identity; meshes are not part
// of a native teaching bundle and need not be fetched again.
export async function readAbxRobotPackage(robot, existingPackage, { signal } = {}) {
  if (!robot) return null;
  const relativePath = robot.relativePath || robot.id;
  requireExport(robot.format === 'urdf', '机器人示教导出需要 URDF 机器人描述');
  const primary = existingPackage?.relativePath === relativePath
    && existingPackage.files?.find((file) => file.path === relativePath);
  if (primary) return { relativePath, format: 'urdf', files: [primary] };
  requireExport(robot.url, '缺少机器人 URDF 地址，请重新加载机器人后导出');
  const response = await fetch(robot.url, { signal });
  requireExport(response.ok, `无法读取机器人 URDF（HTTP ${response.status}）`);
  return { relativePath, format: 'urdf', files: [{ path: relativePath, bytes: new Uint8Array(await response.arrayBuffer()) }] };
}
