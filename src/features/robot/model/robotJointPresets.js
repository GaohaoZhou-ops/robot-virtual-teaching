import { isRobotBodyJoint } from "../../../shared/robotics/robotJointLocks.js";
import { ABX_JOINT_NAMES, parseAbxJson } from "../../teaching/model/abxFormat.js";

const GROUPS = [
  { id: 'left', label: '左臂' },
  { id: 'right', label: '右臂' },
  { id: 'body', label: '躯干' },
  { id: 'head', label: '头部' },
  { id: 'other', label: '其他关节' },
];

// Both UI entry points record reusable robot poses. Keep the source marker as
// provenance, but use the same library/export classification everywhere.
export const isRobotJointPreset = (pose) => ['robot-preset', 'joint-console'].includes(pose?.joints?.source);

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

export function validateRobotPresetName(name, poses = [], robot = null, excludedId = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('请输入预设姿态名称');
  if (trimmed.length > 80) throw new Error('预设姿态名称不能超过 80 个字符');
  if (poses.some((pose) => pose.id !== excludedId && presetMatchesRobot(pose, robot)
    && pose.name.trim() === trimmed)) {
    throw new Error('当前机器人已有同名姿态，请使用其他名称');
  }
  return trimmed;
}

export function robotPresetValuesForEditing(pose, definitions) {
  const unit = pose.joints?.angularUnit || 'degree';
  if (!['degree', 'degrees', 'deg', 'radian', 'radians', 'rad'].includes(unit)) {
    throw new Error('预设姿态的关节角度单位无效');
  }
  const radians = ['radian', 'radians', 'rad'].includes(unit);
  return Object.fromEntries(definitions.filter((joint) => Object.hasOwn(pose.joints?.values || {}, joint.name))
    .map((joint) => [joint.name, pose.joints.values[joint.name]
      * (radians && joint.type !== 'prismatic' ? 180 / Math.PI : 1)]));
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
      return [[joint.name, joint.softLimitRatio
        ? `超出关节软限位（${joint.softLimitCustom ? '自定义范围，占硬限位' : '硬限位中间'} ${Number((joint.softLimitRatio * 100).toFixed(2))}%）` : '超出关节限位']];
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

export function buildRobotPresetFile(joints) {
  const unit = joints?.angularUnit || 'degree';
  const factor = ['degree', 'degrees', 'deg'].includes(unit) ? 1
    : ['radian', 'radians', 'rad'].includes(unit) ? 180 / Math.PI : null;
  if (factor === null) throw new Error(`姿态角度单位不受支持：${unit}`);
  return {
    unit: 'deg',
    joints: Object.fromEntries(Object.entries(ABX_JOINT_NAMES).map(([group, names]) => [
      group, names.map((name) => {
        const value = joints?.values?.[name];
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(value * factor)) {
          throw new Error(`姿态缺少有效关节值：${name}`);
        }
        return value * factor;
      }),
    ])),
  };
}

export function createRobotJointPreset({ id, name, robot, joints, values, sequence = 1 }) {
  const trimmedName = validateRobotPresetName(name);
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
