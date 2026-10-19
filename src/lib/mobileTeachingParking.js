import * as THREE from 'three';
import { normalizeRobotPose } from './robotLoader.js';

export const mobileParkingKey = (pose) => [pose.position.x, pose.position.y, pose.position.z,
  pose.rpy.roll, pose.rpy.pitch, pose.rpy.yaw].map((value) => Number(value).toFixed(5)).join(':');

export function mobileSolutionMapPose(report, row, side = row?.selectedSide) {
  return normalizeRobotPose(row?.solutions?.[side]?.mapPose || row?.mapPose || report.mapPose);
}

export function mobileParkingCandidates(target, initialPose, previousPose, mode) {
  const initial = normalizeRobotPose(initialPose), poses = [], keys = new Set();
  const initialQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(initial.rpy[axis])), 'XYZ',
  ));
  const initialForward = new THREE.Vector3(1, 0, 0).applyQuaternion(initialQuaternion);
  const initialHeading = Math.atan2(initialForward.y, initialForward.x);
  const orientationAtHeading = (heading) => {
    // The workbench stores XYZ Euler angles. Editing only Euler.z turns about
    // the tilted local Z axis, which can introduce an uncompensatable chest
    // roll. Parking turns must rotate the complete chassis around world Z.
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), heading - initialHeading)
      .multiply(initialQuaternion);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
    return Object.fromEntries(['roll', 'pitch', 'yaw'].map((axis, i) => {
      const value = THREE.MathUtils.radToDeg(euler[['x', 'y', 'z'][i]]);
      return [axis, Math.abs(value) < 1e-10 ? 0 : value];
    }));
  };
  const add = (pose) => {
    const key = mobileParkingKey(pose);
    if (!keys.has(key)) { keys.add(key); poses.push(pose); }
  };
  if (mode === 'fixed') return [initial];
  if (mode === 'auto') { if (previousPose) add(normalizeRobotPose(previousPose)); add(initial); }
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(target.quaternion).setZ(0);
  if (forward.lengthSq() < 1e-6) forward.set(Math.cos(initialHeading), Math.sin(initialHeading), 0);
  forward.normalize();
  const heading = Math.atan2(forward.y, forward.x);
  // Keep the support height and chassis tilt; search x/y and world heading. A camera
  // looking down at a part still places the chassis behind its optical centre.
  for (const [distance, lateral, yawOffset] of [
    [0.45, 0, 0], [0.65, 0, 0], [0.3, 0, 0],
    [0.45, 0.25, 0], [0.45, -0.25, 0],
    [0.5, 0, 30], [0.5, 0, -30], [0.8, 0, 0],
    [0.65, 0.3, 30], [0.65, -0.3, -30],
    [0.4, 0, 60], [0.4, 0, -60], [0.3, 0, 180],
  ]) {
    const angle = heading + THREE.MathUtils.degToRad(yawOffset), x = Math.cos(angle), y = Math.sin(angle);
    add({ position: { x: target.position.x - distance * x - lateral * y,
      y: target.position.y - distance * y + lateral * x, z: initial.position.z },
    rpy: orientationAtHeading(Math.atan2(y, x)) });
  }
  return poses;
}
