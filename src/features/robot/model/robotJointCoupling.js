import { getRobotJointLimits } from "./robotJointLimits.js";

export const ARM_JOINT_COUPLING_LIMIT = 1.8;
// Keep projected solutions strictly inside the mechanical boundary, including
// after degree/radian serialization. This is not a tolerance on acceptance.
export const ARM_JOINT_COUPLING_MARGIN = 1e-6;
export const normalizeArmJointCouplingEnabled = (value) => value !== false;

export function configureRobotJointCoupling(robot, enabled) {
  robot.userData.armJointCouplingEnabled = normalizeArmJointCouplingEnabled(enabled);
}

export function getRobotJointCouplingPairs(robot) {
  if (!normalizeArmJointCouplingEnabled(robot?.userData?.armJointCouplingEnabled)) return [];
  const arms = new Map();
  robot?.traverse((joint) => {
    const match = /^(left|right)[_-]J([67])$/i.exec(joint.name);
    if (!match || !['revolute', 'continuous'].includes(joint.userData?.jointType)) return;
    const side = match[1].toLowerCase();
    if (!arms.has(side)) arms.set(side, {});
    arms.get(side)[match[2]] = joint;
  });
  return [...arms.entries()].flatMap(([side, joints]) => joints[6] && joints[7]
    ? [{ side, joints: [joints[6], joints[7]] }] : []);
}

export function robotJointCouplingViolations(pairs) {
  return pairs.flatMap(({ side, joints }) => {
    const sum = joints.reduce((total, joint) => total + joint.userData.jointValue, 0);
    return Number.isFinite(sum) && Math.abs(sum) < ARM_JOINT_COUPLING_LIMIT ? []
      : [{ side, jointNames: joints.map((joint) => joint.name), sum, limit: ARM_JOINT_COUPLING_LIMIT }];
  });
}

// Project a simultaneous IK trial onto the coupled range, respecting both the
// independent joint bounds and locks. Never wrap angles: these are mechanical
// joint coordinates, not equivalent orientations modulo a full revolution.
export function projectRobotJointCoupling(pairs, movable, setJointValue) {
  const bound = ARM_JOINT_COUPLING_LIMIT - ARM_JOINT_COUPLING_MARGIN;
  for (const { joints } of pairs) {
    const sum = joints.reduce((total, joint) => total + joint.userData.jointValue, 0);
    if (!Number.isFinite(sum) || Math.abs(sum) <= bound) continue;
    const direction = Math.sign(sum);
    let remaining = Math.abs(sum) - bound;
    let free = joints.filter((joint) => movable.has(joint));
    // Two passes redistribute the correction if one joint reaches its own
    // bound; with one locked joint, the other takes the entire correction.
    for (let pass = 0; pass < 2 && free.length && remaining > 0; pass += 1) {
      const share = remaining / free.length;
      const next = [];
      for (const joint of free) {
        const { lower, upper } = getRobotJointLimits(joint);
        const before = joint.userData.jointValue;
        const room = Math.max(0, direction > 0 ? before - lower : upper - before);
        setJointValue(joint, before - direction * Math.min(share, room));
        remaining -= direction * (before - joint.userData.jointValue);
        if (room > share) next.push(joint);
      }
      free = next;
    }
  }
  return robotJointCouplingViolations(pairs).length === 0;
}
