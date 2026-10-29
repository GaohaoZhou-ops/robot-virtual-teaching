import { normalizeRobotPose } from "../../robot/model/robotLoader.js";
import * as THREE from 'three';
import { normalizeDegrees } from './robotTelemetry.js';

export const createEndEffectorLocks = () => ({ left: null, right: null });

export const ROBOT_DRAG_UNDO_LIMIT = 50;

export const sameNumericValues = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => Math.abs((a[key] ?? 0) - (b[key] ?? 0)) < 1e-8);
};

export const sameRobotPose = (a, b) => (
  sameNumericValues(a.position, b.position) && sameNumericValues(a.rpy, b.rpy)
);

export const cloneEndEffectorLocks = (locks) => Object.fromEntries(
  Object.entries(locks).map(([side, lock]) => [side, !lock ? null : {
    ...lock,
    ...(lock.type === 'body' ? { jointValues: new Map(lock.jointValues) } : {
      referenceJointValues: lock.referenceJointValues && { ...lock.referenceJointValues },
      pose: normalizeRobotPose(lock.pose),
      targetPosition: lock.targetPosition.clone(),
      targetQuaternion: lock.targetQuaternion.clone(),
      lastResult: lock.lastResult && {
        ...lock.lastResult,
        actualPose: normalizeRobotPose(lock.lastResult.actualPose),
      },
    }),
  }]),
);

export const endEffectorLockModes = (locks) => ({
  left: locks?.left?.type || null,
  right: locks?.right?.type || null,
});

export const endEffectorLockFlags = (locks) => ({
  left: Boolean(locks?.left),
  right: Boolean(locks?.right),
});

export const writeEndEffectorLockDataset = (canvas, locks, activeSide = null) => {
  if (!canvas) return;
  const flags = endEffectorLockFlags(locks);
  const modes = endEffectorLockModes(locks);
  canvas.dataset.endEffectorLeftLocked = flags.left ? 'true' : 'false';
  canvas.dataset.endEffectorRightLocked = flags.right ? 'true' : 'false';
  canvas.dataset.endEffectorLeftLockMode = modes.left || 'free';
  canvas.dataset.endEffectorRightLockMode = modes.right || 'free';
  canvas.dataset.endEffectorLockCount = String(Number(flags.left) + Number(flags.right));
  canvas.dataset.endEffectorGlobalLockCount = String(
    Number(modes.left === 'map') + Number(modes.right === 'map'),
  );
  canvas.dataset.endEffectorActiveLocked =
    activeSide && flags[activeSide] ? 'true' : 'false';
  canvas.dataset.endEffectorActiveLockMode =
    activeSide ? modes[activeSide] || 'free' : 'free';
  canvas.dataset.endEffectorLockedJointCount = String(
    Object.values(locks || {}).reduce(
      (count, lock) => count + (lock?.jointValues?.size || 0),
      0,
    ),
  );
  ['left', 'right'].forEach((side) => {
    const prefix = side === 'left' ? 'endEffectorLeft' : 'endEffectorRight';
    const pose = locks?.[side]?.type === 'map' ? locks[side].pose : null;
    if (!pose) {
      delete canvas.dataset[`${prefix}MapTargetX`];
      delete canvas.dataset[`${prefix}MapTargetY`];
      delete canvas.dataset[`${prefix}MapTargetZ`];
      delete canvas.dataset[`${prefix}MapTargetRoll`];
      delete canvas.dataset[`${prefix}MapTargetPitch`];
      delete canvas.dataset[`${prefix}MapTargetYaw`];
      delete canvas.dataset[`${prefix}MapActualX`];
      delete canvas.dataset[`${prefix}MapActualY`];
      delete canvas.dataset[`${prefix}MapActualZ`];
      delete canvas.dataset[`${prefix}MapPositionError`];
      delete canvas.dataset[`${prefix}MapRotationError`];
      delete canvas.dataset[`${prefix}MapIkStatus`];
      return;
    }
    canvas.dataset[`${prefix}MapTargetX`] = pose.position.x.toFixed(6);
    canvas.dataset[`${prefix}MapTargetY`] = pose.position.y.toFixed(6);
    canvas.dataset[`${prefix}MapTargetZ`] = pose.position.z.toFixed(6);
    canvas.dataset[`${prefix}MapTargetRoll`] = pose.rpy.roll.toFixed(6);
    canvas.dataset[`${prefix}MapTargetPitch`] = pose.rpy.pitch.toFixed(6);
    canvas.dataset[`${prefix}MapTargetYaw`] = pose.rpy.yaw.toFixed(6);
  });
};

export const poseFromWorldObject = (object) => {
  const position = object.getWorldPosition(new THREE.Vector3());
  const quaternion = object.getWorldQuaternion(new THREE.Quaternion());
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'ZYX');
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rpy: {
      roll: normalizeDegrees(THREE.MathUtils.radToDeg(euler.x)),
      pitch: normalizeDegrees(THREE.MathUtils.radToDeg(euler.y)),
      yaw: normalizeDegrees(THREE.MathUtils.radToDeg(euler.z)),
    },
  };
};

export const zividOpticalPoseFromObject = (frame, side) => {
  if (!frame) return null;
  const position = frame.getWorldPosition(new THREE.Vector3());
  const quaternion = frame.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
  return {
    side,
    frameName: frame.name,
    position: { x: position.x, y: position.y, z: position.z },
    quaternion: {
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    },
    forward: { x: forward.x, y: forward.y, z: forward.z },
  };
};

export const parkingMergeTargetFromSnapshot = (value, side) => {
  if (!value?.position || !value?.quaternion) return null;
  const positionValues = ['x', 'y', 'z'].map((axis) => Number(value.position[axis]));
  const quaternionValues = ['x', 'y', 'z', 'w'].map((axis) => Number(value.quaternion[axis]));
  if (![...positionValues, ...quaternionValues].every(Number.isFinite)) return null;
  const quaternion = new THREE.Quaternion(...quaternionValues);
  if (quaternion.lengthSq() < 1e-12) return null;
  quaternion.normalize();
  return {
    side,
    frameName: String(value.frameName || `zivid_${side}_optical_frame`),
    source: 'camera-capture',
    position: new THREE.Vector3(...positionValues),
    quaternion,
  };
};

export const parkingMergeTargetFromFrame = (frame, side) => {
  if (!frame) return null;
  return {
    side,
    frameName: frame.name,
    source: 'forward-kinematics',
    position: frame.getWorldPosition(new THREE.Vector3()),
    quaternion: frame.getWorldQuaternion(new THREE.Quaternion()).normalize(),
  };
};

export const measureParkingMergeTarget = (frame, target) => {
  if (!frame || !target) {
    return { positionError: Number.POSITIVE_INFINITY, rotationError: Number.POSITIVE_INFINITY };
  }
  const position = frame.getWorldPosition(new THREE.Vector3());
  const quaternion = frame.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const quaternionDot = THREE.MathUtils.clamp(
    Math.abs(quaternion.dot(target.quaternion)),
    -1,
    1,
  );
  return {
    positionError: position.distanceTo(target.position),
    rotationError: THREE.MathUtils.radToDeg(2 * Math.acos(quaternionDot)),
  };
};

export const applyPoseToWorldTarget = (target, value) => {
  const pose = normalizeRobotPose(value);
  target.position.set(pose.position.x, pose.position.y, pose.position.z);
  target.quaternion.setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(pose.rpy.roll),
      THREE.MathUtils.degToRad(pose.rpy.pitch),
      THREE.MathUtils.degToRad(pose.rpy.yaw),
      'ZYX',
    ),
  );
  target.updateMatrixWorld(true);
  return pose;
};

export const createEndEffectorSpaceBall = () => {
  const group = new THREE.Group();
  group.name = 'end-effector-space-ball';
  // Keep the tool centre completely open so the gripper remains visible.
  // The RGB rings alone communicate 3D orientation without an occluding mesh.
  group.userData.baseRadius = 0.17;
  const rings = [
    { color: 0xf0443e, rotation: [0, Math.PI / 2, 0] },
    { color: 0x38c75a, rotation: [Math.PI / 2, 0, 0] },
    { color: 0x3c82f6, rotation: [0, 0, 0] },
  ].map(({ color, rotation }, index) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.155 + index * 0.006, 0.006, 8, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.82,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    ring.rotation.set(...rotation);
    return ring;
  });
  group.add(...rings);
  group.traverse((object) => { object.renderOrder = 35; });
  return group;
};

export const endEffectorSideForObject = (object) => {
  let current = object;
  while (current) {
    if (['left', 'right'].includes(current.userData?.endEffectorSide)) {
      return current.userData.endEffectorSide;
    }
    current = current.parent;
  }
  return null;
};

export const expandObjectBoundsInFrame = (bounds, object, frameInverse) => {
  object.traverse((child) => {
    const geometry = child.geometry;
    if (!geometry?.getAttribute?.('position')) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
    const relativeMatrix = new THREE.Matrix4().multiplyMatrices(
      frameInverse,
      child.matrixWorld,
    );
    const { min, max } = geometry.boundingBox;
    [min.x, max.x].forEach((x) => {
      [min.y, max.y].forEach((y) => {
        [min.z, max.z].forEach((z) => {
          bounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(relativeMatrix));
        });
      });
    });
  });
};

export const createRobotChassisDragHandle = (robot, metadata = {}) => {
  robot.updateMatrixWorld(true);
  const frame = robot.getObjectByName('base_link') || robot;
  frame.updateWorldMatrix(true, true);
  const frameInverse = frame.matrixWorld.clone().invert();
  const localBounds = new THREE.Box3();
  const baseVisuals = frame.children.filter(
    (child) => child.userData?.urdfType === 'visual',
  );
  baseVisuals.forEach((object) => {
    expandObjectBoundsInFrame(localBounds, object, frameInverse);
  });

  if (localBounds.isEmpty()) {
    const sourceMin = Array.isArray(metadata.bounds?.min)
      ? new THREE.Vector3().fromArray(metadata.bounds.min)
      : new THREE.Vector3(-0.25, -0.25, 0);
    const sourceMax = Array.isArray(metadata.bounds?.max)
      ? new THREE.Vector3().fromArray(metadata.bounds.max)
      : new THREE.Vector3(0.25, 0.25, 0.2);
    const height = Math.max((sourceMax.z - sourceMin.z) * 0.18, 0.12);
    localBounds.min.set(sourceMin.x, sourceMin.y, sourceMin.z);
    localBounds.max.set(sourceMax.x, sourceMax.y, sourceMin.z + height);
  }

  const size = localBounds.getSize(new THREE.Vector3());
  const center = localBounds.getCenter(new THREE.Vector3());
  const longestSide = Math.max(size.x, size.y, size.z, 0.25);
  const padding = THREE.MathUtils.clamp(longestSide * 0.045, 0.015, 0.05);
  size.x = Math.max(size.x + padding * 2, 0.22);
  size.y = Math.max(size.y + padding * 2, 0.22);
  size.z = Math.max(size.z + padding * 1.2, 0.12);

  const target = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  target.name = 'robot-chassis-planar-drag-target';
  target.position.copy(center);
  target.userData.robotChassisDragTarget = true;
  frame.add(target);

  const guideRadius = Math.max(size.x, size.y) * 0.68;
  const guide = new THREE.Group();
  guide.name = 'robot-chassis-planar-drag-guide';
  guide.visible = false;
  guide.position.set(0, 0, 0.012);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(guideRadius * 0.985, guideRadius, 64),
    new THREE.MeshBasicMaterial({
      color: 0xf4c95d,
      transparent: true,
      opacity: 0.86,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  const guideLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-guideRadius, 0, 0),
      new THREE.Vector3(guideRadius, 0, 0),
      new THREE.Vector3(0, -guideRadius, 0),
      new THREE.Vector3(0, guideRadius, 0),
    ]),
    new THREE.LineBasicMaterial({
      color: 0xf4c95d,
      transparent: true,
      opacity: 0.56,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  guide.add(ring, guideLines);
  guide.traverse((object) => { object.renderOrder = 34; });
  frame.add(guide);

  return { frame, target, guide, localBounds, size };
};
