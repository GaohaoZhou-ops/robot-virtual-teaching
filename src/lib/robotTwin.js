export const ROBOT_TWIN_PREFIX = '/__atlas/robot-twin';
export const ROBOT_TWIN_INTERVAL = 200;
export const ROBOT_TWIN_MAX_AGE = 1500;
export const DEFAULT_ROBOT_TWIN_ADDRESS = '192.168.0.112:9090';

const finite = Number.isFinite;
const freshAge = (age, elapsed) => finite(age) && age >= 0 && age + elapsed < ROBOT_TWIN_MAX_AGE;
const groups = [['torso', 0, 4], ['head', 4, 6], ['left_arm', 6, 13], ['right_arm', 13, 20]];

// ABX SDK order is supplied by the robot's model metadata, never inferred from
// URDF traversal order. Workbench rotations are degrees; ABX feedback is radians.
export function robotTwinSnapshot({ slam, state, model, elapsedMs = 0, errors = [] }) {
  const sample = slam?.sample;
  const pose = sample?.pose;
  const localizationFresh = slam?.fresh === true && freshAge(slam.age_ms, elapsedMs)
    && sample?.ok === true && sample.source === 'slam_websocket'
    && sample.scene?.mode === 'kLocalization' && sample.scene?.operation_running === false
    && [pose?.x_m, pose?.y_m, pose?.yaw_rad, pose?.yaw_rad * 180 / Math.PI].every(finite);
  const names = model?.joint_names_sdk_order;
  const mappingValid = Array.isArray(names) && names.length === 20 && new Set(names).size === 20
    && names.every((name) => typeof name === 'string' && name.trim() === name && name.length > 0
      && !['__proto__', 'constructor', 'prototype'].includes(name));
  const robot = state?.robot;
  const joints = {};
  if (mappingValid && robot?.valid === true && robot.state_fresh === true
    && robot.health_fresh === true && freshAge(robot.state_age_ms, elapsedMs)) {
    for (const [group, start, end] of groups) {
      const samples = robot.joint_samples?.[group];
      if (!Array.isArray(samples) || samples.length !== end - start) continue;
      samples.forEach((joint, index) => {
        const degrees = joint?.position_rad * 180 / Math.PI;
        if (joint?.valid === true && joint.fresh === true && finite(joint.position_rad) && finite(degrees)) {
          joints[names[start + index]] = degrees;
        }
      });
    }
  }
  const warnings = [...errors];
  if (!localizationFresh) warnings.push(sample?.source === 'mock_slam'
    ? '机器人正在使用模拟定位，未作为真机数据同步' : 'SLAM 定位未就绪或已过期，保留上次位置');
  if (!mappingValid) warnings.push('机器人关节映射不可用');
  else if (Object.keys(joints).length !== 20) warnings.push('部分关节反馈未就绪或已过期，保留上次姿态');
  return {
    pose: localizationFresh ? { x: pose.x_m, y: pose.y_m, yaw: pose.yaw_rad * 180 / Math.PI } : null,
    joints,
    jointCount: Object.keys(joints).length,
    expectedJointCount: 20,
    modelName: typeof model?.name === 'string' ? model.name : '',
    localizationFresh,
    // No fallback to state.localization: it is SDK odometry, a different frame.
    poseValidForMs: localizationFresh ? ROBOT_TWIN_MAX_AGE - slam.age_ms - elapsedMs : 0,
    jointsValidForMs: Object.keys(joints).length ? ROBOT_TWIN_MAX_AGE - robot.state_age_ms - elapsedMs : 0,
    warnings,
  };
}

export function robotTwinDisplayPose(offlinePose, livePose) {
  if (!livePose) return offlinePose;
  return { position: { ...offlinePose.position, x: livePose.x, y: livePose.y },
    rpy: { roll: 0, pitch: 0, yaw: livePose.yaw } };
}
