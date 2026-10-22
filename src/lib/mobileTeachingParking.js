import * as THREE from 'three';
import { normalizeRobotPose } from './robotLoader.js';

export const mobileParkingKey = (pose) => [pose.position.x, pose.position.y, pose.position.z,
  pose.rpy.roll, pose.rpy.pitch, pose.rpy.yaw].map((value) => Number(value).toFixed(5)).join(':');

export function mobileSolutionMapPose(report, row, side = row?.selectedSide) {
  return normalizeRobotPose(row?.solutions?.[side]?.mapPose || row?.mapPose || report.mapPose);
}

export function mobileParkingSupportPose(pose, { parkingMode = 'auto', baseSupport = 'current' } = {}) {
  const result = normalizeRobotPose(pose);
  if (parkingMode === 'fixed' || baseSupport !== 'level') return result;
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(result.rpy[axis])), 'XYZ',
  ));
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  return { position: { ...result.position }, rpy: { roll: 0, pitch: 0,
    yaw: THREE.MathUtils.radToDeg(Math.atan2(forward.y, forward.x)) } };
}

// Compromise between two reference-camera placements at one supported base.
// Try both arm assignments and headings; the solver must still validate both
// targets independently (and jointly before making a simultaneous motion).
export function mobileCooperativeParkingCandidates(target, neighbour, initialPose, options = {}) {
  const frames = options.referenceFrames || [], poses = [];
  for (const first of frames) for (const second of frames) {
    if (first.side === second.side) continue;
    const placements = [[target, first], [neighbour, second]].map(([goal, frame]) =>
      mobileParkingCandidates(goal, initialPose, null, 'per-pose', { ...options, referenceFrames: [frame] })[0]);
    const quaternions = placements.map((pose) => new THREE.Quaternion().setFromEuler(new THREE.Euler(
      ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(pose.rpy[axis])), 'XYZ')));
    for (const fraction of [0.5, 0, 1]) {
      const quaternion = quaternions[0].clone().slerp(quaternions[1], fraction);
      const offset = first.position.clone().add(second.position).applyQuaternion(quaternion);
      const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
      poses.push({ position: { x: (target.position.x + neighbour.position.x - offset.x) / 2,
        y: (target.position.y + neighbour.position.y - offset.y) / 2, z: placements[0].position.z },
      rpy: Object.fromEntries(['roll', 'pitch', 'yaw'].map((axis, i) => {
        const value = THREE.MathUtils.radToDeg(euler[['x', 'y', 'z'][i]]);
        return [axis, Math.abs(value) < 1e-10 ? 0 : value];
      })) });
    }
  }
  return poses;
}

export function mobileParkingCandidates(target, initialPose, previousPose, mode,
  { refineClearance = false, baseSupport = 'current', referenceFrames = [] } = {}) {
  const initial = mobileParkingSupportPose(initialPose, { parkingMode: mode, baseSupport }), poses = [], keys = new Set();
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
  // Invert the reference camera FK to place the chassis. Align the complete
  // camera orientation about world Z (including cameras looking vertically),
  // then match its XY position. Z stays on the chosen support plane.
  const referenceHeadings = referenceFrames.map((frame) => {
    const actual = initialQuaternion.clone().multiply(frame.quaternion);
    const relative = target.quaternion.clone().multiply(actual.invert());
    const turn = Math.hypot(relative.z, relative.w) > 1e-10 ? 2 * Math.atan2(relative.z, relative.w) : 0;
    return { frame, heading: initialHeading + turn };
  });
  const addReference = ({ frame, heading }, turn = 0, back = 0, lateral = 0) => {
    const angle = heading + THREE.MathUtils.degToRad(turn), rpy = orientationAtHeading(angle);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(rpy[axis])), 'XYZ',
    ));
    const offset = frame.position.clone().applyQuaternion(quaternion);
    add({ position: { x: target.position.x - offset.x - back * Math.cos(angle) - lateral * Math.sin(angle),
      y: target.position.y - offset.y - back * Math.sin(angle) + lateral * Math.cos(angle), z: initial.position.z }, rpy });
  };
  referenceHeadings.forEach((reference) => addReference(reference));
  if (mode === 'auto') {
    if (previousPose) add(mobileParkingSupportPose(previousPose, { baseSupport }));
    add(initial);
  }
  for (const turn of [30, -30, 60, -60, 90, -90, 180]) referenceHeadings.forEach((reference) => addReference(reference, turn));
  if (refineClearance) for (const [back, lateral] of [[0.15, 0], [0, 0.15], [0, -0.15]]) {
    referenceHeadings.forEach((reference) => addReference(reference, 0, back, lateral));
  }
  if (refineClearance && mode === 'auto') {
    const reference = normalizeRobotPose(previousPose || initial);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...['roll', 'pitch', 'yaw']
      .map((axis) => THREE.MathUtils.degToRad(reference.rpy[axis])), 'XYZ'));
    const direction = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const heading = Math.atan2(direction.y, direction.x), x = Math.cos(heading), y = Math.sin(heading);
    // Small chassis adjustments can free an elbow without abandoning the
    // workpiece or changing the support height / world-up tilt convention.
    for (const [back, lateral, turn] of [[0.2, 0, 0], [0, 0.2, 0], [0, -0.2, 0], [0.15, 0, 20], [0.15, 0, -20]]) {
      add({ position: { x: reference.position.x - back * x - lateral * y,
        y: reference.position.y - back * y + lateral * x, z: initial.position.z },
      rpy: orientationAtHeading(heading + THREE.MathUtils.degToRad(turn)) });
    }
  }
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
    ...(refineClearance ? [[0.65, 0.4, 0], [0.65, -0.4, 0], [0.8, 0.25, 20], [0.8, -0.25, -20], [1, 0, 0]] : []),
  ]) {
    const angle = heading + THREE.MathUtils.degToRad(yawOffset), x = Math.cos(angle), y = Math.sin(angle);
    add({ position: { x: target.position.x - distance * x - lateral * y,
      y: target.position.y - distance * y + lateral * x, z: initial.position.z },
    rpy: orientationAtHeading(Math.atan2(y, x)) });
  }
  return poses;
}
