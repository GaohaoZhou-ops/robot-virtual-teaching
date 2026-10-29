import { normalizeRobotPose, applyRobotJointValues, normalizeRobotJointValues } from "../../robot/model/robotLoader.js";
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import { ROBOT_PARKING_GHOST_COLOR, ROBOT_PARKING_GHOST_OPACITY } from './viewportConfig.js';
import { applyRobotPose } from './robotTelemetry.js';

export const clearRobotParkingGhostLayer = (layer) => {
  if (!layer) return;
  const resources = layer.userData?.ownedResources;
  if (resources instanceof Set) {
    resources.forEach((resource) => resource?.dispose?.());
  }
  layer.clear();
  layer.userData.ownedResources = new Set();
};

export const writePolylineExecutionGhostDataset = (canvas, entries) => {
  if (!canvas) return;
  const ghosts = [...entries.values()];
  canvas.dataset.polylineExecutionGhostState = ghosts.some(({ layer }) => layer.visible) ? 'visible' : 'hidden';
  canvas.dataset.polylineExecutionGhostCount = String(ghosts.length);
  canvas.dataset.polylineExecutionGhostMeshCount = String(ghosts.reduce((sum, { visual }) => sum + visual.meshCount, 0));
  canvas.dataset.polylineExecutionGhosts = JSON.stringify(ghosts.map(({ snapshot }) => snapshot));
};

export const writeRobotParkingGhostHiddenDataset = (canvas) => {
  if (!canvas) return;
  canvas.dataset.parkingGhostState = 'hidden';
  canvas.dataset.parkingGhostKind = '';
  canvas.dataset.parkingGhostTargetId = '';
  canvas.dataset.parkingGhostPoseId = '';
  canvas.dataset.parkingGhostMeshCount = '0';
  canvas.dataset.parkingGhostJointCount = '0';
  canvas.dataset.parkingGhostJointValues = '';
  canvas.dataset.parkingGhostPlanarDistance = '';
  canvas.dataset.parkingGhostStraightDistance = '';
  canvas.dataset.parkingGhostDeltaZ = '';
};

export const measureRobotParkingGhost = (sourcePose, targetPose) => {
  const source = normalizeRobotPose(sourcePose);
  const target = normalizeRobotPose(targetPose);
  const deltaX = target.position.x - source.position.x;
  const deltaY = target.position.y - source.position.y;
  const deltaZ = target.position.z - source.position.z;
  return {
    deltaX,
    deltaY,
    deltaZ,
    planarDistance: Math.hypot(deltaX, deltaY),
    straightDistance: Math.hypot(deltaX, deltaY, deltaZ),
  };
};

export const copyRobotJointMetadata = (source, clone) => {
  if (!source || !clone) return;
  if (source.userData?.jointType) {
    clone.userData.jointType = source.userData.jointType;
    clone.userData.jointAxis = [...(source.userData.jointAxis || [0, 0, 1])];
    clone.userData.jointLimit = { ...(source.userData.jointLimit || {}) };
    clone.userData.armSoftLimitRatio = source.userData.armSoftLimitRatio;
    clone.userData.armSoftLimitRange = source.userData.armSoftLimitRange ? { ...source.userData.armSoftLimitRange } : undefined;
    clone.userData.restPosition = [...(source.userData.restPosition || source.position.toArray())];
    clone.userData.restQuaternion = [
      ...(source.userData.restQuaternion || source.quaternion.toArray()),
    ];
    clone.userData.jointValue = Number(source.userData.jointValue) || 0;
  }
  source.children.forEach((child, index) => {
    copyRobotJointMetadata(child, clone.children[index]);
  });
};

export const createRobotParkingGhostVisual = (liveRobot, ghost) => {
  const resources = new Set();
  const ghostRobot = cloneSkeleton(liveRobot);
  copyRobotJointMetadata(liveRobot, ghostRobot);
  applyRobotJointValues(ghostRobot, ghost.jointValues);
  ghostRobot.name = `parking-ghost:${ghost.parkingPointName || ghost.parkingPointId}`;
  ghostRobot.userData.isRobotParkingGhost = true;
  let meshCount = 0;

  ghostRobot.traverse((object) => {
    const sourceMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const isInteractionHelper = (
      object.userData?.robotChassisDragTarget
      || /^end-effector-.*-double-click-target$/.test(object.name || '')
      || object.name === 'robot-chassis-planar-drag-guide'
      || sourceMaterials.some((material) => material?.colorWrite === false)
    );
    if (isInteractionHelper) {
      object.visible = false;
      return;
    }

    let material = null;
    if (object.isMesh) {
      material = new THREE.MeshBasicMaterial({
        color: ROBOT_PARKING_GHOST_COLOR,
        transparent: true,
        opacity: ROBOT_PARKING_GHOST_OPACITY,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      meshCount += 1;
    } else if (object.isLine || object.isLineSegments) {
      material = new THREE.LineBasicMaterial({
        color: ROBOT_PARKING_GHOST_COLOR,
        transparent: true,
        opacity: ROBOT_PARKING_GHOST_OPACITY * 1.7,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
    } else if (object.isPoints) {
      material = new THREE.PointsMaterial({
        color: ROBOT_PARKING_GHOST_COLOR,
        transparent: true,
        opacity: ROBOT_PARKING_GHOST_OPACITY,
        depthTest: true,
        depthWrite: false,
        size: 0.012,
        sizeAttenuation: true,
        toneMapped: false,
      });
    } else if (object.isSprite) {
      object.visible = false;
    }
    if (!material) return;
    object.material = material;
    object.castShadow = false;
    object.receiveShadow = false;
    object.renderOrder = 23;
    object.userData.isRobotParkingGhost = true;
    resources.add(material);
  });

  const targetPose = normalizeRobotPose(ghost.targetPose);
  const metadata = liveRobot.userData?.robot || {};
  const modelSize = Math.max(
    0.5,
    ...(Array.isArray(metadata.bounds?.size)
      ? metadata.bounds.size.map((value) => Math.abs(Number(value) || 0))
      : [1]),
  );
  const ringRadius = THREE.MathUtils.clamp(modelSize * 0.2, 0.18, 0.85);
  const guideLift = THREE.MathUtils.clamp(ringRadius * 0.08, 0.018, 0.065);

  const poseRoot = new THREE.Group();
  poseRoot.name = 'robot-parking-ghost-pose';
  poseRoot.add(ghostRobot);
  applyRobotPose(poseRoot, targetPose);

  const targetMarker = new THREE.Group();
  targetMarker.name = 'robot-parking-ghost-target-marker';
  targetMarker.position.set(
    targetPose.position.x,
    targetPose.position.y,
    targetPose.position.z + guideLift,
  );
  const ringGeometry = new THREE.RingGeometry(ringRadius * 0.86, ringRadius, 72);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: ROBOT_PARKING_GHOST_COLOR,
    transparent: true,
    opacity: 0.86,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.renderOrder = 29;
  const pulseGeometry = new THREE.RingGeometry(ringRadius * 1.02, ringRadius * 1.075, 72);
  const pulseMaterial = new THREE.MeshBasicMaterial({
    color: ROBOT_PARKING_GHOST_COLOR,
    transparent: true,
    opacity: 0.28,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const pulseRing = new THREE.Mesh(pulseGeometry, pulseMaterial);
  pulseRing.renderOrder = 28;
  targetMarker.add(ring, pulseRing);
  resources.add(ringGeometry);
  resources.add(ringMaterial);
  resources.add(pulseGeometry);
  resources.add(pulseMaterial);

  const forward = new THREE.Vector3(
    Math.cos(THREE.MathUtils.degToRad(targetPose.rpy.yaw)),
    Math.sin(THREE.MathUtils.degToRad(targetPose.rpy.yaw)),
    0,
  );
  const orientationArrow = new THREE.ArrowHelper(
    forward,
    targetMarker.position,
    ringRadius * 0.78,
    ROBOT_PARKING_GHOST_COLOR,
    ringRadius * 0.22,
    ringRadius * 0.1,
  );
  [orientationArrow.line, orientationArrow.cone].forEach((object) => {
    object.material.transparent = true;
    object.material.opacity = 0.92;
    object.material.depthTest = false;
    object.material.depthWrite = false;
    object.renderOrder = 30;
    resources.add(object.material);
  });

  const distanceArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(),
    1,
    ROBOT_PARKING_GHOST_COLOR,
    Math.max(ringRadius * 0.24, 0.05),
    Math.max(ringRadius * 0.1, 0.025),
  );
  distanceArrow.name = 'robot-parking-ghost-distance-guide';
  [distanceArrow.line, distanceArrow.cone].forEach((object) => {
    object.material.transparent = true;
    object.material.opacity = object === distanceArrow.line ? 0.64 : 0.9;
    object.material.depthTest = false;
    object.material.depthWrite = false;
    object.renderOrder = 28;
    resources.add(object.material);
  });

  return {
    objects: [poseRoot, targetMarker, orientationArrow, distanceArrow],
    resources,
    poseRoot,
    ghostRobot,
    targetMarker,
    pulseRing,
    distanceArrow,
    targetPose,
    targetPosition: new THREE.Vector3(
      targetPose.position.x,
      targetPose.position.y,
      targetPose.position.z + guideLift,
    ),
    ringRadius,
    guideLift,
    meshCount,
    jointCount: Object.keys(normalizeRobotJointValues(ghost.jointValues)).length,
  };
};

export const updateRobotParkingGhostGuide = (visual, sourcePose, canvas) => {
  if (!visual) return measureRobotParkingGhost(sourcePose, null);
  const source = normalizeRobotPose(sourcePose);
  const metrics = measureRobotParkingGhost(source, visual.targetPose);
  const start = new THREE.Vector3(
    source.position.x,
    source.position.y,
    source.position.z + visual.guideLift,
  );
  const delta = visual.targetPosition.clone().sub(start);
  const length = delta.length();
  visual.distanceArrow.position.copy(start);
  visual.distanceArrow.visible = length > 1e-4;
  if (visual.distanceArrow.visible) {
    visual.distanceArrow.setDirection(delta.normalize());
    const headLength = Math.min(
      Math.max(visual.ringRadius * 0.24, 0.05),
      length * 0.34,
    );
    visual.distanceArrow.setLength(
      length,
      headLength,
      Math.max(headLength * 0.42, 0.025),
    );
  }
  if (canvas) {
    canvas.dataset.parkingGhostPlanarDistance = metrics.planarDistance.toFixed(6);
    canvas.dataset.parkingGhostStraightDistance = metrics.straightDistance.toFixed(6);
    canvas.dataset.parkingGhostDeltaZ = metrics.deltaZ.toFixed(6);
  }
  return metrics;
};
