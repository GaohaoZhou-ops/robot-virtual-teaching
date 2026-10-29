import { MathUtils, Quaternion, Vector3 } from 'three';

export const MOBILE_TORSO_PITCH_JOINTS = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'];

// Three parallel pitch joints cannot remove roll about their common plane.
// Measure that plane from the actual hierarchy, including the root transform
// and the workbench's XYZ base rotation; Euler.roll alone is not the tilt.
// This is a lower bound even if every pitch lock and limit were released.
export function mobileChestTiltLowerBound(robot, chest) {
  if (!chest) return null;
  robot.updateWorldMatrix(true, true);
  const ancestors = [];
  for (let node = chest; node && node !== robot; node = node.parent) ancestors.push(node);
  const joints = MOBILE_TORSO_PITCH_JOINTS.map((name) => robot.getObjectByName(name));
  if (joints.some((joint) => !joint || joint.userData.jointType !== 'revolute' || !ancestors.includes(joint))) return null;
  const axisOf = (joint) => new Vector3().fromArray(joint.userData.jointAxis || [0, 0, 1])
    .applyQuaternion(joint.getWorldQuaternion(new Quaternion())).normalize();
  const axis = axisOf(joints[0]), up = new Vector3(0, 0, 1).applyQuaternion(chest.getWorldQuaternion(new Quaternion()));
  if (Math.abs(axis.dot(up)) > 1e-6 || joints.some((joint) => axisOf(joint).cross(axis).length() > 1e-6)) return null;
  const chestPitchIndex = Math.min(...joints.map((joint) => ancestors.indexOf(joint)));
  // Do not diagnose a pitch-only restriction on a different robot with an
  // extra roll joint or a yaw joint above the pitch chain. Only chest yaw
  // below all pitch joints, about its own up axis, leaves the plane fixed.
  if (ancestors.some((joint) => ['revolute', 'continuous'].includes(joint.userData.jointType)
    && !joints.includes(joint) && (ancestors.indexOf(joint) > chestPitchIndex
      || axisOf(joint).cross(up).length() > 1e-6))) return null;
  // Allow the tiny fixed-axis rounding error present in the URDF.
  return Math.max(0, MathUtils.radToDeg(Math.asin(Math.min(1, Math.abs(axis.z))))
    - MathUtils.radToDeg(Math.asin(Math.min(1, Math.abs(axis.dot(up))))));
}
