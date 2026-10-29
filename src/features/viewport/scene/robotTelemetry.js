import { normalizeRobotPose, readRobotJointValues } from "../../robot/model/robotLoader.js";
import * as THREE from 'three';
import { normalizeRobotJointLocks } from "../../../shared/robotics/robotJointLocks.js";

export const normalizeDegrees = (value) => {
  const wrapped = ((Number(value) + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped) < 1e-12 ? 0 : wrapped;
};

export const applyRobotPose = (layer, value) => {
  if (!layer) return normalizeRobotPose(value);
  const pose = normalizeRobotPose(value);
  layer.position.set(pose.position.x, pose.position.y, pose.position.z);
  layer.rotation.set(
    THREE.MathUtils.degToRad(pose.rpy.roll),
    THREE.MathUtils.degToRad(pose.rpy.pitch),
    THREE.MathUtils.degToRad(pose.rpy.yaw),
    'XYZ',
  );
  layer.updateMatrixWorld(true);
  return pose;
};

export const writeRobotPoseDataset = (canvas, value) => {
  if (!canvas) return;
  const pose = normalizeRobotPose(value);
  canvas.dataset.robotX = pose.position.x.toFixed(6);
  canvas.dataset.robotY = pose.position.y.toFixed(6);
  canvas.dataset.robotZ = pose.position.z.toFixed(6);
  canvas.dataset.robotRoll = pose.rpy.roll.toFixed(6);
  canvas.dataset.robotPitch = pose.rpy.pitch.toFixed(6);
  canvas.dataset.robotYaw = pose.rpy.yaw.toFixed(6);
  canvas.dataset.robotOrigin = [
    pose.position.x,
    pose.position.y,
    pose.position.z,
  ].join(',');
};

export const clearRobotJointDataset = (canvas) => {
  if (!canvas) return;
  delete canvas.dataset.robotJointValues;
  delete canvas.dataset.robotJointTransforms;
  delete canvas.dataset.robotJointApplySource;
  canvas.dataset.robotJointAppliedCount = '0';
};

export const writeRobotJointLockDataset = (canvas, lockedJointNames) => {
  if (!canvas) return;
  const names = normalizeRobotJointLocks(lockedJointNames);
  canvas.dataset.robotJointLockCount = String(names.length);
  canvas.dataset.robotJointLockedNames = JSON.stringify(names);
};

export const writeRobotJointDataset = (canvas, robot, source = 'scene', measured = null) => {
  if (!robot) return {};
  if (!measured) robot.updateMatrixWorld(true);
  const values = measured?.values || readRobotJointValues(robot);
  const joints = measured?.joints || Object.keys(values).map((name) => robot.getObjectByName(name)).filter(Boolean);
  const transforms = Object.fromEntries(
    joints.map((joint) => [joint.name, {
      position: joint.position.toArray(),
      quaternion: joint.quaternion.toArray(),
    }]),
  );
  if (!canvas) return values;
  canvas.dataset.robotJointValues = JSON.stringify(values);
  canvas.dataset.robotJointTransforms = JSON.stringify(transforms);
  canvas.dataset.robotJointApplySource = source;
  canvas.dataset.robotJointAppliedCount = String(Object.keys(transforms).length);
  canvas.dataset.robotJointApplyRevision = String(
    Number(canvas.dataset.robotJointApplyRevision || 0) + 1,
  );
  return values;
};
