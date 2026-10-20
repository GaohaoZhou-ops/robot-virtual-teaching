import { unzipSync } from 'fflate';
import { Euler, Quaternion } from 'three';
import { sha256Bytes } from './hash.js';
import { abxRouteToProject, validateAbxRoute } from './abxRoute.js';
import {
  ABX_VERSION, ABX_JOINT_ORDER, abxAssert as check, abxBytes, abxEqual,
  abxInteger, abxJointsToDegrees, abxPoseFromTarget, abxText, parseAbxJson,
} from './abxFormat.js';

const MAX_TASK_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const identifier = (value) => check(typeof value === 'string' && /^[0-9a-f]{32}$/.test(value), '示教记录 ID 无效');
const iso = (value) => new Date(Number(abxInteger(value, '时间', 1) / 1000000n)).toISOString();
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const zeroPose = () => abxPoseFromTarget({ x_m: 0, y_m: 0, yaw_rad: 0 });

function locationPose(value) {
  const loc = value?.localization;
  // Odometry is not a map-frame localization.
  if (!loc || loc.source === 'sdk_base_odometry' || loc.parent_frame !== 'map') return null;
  check(Array.isArray(loc.position_m) && loc.position_m.length === 3 && loc.position_m.every(Number.isFinite)
    && Array.isArray(loc.quaternion_wxyz) && loc.quaternion_wxyz.length === 4
    && loc.quaternion_wxyz.every(Number.isFinite), '机器人定位坐标无效');
  const [w, x, y, z] = loc.quaternion_wxyz;
  check(Math.abs(w * w + x * x + y * y + z * z - 1) < 0.02, '机器人定位四元数无效');
  const euler = new Euler().setFromQuaternion(new Quaternion(x, y, z, w).normalize(), 'ZYX');
  return { frameId: 'map', position: Object.fromEntries(['x', 'y', 'z'].map((key, i) => [key, loc.position_m[i]])),
    rpy: { roll: euler.x * 180 / Math.PI, pitch: euler.y * 180 / Math.PI, yaw: euler.z * 180 / Math.PI } };
}

export function abxNestedRecords(record) {
  return record?.type === 'parallel' ? (record.actions || []).flatMap((action) => abxNestedRecords(action.record)) : [record];
}

export async function parseAbxTeachingTask(raw) {
  check(abxBytes(raw).length <= MAX_TASK_BYTES, '单个示教任务文件超过 64 MiB');
  // Native import hashes UTF-8 lines with LF; accept CRLF transport as its UI does.
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  check(lines.length >= 2 && lines.every((line) => line && !line.includes('\r') && abxBytes(line).length <= 12000),
    '示教文件为空、存在空行或超过单行 12000 字节上限');
  const values = lines.map(parseAbxJson), header = values[0], footer = values.at(-1), body = values.slice(1, -1);
  check(header && header.type === 'abx-teaching-task' && Number.isInteger(header.version)
    && header.version >= 1 && header.version <= ABX_VERSION, '不支持的机器人示教格式或版本');
  check(abxEqual(header.joint_order, ABX_JOINT_ORDER) && abxEqual(header.units, { joints: 'rad', position: 'm' }), '机器人关节顺序或单位不匹配');
  const countKeys = ['point_count', ...(header.version >= 2 ? ['parking_count'] : []), ...(header.version >= 14 ? ['basic_pose_count'] : [])];
  check(abxEqual(Object.keys(header).sort(), ['type', 'version', 'name', 'created_ns', 'joint_order', 'units',
    ...countKeys, ...(header.version >= 19 ? ['navigation'] : [])].sort()), '示教文件头字段不匹配');
  check(footer && footer.type === 'end' && abxEqual(Object.keys(footer).sort(), ['type', 'sha256', ...countKeys].sort()), '示教文件缺少结束标记');
  abxText(header.name, '任务名称'); iso(header.created_ns);
  for (const key of countKeys) check(abxInteger(header[key], key) === abxInteger(footer[key], key), '示教首尾数量不一致');
  const digest = await sha256Bytes(abxBytes(lines.slice(1, -1).map((line) => `${line}\n`).join('')));
  check(digest === footer.sha256, '示教文件 SHA-256 校验失败，文件不完整或已损坏');
  const groups = {};
  let phase = 0;
  const phases = { parking: 0, point: 1, basic_pose: 2, trajectory: 3, trajectory_chunk: 3, navigation_chunk: 4 };
  for (const value of body) {
    check(value && Object.hasOwn(phases, value.type) && phases[value.type] >= phase, '示教记录类型或顺序无效');
    phase = phases[value.type];
    (groups[value.type] ||= []).push(value);
  }
  const parkings = groups.parking || [], points = groups.point || [], basics = groups.basic_pose || [];
  for (const [key, items] of [['point_count', points], ['parking_count', parkings], ['basic_pose_count', basics]]) {
    check(BigInt(items.length) === (header[key] === undefined ? 0n : abxInteger(header[key], key)), `${key} 与记录数量不一致`);
    items.forEach((v, i) => check(abxInteger(v.seq, '记录序号', 1) === BigInt(i + 1), '示教记录顺序不连续'));
  }
  const parkingMap = new Map();
  for (const parking of parkings) {
    identifier(parking.id); abxText(parking.name, '停车点名称'); iso(parking.created_ns);
    abxInteger(parking.point_count, '停车点步骤数');
    check(!parkingMap.has(parking.id), '停车点 ID 重复');
    parkingMap.set(parking.id, { parking, count: 0 });
    locationPose(parking.location);
  }
  for (const point of points) {
    abxText(point.label, '姿态名称', 120, true);
    check(point.record && typeof point.record === 'object', '示教步骤缺少记录');
    if (header.version >= 2) {
      const group = parkingMap.get(point.parking_id);
      check(group && abxInteger(point.parking_seq, '停车点内序号', 1) === BigInt(++group.count), '停车点引用或步骤顺序无效');
    }
    for (const record of abxNestedRecords(point.record)) {
      check(record && typeof record === 'object', '机器人动作记录无效');
      if (record.joints_rad) {
        abxJointsToDegrees(record.joints_rad);
        iso(record.captured_ns);
        abxText(record.robot_model, '机器人型号', 200, true);
      } else check(['route_navigation', 'zivid_capture', 'wait', 'wait_until', 'robot_notification',
        'cartesian_move', 'recorded_trajectory'].includes(record.type), `不支持的机器人动作：${record.type || '未知'}`);
    }
  }
  for (const { parking, count } of parkingMap.values()) check(BigInt(count) === BigInt(parking.point_count), '停车点步骤数量不一致');
  const basicIds = new Set();
  for (const basic of basics) {
    identifier(basic.id); check(!basicIds.has(basic.id), '基础姿态 ID 重复'); basicIds.add(basic.id);
    abxText(basic.name, '基础姿态名称'); iso(basic.created_ns); iso(basic.updated_ns);
    abxJointsToDegrees(basic.record?.joints_rad);
  }
  const chunks = groups.navigation_chunk || [];
  const chunkCount = header.navigation == null ? 0n : abxInteger(header.navigation.chunks, '路网分块数', 1);
  check(chunkCount <= 2048n && chunkCount === BigInt(chunks.length), '路网分块数量不一致');
  const data = chunks.map((chunk, index) => {
    check(chunk.seq === String(index + 1) && typeof chunk.data === 'string'
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data), '路网分块序号或 Base64 无效');
    const value = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    check(value.length > 0 && value.length <= 4096, '路网分块大小无效');
    return value;
  });
  let navigation = null;
  if (chunks.length) {
    const combined = new Uint8Array(data.reduce((n, v) => n + v.length, 0));
    let offset = 0;
    data.forEach((v) => { combined.set(v, offset); offset += v.length; });
    navigation = parseAbxJson(decoder.decode(combined));
    check(navigation && (navigation.routes === null || Array.isArray(navigation.routes))
      && (navigation.maps === null || Array.isArray(navigation.maps)), '路网和地图信息无效');
    const ids = new Set();
    for (const route of navigation.routes || []) {
      validateAbxRoute(route);
      check(!ids.has(route.id), '任务内路网 ID 重复'); ids.add(route.id);
    }
  }
  return { header, lines: lines.slice(1, -1), parkings, points, basics, navigation };
}

function convertTask(parsed, { robot = null, robotModel = null, map = null, sourceName = '' } = {}) {
  const { header, points, basics, navigation } = parsed;
  const taskId = `abx-task-${newId()}`;
  const models = [...new Set(points.flatMap((p) => abxNestedRecords(p.record)).map((r) => r.robot_model).filter(Boolean))];
  const taskRobot = models.length === 1 && robotModel === models[0] && robot ? robot
    : { id: `abx:${models.join(',') || 'unknown'}`, name: models.join(' / '), relativePath: '' };
  const stops = header.version === 1 ? [{ id: '0'.repeat(32), name: '停车点 P01', seq: '1',
    created_ns: header.created_ns, point_count: header.point_count, location: null }] : parsed.parkings;
  let currentTarget = null;
  const parkingPoints = stops.map((parking) => {
    const id = `${taskId}:parking:${parking.id}`;
    const parkingPose = locationPose(parking.location);
    if (parkingPose) currentTarget = parkingPose;
    let firstTarget = null;
    const poses = [];
    const taskPoints = points.filter((p) => header.version === 1 || p.parking_id === parking.id);
    for (const point of taskPoints) {
      for (const record of abxNestedRecords(point.record)) {
        if (record.type === 'route_navigation') {
          const route = navigation?.routes?.find((r) => r.id === (record.route_id || navigation.default_route_id));
          const node = route?.nodes.find((n) => `N${n.id}` === record.node_id);
          currentTarget = node ? abxPoseFromTarget(node) : null;
          if (!firstTarget && currentTarget) firstTarget = currentTarget;
        }
      }
      // Parallel/trajectory/camera/wait steps remain native records; they are
      // never flattened into sequential poses that would change their meaning.
      if (!point.record.joints_rad) continue;
      const located = locationPose(point.record) || currentTarget || parkingPose;
      const mapPose = located || zeroPose();
      poses.push({ id: `${taskId}:pose:${point.seq}`, name: point.label || `Pose ${point.seq}`, sequence: poses.length + 1,
        capturedAt: iso(point.record.captured_ns), mapPose, fullBodyJoints: abxJointsToDegrees(point.record.joints_rad),
        abx: { pointSeq: point.seq, located: Boolean(located), mapPose: structuredClone(mapPose),
          displayName: point.label || `Pose ${point.seq}` } });
    }
    const located = parkingPose || firstTarget || poses.find((pose) => pose.abx.located)?.mapPose;
    const mapPose = located || zeroPose();
    return { id, name: parking.name, sequence: Number(parking.seq), createdAt: iso(parking.created_ns), mapPose, poses,
      abx: { parkingId: parking.id, located: Boolean(located), mapPose: structuredClone(mapPose) } };
  });
  const task = { id: taskId, name: header.name, createdAt: iso(header.created_ns), coordinateFrame: 'map',
    robot: { id: taskRobot.id, relativePath: taskRobot.relativePath || '', name: taskRobot.name || '' },
    map: { fileName: map?.name || map?.fileName || '', sourceHash: map?.sourceHash || null, coordinateFrame: 'map', teachingSpaceMode: 'map' },
    parkingPoints, abx: { version: 1, header, lines: parsed.lines, navigation, sourceName, models,
      preservedStepCount: points.filter((p) => !p.record.joints_rad).length,
      parkingIds: parkingPoints.map((p) => p.id),
      poseIds: parkingPoints.map((p) => p.poses.map((pose) => pose.id)) } };
  const jointPoses = basics.map((basic) => ({ id: `${taskId}:basic:${basic.id}`, name: basic.name,
    createdAt: iso(basic.created_ns), updatedAt: iso(basic.updated_ns), robot: task.robot,
    joints: abxJointsToDegrees(basic.record.joints_rad), abx: { basicId: basic.id, taskId } }));
  return { task, jointPoses };
}

export async function readAbxTeachingFile(file, options = {}) {
  check(file.size <= 512 * 1024 * 1024, '示教导入文件超过 512 MiB，请在机器人端导出不含历史图像的任务包');
  let sources, imageCount = 0;
  if (/\.zip$/i.test(file.name)) {
    let total = 0;
    const seen = new Set();
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter(entry) {
      check(!seen.has(entry.name), 'ZIP 中存在重复文件名'); seen.add(entry.name);
      const take = /(^|\/)manifest\.json$|\.abxteach\.ndjson$/.test(entry.name);
      if (take) {
        check(!entry.name.startsWith('/') && !entry.name.includes('\\') && !entry.name.split('/').includes('..'), '示教包文件路径无效');
        check(entry.originalSize <= MAX_TASK_BYTES && (total += entry.originalSize) <= 128 * 1024 * 1024, '示教包解压后数据过大');
      }
      return take;
    } });
    const manifestPath = files['manifest.json'] ? 'manifest.json' : 'abx/manifest.json';
    check(files[manifestPath], '不是机器人示教 ZIP：缺少 manifest.json');
    const manifest = parseAbxJson(decoder.decode(files[manifestPath]));
    check(manifest.schema === 'abx-teaching-export' && manifest.version === 1
      && Array.isArray(manifest.tasks) && manifest.tasks.length >= 1 && manifest.tasks.length <= 100, '机器人示教包清单无效');
    const prefix = manifestPath === 'manifest.json' ? '' : 'abx/';
    const paths = new Set();
    sources = manifest.tasks.map((task) => {
      identifier(task.id);
      check(typeof task.file === 'string' && /^tasks\/[^/\\]+\.abxteach\.ndjson$/.test(task.file)
        && !paths.has(task.file) && files[prefix + task.file], '示教包任务文件缺失、重复或路径无效');
      paths.add(task.file);
      return { name: task.file, raw: decoder.decode(files[prefix + task.file]), manifest: task };
    });
    imageCount = manifest.images?.length || 0;
  } else sources = [{ name: file.name, raw: decoder.decode(new Uint8Array(await file.arrayBuffer())) }];
  const tasks = [], jointPoses = [], routes = new Map();
  for (const source of sources) {
    const parsed = await parseAbxTeachingTask(source.raw);
    if (source.manifest) {
      check(source.manifest.name === parsed.header.name && ['point_count', 'parking_count', 'basic_pose_count']
        .every((key) => source.manifest[key] === undefined || source.manifest[key] === parsed.header[key]), '示教包清单与任务内容不一致');
    }
    const converted = convertTask(parsed, { ...options, sourceName: source.name });
    tasks.push(converted.task); jointPoses.push(...converted.jointPoses);
    for (const route of parsed.navigation?.routes || []) {
      check(!routes.has(route.id) || abxEqual(routes.get(route.id), route), '任务包中同一 ID 的路网内容冲突');
      routes.set(route.id, route);
    }
  }
  const graphs = [...routes.values()].map(abxRouteToProject);
  const warnings = [];
  const actionCount = tasks.reduce((n, task) => n + task.abx.preservedStepCount, 0);
  const unlocated = tasks.flatMap((task) => task.parkingPoints).filter((p) => !p.abx.located).length;
  if (actionCount) warnings.push(`${actionCount} 个原生动作已完整保留，可随任务再次导出；虚拟回放仅显示独立关节 Pose。`);
  if (unlocated) warnings.push(`${unlocated} 个停车点缺少 map 定位，保留原始记录，不生成导航点。`);
  if (imageCount) warnings.push(`包内 ${imageCount} 个历史图像保留在原 ZIP 中，不转换为虚拟相机快照。`);
  return { tasks, jointPoses, abxRoutes: [...routes.values()], waypoints: graphs.flatMap((g) => g.waypoints),
    edges: graphs.flatMap((g) => g.edges), warnings };
}

// Validate the whole addition before committing any React state.
export function mergeAbxImport(current, imported) {
  const routes = new Map((current.abxRoutes || []).map((route) => [route.id, route]));
  for (const route of imported.abxRoutes || []) {
    check(!routes.has(route.id) || abxEqual(routes.get(route.id), route), `路网 ${route.name} 与当前工程同 ID 路网冲突，请在另一工程导入`);
    routes.set(route.id, route);
  }
  const merge = (previous = [], additions = []) => {
    const result = new Map(previous.map((item) => [item.id, item]));
    for (const item of additions) {
      const existing = result.get(item.id);
      check(!existing || abxEqual(existing.pose, item.pose) && existing.from === item.from && existing.to === item.to,
        `导入内容与当前已编辑数据冲突：${item.name || item.id}`);
      if (!existing) result.set(item.id, item);
    }
    return [...result.values()];
  };
  return { abxRoutes: [...routes.values()], waypoints: merge(current.waypoints, imported.waypoints),
    edges: merge(current.edges, imported.edges), tasks: [...(current.teachingTasks || []), ...(imported.tasks || [])],
    jointPoses: [...(current.jointPoses || []), ...(imported.jointPoses || [])] };
}
