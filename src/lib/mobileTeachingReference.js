import { applyRobotJointValues, readRobotJointValues } from './robotLoader.js';
import { presetMatchesRobot } from './robotJointPresets.js';

export function normalizeMobileReferencePose(value = { type: 'current' }) {
  if (value?.type === 'current') return { type: 'current' };
  if (value?.type !== 'preset' || ![value.id, value.name, value.robotId].every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('请选择有效的参考起始姿态');
  }
  const { angularUnit = 'degree', linearUnit = 'meter', values } = value.joints || {};
  const angular = ['degree', 'degrees', 'deg'].includes(angularUnit) ? 'degree'
    : ['radian', 'radians', 'rad'].includes(angularUnit) ? 'radian' : null;
  if (!angular || linearUnit !== 'meter') throw new Error('参考姿态的关节单位无效');
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length
    || !Object.entries(values).every(([name, joint]) => name && Number.isFinite(joint))) {
    throw new Error('参考姿态缺少有效的关节值');
  }
  return { type: 'preset', id: value.id, name: value.name, robotId: value.robotId,
    joints: { angularUnit: angular, linearUnit: 'meter', values: { ...values } } };
}

export function mobileReferenceFromPreset(preset, robot) {
  if (preset?.joints?.source !== 'robot-preset' || !presetMatchesRobot(preset, robot)) {
    throw new Error('参考预设已不存在或不属于当前机器人，请重新选择');
  }
  return normalizeMobileReferencePose({ type: 'preset', id: preset.id, name: preset.name,
    robotId: robot.id || robot.relativePath, joints: preset.joints });
}

// Only call this on the solver's private model. Locks retain the live values;
// joints absent from a preset (including wheels) also retain their live values.
export function applyMobileReferencePose(robot, reference, locked) {
  const normalized = normalizeMobileReferencePose(reference);
  if (normalized.type === 'current') return readRobotJointValues(robot);
  const values = {};
  for (const [name, value] of Object.entries(normalized.joints.values)) {
    const joint = robot.getObjectByName(name), type = joint?.userData.jointType;
    if (!['revolute', 'continuous', 'prismatic'].includes(type) || /wheel/i.test(name)) {
      throw new Error(`参考姿态包含不兼容的关节：${name}`);
    }
    const internal = type === 'prismatic' || normalized.joints.angularUnit === 'radian' ? value : value * Math.PI / 180;
    const { lower = -Infinity, upper = Infinity } = joint.userData.jointLimit || {};
    if (!Number.isFinite(internal) || internal < lower - 1e-8 || internal > upper + 1e-8) {
      throw new Error(`参考姿态超出关节限位：${name}`);
    }
    if (!locked.has(name)) values[name] = type === 'prismatic' ? internal : internal * 180 / Math.PI;
  }
  return applyRobotJointValues(robot, values);
}
