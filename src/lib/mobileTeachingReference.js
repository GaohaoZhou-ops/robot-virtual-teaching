import { applyRobotJointValues, readRobotJointValues } from './robotLoader.js';
import { getRobotJointLimits } from './robotJointLimits.js';
import { isRobotJointPreset, presetMatchesRobot } from './robotJointPresets.js';
import { MOBILE_TORSO_PITCH_JOINTS } from './mobileTeachingChest.js';

export function mobileUpperBodyJoints(robot) {
  const joints = [];
  robot.traverse((joint) => {
    if (['revolute', 'continuous', 'prismatic'].includes(joint.userData.jointType)
      && !/wheel/i.test(joint.name) && !MOBILE_TORSO_PITCH_JOINTS.includes(joint.name)) joints.push(joint);
  });
  return joints;
}

// Compare joints in the robot's own frame. Chassis heading/translation never
// penalize a good upper-body reference; the three height joints stay free to
// lift and level the chest. Keep angular and linear display units separate.
export function mobileReferenceMetrics(joints, reference) {
  let cost = 0, angularCount = 0, linearCount = 0, angle = 0, distance = 0;
  for (const joint of joints) {
    const linear = joint.userData.jointType === 'prismatic';
    let delta = joint.userData.jointValue - (reference[joint.name] || 0) * (linear ? 1 : Math.PI / 180);
    if (joint.userData.jointType === 'continuous') delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    cost += (delta / (linear ? 0.5 : Math.PI)) ** 2;
    if (linear) { distance += Math.abs(delta); linearCount += 1; }
    else { angle += Math.abs(delta) * 180 / Math.PI; angularCount += 1; }
  }
  return { cost: cost / Math.max(1, joints.length), angularCount, linearCount,
    meanAngleDegrees: angularCount ? angle / angularCount : null,
    meanDistanceMeters: linearCount ? distance / linearCount : null };
}

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
  if (!isRobotJointPreset(preset) || !presetMatchesRobot(preset, robot)) {
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
    const { lower, upper } = getRobotJointLimits(joint);
    if (!Number.isFinite(internal) || internal < lower - 1e-8 || internal > upper + 1e-8) {
      throw new Error(`参考姿态超出关节限位：${name}`);
    }
    if (!locked.has(name)) values[name] = type === 'prismatic' ? internal : internal * 180 / Math.PI;
  }
  return applyRobotJointValues(robot, values);
}
