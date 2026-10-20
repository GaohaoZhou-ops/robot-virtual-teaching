import { sha256Bytes } from './hash.js';
import { abxAssert as check, abxBytes, abxEqual, abxInteger, abxText } from './abxFormat.js';
import { parseAbxTeachingTask } from './abxTeachingImport.js';

// Robot exchange contract: 380B平地巡检.zip. Keep the richer project backup
// separate: v11 references the robot's active route and cannot embed a graph.
export const ABX_ROBOT_EXPORT_VERSION = 11;
export const ABX_ROBOT_EXPORT_NOTICE = '此 ZIP 按 380B 平地巡检格式导出任务，导航步骤引用机器人当前路网的站点编号。请核对并启用对应路网；新增或修改的路网需通过右侧“路径/导航 → 导出路径”单独导入。';

const readme = [
  '任务名称与文件路径见 manifest.json。',
  '解压后可在 Web 中逐个导入 tasks/ 下的 .abxteach.ndjson 文件。',
  'images/ 仅包含所选任务关联且已保存完成的 PNG/EXR 图像；任务数据文件中的拍照步骤是配置，不会在导出时触发拍照。',
].join('\n') + '\n';
const jsonBytes = (value) => abxBytes(`${JSON.stringify(value, null, 2)}\n`);
const fields = (value, allowed, label) => {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  check(!extra.length, `${label}包含参考 v11 格式不支持的字段：${extra.join('、')}，请保留完整工程或在机器人端调整后导出`);
};
const actionId = async (key) => (await sha256Bytes(abxBytes(JSON.stringify(['atlas-abx-action', key])))).slice(0, 32);
const serialize = (value) => {
  const result = JSON.stringify(value);
  check(abxBytes(result).length <= 12000, 'ABX 示教记录超过单行 12000 字节上限');
  return result;
};

function convertRecord(source, label, routeIds) {
  const record = structuredClone(source);
  if (record.joints_rad) {
    // 'auto' is the newer format's default. A selected component or arrival
    // action has execution semantics and must never be silently discarded.
    if (record.component === 'auto') delete record.component;
    fields(record, ['captured_ns', 'robot_model', 'robot_sequence', 'robot_received_ns', 'joints_rad'], label);
    abxInteger(record.robot_sequence, `${label}机器人序号`);
    abxInteger(record.robot_received_ns, `${label}接收时间`, 1);
    return record;
  }
  if (record.type === 'route_navigation') {
    fields(record, ['type', 'route_id', 'node_id'], label);
    check(typeof record.node_id === 'string' && /^N(0|[1-9]\d*)$/.test(record.node_id)
      && Number(record.node_id.slice(1)) <= 0xffffffff, `${label}导航点编号无效`);
    if (record.route_id) routeIds.add(record.route_id);
    return { type: 'route_navigation', node_id: record.node_id };
  }
  check(record.type === 'zivid_capture', `${label}的 ${record.type || '未知'} 动作不在参考 v11 格式中，无法无损导出；请保留完整工程或在机器人端调整任务`);
  fields(record, ['type', 'sides', 'formats', 'wait_ms', 'count', 'interval_ms'], label);
  for (const [key, allowed] of [['sides', ['left', 'right']], ['formats', ['png', 'exr']]]) {
    check(Array.isArray(record[key]) && record[key].length > 0
      && new Set(record[key]).size === record[key].length && record[key].every((value) => allowed.includes(value)),
    `${label}拍照 ${key} 不符合参考 v11 格式`);
  }
  for (const key of ['wait_ms', 'count', 'interval_ms']) {
    check(Number.isSafeInteger(record[key]) && record[key] >= (key === 'count' ? 1 : 0), `${label}拍照 ${key} 无效`);
  }
  return record;
}

export async function buildAbxV11Files(result) {
  const read = (name) => JSON.parse(new TextDecoder().decode(result.files[`abx/${name}`]));
  const sourceManifest = read('manifest.json');
  const navigation = read('navigation.json');
  const tasks = [], taskFiles = {}, routeIds = new Set();
  for (const entry of sourceManifest.tasks) {
    const parsed = await parseAbxTeachingTask(new TextDecoder().decode(result.files[`abx/${entry.file}`]));
    const header = { type: 'abx-teaching-task', version: ABX_ROBOT_EXPORT_VERSION,
      name: parsed.header.name, created_ns: parsed.header.created_ns, point_count: parsed.header.point_count,
      joint_order: parsed.header.joint_order, units: parsed.header.units, parking_count: parsed.header.parking_count };
    check(header.parking_count !== undefined, `任务「${header.name}」缺少停车点分组，无法导出参考 v11 格式`);
    const lines = [], sequence = [];
    const previousSteps = navigation.tasks.find((task) => task.id === entry.id)?.sequence || [];
    for (const raw of parsed.lines) {
      const value = JSON.parse(raw), before = structuredClone(value);
      if (value.type === 'navigation_chunk') continue;
      check(['parking', 'point'].includes(value.type),
        `任务「${header.name}」包含 ${value.type}，参考 v11 格式无法无损保存；请保留完整工程或在机器人端调整任务`);
      if (value.type === 'parking') {
        fields(value, ['type', 'id', 'seq', 'name', 'created_ns', 'point_count', 'location'], '停车点');
      } else {
        const label = `任务「${header.name}」步骤 ${value.seq}`;
        fields(value, ['type', 'seq', 'label', 'record', 'parking_id', 'parking_seq', 'action'], label);
        value.record = convertRecord(value.record, label, routeIds);
        if (!value.action) {
          const name = value.record.joints_rad ? value.label || '机器人姿态'
            : value.record.type === 'route_navigation' ? '路网站点导航' : 'Zivid 拍照';
          value.action = { id: await actionId(value.record.joints_rad ? [entry.id, value.seq] : value.record.type), name };
        }
        check(/^[0-9a-f]{32}$/.test(value.action.id), `${label}动作 ID 无效`);
        abxText(value.action.name, `${label}动作名称`);
        fields(value.action, ['id', 'name'], `${label}动作`);
        const previous = previousSteps.find((step) => step.seq === value.seq);
        sequence.push(value.record.type === 'route_navigation'
          ? { ...previous, type: 'route_navigation', seq: value.seq, nodeId: value.record.node_id,
            name: value.label, target: previous?.target || null }
          : { type: value.record.joints_rad ? 'pose' : value.record.type, seq: value.seq, name: value.label });
      }
      lines.push(abxEqual(value, before) ? raw : serialize(value));
    }
    // v11 uses one active robot graph. Dropping different route IDs could make
    // identical N-numbers refer to different physical targets.
    if (parsed.points.some((point) => point.record.type === 'route_navigation' && !point.record.route_id)
      && parsed.navigation?.default_route_id) routeIds.add(parsed.navigation.default_route_id);
    check(routeIds.size <= 1, '参考 v11 格式仅引用机器人当前路网；多个路网的任务请分别导出，避免同编号导航点混淆');
    const counts = { point_count: header.point_count, parking_count: header.parking_count };
    const body = lines.map((line) => `${line}\n`).join('');
    const footer = { type: 'end', ...counts, sha256: await sha256Bytes(abxBytes(body)) };
    const raw = `${serialize(header)}\n${body}${serialize(footer)}\n`;
    await parseAbxTeachingTask(raw);
    taskFiles[entry.file] = abxBytes(raw);
    tasks.push({ id: entry.id, name: header.name, created_ns: header.created_ns, updated_ns: entry.updated_ns,
      ...counts, file: entry.file, image_count: 0 });
    const preview = navigation.tasks.find((task) => task.id === entry.id);
    if (preview) preview.sequence = sequence;
  }
  const files = {
    'manifest.json': jsonBytes({ schema: 'abx-teaching-export', version: 1,
      exported_utc: sourceManifest.exported_utc, include_images: false, tasks, images: [], pending_captures: 0 }),
    'README.txt': abxBytes(readme),
    ...taskFiles,
  };
  navigation.notice = ABX_ROBOT_EXPORT_NOTICE;
  navigation.taskVersion = ABX_ROBOT_EXPORT_VERSION;
  navigation.routeImportIncluded = false;
  const summary = { ...result.summary, taskVersion: ABX_ROBOT_EXPORT_VERSION, routeImportIncluded: false,
    notice: ABX_ROBOT_EXPORT_NOTICE, manifestFile: 'manifest.json', navigationFile: null };
  return { files, summary, navigation, navigationBytes: jsonBytes(navigation) };
}
