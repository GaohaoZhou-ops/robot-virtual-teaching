import { getRobotEndEffector } from './robotLoader.js';
import { isRobotBodyJoint } from './robotJointLocks.js';

// BOTX's waist pose also uses the knee/ankle chain for height and pitch.
export const isPolylineWaistJoint = (joint) => isRobotBodyJoint(joint) || /torso|chest/i.test(joint.name);
export const polylineWaistEnabled = (path) => Boolean(path.base?.waistAssist && !path.base.sync && !path.base.search);

export function polylineJointExclusions(controller, path, lockedJointNames = []) {
  const opposite = getRobotEndEffector(controller.robot, path.side === 'left' ? 'right' : 'left');
  const locked = new Set(lockedJointNames), waist = polylineWaistEnabled(path);
  return new Set(controller.joints.filter((joint) => {
    if (/head|neck/i.test(joint.name)) return true;
    // Waist assistance grants permission only to this planner's copy. Do not
    // modify the user's global locks or restore an old lock snapshot on exit.
    if (isPolylineWaistJoint(joint)) return !waist;
    if (locked.has(joint.name)) return true;
    return opposite?.joints.includes(joint);
  }));
}
