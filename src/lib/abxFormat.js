// Wire contract from workspace.zip / ABXBrainSystem. The deployed source is
// reference-only; all conversion happens in Atlas.
export const ABX_VERSION = 23;
export const ABX_JOINT_ORDER = {
  head: ['yaw', 'pitch'],
  torso: ['ankle_pitch', 'knee_pitch', 'waist_pitch', 'waist_yaw'],
  left_arm: Array.from({ length: 7 }, (_, i) => `J${i + 1}`),
  right_arm: Array.from({ length: 7 }, (_, i) => `J${i + 1}`),
};
export const ABX_JOINT_NAMES = {
  head: ['head_yaw_J', 'head_pitch_J'],
  torso: ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J'],
  left_arm: ABX_JOINT_ORDER.left_arm.map((name) => `left_${name}`),
  right_arm: ABX_JOINT_ORDER.right_arm.map((name) => `right_${name}`),
};
export const abxBytes = (value) => new TextEncoder().encode(value);
export const abxAssert = (condition, message) => { if (!condition) throw new Error(message); };
export const abxEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && abxEqual(a[key], b[key]));
};
export function parseAbxJson(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('机器人文件包含无效 JSON'); }
  // JSON.parse silently accepts duplicate keys, whereas the robot rejects them.
  const stack = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
    else if (token === '}' || token === ']') stack.pop();
    else if (/^\s*:/.test(raw.slice(match.index + token.length))) {
      const key = JSON.parse(token), keys = stack.at(-1);
      abxAssert(keys && !keys.has(key), `机器人 JSON 包含重复字段：${key}`);
      keys.add(key);
    }
  }
  return value;
}
export function abxInteger(value, label, minimum = 0) {
  abxAssert(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), `${label}必须是整数字符串`);
  const integer = BigInt(value);
  abxAssert(integer >= BigInt(minimum) && integer <= 9223372036854775807n, `${label}超出范围`);
  return integer;
}
export function abxText(value, label, maximum = 120, empty = false) {
  abxAssert(typeof value === 'string' && (empty || value.trim()) && [...value].length <= maximum
    && !/[\x00-\x1f\x7f]/.test(value), `${label}无效`);
  return value;
}
export function abxJointsToDegrees(joints) {
  abxAssert(joints && abxEqual(Object.keys(joints).sort(), Object.keys(ABX_JOINT_NAMES).sort()), '必须包含头部、躯干和双臂全部 20 个关节');
  const values = {};
  for (const [group, names] of Object.entries(ABX_JOINT_NAMES)) {
    abxAssert(Array.isArray(joints[group]) && joints[group].length === names.length
      && joints[group].every((v) => typeof v === 'number' && Number.isFinite(v)), `${group} 关节数据无效`);
    names.forEach((name, i) => { values[name] = joints[group][i] * 180 / Math.PI; });
  }
  return { angularUnit: 'degree', linearUnit: 'meter', source: 'abx-teaching-task', count: 20, values };
}
export function abxPoseFromTarget(target) {
  return { frameId: 'map', position: { x: target.x_m, y: target.y_m, z: 0 },
    rpy: { roll: 0, pitch: 0, yaw: (target.yaw_rad ?? 0) * 180 / Math.PI } };
}
