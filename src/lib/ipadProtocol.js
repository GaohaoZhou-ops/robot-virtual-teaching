// Shared by the browser and LAN service. All positions are metres, Z up.
export const IPAD_PROTOCOL = 'atlas-ipad-teaching/1';
export const MAX_MODEL_BYTES = 192 * 1024 * 1024;
export const MAX_MODEL_VERTICES = 5000000;
export const MAX_MODEL_INDICES = 30000000;
export const MAX_SAMPLES = 50000;
export const VISION_HEAD_FRAME = 'visionpro_head_optical_frame';
export const mobileDeviceKey = (result) => result?.device?.platform === 'visionOS' ? 'vision' : 'ipad';
export const mobileDeviceLabel = (result) => mobileDeviceKey(result) === 'vision' ? 'Vision Pro' : 'iPad';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const finiteVector = (v, keys) => v && keys.every((key) => Number.isFinite(v[key]));
const xyz = ['x', 'y', 'z'];
const validDate = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const poseNameSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function validPoseName(name) {
  if (name == null) return true;
  if (typeof name !== 'string') return false;
  if (name.length <= 80) return true;
  // Swift String.prefix(80) counts Characters, not UTF-16 code units.
  let count = 0;
  for (const _ of poseNameSegmenter.segment(name)) {
    if (++count > 80) return false;
  }
  return true;
}

export function validateModelBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(bytes.byteLength >= 32 && bytes.byteLength <= MAX_MODEL_BYTES, '模型大小无效');
  check(view.getUint32(0, true) === 0x534c5441 && view.getUint32(4, true) === 1, '模型格式不支持');
  const vertices = view.getUint32(8, true), indices = view.getUint32(12, true);
  check(vertices > 0 && vertices <= MAX_MODEL_VERTICES && indices <= MAX_MODEL_INDICES && indices % 3 === 0, '模型数量超出限制');
  check(bytes.byteLength === 32 + vertices * 16 + indices * 4, '模型文件不完整');
  for (let i = 0; i < vertices * 3; i += 1) check(Number.isFinite(view.getFloat32(32 + i * 4, true)), '模型坐标无效');
  for (let i = 0; i < indices; i += 1) check(view.getUint32(32 + vertices * 16 + i * 4, true) < vertices, '模型索引越界');
  return { vertices, indices };
}

export function validateIPadResult(result, manifest, sessionId) {
  check(result?.protocol === IPAD_PROTOCOL, 'iPad 数据协议不支持');
  check(result.sessionId === sessionId && result.modelHash === manifest.modelHash, '示教结果与发送的模型不匹配');
  check(typeof result.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(result.id), '结果标识无效');
  check(result.coordinateFrame === 'virtual_origin', '示教坐标系必须是 virtual_origin');
  const vision = result.device?.platform === 'visionOS';
  check(typeof result.device?.model === 'string' && result.device.model.length > 0 && result.device.model.length <= 80, '结果缺少采集设备信息');
  if (vision) {
    check(result.device.poseSource === 'deviceAnchor' && result.device.lidar === false, 'Vision Pro 结果必须标明头显参考位姿来源');
  } else {
    check((result.device.platform == null || result.device.platform === 'iPadOS') && result.device.lidar === true,
      '结果缺少 LiDAR 设备信息或设备平台不支持');
  }
  check(validDate(result.createdAt) && validDate(result.completedAt), '示教时间无效');
  check(Array.isArray(result.calibrations) && result.calibrations.length > 0 && result.calibrations.length <= 1000, '缺少空间校准');
  const segments = new Set();
  for (const calibration of result.calibrations) {
    check(typeof calibration.id === 'string' && !segments.has(calibration.id), '校准标识重复');
    segments.add(calibration.id);
    const m = calibration.worldFromModel;
    check(Array.isArray(m) && m.length === 16 && m.every(Number.isFinite), '校准矩阵无效');
    check(Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) < 0.0001 && Math.abs(m[15] - 1) < 0.0001, '校准矩阵必须是仿射变换');
    const dot = (a, b) => [0, 1, 2].reduce((sum, i) => sum + m[a * 4 + i] * m[b * 4 + i], 0);
    check([0, 1, 2].every((a) => [0, 1, 2].every((b) => Math.abs(dot(a, b) - (a === b ? 1 : 0)) < 0.002)), '校准不能缩放或拉伸物体');
    const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    check(Math.abs(determinant - 1) < 0.002, '校准不能镜像物体');
  }
  check(Array.isArray(result.samples) && result.samples.length > 0 && result.samples.length <= MAX_SAMPLES, '示教点数量无效');
  const ids = new Set();
  for (const sample of result.samples) {
    check(sample.origin == null || ['ipad', 'desktop'].includes(sample.origin), 'Pose 来源无效');
    check(sample.arm == null || (sample.origin === 'desktop' && ['left', 'right'].includes(sample.arm)), 'Pose 左右臂标记无效');
    check(typeof sample.id === 'string' && !ids.has(sample.id), '示教点标识重复');
    ids.add(sample.id);
    check(validPoseName(sample.name), 'Pose 名称过长');
    check(sample.previewAspect == null || (Number.isFinite(sample.previewAspect) && sample.previewAspect > 0 && sample.previewAspect < 10), 'Pose 预览比例无效');
    for (const key of ['previewCameraTransform', 'previewProjection']) {
      check(sample[key] == null || (Array.isArray(sample[key]) && sample[key].length === 16 && sample[key].every(Number.isFinite)), 'Pose 预览矩阵无效');
    }
    check(segments.has(sample.segmentId) && validDate(sample.capturedAt), '示教点缺少校准或时间');
    check(['keyframe', 'trajectory'].includes(sample.kind) && sample.tracking === 'normal', '仅接收定位正常时的示教点');
    check(finiteVector(sample.cameraPose?.position, xyz) && finiteVector(sample.cameraPose?.quaternion, [...xyz, 'w']), '相机位姿无效');
    const q = sample.cameraPose.quaternion;
    check(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.002, '相机旋转四元数未归一化');
    check(sample.cameraPose.frameName === (vision ? VISION_HEAD_FRAME : 'ipad_camera_optical_frame'), '相机轴约定与采集设备不一致');
    check(sample.surfacePoint == null || finiteVector(sample.surfacePoint, xyz), '表面点无效');
  }
  return result;
}

export function validateIPadPoseSeed(seed, manifest) {
  if (seed == null) return undefined;
  check(Array.isArray(seed.samples) && seed.samples.every((sample) => ['desktop', 'ipad'].includes(sample?.origin)
    && sample.kind === 'keyframe' && sample.segmentId === 'mac-reference'), '同步 Pose 来源无效');
  const now = new Date().toISOString();
  validateIPadResult({ protocol: IPAD_PROTOCOL, id: 'mac-reference', sessionId: 'mac-reference',
    modelHash: manifest.modelHash, coordinateFrame: 'virtual_origin', createdAt: now, completedAt: now,
    device: { model: 'iPad Pro', lidar: true },
    calibrations: [{ id: 'mac-reference', worldFromModel: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    samples: seed.samples }, manifest, 'mac-reference');
  return { samples: seed.samples };
}

export function ipadPoseArm(sample) {
  if (sample.origin !== 'desktop') return undefined;
  if (sample.arm != null) return sample.arm;
  if (sample.name?.endsWith(' · 左相机')) return 'left';
  if (sample.name?.endsWith(' · 右相机')) return 'right';
  return undefined;
}
