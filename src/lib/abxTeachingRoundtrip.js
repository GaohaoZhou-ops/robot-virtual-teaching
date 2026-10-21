import { sha256Bytes } from './hash.js';
import { ABX_VERSION, ABX_JOINT_NAMES, abxAssert as check, abxBytes, abxEqual, abxText } from './abxFormat.js';
import { abxNestedRecords, parseAbxTeachingTask } from './abxTeachingImport.js';

const encodeJson = (value) => abxBytes(`${JSON.stringify(value, null, 2)}\n`);
const serialize = (value) => {
  const line = JSON.stringify(value);
  check(abxBytes(line).length <= 12000, 'ABX 示教记录超过单行 12000 字节上限');
  return line;
};
const stableId = async (id) => (await sha256Bytes(abxBytes(JSON.stringify(['atlas-abx-task', id])))).slice(0, 32);

function updateJoints(record, joints) {
  check(joints?.values, '导入姿态缺少关节数据');
  const unit = joints.angularUnit || 'degree';
  check(['degree', 'degrees', 'deg', 'rad', 'radian', 'radians'].includes(unit), '关节单位无效');
  const factor = ['degree', 'degrees', 'deg'].includes(unit) ? Math.PI / 180 : 1;
  const known = new Set(Object.values(ABX_JOINT_NAMES).flat());
  check(Object.keys(joints.values).every((key) => known.has(key) || /^wheel_(LF|LR|RF|RR)_J$/.test(key)), '导入姿态包含 ABX 无法表达的关节');
  for (const [group, names] of Object.entries(ABX_JOINT_NAMES)) {
    names.forEach((name, i) => {
      const value = joints.values[name];
      check(typeof value === 'number' && Number.isFinite(value), `关节 ${name}必须是有限数值`);
      const radians = value * factor;
      // Keep original decimal values for a no-op degree/radian round trip.
      if (Math.abs(record.joints_rad[group][i] - radians) > 1e-12) record.joints_rad[group][i] = radians;
    });
  }
}

// Older robot tasks only name N numbers. Bind them only when the project has
// an explicitly imported, unambiguous graph; never infer one from virtual poses.
function legacyNavigation(task, routes) {
  const records = task.abx.lines.flatMap((raw) => {
    const value = JSON.parse(raw);
    return value.type === 'point' ? [...abxNestedRecords(value.record)] : [];
  }).filter((record) => record.type === 'route_navigation');
  if (!records.length || !routes.length) return null;
  const selected = new Map();
  let defaultRouteId = null;
  for (const record of records) {
    check(record.route_id || routes.length === 1,
      `任务「${task.name}」仅保存站点编号，但当前存在多个路网，无法确定 ${record.node_id} 所属路网；请只保留对应路网后导出`);
    const route = record.route_id ? routes.find((item) => item.id === record.route_id) : routes[0];
    check(route, `任务「${task.name}」关联的路网 ${record.route_id} 已缺失`);
    check(route.nodes.some((node) => `N${node.id}` === record.node_id),
      `任务「${task.name}」的导航目标 ${record.node_id} 不在已导入路网「${route.name}」中，请导入对应的原始路网后导出`);
    selected.set(route.id, route);
    if (!record.route_id) defaultRouteId = route.id;
  }
  return { routes: [...selected.values()], maps: null, default_route_id: defaultRouteId };
}

export async function appendImportedAbxTasks(result, payload, { attachLegacyRoutes = false } = {}) {
  const nativeTasks = (payload.virtualTeaching?.tasks || []).filter((task) => task.abx);
  if (!nativeTasks.length) return result;
  const files = result.files;
  const read = (name) => JSON.parse(new TextDecoder().decode(files[`abx/${name}`]));
  const manifest = read('manifest.json'), navigationFile = read('navigation.json'), mapping = read('source-mapping.json');
  const currentRoutes = navigationFile.routes || [navigationFile.route];
  for (const task of nativeTasks) {
    const native = task.abx;
    check(native.version === 1 && Array.isArray(native.lines), '导入任务的原生记录缺失');
    abxText(task.name, '任务名称');
    check(task.coordinateFrame === 'map', '机器人原生任务必须使用 map 坐标系');
    check(abxEqual(task.parkingPoints.map((p) => p.id), native.parkingIds)
      && abxEqual(task.parkingPoints.map((p) => p.poses.map((pose) => pose.id)), native.poseIds),
    `任务 ${task.name} 的停车点或步骤结构已改变；原生动作需保持顺序，请在机器人端调整结构后重新导入`);
    const parkings = new Map(task.parkingPoints.map((parking) => [parking.abx.parkingId, parking]));
    const poses = new Map(task.parkingPoints.flatMap((p) => p.poses.map((pose) => [pose.abx.pointSeq, pose])));
    for (const value of [...parkings.values(), ...poses.values()]) {
      check(abxEqual(value.mapPose, value.abx.mapPose),
        `任务 ${task.name} 的停车定位已改变；请编辑对应路网节点，原生历史定位不能替换为虚拟测量`);
    }
    const header = { ...native.header, name: task.name };
    const originalNavigation = native.navigation || null;
    const navigation = originalNavigation ? structuredClone(originalNavigation)
      : attachLegacyRoutes ? legacyNavigation(task, payload.abxRoutes?.length ? currentRoutes : []) : null;
    if (navigation) navigation.routes = (navigation.routes || []).map((route) => {
      const edited = currentRoutes.find((r) => r.id === route.id);
      check(edited, `任务 ${task.name} 关联的路网 ${route.name} 已缺失`);
      return edited;
    });
    const lines = [];
    const sequence = [];
    let poseCount = 0, navigationCount = 0;
    for (const raw of native.lines) {
      const value = JSON.parse(raw), before = structuredClone(value);
      if (value.type === 'navigation_chunk' && !abxEqual(originalNavigation, navigation)) continue;
      if (value.type === 'parking') {
        const parking = parkings.get(value.id);
        abxText(parking.name, '停车点名称'); value.name = parking.name;
      }
      if (value.type === 'basic_pose') {
        const basic = payload.virtualTeaching?.jointPoses?.find((pose) => pose.abx?.taskId === task.id && pose.abx.basicId === value.id);
        if (basic) {
          abxText(basic.name, '基础姿态名称'); value.name = basic.name;
          updateJoints(value.record, basic.joints);
        }
      }
      if (value.type === 'point') {
        if (value.record.joints_rad) {
          const pose = poses.get(value.seq);
          check(pose, '原生关节 Pose 对应关系缺失');
          abxText(pose.name, '姿态名称');
          value.label = pose.name === pose.abx.displayName ? value.label : pose.name;
          updateJoints(value.record, pose.fullBodyJoints);
          poseCount += 1;
        }
        for (const record of abxNestedRecords(value.record)) {
          if (record.type !== 'route_navigation') continue;
          const route = navigation?.routes?.find((r) => r.id === (record.route_id || navigation.default_route_id));
          const node = route?.nodes.find((n) => `N${n.id}` === record.node_id);
          // Preserve unresolved legacy references on a no-op import/export,
          // but never export a deletion that breaks a previously resolved node.
          const previousRoute = originalNavigation?.routes?.find((r) => r.id === (record.route_id || originalNavigation.default_route_id));
          check(!previousRoute?.nodes.some((n) => `N${n.id}` === record.node_id) || node,
            `任务 ${task.name} 的导航目标 ${record.node_id} 已被删除`);
          navigationCount += 1;
          sequence.push({ type: 'route_navigation', routeId: route?.id || record.route_id || null,
            nodeId: record.node_id, seq: value.seq,
            target: node ? { x_m: node.x_m, y_m: node.y_m, yaw_rad: node.yaw_rad } : null, name: value.label });
        }
        if (value.record.type !== 'route_navigation') sequence.push({ type: value.record.joints_rad ? 'pose' : value.record.type,
          seq: value.seq, name: value.label });
      }
      lines.push(abxEqual(value, before) ? raw : serialize(value));
    }
    if (!abxEqual(originalNavigation, navigation)) {
      // Adding chunks requires the native navigation-capable header. The
      // original parking/point records, action IDs and timestamps stay intact.
      header.version = ABX_VERSION;
      header.basic_pose_count ??= '0';
      const bytes = abxBytes(JSON.stringify(navigation));
      check(bytes.length <= 4096 * 2048, '任务路网和地图信息超过 8 MiB 上限');
      let count = 0;
      for (let offset = 0; offset < bytes.length; offset += 4096) lines.push(serialize({
        type: 'navigation_chunk', seq: String(++count), data: btoa(String.fromCharCode(...bytes.subarray(offset, offset + 4096))),
      }));
      header.navigation = { chunks: String(count) };
    }
    if (attachLegacyRoutes && navigationCount && !navigation) {
      result.summary.warnings.push(`任务「${task.name}」仅包含站点编号，当前工程未导入对应路网；请导入原始路网后重新导出，或在机器人端核对当前启用的路网。`);
    }
    const counts = Object.fromEntries(['point_count', 'parking_count', 'basic_pose_count']
      .filter((key) => header[key] !== undefined).map((key) => [key, header[key]]));
    const body = lines.length ? `${lines.join('\n')}\n` : '';
    const raw = `${serialize(header)}\n${body}${serialize({ type: 'end', ...counts, sha256: await sha256Bytes(abxBytes(body)) })}\n`;
    // Recheck metadata restored from project/session files as well as fresh imports.
    await parseAbxTeachingTask(raw);
    const id = await stableId(task.id), file = `tasks/${id}.abxteach.ndjson`;
    files[`abx/${file}`] = abxBytes(raw);
    const routeFiles = (navigation?.routes || []).map((route, i) => {
      const name = `routes/${id}/${i + 1}.route.json`;
      files[`abx/${name}`] = abxBytes(`${JSON.stringify(route)}\n`); return name;
    });
    const maps = navigation?.maps?.length ? `maps/${id}.json` : null;
    if (maps) files[`abx/${maps}`] = encodeJson(navigation.maps);
    manifest.tasks.push({ id, name: task.name, created_ns: header.created_ns, updated_ns: header.created_ns,
      ...counts, file, image_count: 0, navigation: navigation ? { routes: routeFiles.length ? routeFiles : null, maps } : null });
    navigationFile.tasks.push({ sourceId: task.id, id, name: task.name, file, sequence });
    mapping.tasks.push({ sourceId: task.id, id, file, nativeImport: true });
    result.summary.poseCount += poseCount;
    result.summary.navigationCount += navigationCount;
    result.summary.taskCount += 1;
    if (native.preservedStepCount) result.summary.warnings.push(`任务「${task.name}」的 ${native.preservedStepCount} 个原生动作按原顺序保留。`);
  }
  // Restore the working task order even when native and virtual tasks are mixed.
  const order = new Map(await Promise.all((payload.virtualTeaching.tasks || []).map(async (task, i) => [await stableId(task.id), i])));
  manifest.tasks.sort((a, b) => order.get(a.id) - order.get(b.id));
  navigationFile.tasks.sort((a, b) => order.get(a.id) - order.get(b.id));
  mapping.tasks.sort((a, b) => order.get(a.id) - order.get(b.id));
  files['abx/manifest.json'] = encodeJson(manifest);
  files['abx/navigation.json'] = encodeJson(navigationFile);
  const reference = read('free-navigation.json');
  reference.tasks = navigationFile.tasks.map((task) => ({ ...task, sequence: task.sequence.map((step) => (
    step.type === 'route_navigation'
      ? { ...step, type: 'free_navigation', mode: 'free' }
      : step
  )) }));
  files['abx/free-navigation.json'] = encodeJson(reference);
  files['abx/source-mapping.json'] = encodeJson(mapping);
  return result;
}
