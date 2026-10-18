import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

export const ZERO_MODEL_ORIGIN = Object.freeze({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 });
const FIELDS = Object.keys(ZERO_MODEL_ORIGIN);
const ANGLES = ['roll', 'pitch', 'yaw'];
const DEGREES = 180 / Math.PI;

export function readModelOrigin(origin) {
  if (!origin || FIELDS.some((field) => origin[field] === '' || origin[field] == null || !Number.isFinite(Number(origin[field])))) return null;
  return Object.fromEntries(FIELDS.map((field) => [field, Number(origin[field])]));
}

// The fields describe the new frame in source coordinates. Moving the model
// in that frame therefore uses the inverse of the entered frame pose.
export function modelMatrixFromOrigin(origin) {
  const pose = readModelOrigin(origin);
  if (!pose) return null;
  return new Matrix4().compose(
    new Vector3(pose.x, pose.y, pose.z),
    new Quaternion().setFromEuler(new Euler(pose.roll / DEGREES, pose.pitch / DEGREES, pose.yaw / DEGREES, 'ZYX')),
    new Vector3(1, 1, 1),
  ).invert();
}

export function modelPoseFromOrigin(origin, center) {
  const matrix = modelMatrixFromOrigin(origin);
  if (!matrix) return null;
  return {
    position: center.clone().applyMatrix4(matrix),
    quaternion: new Quaternion().setFromRotationMatrix(matrix),
  };
}

export function originFromModelPose(position, quaternion, center, previousOrigin, mode) {
  const previous = readModelOrigin(previousOrigin) || ZERO_MODEL_ORIGIN;
  const frameRotation = quaternion.clone().invert().normalize();
  const framePosition = center.clone().sub(position.clone().applyQuaternion(frameRotation));
  let angles = ANGLES.map((field) => previous[field]);
  if (mode !== 'translate') {
    const matrix = new Matrix4().makeRotationFromQuaternion(frameRotation).elements;
    const cosPitch = Math.hypot(matrix[0], matrix[1]);
    const pitch = Math.atan2(-matrix[2], cosPitch);
    // Preserve precision near +/-90 degrees; Three's general Euler conversion
    // snaps to its singular branch earlier than an editing/export tool should.
    const roll = cosPitch > 1e-10 ? Math.atan2(matrix[6], matrix[10]) : previous.roll / DEGREES;
    const yaw = cosPitch > 1e-10 ? Math.atan2(matrix[1], matrix[0])
      : Math.atan2(-matrix[4], matrix[5]) + Math.sign(pitch) * roll;
    const base = [roll, pitch, yaw].map((value) => value * DEGREES);
    // Equivalent Euler branches avoid unnecessary +/-180 jumps during a drag.
    const candidates = [base, [base[0] + 180, 180 - base[1], base[2] + 180]]
      .map((candidate) => candidate.map((value, index) => value + 360 * Math.round((angles[index] - value) / 360)));
    const distance = (candidate) => candidate.reduce((sum, value, index) => sum + (value - angles[index]) ** 2, 0);
    angles = candidates.sort((a, b) => distance(a) - distance(b))[0];
  }
  const clean = (value) => Math.abs(value) < 1e-10 ? 0 : Number(value.toPrecision(12));
  const values = [...framePosition.toArray(), ...angles];
  return Object.fromEntries(FIELDS.map((field, index) => [field, clean(values[index])]));
}
