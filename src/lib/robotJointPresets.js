import { isRobotBodyJoint } from './robotJointLocks.js';
import { ABX_JOINT_NAMES, parseAbxJson } from './abxFormat.js';

const GROUPS = [
  { id: 'left', label: '左臂' },
  { id: 'right', label: '右臂' },
  { id: 'body', label: '躯干' },
  { id: 'head', label: '头部' },
  { id: 'other', label: '其他关节' },
];

export function presetJointDefinitions(definitions = []) {
  const seen = new Set();
  return definitions.filter((joint) => {
    if (!joint?.name || seen.has(joint.name) || /wheel/i.test(joint.name)
      || !['revolute', 'continuous', 'prismatic'].includes(joint.type)) return false;
    seen.add(joint.name);
    return true;
  });
}

export function groupPresetJoints(joints) {
  const grouped = new Map(GROUPS.map((group) => [group.id, []]));
  joints.forEach((joint) => {
    const name = joint.name;
    const group = isRobotBodyJoint(name) || /(torso|trunk|spine|lift)/i.test(name) ? 'body'
      : /(head|neck)/i.test(name) ? 'head'
        : /^left[_-]/i.test(name) ? 'left'
          : /^right[_-]/i.test(name) ? 'right' : 'other';
    grouped.get(group).push(joint);
  });
  return GROUPS.flatMap((group) => grouped.get(group.id).length
    ? [{ ...group, joints: grouped.get(group.id) }] : []);
}

export function presetMatchesRobot(pose, robot) {
  const poseKey = pose?.robot?.id || pose?.robot?.relativePath;
  const robotKey = robot?.id || robot?.relativePath;
  return Boolean(poseKey && robotKey && poseKey === robotKey);
}

export function jointValueToInput(value, joint, unit) {
  return joint.type !== 'prismatic' && unit === 'radian' ? value * Math.PI / 180 : value;
}

export function jointValueFromInput(text, joint, unit) {
  if (String(text).trim() === '') return Number.NaN;
  const value = Number(text);
  if (!Number.isFinite(value)) return Number.NaN;
  return joint.type !== 'prismatic' && unit === 'radian' ? value * 180 / Math.PI : value;
}

export function jointPresetErrors(joints, values) {
  return Object.fromEntries(joints.flatMap((joint) => {
    const value = values[joint.name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return [[joint.name, '请输入有效数值']];
    const tolerance = 1e-8;
    if ((Number.isFinite(joint.lower) && value < joint.lower - tolerance)
      || (Number.isFinite(joint.upper) && value > joint.upper + tolerance)) {
      return [[joint.name, '超出关节限位']];
    }
    return [];
  }));
}

export function readRobotPresetFile(text, definitions, fileName) {
  const data = parseAbxJson(String(text).replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('预设姿态文件必须是 JSON 对象');
  }
  if (!['deg', 'rad'].includes(data.unit)) throw new Error('预设姿态 unit 必须是 deg（角度）或 rad（弧度）');
  const groups = data.joints;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)
    || Object.keys(groups).length !== Object.keys(ABX_JOINT_NAMES).length
    || Object.keys(groups).some((key) => !Object.hasOwn(ABX_JOINT_NAMES, key))) {
    throw new Error('joints 必须包含 head、torso、left_arm、right_arm 四组关节');
  }
  const byName = new Map(presetJointDefinitions(definitions).map((joint) => [joint.name, joint]));
  const unit = data.unit === 'rad' ? 'radian' : 'degree';
  const joints = [], values = {};
  for (const [group, names] of Object.entries(ABX_JOINT_NAMES)) {
    if (!Array.isArray(groups[group]) || groups[group].length !== names.length) {
      throw new Error(`${group} 必须包含 ${names.length} 个关节值`);
    }
    names.forEach((name, index) => {
      const value = groups[group][index];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${group}[${index}] 必须是有效数值`);
      }
      const joint = byName.get(name);
      if (!joint || joint.type === 'prismatic') throw new Error(`当前机器人缺少兼容的旋转关节：${name}`);
      joints.push(joint);
      values[name] = jointValueFromInput(value, joint, unit);
    });
  }
  const errors = Object.entries(jointPresetErrors(joints, values));
  if (errors.length) throw new Error(`${errors[0][0]}：${errors[0][1]}`);
  return {
    name: String(fileName || '').replace(/\.json$/i, '').trim().slice(0, 80) || '导入姿态',
    unit,
    joints,
    values,
  };
}

export function createRobotJointPreset({ id, name, robot, joints, values, sequence = 1 }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('请输入预设姿态名称');
  if (!robot || !(robot.id || robot.relativePath)) throw new Error('请先加载机器人模型');
  const definitions = presetJointDefinitions(joints);
  if (!definitions.length) throw new Error('当前机器人没有可设置的姿态关节');
  const errors = Object.entries(jointPresetErrors(definitions, values));
  if (errors.length) throw new Error(`${errors[0][0]}：${errors[0][1]}`);
  const timestamp = new Date().toISOString();
  return {
    id,
    name: trimmedName,
    sequence,
    createdAt: timestamp,
    updatedAt: timestamp,
    robot: { id: robot.id || robot.relativePath, name: robot.name, relativePath: robot.relativePath },
    joints: {
      angularUnit: 'degree',
      linearUnit: 'meter',
      source: 'robot-preset',
      count: definitions.length,
      values: Object.fromEntries(definitions.map((joint) => [
        joint.name,
        Math.max(joint.lower ?? -Infinity, Math.min(joint.upper ?? Infinity, values[joint.name])),
      ])),
    },
  };
}
