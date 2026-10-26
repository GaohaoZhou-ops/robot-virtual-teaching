import * as THREE from 'three';
import { setRobotJointValue } from './robotLoader.js';
import { getRobotJointLimits } from './robotJointLimits.js';

const PITCH_JOINTS = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'];
const PITCH_WEIGHT = 0.6;
const FORWARD_WEIGHT = 0.08;
const radians = THREE.MathUtils.degToRad;
const degrees = THREE.MathUtils.radToDeg;

export function createRobotTorsoController(robot, center = new THREE.Vector3()) {
  const chest = robot.getObjectByName('waist_yaw_L');
  const base = robot.getObjectByName('base_link');
  const pitchJoints = PITCH_JOINTS.map((name) => robot.getObjectByName(name));
  const yawJoint = robot.getObjectByName('waist_yaw_J');
  if (!chest || !base || [...pitchJoints, yawJoint].some((joint) =>
    !joint || joint.userData.jointType !== 'revolute')) return null;
  const frame = new THREE.Object3D();
  frame.name = 'torso-control-frame';
  frame.position.copy(center);
  chest.add(frame);
  const joints = [...pitchJoints, yawJoint];
  const maxHeight = joints.reduce((length, joint) =>
    length + new THREE.Vector3().fromArray(joint.userData.restPosition).length(), center.length());
  return {
    side: 'torso', robot, base, chest, frame, joints, pitchJoints, yawJoint,
    get limits() {
      const yaw = getRobotJointLimits(yawJoint);
      return {
        height: [0, maxHeight],
        yaw: [degrees(yaw.lower), degrees(yaw.upper)],
        pitch: ['lower', 'upper'].map((bound) => degrees(pitchJoints.reduce(
          (sum, joint) => sum + getRobotJointLimits(joint)[bound], 0,
        ))),
      };
    },
  };
}

export function readRobotTorsoPose(controller) {
  controller.robot.updateMatrixWorld(true);
  const position = controller.base.worldToLocal(controller.frame.getWorldPosition(new THREE.Vector3()));
  return {
    height: position.z,
    forward: position.x,
    yaw: degrees(controller.yawJoint.userData.jointValue),
    pitch: degrees(controller.pitchJoints.reduce((sum, joint) => sum + joint.userData.jointValue, 0)),
  };
}

// Height and tilt are task-space goals. The three pitch joints cooperate while
// forward displacement is a soft preference, so tilting at full extension still
// works. Multi-start bending escapes the straight-leg height singularity.
export function solveRobotTorsoPose(controller, requested, referenceForward) {
  const { robot, base, frame, pitchJoints, yawJoint } = controller;
  const original = readRobotTorsoPose(controller);
  const target = Object.fromEntries(['height', 'yaw', 'pitch'].map((axis) => [
    axis, Number.isFinite(Number(requested[axis])) ? Number(requested[axis]) : original[axis],
  ]));
  setRobotJointValue(yawJoint, radians(target.yaw));
  const initial = pitchJoints.map((joint) => joint.userData.jointValue);
  const forward = Number.isFinite(referenceForward) ? referenceForward : original.forward;
  const inverseBase = base.getWorldQuaternion(new THREE.Quaternion()).invert();
  const point = new THREE.Vector3();
  const jointPoint = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const derivative = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const setValues = (values) => {
    pitchJoints.forEach((joint, index) => setRobotJointValue(joint, values[index]));
    robot.updateMatrixWorld(true);
  };
  const measure = () => {
    const pose = readRobotTorsoPose(controller);
    const error = new THREE.Vector3(
      target.height - pose.height,
      radians(target.pitch - pose.pitch) * PITCH_WEIGHT,
      (forward - pose.forward) * FORWARD_WEIGHT,
    );
    return { pose, error, cost: error.lengthSq() };
  };
  let best = { ...measure(), values: [...initial] };
  const seeds = [initial, [0.16, -0.32, 0.16], [0.44, -0.88, 0.44]].map((values, index) =>
    index ? initial.map((value, joint) => value + values[joint]) : values);
  for (const seed of seeds) {
    if (best.cost < 1e-10) break;
    setValues(seed);
    for (let iteration = 0; iteration < 70; iteration += 1) {
      const current = measure();
      const values = pitchJoints.map((joint) => joint.userData.jointValue);
      if (current.cost < best.cost) best = { ...current, values };
      if (current.cost < 1e-10) break;
      frame.getWorldPosition(point);
      const columns = pitchJoints.map((joint) => {
        joint.getWorldPosition(jointPoint);
        joint.getWorldQuaternion(quaternion);
        axis.fromArray(joint.userData.jointAxis).applyQuaternion(quaternion).normalize();
        derivative.crossVectors(axis, point.clone().sub(jointPoint)).applyQuaternion(inverseBase);
        return new THREE.Vector3(derivative.z, PITCH_WEIGHT, derivative.x * FORWARD_WEIGHT);
      });
      const normal = new THREE.Matrix3().set(
        columns[0].dot(columns[0]) + 0.0001, columns[0].dot(columns[1]), columns[0].dot(columns[2]),
        columns[1].dot(columns[0]), columns[1].dot(columns[1]) + 0.0001, columns[1].dot(columns[2]),
        columns[2].dot(columns[0]), columns[2].dot(columns[1]), columns[2].dot(columns[2]) + 0.0001,
      );
      const step = new THREE.Vector3(...columns.map((column) => column.dot(current.error)))
        .applyMatrix3(normal.invert()).toArray();
      const stepScale = Math.min(1, 0.18 / Math.max(...step.map(Math.abs), 1e-12));
      let improved = false;
      for (const scale of [1, 0.5, 0.25, 0.1]) {
        setValues(values.map((value, index) => value + step[index] * stepScale * scale));
        if (measure().cost < current.cost - 1e-13) {
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    const result = measure();
    if (result.cost < best.cost) {
      best = { ...result, values: pitchJoints.map((joint) => joint.userData.jointValue) };
    }
  }
  setValues(best.values);
  const pose = readRobotTorsoPose(controller);
  const heightError = Math.abs(target.height - pose.height);
  const rotationError = Math.max(Math.abs(target.pitch - pose.pitch), Math.abs(target.yaw - pose.yaw));
  return {
    pose, target, heightError, rotationError,
    status: heightError < 0.005 && rotationError < 0.5 ? 'tracking' : 'limited',
  };
}
