export const ROBOT_PEDESTRIANS_PATH = '/api/v1/lidars/detection/status';
export const ROBOT_PEDESTRIANS_INTERVAL = 500;
export const ROBOT_PEDESTRIANS_MAX_BOXES = 128;
export const ROBOT_PEDESTRIAN_HOLD_MS = 1200;
export const ROBOT_PEDESTRIAN_FADE_MS = 1000;
export const ROBOT_PEDESTRIAN_RECOVER_MS = 200;
export const ROBOT_PEDESTRIAN_VISIBLE_MS = ROBOT_PEDESTRIAN_HOLD_MS + ROBOT_PEDESTRIAN_FADE_MS;
export const ROBOT_PEDESTRIAN_TRACK_TTL_MS = 3000;

const finite = Number.isFinite;
const age = (value) => finite(value) && value >= 0;
const messages = {
  loading: '机器人正在加载行人检测', waiting: '等待新的行人感知结果',
  stopped: '机器人后台行人检测已关闭', stopping: '机器人正在关闭行人检测',
  error: '机器人行人检测暂不可用',
};

// ABX reports metres/radians in base_link, with an expiry relative to its own
// clock. Never interpret an unavailable/stale result as a valid empty scene.
export function robotPedestrianSnapshot(result, elapsedMs = 0) {
  if (!result || result.ok !== true || typeof result.state !== 'string') throw new Error('行人感知数据格式无效');
  const message = typeof result.message === 'string' ? result.message.slice(0, 300) : '';
  const empty = { boxes: [], validForMs: 0, sampleId: null, sampleAgeMs: null };
  if (result.mode !== 'resident') return { ...empty, phase: 'unavailable', message: '当前机器人未提供后台行人感知结果' };
  if (result.state !== 'running' || result.enabled !== true || result.ready !== true) {
    return { ...empty, phase: 'waiting', message: message || messages[result.state] || '等待机器人行人感知就绪' };
  }
  if (result.frame !== 'base_link' || !Array.isArray(result.boxes) || result.boxes.length > ROBOT_PEDESTRIANS_MAX_BOXES
    || !age(result.ttl_ms) || result.ttl_ms > 1500 || !age(result.result_age_ms) || !age(result.source_age_ms)
    || !Number.isSafeInteger(result.captured_at_ms) || result.captured_at_ms <= 0) throw new Error('行人感知坐标系或时效无效');
  const boxes = result.boxes.map((box) => {
    if (box?.label !== 'person' || !Array.isArray(box.center_m) || box.center_m.length !== 3
      || !box.center_m.every((n) => finite(n) && Math.abs(n) <= 100)
      || !Array.isArray(box.size_m) || box.size_m.length !== 3 || !box.size_m.every((n) => finite(n) && n > 0 && n <= 5)
      || !finite(box.yaw_rad) || !finite(box.score) || box.score < 0 || box.score > 1) throw new Error('行人感知包围盒无效');
    return { center: [...box.center_m], size: [...box.size_m], yaw: box.yaw_rad, score: box.score };
  });
  const sampleAgeMs = result.result_age_ms + result.source_age_ms + Math.max(0, elapsedMs);
  const validForMs = Math.max(0, result.ttl_ms - sampleAgeMs);
  return { phase: validForMs > 0 ? 'live' : 'waiting', boxes: validForMs > 0 ? boxes : [], validForMs,
    sampleAgeMs,
    sampleId: String(result.captured_at_ms), message: validForMs > 0 ? '' : '行人感知已过期，等待新结果' };
}
