export const HAND_EYE_CALIBRATION_FILES = Object.freeze({
  left: 'calib/handeye_left_real_report.json',
  right: 'calib/handeye_right_real_report.json',
});
export const HAND_EYE_CALIBRATION_MAX_BYTES = 1024 * 1024;
export const HAND_EYE_CALIBRATION_TIMEOUT_MS = 2500;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(finite);
const matrix = (value) => Array.isArray(value) && value.length === 3 && value.every((row) => vector(row, 3));
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function validCameraIntrinsics(value) {
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width < 1 || value.height < 1 || value.width > 32768 || value.height > 32768
    || !matrix(value.K)) return false;
  const k = value.K;
  const fovX = Math.atan((value.width - k[0][2]) / k[0][0]) + Math.atan(k[0][2] / k[0][0]);
  const fovY = Math.atan((value.height - k[1][2]) / k[1][1]) + Math.atan(k[1][2] / k[1][1]);
  // Keep the pinhole projection within the same supported angular range as
  // the nominal model, including protection against extreme numeric values.
  return [fovX, fovY].every((fov) => fov >= Math.PI / 180 && fov <= 175 * Math.PI / 180)
    && k[0][0] > 0 && k[1][1] > 0 && k[0][2] >= 0 && k[0][2] <= value.width
    && k[1][2] >= 0 && k[1][2] <= value.height
    && Math.abs(k[0][1]) < 1e-9 && Math.abs(k[1][0]) < 1e-9
    && Math.abs(k[2][0]) < 1e-9 && Math.abs(k[2][1]) < 1e-9 && Math.abs(k[2][2] - 1) < 1e-9;
}

function validateTransform(value, label) {
  check(matrix(value?.rotation) && vector(value?.translation_m, 3), `${label} 必须包含 3×3 旋转矩阵和米制平移`);
  const r = value.rotation;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = r[i].reduce((sum, v, k) => sum + v * r[j][k], 0);
    check(Math.abs(dot - Number(i === j)) < 1e-5, `${label} 旋转矩阵不正交`);
  }
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
    - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  check(Math.abs(det - 1) < 1e-5, `${label} 必须是右手旋转矩阵`);
}

export function parseHandEyeCalibration(text) {
  check(typeof text === 'string' && text.length <= HAND_EYE_CALIBRATION_MAX_BYTES, '标定文件过大');
  let report;
  try { report = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 格式错误'); }
  check(report?.format === 'botx_handeye_real_report_v1', '不支持的标定文件格式');
  const method = report.recommended_method;
  check(['Tsai', 'Park', 'Horaud', 'Andreff', 'Daniilidis'].includes(method)
    && Object.hasOwn(report.methods || {}, method), '推荐标定方法缺失或无效');
  const result = report.methods[method];
  validateTransform(result?.camera_to_tool, 'camera_to_tool');
  validateTransform(result?.tool_to_camera, 'tool_to_camera');
  const a = result.camera_to_tool, b = result.tool_to_camera;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) check(Math.abs(a.rotation[i].reduce((sum, v, k) => sum + v * b.rotation[k][j], 0)
      - Number(i === j)) < 1e-5, '正反向标定矩阵不互为逆矩阵');
    check(Math.abs(a.translation_m[i] + a.rotation[i].reduce((sum, v, k) => sum + v * b.translation_m[k], 0)) < 1e-5,
      '正反向标定平移不一致');
  }
  check(validCameraIntrinsics(report.intrinsics), '相机内参 K 或图像分辨率无效');
  check(vector(report.intrinsics.distortion, 5), '畸变参数必须包含 5 个有限数值');
  return {
    format: report.format, method,
    generatedAt: typeof report.generated_at_utc === 'string' ? report.generated_at_utc : '',
    planRevision: typeof report.source?.plan_revision === 'string' ? report.source.plan_revision : '',
    cameraToTool: a,
    intrinsics: { width: report.intrinsics.width, height: report.intrinsics.height,
      K: report.intrinsics.K, distortion: report.intrinsics.distortion, distortionModel: 'opencv-brown-conrady' },
  };
}

// Optional resources are isolated per side and bounded in time. A broken
// calibration must never turn a working robot/model archive into a load error.
export async function readOptionalCalibration(url, { signal, timeoutMs = HAND_EYE_CALIBRATION_TIMEOUT_MS, fetcher = fetch } = {}) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  if (!url) return { status: 'missing', message: '未找到标定文件' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, cache: 'no-store' });
    if (response.status === 404) return { status: 'missing', message: '未找到标定文件' };
    if (!response.ok) return { status: 'unavailable', message: `读取失败（HTTP ${response.status}）` };
    if (Number(response.headers?.get('content-length')) > HAND_EYE_CALIBRATION_MAX_BYTES) {
      controller.abort();
      return { status: 'invalid', message: '标定文件超过 1 MB' };
    }
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), decoder = new TextDecoder(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > HAND_EYE_CALIBRATION_MAX_BYTES) {
            controller.abort();
            await reader.cancel().catch(() => {});
            return { status: 'invalid', message: '标定文件超过 1 MB' };
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        text = chunks.join('') + decoder.decode();
      } finally { reader.releaseLock(); }
    } else text = await response.text();
    if (new TextEncoder().encode(text).byteLength > HAND_EYE_CALIBRATION_MAX_BYTES) return { status: 'invalid', message: '标定文件超过 1 MB' };
    return { status: 'read', text };
  } catch {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return { status: 'unavailable', message: timedOut ? '标定文件读取超时' : '标定文件读取失败' };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
