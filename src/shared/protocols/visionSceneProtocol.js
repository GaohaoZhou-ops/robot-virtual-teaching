export const VISION_SCENE_FORMAT = 'atlas-vision-scene/1';
export const MAX_SCENE_ASSET_BYTES = 192 * 1024 * 1024;
export const MAX_SCENE_BYTES = 1024 * 1024 * 1024;

export function validateVisionScene(scene) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const vector = (v, count) => Array.isArray(v) && v.length === count && v.every(Number.isFinite);
  const name = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
  const pose = (v) => v && ['position', 'rpy'].every((key) => v[key] &&
    (key === 'position' ? ['x', 'y', 'z'] : ['roll', 'pitch', 'yaw']).every((axis) => Number.isFinite(v[key][axis])));
  const joints = (v) => v && !Array.isArray(v) && Object.keys(v).length <= 256 && Object.entries(v).every(([key, value]) => name(key) && Number.isFinite(value));
  check(scene?.format === VISION_SCENE_FORMAT && name(scene.name) && ['map', 'virtual_origin'].includes(scene.coordinateFrame), '空间工程格式无效');
  check(vector(scene.bounds?.min, 3) && vector(scene.bounds?.max, 3) && scene.bounds.min.every((v, i) => v <= scene.bounds.max[i]), '空间工程范围无效');
  check(Array.isArray(scene.assets) && scene.assets.length > 0 && scene.assets.length <= 1024, '空间资源数量超出范围');
  const assets = new Set(); let bytes = 0;
  for (const asset of scene.assets) {
    check(/^[a-f0-9]{64}$/.test(asset.id) && asset.modelHash === asset.id && !assets.has(asset.id), '空间资源摘要无效或重复');
    check(Number.isInteger(asset.vertices) && asset.vertices > 0 && asset.vertices <= 5_000_000 && Number.isInteger(asset.indices)
      && asset.indices >= 0 && asset.indices <= 30_000_000 && asset.indices % 3 === 0, '空间资源网格无效');
    check(asset.byteLength === 32 + asset.vertices * 16 + asset.indices * 4 && asset.byteLength <= MAX_SCENE_ASSET_BYTES, '空间资源大小无效');
    check(asset.protocol === 'atlas-ipad-teaching/1' && asset.coordinateFrame === 'virtual_origin' && asset.distanceUnit === 'meter' && asset.verticalAxis === 'Z'
      && ['x', 'y', 'z'].every((axis) => Number.isFinite(asset.bounds?.min?.[axis]) && Number.isFinite(asset.bounds?.max?.[axis])
        && asset.bounds.min[axis] <= asset.bounds.max[axis]), '空间资源坐标或边界无效');
    assets.add(asset.id); bytes += asset.byteLength;
  }
  check(bytes <= MAX_SCENE_BYTES, '完整空间工程超过 1 GiB，请先整理源模型');
  check(Array.isArray(scene.nodes) && scene.nodes.length <= 8192, '空间节点数量超出范围');
  const nodes = new Set();
  for (const node of scene.nodes) {
    check(name(node.id) && !nodes.has(node.id) && name(node.name) && vector(node.transform, 16), '空间节点无效');
    check([3, 7, 11].every((i) => Math.abs(node.transform[i]) < 0.0001) && Math.abs(node.transform[15] - 1) < 0.0001
      && [0, 4, 8].every((i) => Math.hypot(...node.transform.slice(i, i + 3)) > 1e-8), '空间节点变换无效');
    check(node.parent == null || nodes.has(node.parent), '空间节点必须按父子顺序排列');
    check(node.asset == null || assets.has(node.asset), '空间节点缺少资源');
    check(['map', 'robot', 'part', 'joint'].includes(node.role), '空间节点角色无效');
    if (node.material != null) check(node.role === 'part' && ['roughness', 'metallic'].every(key =>
      Number.isFinite(node.material[key]) && node.material[key] >= 0 && node.material[key] <= 1), '机器人表面材质无效');
    if (node.joint) check(name(node.joint.name) && ['revolute', 'continuous', 'prismatic'].includes(node.joint.type)
      && vector(node.joint.axis, 3) && Math.abs(Math.hypot(...node.joint.axis) - 1) < 0.002
      && vector(node.joint.restPosition, 3) && vector(node.joint.restQuaternion, 4)
      && Math.abs(Math.hypot(...node.joint.restQuaternion) - 1) < 0.002 && Number.isFinite(node.joint.value), '空间关节无效');
    nodes.add(node.id);
  }
  check(scene.robotRoot == null || nodes.has(scene.robotRoot), '机器人根节点无效');
  check(Array.isArray(scene.paths) && scene.paths.length <= 50000 && scene.paths.every((p) => name(p.id) && name(p.name)
    && Array.isArray(p.points) && p.points.length <= 50000 && p.points.every((v) => vector(v, 3))), '空间路线无效');
  check(scene.paths.reduce((count, p) => count + p.points.length, 0) <= 200000, '空间路线点数超过范围');
  check(Array.isArray(scene.markers) && scene.markers.length <= 50000 && scene.markers.every((m) => name(m.id) && name(m.name) && vector(m.position, 3)), '空间标记无效');
  check(Array.isArray(scene.clips) && scene.clips.length <= 512, '空间动作数量超出范围');
  for (const items of [scene.paths, scene.markers, scene.clips.map((c) => ({ id: c.taskId }))]) check(new Set(items.map((i) => i.id)).size === items.length, '空间项目标识重复');
  let segments = 0;
  for (const clip of scene.clips) {
    check(name(clip.taskId) && name(clip.taskName) && Number.isFinite(clip.totalDurationMs) && clip.totalDurationMs > 0
      && pose(clip.initialRobotPose) && joints(clip.initialJointValues) && Array.isArray(clip.segments), '空间动作无效');
    let time = 0;
    for (const segment of clip.segments) {
      check(['chassis', 'joints', 'hold'].includes(segment.phase) && pose(segment.fromPose) && pose(segment.toPose)
        && joints(segment.fromJointValues) && joints(segment.toJointValues) && Number.isFinite(segment.durationMs) && segment.durationMs >= 0
        && Math.abs(segment.startOffsetMs - time) < 0.001 && Math.abs(segment.endOffsetMs - time - segment.durationMs) < 0.001, '空间动作时间线无效');
      time = segment.endOffsetMs; segments += 1;
    }
    check(Math.abs(time - clip.totalDurationMs) < 0.001, '空间动作总时长不一致');
  }
  check(segments <= 50000, '空间动作分段过多');
  return scene;
}
