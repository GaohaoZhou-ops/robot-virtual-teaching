import { Matrix4, Vector3, Quaternion } from 'three';
import { HAND_EYE_CALIBRATION_FILES, parseHandEyeCalibration, readOptionalCalibration } from '../../../shared/robotics/handEyeCalibration.js';

export function applyRobotCameraCalibration(robot, side, calibration) {
  const tool = robot.getObjectByName(`tool_${side}`);
  const optical = robot.getObjectByName(`zivid_${side}_optical_frame`);
  const joint = optical?.parent;
  if (!tool || !optical || joint?.userData.jointType !== 'fixed' || !joint.parent) {
    throw new Error('模型缺少对应工具坐标系或固定光学坐标系');
  }
  const { rotation: r, translation_m: t } = calibration.cameraToTool;
  const toolFromCamera = new Matrix4().set(...r[0], t[0], ...r[1], t[1], ...r[2], t[2], 0, 0, 0, 1);
  robot.updateWorldMatrix(true, true);
  // Keep the housing and kinematic joints in their existing frames. Replace
  // the optical joint's local transform, accounting for the mounting chain.
  const local = joint.parent.matrixWorld.clone().invert().multiply(tool.matrixWorld)
    .multiply(toolFromCamera).multiply(optical.matrix.clone().invert());
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
  local.decompose(position, quaternion, scale);
  if (![...position, ...quaternion, ...scale].every(Number.isFinite)
    || scale.distanceTo(new Vector3(1, 1, 1)) > 1e-4) throw new Error('光学坐标变换无效');
  joint.position.copy(position); joint.quaternion.copy(quaternion).normalize();
  joint.userData.restPosition = joint.position.toArray();
  joint.userData.restQuaternion = joint.quaternion.toArray();
  robot.updateWorldMatrix(true, true);
}

export async function loadRobotCameraCalibrations(robot, resolveUrl, options = {}) {
  const sides = ['left', 'right'].filter((side) => robot.getObjectByName(`zivid_${side}_link`)
    || robot.getObjectByName(`zivid_${side}_optical_frame`));
  if (!sides.length) return null;
  const entries = await Promise.all(sides.map(async (side) => {
    const source = HAND_EYE_CALIBRATION_FILES[side];
    let state;
    try {
      const resource = await readOptionalCalibration(resolveUrl(source), options);
      if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      if (resource.status === 'read') {
        const calibration = parseHandEyeCalibration(resource.text);
        applyRobotCameraCalibration(robot, side, calibration);
        state = { status: 'loaded', source, ...calibration };
      } else state = { ...resource, source };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      state = { status: 'invalid', source, message: error.message || '标定文件无效' };
    }
    const optical = robot.getObjectByName(`zivid_${side}_optical_frame`);
    if (optical) optical.userData.cameraCalibration = state;
    return [side, state];
  }));
  return Object.fromEntries(entries);
}
