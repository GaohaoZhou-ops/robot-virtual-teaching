import { configureRobotJointCoupling, getRobotJointCouplingPairs, robotJointCouplingViolations } from '../lib/robotJointCoupling.js';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createIPadCaptureLayer, createMobilePosePreview, disposeIPadCaptureLayer, mobileSamplePosition } from '../lib/ipadCaptureDisplay.js';
import { solveMobileTeachingInWorker } from '../lib/mobileTeachingWorker.js';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  Bot,
  Box,
  Camera,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Keyboard,
  Lock,
  MapPin,
  MousePointer2,
  Move3D,
  Palette,
  Rotate3D,
  RotateCcw,
  Route,
  Ruler,
  Save,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Unlock,
  X,
} from 'lucide-react';
import EndEffectorControlPanel from './EndEffectorControlPanel.jsx';
import PolylineTeachingPanel from './PolylineTeachingPanel.jsx';
import TorsoControlPanel from './TorsoControlPanel.jsx';
import { createRobotTorsoController, readRobotTorsoPose, solveRobotTorsoPose } from '../lib/robotTorsoControl.js';
import ViewerMenu from './ViewerMenu.jsx';
import TeachingSurfaceCoverage from './TeachingSurfaceCoverage.jsx';
import ViewportInteractionModeButton from './ViewportInteractionModeButton.jsx';
import { configureViewportTrackball, createViewportNavigation, DETAIL_DOLLY_FLOOR_RATIO, MAX_OPTICAL_ZOOM, VIEWPORT_DRAG_THRESHOLD, VIEWPORT_FOV, viewportWheelDelta } from '../lib/viewportNavigation.js';
import { applyScreenViewportGesture } from '../lib/ipadScreenViewport.js';
import { createIndependentGround, viewportDistanceScale } from '../lib/viewportReference.js';
import RobotDistanceWarning from './RobotDistanceWarning.jsx';
import RobotCollisionJointSettings from './RobotCollisionJointSettings.jsx';
import { RobotJointCouplingContext, RobotJointLimitContext } from './RobotJointLimitContext.js';
import { normalizeIgnoredCollisionJoints } from '../lib/robotCollisionSettings.js';
import { applyRobotModelOpacity } from '../lib/robotDisplay.js';
import {
  createUniformMeshIndex,
  MESH_RENDER_QUALITY_OPTIONS,
  prepareMapGeometryTopology,
  resolveMeshRenderQuality,
} from '../lib/mapGeometry.js';
import {
  clusterNearbyParkingPoints,
  createCommonParkingCandidates,
  DEFAULT_PARKING_CLUSTER_DISTANCE,
  DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
  DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
} from '../lib/parkingPointMerge.js';
import {
  applyRobotJointValues,
  configureRobotArmSoftLimits,
  disposeRobotModel,
  getRobotEndEffector,
  loadRobotModel,
  normalizeRobotJointValues,
  normalizeRobotPose,
  robotGroundLift,
  readRobotJointValues,
  setRobotVisualBounds,
  setRobotJointValue,
} from '../lib/robotLoader.js';
import { normalizeRobotJointLocks } from '../lib/robotJointLocks.js';
import { solveEndEffectorIk } from '../lib/robotEndEffectorIk.js';
import {
  collectTeachingVisionCoverageFrames,
  createTeachingSurfaceProjectionOverlay,
  createTeachingVisionCoverageVolume,
  disposeTeachingSurfaceProjectionOverlay,
  markTeachingSurfaceCoverageRange,
  prepareTeachingVisionCoverageFrames,
  TEACHING_SURFACE_PROJECTION_MODE,
  VISION_COVERAGE_EMPTY_CELL_MODE,
  VISION_COVERAGE_MODE,
  VISION_COVERAGE_SURFACE_STOP,
} from '../lib/visionCoverage.js';
import {
  applyRobotCollisionHighlights,
  collectRobotCollisionProxies,
  createRobotCollisionStatus,
  disposeRobotCollisionProxies,
  getRobotCollisionJointOptions,
  ROBOT_COLLISION_CHECK_INTERVAL_MS,
  ROBOT_COLLISION_CONTACT_MARGIN,
  ROBOT_COLLISION_SAFETY_DISTANCE,
  selectRobotCollisionProbe,
  serializeRobotCollisionProxies,
} from '../lib/robotCollision.js';
import { createRobotCollisionBackend } from '../lib/robotCollisionBackend.js';
import { buildWaypointLabels } from '../lib/waypointLabels.js';
import { buildPathLabels } from '../lib/pathLabels.js';
import { placedObjectLayers, placedObjectMask } from '../lib/placedObjectRendering.js';

const RESOLUTION_LEVELS = [
  { ratio: 0.05, label: '极速', tone: 'turbo' },
  { ratio: 0.1, label: '性能', tone: 'performance' },
  { ratio: 0.25, label: '性能', tone: 'performance' },
  { ratio: 0.5, label: '均衡', tone: 'balanced' },
  { ratio: 0.75, label: '高精', tone: 'precision' },
  { ratio: 1, label: '原始', tone: 'native' },
];

const DEFAULT_RESOLUTION_INDEX = RESOLUTION_LEVELS.length - 1;
const AUTO_POINT_BUDGET = 1_000_000;
const WAYPOINT_VOLUME_RATIO = 0.14;
const WAYPOINT_RADIUS_SCALE = Math.cbrt(WAYPOINT_VOLUME_RATIO);
// Keep the interaction target at its former size while making only the visible
// marker more compact, so dense waypoint layouts remain easy to select.
const WAYPOINT_HIT_RADIUS_SCALE = Math.cbrt(0.2) * 2.2;
const WAYPOINT_FOCUS_DISTANCE_RATIO = 0.17;
const PARKING_POINT_FOCUS_DISTANCE_SCALE = 1.5;
const WAYPOINT_DEFAULT_COLOR = '#ffd166';
const WAYPOINT_SELECTED_BODY_COLOR = '#59dbe8';
const WAYPOINT_SELECTED_HALO_COLOR = '#9b8cff';
const MIN_WAYPOINT_SCREEN_DIAMETER = 8;
const MAX_WAYPOINT_SCREEN_DIAMETER = 10;
const MAX_WAYPOINT_LOD_SCALE = 24;
const ROS_AXIS_SCREEN_LENGTH = 68;
const MIN_ROS_AXIS_LOD_SCALE = 1e-30;
const PICK_DRAG_THRESHOLD = VIEWPORT_DRAG_THRESHOLD;
const KEYBOARD_TAP_DURATION = 0.065;
const KEYBOARD_WORLD_SPEED_RATIO = 0.75;
const KEYBOARD_MIN_PROJECTED_AXIS = 1e-4;
const KEYBOARD_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const SPACEMOUSE_INPUT_STALE_MS = 180;
const SPACEMOUSE_WHEEL_GUARD_MS = 420;
const SPACEMOUSE_WHEEL_ARBITRATION_MS = 48;
const SPACEMOUSE_FILTER_ATTACK_SECONDS = 0.038;
const SPACEMOUSE_FILTER_RELEASE_SECONDS = 0.068;
const SPACEMOUSE_FILTER_EPSILON = 0.0025;
const SPACEMOUSE_FORWARD_SPEED_RATIO = 0.9;
const SPACEMOUSE_PAN_PIXELS_PER_SECOND = 640;
const SPACEMOUSE_ROTATION_SPEED = THREE.MathUtils.degToRad(125);
const SPACEMOUSE_AXIS_HUD_HOLD_MS = 1000;
const MAIN_VIEW_PREVIEW_CONTROL_EVENT = 'atlas-main-view-preview-control';
const SPACEMOUSE_VIEW_AXES = Object.freeze(['x', 'y', 'z', 'roll', 'pitch', 'yaw']);
const SPACEMOUSE_TRANSLATION_AXES = Object.freeze(['x', 'y', 'z']);
const SPACEMOUSE_ROTATION_AXES = Object.freeze(['roll', 'pitch', 'yaw']);
const SPACEMOUSE_AXIS_HUD_META = Object.freeze({
  x: { code: 'X', label: '前进 / 后退', group: 'XYZ' },
  y: { code: 'Y', label: '向左 / 向右', group: 'XYZ' },
  z: { code: 'Z', label: '向上 / 向下', group: 'XYZ' },
  roll: { code: 'ROLL', label: '左翻滚 / 右翻滚', group: 'RPY' },
  pitch: { code: 'PITCH', label: '前倾 / 后仰', group: 'RPY' },
  yaw: { code: 'YAW', label: '左偏航 / 右偏航', group: 'RPY' },
});
const ROBOT_LINEAR_SPEED = 0.9;
// Ground alignment is an occasional trim operation, so keep this deliberately
// slower than planar driving: a key tap changes height by roughly 8 mm.
const ROBOT_VERTICAL_SPEED = 0.12;
const ROBOT_ROTATION_SPEED = THREE.MathUtils.degToRad(72);
const ROBOT_PARKING_GHOST_COLOR = 0x63e6ee;
const ROBOT_PARKING_GHOST_OPACITY = 0.24;
const EMPTY_VISION_COVERAGE_STATS = Object.freeze({
  poseCount: 0,
  frameCount: 0,
  opticalPointCount: 0,
  coordinateFrameCount: 0,
  coordinateAxisCount: 0,
  cellCount: 0,
  hitCellCount: 0,
  renderCellCount: 0,
  omittedCellCount: 0,
  minimumDepth: null,
  maximumDepth: null,
});
const EMPTY_TEACHING_SURFACE_TINT_STATS = Object.freeze({
  status: 'hidden',
  coveredPointCount: 0,
  totalPointCount: 0,
});
const TEACHING_SURFACE_COVERAGE_ATTRIBUTE = 'atlasTeachingCoverage';
const TEACHING_SURFACE_TINT_CHUNK_SIZE = 50_000;
const TEACHING_SURFACE_TINT_OPACITY = 0.05;
const PROGRESSIVE_COVERAGE_PLAYBACK_STATUSES = new Set(['playing', 'paused', 'completed']);
const ROBOT_POSE_REPORT_INTERVAL = 70;
const ROBOT_JOINT_REPORT_INTERVAL = 70;
const ZIVID_CAMERA_POSE_REPORT_INTERVAL = 70;
const CHASSIS_CONTROL_AXIS_SCREEN_LENGTH = 72;
const COLLISION_INDEX_CELL_SIZE = 0.12;
const END_EFFECTOR_SCREEN_DIAMETER = 58;
const ROBOT_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const ROBOT_VERTICAL_CONTROL_CODES = new Set(['ArrowUp', 'ArrowDown']);
const KEYBOARD_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);
const KEYBOARD_KEY_CODES = {
  w: 'KeyW',
  a: 'KeyA',
  s: 'KeyS',
  d: 'KeyD',
  q: 'KeyQ',
  e: 'KeyE',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  shift: 'ShiftLeft',
};

const KEYBOARD_ROTATION_ACTIONS = {
  ArrowUp: 'pitch-up',
  ArrowDown: 'pitch-down',
  ArrowLeft: 'yaw-left',
  ArrowRight: 'yaw-right',
};

const KEYBOARD_VERTICAL_ACTIONS = {
  KeyQ: 'z-up',
  KeyE: 'z-down',
};

const ROBOT_CONTROL_ACTIONS = {
  KeyW: 'forward',
  KeyA: 'strafe-left',
  KeyS: 'backward',
  KeyD: 'strafe-right',
  ArrowUp: 'z-up',
  ArrowDown: 'z-down',
  ArrowLeft: 'yaw-left',
  ArrowRight: 'yaw-right',
};

const CAMERA_TEACH_ACTIONS = Object.freeze({
  near: { kind: 'translate', axis: [0, 0, 1], direction: 1 },
  far: { kind: 'translate', axis: [0, 0, 1], direction: -1 },
  up: { kind: 'translate', axis: [0, -1, 0], direction: 1 },
  down: { kind: 'translate', axis: [0, 1, 0], direction: 1 },
  left: { kind: 'translate', axis: [-1, 0, 0], direction: 1 },
  right: { kind: 'translate', axis: [1, 0, 0], direction: 1 },
  'yaw-left': { kind: 'rotate', axis: [0, 1, 0], direction: -1 },
  'yaw-right': { kind: 'rotate', axis: [0, 1, 0], direction: 1 },
  'pitch-up': { kind: 'rotate', axis: [1, 0, 0], direction: 1 },
  'pitch-down': { kind: 'rotate', axis: [1, 0, 0], direction: -1 },
  'roll-left': { kind: 'rotate', axis: [0, 0, 1], direction: -1 },
  'roll-right': { kind: 'rotate', axis: [0, 0, 1], direction: 1 },
});

const movementCodeForEvent = (event) =>
  KEYBOARD_CONTROL_CODES.has(event.code)
    ? event.code
    : KEYBOARD_KEY_CODES[String(event.key || '').toLowerCase()] || null;

const readViewVector = (value) => {
  if (!value) return null;
  const x = Number(Array.isArray(value) ? value[0] : value.x);
  const y = Number(Array.isArray(value) ? value[1] : value.y);
  const z = Number(Array.isArray(value) ? value[2] : value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
};

const normalizeCameraView = (value) => {
  if (!value || typeof value !== 'object') return null;
  const position = readViewVector(value.position);
  const target = readViewVector(value.target);
  const up = readViewVector(value.up);
  const zoom = Number(value.zoom);
  const projectionX = Number(value.projectionOffset?.x ?? value.precisionPan?.x ?? 0);
  const projectionY = Number(value.projectionOffset?.y ?? value.precisionPan?.y ?? 0);
  if (
    !position
    || !target
    || !up
    || !Number.isFinite(zoom)
    || zoom <= 0
    || !Number.isFinite(projectionX)
    || !Number.isFinite(projectionY)
  ) {
    return null;
  }
  const viewDistance = Math.hypot(
    position.x - target.x,
    position.y - target.y,
    position.z - target.z,
  );
  if (viewDistance < 1e-12 || Math.hypot(up.x, up.y, up.z) < 1e-12) return null;
  return {
    position,
    target,
    up,
    zoom: THREE.MathUtils.clamp(zoom, 1, MAX_OPTICAL_ZOOM),
    projectionOffset: { x: projectionX, y: projectionY },
  };
};

const cameraViewSignature = (view) => {
  const normalized = normalizeCameraView(view);
  if (!normalized) return '';
  return [
    normalized.position.x,
    normalized.position.y,
    normalized.position.z,
    normalized.target.x,
    normalized.target.y,
    normalized.target.z,
    normalized.up.x,
    normalized.up.y,
    normalized.up.z,
    normalized.zoom,
    normalized.projectionOffset.x,
    normalized.projectionOffset.y,
  ].map((value) => value.toExponential(12)).join('|');
};

const adaptiveResolutionIndex = (pointCount) => {
  if (!pointCount || pointCount <= AUTO_POINT_BUDGET) return DEFAULT_RESOLUTION_INDEX;
  for (let index = DEFAULT_RESOLUTION_INDEX - 1; index >= 0; index -= 1) {
    if (Math.round(pointCount * RESOLUTION_LEVELS[index].ratio) <= AUTO_POINT_BUDGET) {
      return index;
    }
  }
  return 0;
};

const formatPointCount = (count) => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  return String(count);
};

const formatHeight = (value) => (Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2));

const packCollisionPositions = (attribute) => {
  const count = attribute?.count || 0;
  if (
    attribute?.array instanceof Float32Array
    && !attribute.isInterleavedBufferAttribute
    && attribute.itemSize === 3
  ) {
    return attribute.array.slice(0, count * 3);
  }
  const packed = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    packed[offset] = attribute.getX(index);
    packed[offset + 1] = attribute.getY(index);
    packed[offset + 2] = attribute.getZ(index);
  }
  return packed;
};

const packCollisionIndices = (attribute) => {
  const count = attribute?.count || 0;
  if (attribute?.array instanceof Uint32Array && !attribute.isInterleavedBufferAttribute) {
    return attribute.array.slice(0, count);
  }
  if (attribute?.array instanceof Uint16Array && !attribute.isInterleavedBufferAttribute) {
    return Uint32Array.from(attribute.array.subarray(0, count));
  }
  const packed = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) packed[index] = attribute.getX(index);
  return packed;
};

const collisionStatusSignature = (status) => JSON.stringify({
  enabled: status.enabled,
  state: status.state,
  backend: status.backend,
  requestedBackend: status.requestedBackend,
  engine: status.engine,
  minimumDistance: Number.isFinite(status.minimumDistance)
    ? Number(status.minimumDistance).toFixed(4)
    : null,
  collisionLinks: status.collisionLinks,
  nearLinks: status.nearLinks,
  excludedLinks: status.excludedLinks,
  ignoredJointNames: status.ignoredJointNames,
  ignoredLinks: status.ignoredLinks,
  monitoredLinkCount: status.monitoredLinkCount,
  monitoredProxyCount: status.monitoredProxyCount,
  collisionModelProxyCount: status.collisionModelProxyCount,
  visualFallbackProxyCount: status.visualFallbackProxyCount,
  sourcePointCount: status.sourcePointCount,
  indexedPointCount: status.indexedPointCount,
  meshSampleCount: status.meshSampleCount,
  message: status.message,
  detail: status.detail,
});

const normalizeDegrees = (value) => {
  const wrapped = ((Number(value) + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped) < 1e-12 ? 0 : wrapped;
};

const applyRobotPose = (layer, value) => {
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

const writeRobotPoseDataset = (canvas, value) => {
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

const clearRobotJointDataset = (canvas) => {
  if (!canvas) return;
  delete canvas.dataset.robotJointValues;
  delete canvas.dataset.robotJointTransforms;
  delete canvas.dataset.robotJointApplySource;
  canvas.dataset.robotJointAppliedCount = '0';
};

const writeRobotJointLockDataset = (canvas, lockedJointNames) => {
  if (!canvas) return;
  const names = normalizeRobotJointLocks(lockedJointNames);
  canvas.dataset.robotJointLockCount = String(names.length);
  canvas.dataset.robotJointLockedNames = JSON.stringify(names);
};

const writeRobotJointDataset = (canvas, robot, source = 'scene') => {
  if (!robot) return {};
  robot.updateMatrixWorld(true);
  const values = readRobotJointValues(robot);
  const transforms = Object.fromEntries(
    Object.keys(values).flatMap((name) => {
      const joint = robot.getObjectByName(name);
      if (!joint) return [];
      return [[name, {
        position: joint.position.toArray(),
        quaternion: joint.quaternion.toArray(),
      }]];
    }),
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

const createEndEffectorLocks = () => ({ left: null, right: null });

const ROBOT_DRAG_UNDO_LIMIT = 50;
const sameNumericValues = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => Math.abs((a[key] ?? 0) - (b[key] ?? 0)) < 1e-8);
};
const sameRobotPose = (a, b) => (
  sameNumericValues(a.position, b.position) && sameNumericValues(a.rpy, b.rpy)
);
const cloneEndEffectorLocks = (locks) => Object.fromEntries(
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

const endEffectorLockModes = (locks) => ({
  left: locks?.left?.type || null,
  right: locks?.right?.type || null,
});

const endEffectorLockFlags = (locks) => ({
  left: Boolean(locks?.left),
  right: Boolean(locks?.right),
});

const writeEndEffectorLockDataset = (canvas, locks, activeSide = null) => {
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

const poseFromWorldObject = (object) => {
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

const zividOpticalPoseFromObject = (frame, side) => {
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

const parkingMergeTargetFromSnapshot = (value, side) => {
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

const parkingMergeTargetFromFrame = (frame, side) => {
  if (!frame) return null;
  return {
    side,
    frameName: frame.name,
    source: 'forward-kinematics',
    position: frame.getWorldPosition(new THREE.Vector3()),
    quaternion: frame.getWorldQuaternion(new THREE.Quaternion()).normalize(),
  };
};

const measureParkingMergeTarget = (frame, target) => {
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

const applyPoseToWorldTarget = (target, value) => {
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

const createEndEffectorSpaceBall = () => {
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

const endEffectorSideForObject = (object) => {
  let current = object;
  while (current) {
    if (['left', 'right'].includes(current.userData?.endEffectorSide)) {
      return current.userData.endEffectorSide;
    }
    current = current.parent;
  }
  return null;
};

const expandObjectBoundsInFrame = (bounds, object, frameInverse) => {
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

const createRobotChassisDragHandle = (robot, metadata = {}) => {
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

const colorModeValue = (mode) => (mode === 'height' ? 1 : mode === 'white' ? 2 : 0);
const POINT_COLOR_MODES = [
  { id: 'height', label: '高程色' },
  { id: 'source', label: '原始色' },
  { id: 'white', label: '纯白色' },
];

// Keep the source buffer untouched and perform all three color modes in the GPU.
// The five height stops match the on-screen scale from low (blue) to high (coral).
const installMapColorShader = (material, bounds, colorMode, { surface = false, objectColorMode = colorMode } = {}) => {
  material.userData.mapColorMode = colorMode;
  material.userData.objectColorMode = objectColorMode;
  material.defaultAttributeValues = { ...material.defaultAttributeValues, atlasPlacedObject: [0] };
  material.userData.teachingTintVisibility = 1;
  material.userData.teachingTintOpacity = TEACHING_SURFACE_TINT_OPACITY;
  if (surface) {
    material.extensions = { ...(material.extensions || {}), derivatives: true };
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlasPointColorMode = {
      value: colorModeValue(material.userData.mapColorMode),
    };
    shader.uniforms.atlasObjectColorMode = { value: colorModeValue(material.userData.objectColorMode) };
    shader.uniforms.atlasHeightMin = { value: bounds.min.z };
    shader.uniforms.atlasHeightMax = { value: bounds.max.z };
    shader.uniforms.atlasTeachingTintVisibility = {
      value: material.userData.teachingTintVisibility,
    };
    shader.uniforms.atlasTeachingTintOpacity = {
      value: material.userData.teachingTintOpacity,
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float ${TEACHING_SURFACE_COVERAGE_ATTRIBUTE};
attribute float atlasPlacedObject;
varying float vAtlasPlacedObject;
varying float vAtlasHeight;
varying float vAtlasTeachingCoverage;
${surface ? 'varying vec3 vAtlasViewPosition;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vAtlasTeachingCoverage = ${TEACHING_SURFACE_COVERAGE_ATTRIBUTE};
vAtlasPlacedObject = atlasPlacedObject;
#ifdef USE_INSTANCING
  vAtlasHeight = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).z;
#else
  vAtlasHeight = (modelMatrix * vec4(transformed, 1.0)).z;
#endif`,
      );
    if (surface) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vAtlasViewPosition = -mvPosition.xyz;`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vAtlasHeight;
varying float vAtlasTeachingCoverage;
varying float vAtlasPlacedObject;
${surface ? 'varying vec3 vAtlasViewPosition;' : ''}
uniform float atlasPointColorMode;
uniform float atlasObjectColorMode;
uniform float atlasHeightMin;
uniform float atlasHeightMax;
uniform float atlasTeachingTintVisibility;
uniform float atlasTeachingTintOpacity;

vec3 atlasHeightPalette(float heightValue) {
  float t = clamp(
    (heightValue - atlasHeightMin) / max(atlasHeightMax - atlasHeightMin, 0.000001),
    0.0,
    1.0
  );
  vec3 lowBlue = vec3(0.0176, 0.0685, 0.2159);
  vec3 cyan = vec3(0.0212, 0.3916, 0.6308);
  vec3 green = vec3(0.0908, 0.6514, 0.3325);
  vec3 amber = vec3(0.9047, 0.5841, 0.1095);
  vec3 highCoral = vec3(1.0, 0.1620, 0.1560);
  if (t < 0.25) return mix(lowBlue, cyan, smoothstep(0.0, 0.25, t));
  if (t < 0.50) return mix(cyan, green, smoothstep(0.25, 0.50, t));
  if (t < 0.75) return mix(green, amber, smoothstep(0.50, 0.75, t));
  return mix(amber, highCoral, smoothstep(0.75, 1.0, t));
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float atlasActiveColorMode = vAtlasPlacedObject > 0.5 ? atlasObjectColorMode : atlasPointColorMode;
if (atlasActiveColorMode > 1.5) {
  diffuseColor.rgb = vec3(1.0);
} else if (atlasActiveColorMode > 0.5) {
  diffuseColor.rgb = atlasHeightPalette(vAtlasHeight);
}
${surface ? `vec3 atlasDx = dFdx(vAtlasViewPosition);
vec3 atlasDy = dFdy(vAtlasViewPosition);
vec3 atlasFaceNormal = normalize(cross(atlasDx, atlasDy));
vec3 atlasLightDirection = normalize(vec3(0.32, 0.46, 0.83));
float atlasSurfaceLight = 0.68 + 0.32 * abs(dot(atlasFaceNormal, atlasLightDirection));
diffuseColor.rgb *= atlasSurfaceLight;` : ''}
${surface ? '' : `float atlasTeachingSurface = smoothstep(
  0.18,
  0.82,
  clamp(vAtlasTeachingCoverage, 0.0, 1.0)
);
vec3 atlasTeachingTint = vec3(0.1765, 0.9412, 0.5961);
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  atlasTeachingTint,
  atlasTeachingSurface
    * atlasTeachingTintOpacity
    * atlasTeachingTintVisibility
);`}`,
      );
    material.userData.mapColorShader = shader;
  };
  material.customProgramCacheKey = () => (
    surface ? 'atlas-map-color-v13-object-layers-surface' : 'atlas-map-color-v13-object-layers-points'
  );
};

const statusColor = (status, selected = false) => {
  if (status === 'unreachable') return 0xf4c95d;
  if (selected) return 0xb7f8ff;
  if (status === 'connected') return 0x5ee59a;
  return 0x59dbe8;
};

const tagSelectionTarget = (object, type, id) => {
  object.traverse((child) => {
    child.userData.selectionType = type;
    child.userData.selectionId = id;
  });
};

const selectionForObject = (object) => {
  let current = object;
  while (current) {
    if (current.userData?.selectionType && current.userData?.selectionId) {
      return {
        type: current.userData.selectionType,
        id: current.userData.selectionId,
      };
    }
    current = current.parent;
  }
  return null;
};

const disposeObject = (object) => {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
};

const clearRobotParkingGhostLayer = (layer) => {
  if (!layer) return;
  const resources = layer.userData?.ownedResources;
  if (resources instanceof Set) {
    resources.forEach((resource) => resource?.dispose?.());
  }
  layer.clear();
  layer.userData.ownedResources = new Set();
};

const writeRobotParkingGhostHiddenDataset = (canvas) => {
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

const measureRobotParkingGhost = (sourcePose, targetPose) => {
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

const copyRobotJointMetadata = (source, clone) => {
  if (!source || !clone) return;
  if (source.userData?.jointType) {
    clone.userData.jointType = source.userData.jointType;
    clone.userData.jointAxis = [...(source.userData.jointAxis || [0, 0, 1])];
    clone.userData.jointLimit = { ...(source.userData.jointLimit || {}) };
    clone.userData.armSoftLimitRatio = source.userData.armSoftLimitRatio;
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

const createRobotParkingGhostVisual = (liveRobot, ghost) => {
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

const updateRobotParkingGhostGuide = (visual, sourcePose, canvas) => {
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

const createRosAxisLabel = (text, color, worldHeight) => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.font = '700 36px "SFMono-Regular", Menlo, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0, 0, 0, 0.92)';
  context.shadowBlur = 5;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(worldHeight, worldHeight, 1);
  sprite.renderOrder = 20;
  return sprite;
};

const createRosAxisArrow = (direction, color, length, shaftRadius) => {
  const group = new THREE.Group();
  const shaftLength = length * 0.76;
  const headLength = length - shaftLength;
  const material = new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
    material,
  );
  shaft.position.y = shaftLength / 2;
  shaft.renderOrder = 18;

  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(0, shaftRadius * 3.15, headLength, 16),
    material.clone(),
  );
  head.position.y = shaftLength + headLength / 2;
  head.renderOrder = 18;
  group.add(shaft, head);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  return group;
};

const createCoordinateOrigin = (axisLength) => {
  const group = new THREE.Group();
  group.userData.baseAxisLength = axisLength;
  const shaftRadius = axisLength * 0.025;
  [
    { name: 'X', direction: new THREE.Vector3(1, 0, 0), color: '#f0443e' },
    { name: 'Y', direction: new THREE.Vector3(0, 1, 0), color: '#38c75a' },
    { name: 'Z', direction: new THREE.Vector3(0, 0, 1), color: '#3c82f6' },
  ].forEach(({ name, direction, color }) => {
    const arrow = createRosAxisArrow(direction, color, axisLength, shaftRadius);
    const label = createRosAxisLabel(name, color, axisLength * 0.16);
    label.position.copy(direction).multiplyScalar(axisLength * 1.09);
    group.add(arrow, label);
  });
  const joint = new THREE.Mesh(
    new THREE.SphereGeometry(shaftRadius * 1.55, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xe9edf0, depthTest: false, depthWrite: false, fog: false }),
  );
  joint.renderOrder = 19;
  group.add(joint);
  return group;
};

const createChassisControlGuide = () => {
  const group = new THREE.Group();
  group.name = 'robot-chassis-keyboard-control-guide';
  group.visible = false;
  const heightMaterials = [];
  [
    { name: 'X', direction: new THREE.Vector3(1, 0, 0), color: '#f36b68' },
    { name: 'Y', direction: new THREE.Vector3(0, 1, 0), color: '#5ee59a' },
    { name: 'Z', direction: new THREE.Vector3(0, 0, 1), color: '#79a8ff' },
  ].forEach(({ name, direction, color }) => {
    const arrow = createRosAxisArrow(direction, color, 1, 0.012);
    const label = createRosAxisLabel(name, color, 0.28);
    label.position.copy(direction).multiplyScalar(1.15);
    group.add(arrow, label);
    if (name === 'Z') {
      arrow.traverse((object) => {
        if (object.material) heightMaterials.push(object.material);
      });
      heightMaterials.push(label.material);
    } else {
      const reverse = createRosAxisArrow(direction.clone().negate(), color, 0.68, 0.009);
      reverse.traverse((object) => {
        if (!object.material) return;
        object.material.transparent = true;
        object.material.opacity = 0.48;
      });
      group.add(reverse);
    }
  });
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xf4c95d,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.009, 8, 72), ringMaterial);
  group.add(ring);
  [-1, 1].forEach((sign) => {
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 12), ringMaterial);
    head.position.set(0, sign * 0.78, 0);
    head.rotation.z = -Math.PI / 2;
    group.add(head);
  });
  group.traverse((object) => { object.renderOrder = 36; });
  return { group, heightMaterials, heightLocked: null };
};

export default function PointCloudViewer({
  mapData,
  mapOriginPose = null,
  displaySettingsContainer,
  heightRange,
  showSlice = true,
  waypoints,
  edges,
  selectedWaypointId,
  selectedEdgeId,
  colorMode = 'height',
  onColorModeChange,
  placedObjectColorMode = colorMode,
  onPlacedObjectColorModeChange,
  workspaceTransfer = null,
  meshRenderQuality = 'auto',
  onMeshRenderQualityChange,
  showPaths = true,
  onShowPathsChange,
  showParkingPoints = true,
  onShowParkingPointsChange,
  showWaypoints = true,
  onShowWaypointsChange,
  showWaypointNames = true,
  onShowWaypointNamesChange,
  showPathNames = false,
  onShowPathNamesChange,
  showHeightLegend = true,
  onShowHeightLegendChange,
  onSelectWaypoint,
  onInspectorPageRequest,
  onSelectEdge,
  onClearSelection,
  focusRequest,
  initialView,
  onViewChange,
  resetRequest,
  robotDescriptor,
  showRobot = true,
  onShowRobotChange,
  robotLoadState,
  robotPose,
  robotJointValues,
  lockedRobotJointNames = [],
  robotControlEnabled = false,
  robotHeightLocked = false,
  robotTrajectoryActive: externalRobotTrajectoryActive = false,
  onSavePolyline,
  onDeletePolyline,
  onPolylineBusyChange,
  polylineOpen = false,
  onPolylineOpenChange,
  polylineContainer,
  polylineRequest,
  onPolylineRequestHandled,
  teachingPlayback = null,
  robotParkingGhost = null,
  teachingCaptureBusy = false,
  teachingSpaceMode = 'map',
  teachingDevice = 'desktop',
  teachingTasks = [],
  selectedMobilePose = null,
  spaceMouseInputRef,
  viewportCanvasRef,
  collaborationViewportRef,
  cameraTeachingCommand,
  collisionProtectionEnabled = true,
  ignoredCollisionJointNames = [],
  onIgnoredCollisionJointNamesChange,
  onRobotLoadState,
  onRobotPoseChange,
  onRobotJointValuesChange,
  onResetRobotJointPose,
  onRobotControlChange,
  onRobotHeightLockChange,
  onZividCameraPoseChange,
  onCameraTeachingResult,
  onParkingMergePlannerChange,
  onMobileTeachingSolverChange,
  onCollisionProtectionChange,
  onClearRobotParkingGhost,
  onMoveToParkingPoint,
  onEditParkingPoint,
  onCancelTeachingPreviewEdit,
  onRecordParkingPointPosition,
  onEditTeachingPose,
  onConfirmTeachingPose,
  onCollisionProtectionStatus,
  isActive = true,
}) {
  const pendingPolylineRequest = polylineRequest?.sceneId === mapData?.geometry?.uuid
    && polylineRequest?.robotId === (robotDescriptor?.id || robotDescriptor?.relativePath) ? polylineRequest : null;
  const [robotOpacity, setRobotOpacity] = useState(1);
  const [polylineSuggestion, setPolylineSuggestion] = useState(null);
  const robotOpacityRef = useRef(robotOpacity);
  robotOpacityRef.current = robotOpacity;
  const polylineOpenRef = useRef(polylineOpen);
  polylineOpenRef.current = polylineOpen;
  const robotTrajectoryActive = externalRobotTrajectoryActive || polylineOpen;
  const mountRef = useRef(null);
  const distanceScaleRef = useRef(null);
  const distanceScaleLabelRef = useRef(null);
  const spaceMouseAxisHudRef = useRef(null);
  const sceneRef = useRef(null);
  const sliceGroupRef = useRef(null);
  const routeGroupRef = useRef(null);
  const waypointGroupRef = useRef(null);
  const waypointNameElementsRef = useRef(new Map());
  const waypointLabels = useMemo(() => buildWaypointLabels(waypoints), [waypoints]);
  const pathNameElementsRef = useRef(new Map());
  const pathLabels = useMemo(() => showPaths && showPathNames ? buildPathLabels(waypoints, edges) : [],
    [showPaths, showPathNames, waypoints, edges]);
  const mapOriginGroupRef = useRef(null);
  const mapOriginLabelRef = useRef(null);
  const visionCoverageGroupRef = useRef(null);
  const surfaceCoverageProjectionRef = useRef(null);
  const visionCoverageRenderingEnabledRef = useRef(true);
  const teachingSurfaceTintOpacityRef = useRef(TEACHING_SURFACE_TINT_OPACITY);
  const robotLayerRef = useRef(null);
  const showRobotRef = useRef(showRobot);
  const loadedRobotRef = useRef(null);
  const robotParkingGhostLayerRef = useRef(null);
  const robotParkingGhostVisualRef = useRef(null);
  const polylineGhostRef = useRef(null);
  const robotChassisHandleRef = useRef(null);
  const robotControlInteractionRef = useRef(null);
  const chassisDragInteractionRef = useRef(null);
  const chassisDragModeRef = useRef(false);
  const endEffectorControllersRef = useRef({ left: null, right: null });
  const torsoControllerRef = useRef(null);
  const transformControlsRef = useRef(null);
  const endEffectorTargetRef = useRef(null);
  const endEffectorSpaceBallRef = useRef(null);
  const endEffectorControlRef = useRef(null);
  const lockedEndEffectorsRef = useRef(createEndEffectorLocks());
  const globalEndEffectorUpdateRef = useRef(null);
  const endEffectorInteractionRef = useRef(null);
  const endEffectorObjectChangeRef = useRef(null);
  const robotDragHistoryRef = useRef({ entries: [], pending: null, restoring: false });
  const robotDragActionsRef = useRef(null);
  const selectedWaypointPulseRef = useRef(null);
  const controlsRef = useRef(null);
  const cameraRef = useRef(null);
  const displayGeometryRef = useRef(null);
  const surfaceGeometryRef = useRef(null);
  const cloudMaterialRef = useRef(null);
  const meshMaterialRef = useRef(null);
  const colorModeRef = useRef(colorMode);
  const placedObjectColorModeRef = useRef(placedObjectColorMode);
  const renderActiveRef = useRef(Boolean(isActive));
  const onSelectWaypointRef = useRef(onSelectWaypoint);
  const onInspectorPageRequestRef = useRef(onInspectorPageRequest);
  const onSelectEdgeRef = useRef(onSelectEdge);
  const onClearSelectionRef = useRef(onClearSelection);
  const pressedKeysRef = useRef(new Set());
  const keyboardImpulseRef = useRef(new Set());
  const interactionModeRef = useRef('rotate');
  const precisionPanRef = useRef(null);
  const focusAnimationRef = useRef(null);
  const robotFollowPositionRef = useRef(null);
  const pointerInteractionRef = useRef(null);
  const viewActionsRef = useRef(null);
  const initialViewRef = useRef(initialView);
  const onViewChangeRef = useRef(onViewChange);
  const onRobotLoadStateRef = useRef(onRobotLoadState);
  const onRobotPoseChangeRef = useRef(onRobotPoseChange);
  const onRobotJointValuesChangeRef = useRef(onRobotJointValuesChange);
  const onRobotControlChangeRef = useRef(onRobotControlChange);
  const onClearRobotParkingGhostRef = useRef(onClearRobotParkingGhost);
  const onCancelTeachingPreviewEditRef = useRef(onCancelTeachingPreviewEdit);
  const robotParkingGhostRef = useRef(robotParkingGhost);
  const teachingPoseEditing = Boolean(robotParkingGhost?.editing && robotParkingGhost.poseId);
  const teachingPoseEditingRef = useRef(teachingPoseEditing);
  teachingPoseEditingRef.current = teachingPoseEditing;
  const onZividCameraPoseChangeRef = useRef(onZividCameraPoseChange);
  const onCameraTeachingResultRef = useRef(onCameraTeachingResult);
  const parkingMergePlannerRef = useRef(null);
  const onCollisionProtectionStatusRef = useRef(onCollisionProtectionStatus);
  const collisionMonitorGenerationRef = useRef(0);
  const collisionHighlightCleanupRef = useRef(null);
  const collisionCheckRequestRef = useRef(null);
  const ignoredCollisionJointNamesRef = useRef([]);
  ignoredCollisionJointNamesRef.current = normalizeIgnoredCollisionJoints(ignoredCollisionJointNames);
  const zividCameraFramesRef = useRef({ left: null, right: null });
  const lastZividCameraPoseReportRef = useRef(0);
  const lastZividCameraPoseSignatureRef = useRef('');
  const robotPoseRef = useRef(normalizeRobotPose(robotPose));
  const robotJointValuesRef = useRef(normalizeRobotJointValues(robotJointValues));
  const robotArmSoftLimitRatio = useContext(RobotJointLimitContext);
  const robotArmJointCouplingEnabled = useContext(RobotJointCouplingContext);
  const robotArmSoftLimitRatioRef = useRef(robotArmSoftLimitRatio);
  robotArmSoftLimitRatioRef.current = robotArmSoftLimitRatio;
  const robotArmJointCouplingEnabledRef = useRef(robotArmJointCouplingEnabled);
  robotArmJointCouplingEnabledRef.current = robotArmJointCouplingEnabled;
  const lockedRobotJointNamesRef = useRef(normalizeRobotJointLocks(lockedRobotJointNames));
  const robotControlEnabledRef = useRef(Boolean(robotControlEnabled));
  const robotHeightLockedRef = useRef(Boolean(robotHeightLocked));
  const robotTrajectoryActiveRef = useRef(Boolean(robotTrajectoryActive));
  const robotLoadStateRef = useRef(robotLoadState);
  const robotPoseActionsRef = useRef(null);
  const lastRobotPoseReportRef = useRef(0);
  const lastRobotJointReportRef = useRef(0);
  const appliedInitialViewRef = useRef(null);
  const appliedResetRevisionRef = useRef(0);
  const appliedCameraTeachingRevisionRef = useRef(0);
  const cameraIkReferencesRef = useRef({ left: null, right: null });
  const [interactionMode, setInteractionMode] = useState('rotate');
  const [shiftPanArmed, setShiftPanArmed] = useState(false);
  const [chassisDragMode, setChassisDragMode] = useState(false);
  const [chassisDragging, setChassisDragging] = useState(false);
  const [endEffectorControl, setEndEffectorControl] = useState(null);
  const [endEffectorLockModesState, setEndEffectorLockModesState] = useState({
    left: null,
    right: null,
  });
  const [robotCollisionStatus, setRobotCollisionStatus] = useState(
    () => createRobotCollisionStatus(),
  );
  const [showDistanceWarnings, setShowDistanceWarnings] = useState(true);
  const [distanceSettingsOpen, setDistanceSettingsOpen] = useState(false);
  const [collisionJointSettingsOpen, setCollisionJointSettingsOpen] = useState(false);
  const collisionJointOptions = useMemo(() => robotLoadState?.status === 'loaded'
    ? getRobotCollisionJointOptions(loadedRobotRef.current) : [], [robotDescriptor, robotLoadState?.status]);
  const [visionCoverageStats, setVisionCoverageStats] = useState(
    EMPTY_VISION_COVERAGE_STATS,
  );
  const [teachingSurfaceTintStats, setTeachingSurfaceTintStats] = useState(
    EMPTY_TEACHING_SURFACE_TINT_STATS,
  );
  const [visionCoverageRenderingEnabled, setVisionCoverageRenderingEnabled] = useState(true);
  const [showSurfaceCoverage, setShowSurfaceCoverage] = useState(false);
  const [teachingSurfaceTintOpacity, setTeachingSurfaceTintOpacity] = useState(
    TEACHING_SURFACE_TINT_OPACITY,
  );
  visionCoverageRenderingEnabledRef.current = visionCoverageRenderingEnabled;
  teachingSurfaceTintOpacityRef.current = teachingSurfaceTintOpacity;
  interactionModeRef.current = interactionMode;
  colorModeRef.current = colorMode;
  placedObjectColorModeRef.current = placedObjectColorMode;
  renderActiveRef.current = Boolean(isActive);
  onSelectWaypointRef.current = onSelectWaypoint;
  onInspectorPageRequestRef.current = onInspectorPageRequest;
  onSelectEdgeRef.current = onSelectEdge;
  onClearSelectionRef.current = onClearSelection;
  initialViewRef.current = initialView;
  onViewChangeRef.current = onViewChange;
  onRobotLoadStateRef.current = onRobotLoadState;
  onRobotPoseChangeRef.current = onRobotPoseChange;
  onRobotJointValuesChangeRef.current = onRobotJointValuesChange;
  onRobotControlChangeRef.current = onRobotControlChange;
  onClearRobotParkingGhostRef.current = onClearRobotParkingGhost;
  onCancelTeachingPreviewEditRef.current = onCancelTeachingPreviewEdit;
  robotParkingGhostRef.current = robotParkingGhost;
  onZividCameraPoseChangeRef.current = onZividCameraPoseChange;
  onCameraTeachingResultRef.current = onCameraTeachingResult;
  onCollisionProtectionStatusRef.current = onCollisionProtectionStatus;
  showRobotRef.current = showRobot;
  robotControlEnabledRef.current = Boolean(showRobot && robotControlEnabled && !teachingPoseEditing);
  robotHeightLockedRef.current = Boolean(robotHeightLocked);
  robotTrajectoryActiveRef.current = Boolean(robotTrajectoryActive);
  robotLoadStateRef.current = robotLoadState;
  lockedRobotJointNamesRef.current = normalizeRobotJointLocks(lockedRobotJointNames);
  const [manualResolution, setManualResolution] = useState({ mapKey: null, index: null });
  const robotFollowEnabled = robotTrajectoryActive && Boolean(teachingPlayback?.followRobot);

  const visionCoveragePlaybackStatus = String(teachingPlayback?.status || 'idle');
  const visionCoveragePlaybackTaskId = String(teachingPlayback?.taskId || '');
  const visionCoveragePlaybackActive = Boolean(
    teachingSpaceMode === 'independent'
    && visionCoveragePlaybackTaskId
    && PROGRESSIVE_COVERAGE_PLAYBACK_STATUSES.has(visionCoveragePlaybackStatus),
  );
  const visionCoveragePlaybackReachedPoseIds = visionCoveragePlaybackActive
    && Array.isArray(teachingPlayback?.reachedPoseIds)
    ? teachingPlayback.reachedPoseIds.map(String)
    : [];
  const visionCoveragePlaybackReachedSignature = JSON.stringify(
    visionCoveragePlaybackReachedPoseIds,
  );
  const visionCoveragePlaybackPoseCount = Math.max(
    0,
    Number(teachingPlayback?.poseCount) || 0,
  );
  const visionCoveragePlaybackSelection = useMemo(() => {
    if (teachingSpaceMode !== 'independent') {
      return {
        progressive: false,
        mode: 'hidden',
        taskId: '',
        records: [],
        availableFrameCount: 0,
        availablePoseCount: 0,
        reachedPoseCount: 0,
        playbackPoseCount: 0,
      };
    }

    const allRecords = collectTeachingVisionCoverageFrames(teachingTasks);
    if (!visionCoveragePlaybackActive) {
      const poseIds = new Set(allRecords.map((record) => record.poseId).filter(Boolean));
      return {
        progressive: false,
        mode: 'static-all-records',
        taskId: '',
        records: allRecords,
        availableFrameCount: allRecords.length,
        availablePoseCount: poseIds.size,
        reachedPoseCount: poseIds.size,
        playbackPoseCount: poseIds.size,
      };
    }

    const taskRecords = allRecords.filter(
      (record) => String(record.taskId || '') === visionCoveragePlaybackTaskId,
    );
    const reachedPoseIds = new Set(visionCoveragePlaybackReachedPoseIds);
    const records = taskRecords.filter((record) => reachedPoseIds.has(String(record.poseId)));
    return {
      progressive: true,
      mode: 'pose-arrival-progressive',
      taskId: visionCoveragePlaybackTaskId,
      records,
      availableFrameCount: taskRecords.length,
      availablePoseCount: new Set(
        taskRecords.map((record) => record.poseId).filter(Boolean),
      ).size,
      reachedPoseCount: new Set(
        records.map((record) => record.poseId).filter(Boolean),
      ).size,
      playbackPoseCount: visionCoveragePlaybackPoseCount,
    };
  }, [
    teachingSpaceMode,
    teachingTasks,
    visionCoveragePlaybackActive,
    visionCoveragePlaybackPoseCount,
    visionCoveragePlaybackReachedSignature,
    visionCoveragePlaybackTaskId,
  ]);

  const sourcePointCount = mapData?.geometry?.getAttribute('position')?.count || 0;
  const meshInfo = mapData?.meshInfo || mapData?.geometry?.userData?.mapTopology || null;
  const hasEmbeddedMesh = Boolean(meshInfo?.hasMesh && meshInfo.faceCount > 0);
  const meshQualityPlan = resolveMeshRenderQuality(
    meshRenderQuality,
    meshInfo?.faceCount,
  );
  const renderablePointCount = hasEmbeddedMesh
    ? Number(meshInfo.unreferencedPointCount) || 0
    : sourcePointCount;
  const resolutionMapKey = mapData?.mapId || mapData?.geometry?.uuid || null;
  const suggestedResolutionIndex = adaptiveResolutionIndex(renderablePointCount);
  const suggestedResolution = RESOLUTION_LEVELS[suggestedResolutionIndex];
  const hasManualResolution =
    manualResolution.mapKey === resolutionMapKey
    && Number.isInteger(manualResolution.index);
  const resolutionIndex = hasManualResolution
    ? manualResolution.index
    : suggestedResolutionIndex;
  const resolutionSelection = hasManualResolution
    ? 'manual'
    : resolutionIndex < DEFAULT_RESOLUTION_INDEX
      ? 'auto'
      : 'native';
  const resolution = RESOLUTION_LEVELS[resolutionIndex];
  const renderedPointCount = renderablePointCount
    ? Math.max(1, Math.round(renderablePointCount * resolution.ratio))
    : 0;
  const objectLayers = useMemo(() => teachingSpaceMode === 'map'
    ? placedObjectLayers(mapData, workspaceTransfer) : null, [mapData, workspaceTransfer, teachingSpaceMode]);
  const placedObjectPointCount = objectLayers?.objectRanges.reduce((count, range) => count + range.count, 0) || 0;
  const hasObjectColorControl = teachingSpaceMode === 'map' && workspaceTransfer?.kind === 'placement';
  const isHeightColor = (colorMode === 'height' && sourcePointCount > placedObjectPointCount)
    || (placedObjectPointCount > 0 && placedObjectColorMode === 'height');
  const colorModeIndex = Math.max(
    0,
    POINT_COLOR_MODES.findIndex((option) => option.id === colorMode),
  );
  const colorModeMeta = POINT_COLOR_MODES[colorModeIndex];
  const nextColorMode = POINT_COLOR_MODES[(colorModeIndex + 1) % POINT_COLOR_MODES.length];
  const objectColorModeIndex = Math.max(0, POINT_COLOR_MODES.findIndex((option) => option.id === placedObjectColorMode));
  const objectColorModeMeta = POINT_COLOR_MODES[objectColorModeIndex];
  const nextObjectColorMode = POINT_COLOR_MODES[(objectColorModeIndex + 1) % POINT_COLOR_MODES.length];
  const heightMin = mapData?.bounds?.min?.z ?? 0;
  const heightMax = mapData?.bounds?.max?.z ?? 1;
  const heightLegendTicks = [1, 0.75, 0.5, 0.25, 0].map(
    (ratio) => heightMin + (heightMax - heightMin) * ratio,
  );
  const chooseResolution = (nextIndex) => {
    setManualResolution({
      mapKey: resolutionMapKey,
      index: Math.max(0, Math.min(DEFAULT_RESOLUTION_INDEX, nextIndex)),
    });
  };
  const chooseResolutionMode = (value) => {
    if (value === 'auto') {
      setManualResolution({ mapKey: null, index: null });
      return;
    }
    chooseResolution(Number(value));
  };

  const applyRobotJointStateToScene = (values, source = 'external') => {
    const normalized = normalizeRobotJointValues(values);
    robotJointValuesRef.current = normalized;
    const robot = loadedRobotRef.current;
    if (!robot) return normalized;
    applyRobotJointValues(robot, normalized);
    robotLayerRef.current?.updateMatrixWorld(true);
    return writeRobotJointDataset(controlsRef.current?.domElement, robot, source);
  };

  const reportRobotJointValues = (force = false) => {
    const robot = loadedRobotRef.current;
    if (!robot) return;
    const values = writeRobotJointDataset(
      controlsRef.current?.domElement,
      robot,
      'scene-report',
    );
    robotJointValuesRef.current = values;
    const now = performance.now();
    if (!force && now - lastRobotJointReportRef.current < ROBOT_JOINT_REPORT_INTERVAL) return;
    lastRobotJointReportRef.current = now;
    onRobotJointValuesChangeRef.current?.(values);
  };

  const getPolylineContext = () => {
    const robot = loadedRobotRef.current;
    robot?.updateWorldMatrix(true, true);
    return { robot, scene: sceneRef.current, camera: cameraRef.current,
      canvas: controlsRef.current?.domElement, geometry: mapData?.geometry,
      lockedJointNames: lockedRobotJointNamesRef.current,
      focusSuggestion: () => {
        const visual = polylineGhostRef.current?.visual, camera = cameraRef.current, controls = controlsRef.current;
        if (!visual || !camera || !controls) return;
        const bounds = setRobotVisualBounds(new THREE.Box3(), visual.poseRoot);
        if (robot) bounds.union(setRobotVisualBounds(new THREE.Box3(), robot));
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        if (!Number.isFinite(sphere.radius)) return;
        if (focusAnimationRef.current) cancelAnimationFrame(focusAnimationRef.current);
        precisionPanRef.current?.clear?.();
        const direction = camera.position.clone().sub(controls.target);
        if (direction.lengthSq() < 1e-12) direction.set(-.5, -.8, .45);
        const halfFov = Math.min(THREE.MathUtils.degToRad(camera.fov / 2),
          Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
        camera.zoom = 1; camera.updateProjectionMatrix();
        controls.target.copy(sphere.center);
        camera.position.copy(sphere.center).addScaledVector(direction.normalize(), Math.max(.5, sphere.radius * 1.35 / Math.sin(halfFov)));
        controls.update();
      },
      configurationKey: robot ? JSON.stringify([robot.userData.armJointCouplingEnabled,
        ['left', 'right'].flatMap((side) => getRobotEndEffector(robot, side)?.joints.map((joint) =>
          [joint.name, joint.userData.jointLimit, joint.userData.armSoftLimitRatio, joint.userData.armJointCouplingEnabled]) || [])]) : '',
      applyState: ({ joints, basePose }) => {
        if (basePose) {
          const layer = robotLayerRef.current;
          layer.parent?.updateWorldMatrix(true, false);
          const position = new THREE.Vector3().fromArray(basePose.position);
          const quaternion = new THREE.Quaternion().fromArray(basePose.quaternion);
          if (layer.parent) {
            position.applyMatrix4(layer.parent.matrixWorld.clone().invert());
            quaternion.premultiply(layer.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
          }
          const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
          const pose = { position: { x: position.x, y: position.y, z: position.z },
            rpy: { roll: THREE.MathUtils.radToDeg(rotation.x), pitch: THREE.MathUtils.radToDeg(rotation.y), yaw: THREE.MathUtils.radToDeg(rotation.z) } };
          robotPoseRef.current = applyRobotPose(layer, pose);
          writeRobotPoseDataset(controlsRef.current?.domElement, pose);
          onRobotPoseChangeRef.current?.(pose);
        }
        applyRobotJointStateToScene(joints, 'polyline-playback'); reportRobotJointValues(true);
      },
    };
  };

  useEffect(() => { onPolylineOpenChange?.(false); }, [mapData?.geometry, robotDescriptor?.id, onPolylineOpenChange]);

  useEffect(() => {
    if (!pendingPolylineRequest || !isActive || robotLoadState?.status !== 'loaded') return;
    updateRobotKeyboardControl(false);
    chassisDragInteractionRef.current?.exit?.('polyline-teaching');
    endEffectorInteractionRef.current?.exit?.();
    clearEndEffectorLocks();
    onPolylineOpenChange?.(true);
    // Frame the saved line together with the robot so both preview and motion
    // are visible, without changing robot visibility or its physical pose.
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls || !pendingPolylineRequest.path.points.length) return;
    const bounds = new THREE.Box3().setFromPoints(pendingPolylineRequest.path.points.map((point) => new THREE.Vector3().fromArray(point.position)));
    if (loadedRobotRef.current) bounds.union(setRobotVisualBounds(new THREE.Box3(), loadedRobotRef.current));
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius)) return;
    if (focusAnimationRef.current) cancelAnimationFrame(focusAnimationRef.current);
    precisionPanRef.current?.clear?.();
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(-0.5, -0.8, 0.45);
    const halfFov = Math.min(THREE.MathUtils.degToRad(camera.fov / 2),
      Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
    camera.zoom = 1; camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction.normalize(), Math.max(0.5, sphere.radius * 1.35 / Math.sin(halfFov)));
    controls.update();
  }, [pendingPolylineRequest?.id, isActive, robotLoadState?.status, onPolylineOpenChange]);

  const reportZividCameraPoses = (force = false) => {
    const frames = zividCameraFramesRef.current;
    if (!frames.left && !frames.right) return;
    const now = performance.now();
    if (
      !force
      && now - lastZividCameraPoseReportRef.current < ZIVID_CAMERA_POSE_REPORT_INTERVAL
    ) {
      return;
    }
    lastZividCameraPoseReportRef.current = now;
    robotLayerRef.current?.updateMatrixWorld(true);
    const poses = Object.fromEntries(
      Object.entries(frames).flatMap(([side, frame]) => {
        const pose = zividOpticalPoseFromObject(frame, side);
        return pose ? [[side, pose]] : [];
      }),
    );
    const signature = Object.values(poses)
      .flatMap((pose) => [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.quaternion.x,
        pose.quaternion.y,
        pose.quaternion.z,
        pose.quaternion.w,
      ])
      .map((value) => value.toFixed(7))
      .join('|');
    if (!force && signature === lastZividCameraPoseSignatureRef.current) return;
    lastZividCameraPoseSignatureRef.current = signature;

    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      Object.entries(poses).forEach(([side, pose]) => {
        const prefix = side === 'left' ? 'zividLeftOptical' : 'zividRightOptical';
        canvas.dataset[`${prefix}Frame`] = pose.frameName;
        canvas.dataset[`${prefix}Position`] = [
          pose.position.x,
          pose.position.y,
          pose.position.z,
        ].map((value) => value.toFixed(6)).join(',');
        canvas.dataset[`${prefix}Quaternion`] = [
          pose.quaternion.x,
          pose.quaternion.y,
          pose.quaternion.z,
          pose.quaternion.w,
        ].map((value) => value.toFixed(8)).join(',');
      });
      canvas.dataset.zividCameraPoseRevision = String(
        Number(canvas.dataset.zividCameraPoseRevision || 0) + 1,
      );
    }
    onZividCameraPoseChangeRef.current?.(poses);
    return poses;
  };

  parkingMergePlannerRef.current = async (request = {}) => {
    const task = request?.task;
    if (!task?.id) throw new Error('没有可分析的示教任务');
    const distanceThreshold = THREE.MathUtils.clamp(
      Number(request.distanceThreshold) || DEFAULT_PARKING_CLUSTER_DISTANCE,
      0.02,
      5,
    );
    const positionTolerance = THREE.MathUtils.clamp(
      Number(request.positionTolerance) || DEFAULT_PARKING_MERGE_XYZ_TOLERANCE,
      0.001,
      0.5,
    );
    const rotationTolerance = THREE.MathUtils.clamp(
      Number(request.rotationTolerance) || DEFAULT_PARKING_MERGE_RPY_TOLERANCE,
      0.1,
      45,
    );
    const spatialAnalysis = clusterNearbyParkingPoints(
      task.parkingPoints || [],
      distanceThreshold,
    );
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.parkingMergePlannerState = 'analyzing';
      canvas.dataset.parkingMergeClusterCount = String(spatialAnalysis.clusters.length);
      delete canvas.dataset.parkingMergePlannerError;
    }

    if (!spatialAnalysis.clusters.length) {
      if (canvas) canvas.dataset.parkingMergePlannerState = 'ready';
      return {
        version: 1,
        status: 'no-neighbors',
        armJointCouplingEnabled: robotArmJointCouplingEnabledRef.current,
        taskId: task.id,
        analyzedAt: new Date().toISOString(),
        distanceThreshold,
        positionTolerance,
        rotationTolerance,
        clusters: [],
        nearbyPairs: spatialAnalysis.nearbyPairs,
        isolatedParkingPointIds: spatialAnalysis.isolatedParkingPointIds,
        feasibleClusterCount: 0,
      };
    }

    const liveRobot = loadedRobotRef.current;
    if (!liveRobot) throw new Error('机器人运动学模型尚未加载，无法搜索公共停车点');
    const liveFrames = zividCameraFramesRef.current;
    const availableSides = ['left', 'right'].filter((side) => (
      liveFrames[side] && endEffectorControllersRef.current[side]
    ));
    if (!availableSides.length) {
      throw new Error('机器人末端相机运动链尚未就绪，无法校验拍照姿态');
    }

    const planningRobot = liveRobot.clone(true);
    const planningLayer = new THREE.Group();
    planningLayer.name = 'parking-point-merge-planning-layer';
    planningLayer.add(planningRobot);
    const baselineJoints = readRobotJointValues(liveRobot);
    const planningControllers = Object.fromEntries(availableSides.flatMap((side) => {
      const controller = getRobotEndEffector(planningRobot, side);
      const opticalFrame = planningRobot.getObjectByName(liveFrames[side].name)
        || planningRobot.getObjectByName(`zivid_${side}_optical_frame`);
      return controller && opticalFrame
        ? [[side, { ...controller, frame: opticalFrame }]]
        : [];
    }));
    const planningSides = availableSides.filter((side) => planningControllers[side]);
    if (!planningSides.length) {
      planningLayer.clear();
      throw new Error('克隆的机器人模型缺少 Zivid 光学坐标系');
    }

    const applyPlanningSeed = (mapPose, jointValues) => {
      applyRobotPose(planningLayer, mapPose);
      applyRobotJointValues(planningRobot, baselineJoints);
      applyRobotJointValues(planningRobot, jointValues || {});
      planningLayer.updateMatrixWorld(true);
    };
    const clusterPlans = [];

    try {
      for (const cluster of spatialAnalysis.clusters) {
        const sourcePoseRecords = cluster.members.flatMap((parkingPoint) => (
          (parkingPoint.poses || []).map((pose) => ({ parkingPoint, pose }))
        ));
        if (!sourcePoseRecords.length) {
          clusterPlans.push({
            id: cluster.id,
            memberIds: cluster.memberIds,
            memberNames: cluster.memberNames,
            poseCount: 0,
            targetCount: 0,
            maximumPairDistance: cluster.maximumPairDistance,
            nearbyPairCount: cluster.nearbyPairCount,
            feasible: false,
            reason: '该近邻簇没有机械臂示教姿态',
            candidateCount: 0,
            plannedPoses: [],
          });
          continue;
        }

        const targetRecords = sourcePoseRecords.map(({ parkingPoint, pose }) => {
          const sourceMapPose = pose.mapPose || parkingPoint.mapPose;
          const sourceJoints = pose.fullBodyJoints?.values || {};
          applyPlanningSeed(sourceMapPose, sourceJoints);
          const targets = planningSides.flatMap((side) => {
            const capturedPose = pose.cameraCapture?.frames?.[side]?.opticalPose;
            const target = parkingMergeTargetFromSnapshot(capturedPose, side)
              || parkingMergeTargetFromFrame(planningControllers[side].frame, side);
            return target ? [target] : [];
          });
          return {
            poseId: pose.id,
            poseName: pose.name,
            sourceParkingPointId: parkingPoint.id,
            sourceParkingPointName: parkingPoint.name,
            sourceMapPose,
            sourceJoints,
            targets,
          };
        });
        const candidates = createCommonParkingCandidates(cluster.members);
        let bestCandidate = null;

        for (const candidate of candidates) {
          const plannedPoses = [];
          for (const record of targetRecords) {
            applyPlanningSeed(candidate.mapPose, record.sourceJoints);
            let sideErrors = {};

            for (let pass = 0; pass < 4; pass += 1) {
              record.targets.forEach((target) => {
                const controller = planningControllers[target.side];
                solveEndEffectorIk(
                  controller,
                  target.position,
                  target.quaternion,
                  new Set(),
                );
              });
              planningLayer.updateMatrixWorld(true);
              sideErrors = Object.fromEntries(record.targets.map((target) => [
                target.side,
                {
                  ...measureParkingMergeTarget(
                    planningControllers[target.side]?.frame,
                    target,
                  ),
                  targetSource: target.source,
                  frameName: target.frameName,
                },
              ]));
              const errors = Object.values(sideErrors);
              if (
                errors.length
                && errors.every((error) => (
                  error.positionError <= Math.min(positionTolerance, 0.004)
                  && error.rotationError <= Math.min(rotationTolerance, 1)
                ))
              ) break;
            }

            const errors = Object.values(sideErrors);
            const positionError = errors.length
              ? Math.max(...errors.map((error) => error.positionError))
              : Number.POSITIVE_INFINITY;
            const rotationError = errors.length
              ? Math.max(...errors.map((error) => error.rotationError))
              : Number.POSITIVE_INFINITY;
            const feasible = errors.length === record.targets.length
              && errors.length > 0
              && positionError <= positionTolerance
              && rotationError <= rotationTolerance
              && !robotJointCouplingViolations(getRobotJointCouplingPairs(planningRobot)).length;
            plannedPoses.push({
              poseId: record.poseId,
              poseName: record.poseName,
              sourceParkingPointId: record.sourceParkingPointId,
              sourceParkingPointName: record.sourceParkingPointName,
              feasible,
              positionError,
              rotationError,
              sideErrors,
              jointValues: readRobotJointValues(planningRobot),
            });
          }

          const feasiblePoseCount = plannedPoses.filter((pose) => pose.feasible).length;
          const failedPoseCount = plannedPoses.length - feasiblePoseCount;
          const maximumPositionError = Math.max(
            ...plannedPoses.map((pose) => pose.positionError),
          );
          const maximumRotationError = Math.max(
            ...plannedPoses.map((pose) => pose.rotationError),
          );
          const score = failedPoseCount * 1_000_000
            + (maximumPositionError / positionTolerance) * 1_000
            + (maximumRotationError / rotationTolerance) * 100
            + candidate.travel.maximum;
          const candidateResult = {
            id: candidate.id,
            source: candidate.source,
            sourceLabel: candidate.sourceLabel,
            anchorParkingPointId: candidate.anchorParkingPointId,
            anchorParkingPointName: candidate.anchorParkingPointName,
            mapPose: candidate.mapPose,
            travel: candidate.travel,
            plannedPoses,
            feasiblePoseCount,
            failedPoseCount,
            maximumPositionError,
            maximumRotationError,
            score,
          };
          if (!bestCandidate || candidateResult.score < bestCandidate.score) {
            bestCandidate = candidateResult;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }

        const feasible = Boolean(
          bestCandidate
          && bestCandidate.failedPoseCount === 0
          && bestCandidate.plannedPoses.length === sourcePoseRecords.length,
        );
        clusterPlans.push({
          id: cluster.id,
          memberIds: cluster.memberIds,
          memberNames: cluster.memberNames,
          poseCount: sourcePoseRecords.length,
          targetCount: targetRecords.reduce(
            (total, record) => total + record.targets.length,
            0,
          ),
          maximumPairDistance: cluster.maximumPairDistance,
          nearbyPairCount: cluster.nearbyPairCount,
          candidateCount: candidates.length,
          feasible,
          reason: feasible ? '' : '没有候选底盘位姿能同时满足全部相机姿态容差与关节约束',
          candidate: bestCandidate
            ? {
                id: bestCandidate.id,
                source: bestCandidate.source,
                sourceLabel: bestCandidate.sourceLabel,
                anchorParkingPointId: bestCandidate.anchorParkingPointId,
                anchorParkingPointName: bestCandidate.anchorParkingPointName,
                mapPose: bestCandidate.mapPose,
                travel: bestCandidate.travel,
                maximumPositionError: bestCandidate.maximumPositionError,
                maximumRotationError: bestCandidate.maximumRotationError,
                feasiblePoseCount: bestCandidate.feasiblePoseCount,
                failedPoseCount: bestCandidate.failedPoseCount,
              }
            : null,
          plannedPoses: bestCandidate?.plannedPoses || [],
        });
      }
    } finally {
      planningLayer.remove(planningRobot);
      planningLayer.clear();
    }

    const result = {
      version: 1,
      status: 'ready',
      taskId: task.id,
      analyzedAt: new Date().toISOString(),
      method: 'xy-single-link+common-base-dual-optical-dls',
      armJointCouplingEnabled: planningRobot.userData.armJointCouplingEnabled !== false,
      distanceThreshold,
      positionTolerance,
      rotationTolerance,
      clusters: clusterPlans,
      nearbyPairs: spatialAnalysis.nearbyPairs,
      isolatedParkingPointIds: spatialAnalysis.isolatedParkingPointIds,
      feasibleClusterCount: clusterPlans.filter((cluster) => cluster.feasible).length,
    };
    if (canvas) {
      canvas.dataset.parkingMergePlannerState = 'ready';
      canvas.dataset.parkingMergeFeasibleClusterCount = String(result.feasibleClusterCount);
      canvas.dataset.parkingMergeAnalysisRevision = String(
        Number(canvas.dataset.parkingMergeAnalysisRevision || 0) + 1,
      );
    }
    return result;
  };

  useEffect(() => {
    if (!onParkingMergePlannerChange) return undefined;
    const provider = async (request) => {
      try {
        return await parkingMergePlannerRef.current?.(request);
      } catch (error) {
        const canvas = controlsRef.current?.domElement;
        if (canvas) {
          canvas.dataset.parkingMergePlannerState = 'error';
          canvas.dataset.parkingMergePlannerError = error?.message || 'planning-failed';
        }
        throw error;
      }
    };
    onParkingMergePlannerChange(provider);
    return () => onParkingMergePlannerChange(null);
  }, [onParkingMergePlannerChange]);

  useEffect(() => {
    if (!onMobileTeachingSolverChange) return undefined;
    onMobileTeachingSolverChange((request) => {
      if (robotLoadStateRef.current?.status !== 'loaded') throw new Error('机器人模型尚未就绪');
      const geometry = mapData?.geometry;
      const environment = request.options.checkCollisions ? { positions: packCollisionPositions(geometry?.getAttribute('position')),
        indices: packCollisionIndices(geometry?.getIndex()), kind: mapData?.faceCount > 0 ? 'mesh' : 'points' } : undefined;
      return solveMobileTeachingInWorker({ ...request, robot: loadedRobotRef.current,
        mapPose: robotPoseRef.current, lockedJointNames: lockedRobotJointNamesRef.current, environment });
    });
    return () => onMobileTeachingSolverChange(null);
  }, [onMobileTeachingSolverChange, mapData?.geometry, mapData?.faceCount]);

  const currentEndEffectorLockModes = () =>
    endEffectorLockModes(lockedEndEffectorsRef.current);

  const syncEndEffectorLockState = (activeSide = endEffectorControlRef.current?.side) => {
    const modes = currentEndEffectorLockModes();
    setEndEffectorLockModesState(modes);
    writeEndEffectorLockDataset(
      controlsRef.current?.domElement,
      lockedEndEffectorsRef.current,
      activeSide,
    );
    return modes;
  };

  const restoreLockedEndEffectorJoints = (activeSide) => {
    const frozenJoints = new Set();
    const robot = loadedRobotRef.current;
    lockedRobotJointNamesRef.current.forEach((name) => {
      const joint = robot?.getObjectByName(name);
      if (joint?.userData?.jointType) frozenJoints.add(joint);
    });
    Object.entries(lockedEndEffectorsRef.current).forEach(([side, lock]) => {
      if (!lock || side === activeSide) return;
      const controller = endEffectorControllersRef.current[side];
      if (lock.type === 'body') {
        lock.jointValues.forEach((value, joint) => {
          if (!frozenJoints.has(joint)) setRobotJointValue(joint, value);
        });
      }
      controller?.joints?.forEach((joint) => frozenJoints.add(joint));
    });
    endEffectorControllersRef.current[activeSide]?.robot?.updateMatrixWorld(true);
    return frozenJoints;
  };

  const endEffectorPanelState = (active, overrides = {}) => {
    const lockModes = currentEndEffectorLockModes();
    return {
      side: active.side,
      mode: active.mode,
      pose: active.pose,
      status: active.status,
      positionError: active.positionError,
      rotationError: active.rotationError,
      ...(active.side === 'torso' && {
        torsoPose: active.torsoPose,
        limits: active.controller.limits,
        heightError: active.heightError || 0,
        armLockLimited: active.armLockLimited,
      }),
      dragging: Boolean(transformControlsRef.current?.dragging),
      ...overrides,
      locked: Boolean(lockModes[active.side]),
      lockMode: lockModes[active.side],
      lockModes,
    };
  };

  const writeActiveEndEffectorDataset = (canvas, active, result, pose) => {
    if (!canvas) return;
    canvas.dataset.endEffectorControlState = 'active';
    canvas.dataset.endEffectorSide = active.side;
    canvas.dataset.endEffectorMode = active.mode;
    canvas.dataset.endEffectorIkStatus = result.status;
    canvas.dataset.endEffectorPositionError = result.positionError.toExponential(5);
    canvas.dataset.endEffectorRotationError = result.rotationError.toFixed(4);
    canvas.dataset.endEffectorFrozenJointCount = String(result.frozenJointCount || 0);
    canvas.dataset.endEffectorIkIterations = String(result.iterations || 0);
    canvas.dataset.endEffectorIkSolveMs = (result.solveMs || 0).toFixed(3);
    canvas.dataset.endEffectorTargetX = pose.position.x.toFixed(6);
    canvas.dataset.endEffectorTargetY = pose.position.y.toFixed(6);
    canvas.dataset.endEffectorTargetZ = pose.position.z.toFixed(6);
    canvas.dataset.endEffectorTargetRoll = pose.rpy.roll.toFixed(6);
    canvas.dataset.endEffectorTargetPitch = pose.rpy.pitch.toFixed(6);
    canvas.dataset.endEffectorTargetYaw = pose.rpy.yaw.toFixed(6);
    canvas.dataset.endEffectorActualX = result.actualPose.position.x.toFixed(6);
    canvas.dataset.endEffectorActualY = result.actualPose.position.y.toFixed(6);
    canvas.dataset.endEffectorActualZ = result.actualPose.position.z.toFixed(6);
    canvas.dataset.endEffectorSolveCount = String(
      Number(canvas.dataset.endEffectorSolveCount || 0) + 1,
    );
    writeEndEffectorLockDataset(canvas, lockedEndEffectorsRef.current, active.side);
  };

  const solveGlobalEndEffectorLocks = (forceReport = false, requestedSides = null) => {
    const canvas = controlsRef.current?.domElement;
    const sides = requestedSides || ['left', 'right'];
    const results = {};
    sides.forEach((side) => {
      const lock = lockedEndEffectorsRef.current[side];
      const controller = endEffectorControllersRef.current[side];
      if (lock?.type !== 'map' || !controller) return;
      const frozenJoints = restoreLockedEndEffectorJoints(side);
      if (endEffectorControlRef.current?.side === 'torso') {
        torsoControllerRef.current?.joints.forEach((joint) => frozenJoints.add(joint));
      }
      const result = solveEndEffectorIk(
        controller,
        lock.targetPosition,
        lock.targetQuaternion,
        frozenJoints,
        { referenceJointValues: lock.referenceJointValues },
      );
      if (!result) return;
      lock.lastResult = result;
      results[side] = result;

      if (canvas) {
        const prefix = side === 'left' ? 'endEffectorLeft' : 'endEffectorRight';
        canvas.dataset[`${prefix}MapIkStatus`] = result.status;
        canvas.dataset[`${prefix}MapPositionError`] = result.positionError.toExponential(5);
        canvas.dataset[`${prefix}MapRotationError`] = result.rotationError.toFixed(4);
        canvas.dataset[`${prefix}MapActualX`] = result.actualPose.position.x.toFixed(6);
        canvas.dataset[`${prefix}MapActualY`] = result.actualPose.position.y.toFixed(6);
        canvas.dataset[`${prefix}MapActualZ`] = result.actualPose.position.z.toFixed(6);
        canvas.dataset.endEffectorGlobalSolveCount = String(
          Number(canvas.dataset.endEffectorGlobalSolveCount || 0) + 1,
        );
      }

      const active = endEffectorControlRef.current;
      if (active?.side === side) {
        active.pose = lock.pose;
        active.status = result.status;
        active.positionError = result.positionError;
        active.rotationError = result.rotationError;
        setEndEffectorControl(endEffectorPanelState(active));
        writeActiveEndEffectorDataset(canvas, active, result, lock.pose);
      }
    });
    if (Object.keys(results).length) {
      reportRobotJointValues(forceReport);
      reportZividCameraPoses(forceReport);
    }
    return results;
  };

  globalEndEffectorUpdateRef.current = solveGlobalEndEffectorLocks;

  const syncTorsoTarget = (active) => {
    const target = endEffectorTargetRef.current;
    if (!target) return;
    active.controller.frame.getWorldPosition(target.position);
    active.controller.base.getWorldQuaternion(target.quaternion);
    if (active.mode !== 'height') {
      target.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(active.torsoPose.pitch),
      ));
    }
    if (active.mode === 'yaw') {
      target.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(active.torsoPose.yaw),
      ));
    }
    target.updateMatrixWorld(true);
    active.pose = poseFromWorldObject(target);
  };

  const configureTorsoTransform = (active) => {
    const transform = transformControlsRef.current;
    transform.setSpace('local');
    transform.setMode(active.mode === 'height' ? 'translate' : 'rotate');
    transform.showX = false;
    transform.showY = active.mode === 'pitch';
    transform.showZ = active.mode !== 'pitch';
    endEffectorSpaceBallRef.current?.children.forEach((ring, index) => {
      ring.visible = index === (active.mode === 'pitch' ? 1 : 2);
    });
    syncTorsoTarget(active);
  };

  const updateTorsoTarget = (forceReport = false, changes = null) => {
    const active = endEffectorControlRef.current;
    const target = endEffectorTargetRef.current;
    if (active?.side !== 'torso' || !target) return null;
    const requested = { ...active.torsoPose, ...changes };
    if (!changes) {
      if (active.mode === 'height') {
        requested.height = active.controller.base.worldToLocal(target.getWorldPosition(new THREE.Vector3())).z;
      } else {
        const rotation = active.controller.base.getWorldQuaternion(new THREE.Quaternion()).invert()
          .multiply(target.getWorldQuaternion(new THREE.Quaternion()));
        if (active.mode === 'yaw') {
          rotation.premultiply(new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), -THREE.MathUtils.degToRad(active.torsoPose.pitch),
          ));
          const angle = THREE.MathUtils.radToDeg(2 * Math.atan2(rotation.z, rotation.w));
          requested.yaw += THREE.MathUtils.euclideanModulo(angle - requested.yaw + 180, 360) - 180;
        } else {
          const up = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
          const angle = THREE.MathUtils.radToDeg(Math.atan2(up.x, up.z));
          requested.pitch += THREE.MathUtils.euclideanModulo(angle - requested.pitch + 180, 360) - 180;
        }
      }
    }
    const result = solveRobotTorsoPose(active.controller, requested, active.referenceForward);
    // Explicit torso control drives the body even when its joints are excluded
    // from arm IK. Keep arm body locks and compensate map locks with arm joints.
    Object.values(lockedEndEffectorsRef.current).forEach((lock) => {
      if (lock?.type !== 'body') return;
      active.controller.joints.forEach((joint) => {
        if (lock.jointValues.has(joint)) lock.jointValues.set(joint, joint.userData.jointValue);
      });
    });
    const locks = solveGlobalEndEffectorLocks(forceReport);
    active.torsoPose = result.pose;
    active.heightError = result.heightError;
    active.positionError = result.heightError;
    active.rotationError = result.rotationError;
    active.armLockLimited = Object.values(locks).some((lock) => lock.status === 'limited');
    active.status = active.armLockLimited ? 'limited' : result.status;
    syncTorsoTarget(active);
    setEndEffectorControl(endEffectorPanelState(active));
    writeActiveEndEffectorDataset(controlsRef.current?.domElement, active, {
      ...active, actualPose: active.pose,
    }, active.pose);
    reportRobotJointValues(forceReport);
    reportZividCameraPoses(forceReport);
    return result;
  };

  const setTorsoControlMode = (mode) => {
    const active = endEffectorControlRef.current;
    if (active?.side !== 'torso' || !['height', 'yaw', 'pitch'].includes(mode)) return;
    active.mode = mode;
    active.torsoPose = readRobotTorsoPose(active.controller);
    configureTorsoTransform(active);
    setEndEffectorControl(endEffectorPanelState(active));
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.endEffectorMode = mode;
  };

  const setTorsoPose = (changes) => {
    if (endEffectorControlRef.current?.side !== 'torso') return;
    clearRobotDragHistory();
    updateTorsoTarget(true, changes);
  };

  const updateEndEffectorTarget = (forceReport = false) => {
    const active = endEffectorControlRef.current;
    if (active?.side === 'torso') return updateTorsoTarget(forceReport);
    const target = endEffectorTargetRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!active || !target) return null;

    const activeLock = lockedEndEffectorsRef.current[active.side];
    if (activeLock?.type === 'body') {
      activeLock.jointValues.forEach((value, joint) => setRobotJointValue(joint, value));
      active.controller.robot.updateMatrixWorld(true);
      const pose = poseFromWorldObject(active.controller.frame);
      applyPoseToWorldTarget(target, pose);
      const result = {
        actualPose: pose,
        positionError: 0,
        rotationError: 0,
        status: 'locked',
        frozenJointCount: active.controller.joints.length,
      };
      active.pose = pose;
      active.status = 'locked';
      active.positionError = 0;
      active.rotationError = 0;
      setEndEffectorControl(endEffectorPanelState(active));
      writeActiveEndEffectorDataset(canvas, active, result, pose);
      reportRobotJointValues(forceReport);
      return result;
    }

    if (activeLock?.type === 'map') {
      applyPoseToWorldTarget(target, activeLock.pose);
      const results = solveGlobalEndEffectorLocks(forceReport, [active.side]);
      return results[active.side] || null;
    }

    const frozenJoints = restoreLockedEndEffectorJoints(active.side);
    target.updateMatrixWorld(true);
    const targetPosition = target.getWorldPosition(new THREE.Vector3());
    const targetQuaternion = target.getWorldQuaternion(new THREE.Quaternion());
    const result = solveEndEffectorIk(
      active.controller,
      targetPosition,
      targetQuaternion,
      frozenJoints,
      { referenceJointValues: active.referenceJointValues },
    );
    if (!result) return null;
    const pose = poseFromWorldObject(target);
    active.pose = pose;
    active.status = result.status;
    active.positionError = result.positionError;
    active.rotationError = result.rotationError;
    setEndEffectorControl(endEffectorPanelState(active));
    writeActiveEndEffectorDataset(canvas, active, result, pose);
    reportRobotJointValues(forceReport);
    return result;
  };

  const enterEndEffectorControl = (side) => {
    if (!showRobotRef.current || robotTrajectoryActiveRef.current) return false;
    const isTorso = side === 'torso';
    const controller = isTorso ? torsoControllerRef.current : endEffectorControllersRef.current[side];
    const transform = transformControlsRef.current;
    const target = endEffectorTargetRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!controller || !transform || !target) return false;
    cameraIkReferencesRef.current = { left: null, right: null };
    const previous = endEffectorControlRef.current;
    // Repeatedly selecting the same part must keep the original cancellation point.
    const initialState = previous?.side === side ? previous.initialState : {
      ...captureRobotDragState(),
      undoEntries: [...robotDragHistoryRef.current.entries],
    };
    if (!isTorso) restoreLockedEndEffectorJoints(side);
    const activeLock = lockedEndEffectorsRef.current[side];
    if (activeLock?.type === 'body') {
      activeLock.jointValues.forEach((value, joint) => setRobotJointValue(joint, value));
    } else if (activeLock?.type === 'map') {
      solveGlobalEndEffectorLocks(true, [side]);
    }
    controller.robot.updateMatrixWorld(true);
    const pose = activeLock?.type === 'map'
      ? activeLock.pose
      : poseFromWorldObject(controller.frame);
    applyPoseToWorldTarget(target, pose);
    const locked = Boolean(activeLock);
    const lastResult = activeLock?.lastResult;
    const status = activeLock?.type === 'body'
      ? 'locked'
      : lastResult?.status || 'tracking';
    transform.detach();
    target.visible = !locked;
    transform.enabled = !locked;
    transform.showX = true;
    transform.showY = true;
    transform.showZ = true;
    endEffectorSpaceBallRef.current?.children.forEach((ring) => { ring.visible = true; });
    transform.setSpace('world');
    transform.setMode('translate');
    if (!locked) transform.attach(target);
    endEffectorControlRef.current = {
      side,
      initialState,
      referenceJointValues: previous?.side === side && previous.referenceJointValues
        ? previous.referenceJointValues : readRobotJointValues(controller.robot),
      mode: isTorso ? 'height' : 'translate',
      controller,
      pose,
      status,
      positionError: activeLock?.type === 'map' ? lastResult?.positionError || 0 : 0,
      rotationError: activeLock?.type === 'map' ? lastResult?.rotationError || 0 : 0,
    };
    if (isTorso) {
      const active = endEffectorControlRef.current;
      active.torsoPose = readRobotTorsoPose(controller);
      active.referenceForward = previous?.side === 'torso'
        ? previous.referenceForward : active.torsoPose.forward;
      configureTorsoTransform(active);
    }
    setEndEffectorControl(endEffectorPanelState(endEffectorControlRef.current));
    if (robotControlEnabledRef.current) {
      robotControlEnabledRef.current = false;
      onRobotControlChangeRef.current?.(false);
    }
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();
    interactionModeRef.current = 'rotate';
    setInteractionMode('rotate');
    setShiftPanArmed(false);
    if (canvas) {
      canvas.dataset.endEffectorControlState = 'active';
      canvas.dataset.endEffectorSide = side;
      canvas.dataset.endEffectorMode = isTorso ? 'height' : 'translate';
      canvas.dataset.endEffectorIkStatus = status;
      canvas.dataset.endEffectorSpaceBallVisible = locked ? 'false' : 'true';
      canvas.dataset.endEffectorTransformAttached = locked ? 'false' : 'true';
      canvas.dataset.endEffectorDoubleClickCount = String(
        Number(canvas.dataset.endEffectorDoubleClickCount || 0) + 1,
      );
      writeEndEffectorLockDataset(canvas, lockedEndEffectorsRef.current, side);
      canvas.focus({ preventScroll: true });
    }
    updateEndEffectorTarget(true);
    return true;
  };

  const exitEndEffectorControl = () => {
    const transform = transformControlsRef.current;
    const target = endEffectorTargetRef.current;
    if (transform?.dragging) transform.pointerUp(null);
    transform?.detach();
    if (transform) {
      transform.showX = true;
      transform.showY = true;
      transform.showZ = true;
    }
    if (target) target.visible = false;
    if (controlsRef.current) controlsRef.current.enabled = true;
    endEffectorControlRef.current = null;
    setEndEffectorControl(null);
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.endEffectorControlState = 'idle';
      canvas.dataset.endEffectorSide = '';
      canvas.dataset.endEffectorMode = '';
      canvas.dataset.endEffectorDragging = 'false';
      canvas.dataset.endEffectorSpaceBallVisible = 'false';
      canvas.dataset.endEffectorTransformAttached = 'false';
      canvas.dataset.endEffectorFrozenJointCount = '0';
      writeEndEffectorLockDataset(canvas, lockedEndEffectorsRef.current);
    }
    reportRobotJointValues(true);
  };

  const setEndEffectorMode = (mode) => {
    const nextMode = mode === 'rotate' ? 'rotate' : 'translate';
    const active = endEffectorControlRef.current;
    if (!active || lockedEndEffectorsRef.current[active.side]) return;
    active.mode = nextMode;
    transformControlsRef.current?.setMode(nextMode);
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.endEffectorMode = nextMode;
    setEndEffectorControl((current) => current ? { ...current, mode: nextMode } : current);
  };

  const setEndEffectorPose = (pose) => {
    const target = endEffectorTargetRef.current;
    const active = endEffectorControlRef.current;
    if (!target || !active || lockedEndEffectorsRef.current[active.side]) return;
    robotDragActionsRef.current?.clear();
    applyPoseToWorldTarget(target, pose);
    updateEndEffectorTarget(true);
  };

  const resetEndEffectorJoints = () => {
    const active = endEffectorControlRef.current;
    if (!active || lockedEndEffectorsRef.current[active.side]) return;
    robotDragActionsRef.current?.clear();
    const frozenJoints = restoreLockedEndEffectorJoints(active.side);
    const values = readRobotJointValues(active.controller.robot);
    active.controller.joints.forEach((joint) => {
      if (!frozenJoints.has(joint)) values[joint.name] = 0;
    });
    applyRobotJointValues(active.controller.robot, values);
    robotJointValuesRef.current = readRobotJointValues(active.controller.robot);
    active.referenceJointValues = { ...robotJointValuesRef.current };
    cameraIkReferencesRef.current = { left: null, right: null };
    const pose = poseFromWorldObject(active.controller.frame);
    applyPoseToWorldTarget(endEffectorTargetRef.current, pose);
    active.pose = pose;
    active.status = 'tracking';
    active.positionError = 0;
    active.rotationError = 0;
    updateEndEffectorTarget(true);
  };

  const setEndEffectorLockMode = (requestedMode) => {
    const active = endEffectorControlRef.current;
    const transform = transformControlsRef.current;
    const target = endEffectorTargetRef.current;
    const canvas = controlsRef.current?.domElement;
    if (
      !active
      || !transform
      || !target
      || transform.dragging
      || !['body', 'map'].includes(requestedMode)
    ) return;

    const existingLock = lockedEndEffectorsRef.current[active.side];
    if (existingLock?.type === requestedMode) {
      lockedEndEffectorsRef.current = {
        ...lockedEndEffectorsRef.current,
        [active.side]: null,
      };
      const frozenJoints = restoreLockedEndEffectorJoints(active.side);
      active.controller.robot.updateMatrixWorld(true);
      const pose = poseFromWorldObject(active.controller.frame);
      applyPoseToWorldTarget(target, pose);
      target.visible = true;
      transform.enabled = true;
      transform.setSpace('world');
      transform.setMode(active.mode);
      transform.attach(target);
      active.pose = pose;
      active.status = 'tracking';
      active.positionError = 0;
      active.rotationError = 0;
      active.referenceJointValues = readRobotJointValues(active.controller.robot);
      setEndEffectorControl(endEffectorPanelState(active));
      syncEndEffectorLockState(active.side);
      if (canvas) {
        canvas.dataset.endEffectorIkStatus = 'tracking';
        canvas.dataset.endEffectorSpaceBallVisible = 'true';
        canvas.dataset.endEffectorTransformAttached = 'true';
        canvas.dataset.endEffectorFrozenJointCount = String(
          active.controller.joints.filter((joint) => frozenJoints.has(joint)).length,
        );
      }
      reportRobotJointValues(true);
      canvas?.focus({ preventScroll: true });
      return;
    }

    if (existingLock?.type === 'body') {
      existingLock.jointValues.forEach((value, joint) => setRobotJointValue(joint, value));
    } else if (existingLock?.type === 'map') {
      solveGlobalEndEffectorLocks(true, [active.side]);
    } else {
      updateEndEffectorTarget(true);
    }
    active.controller.robot.updateMatrixWorld(true);
    const pose = poseFromWorldObject(active.controller.frame);
    const worldPosition = active.controller.frame.getWorldPosition(new THREE.Vector3());
    const worldQuaternion = active.controller.frame
      .getWorldQuaternion(new THREE.Quaternion())
      .normalize();
    const lock = requestedMode === 'body'
      ? {
        type: 'body',
        side: active.side,
        jointValues: new Map(
          active.controller.joints.map((joint) => [
            joint,
            Number(joint.userData.jointValue) || 0,
          ]),
        ),
      }
      : {
        type: 'map',
        side: active.side,
        referenceJointValues: readRobotJointValues(active.controller.robot),
        pose,
        targetPosition: worldPosition.clone(),
        targetQuaternion: worldQuaternion.clone(),
        lastResult: {
          actualPose: pose,
          positionError: 0,
          rotationError: 0,
          status: 'tracking',
          frozenJointCount: 0,
        },
      };
    lockedEndEffectorsRef.current = {
      ...lockedEndEffectorsRef.current,
      [active.side]: lock,
    };
    applyPoseToWorldTarget(target, pose);
    transform.detach();
    transform.enabled = false;
    target.visible = false;
    if (controlsRef.current) controlsRef.current.enabled = true;
    active.pose = pose;
    active.status = requestedMode === 'body' ? 'locked' : 'tracking';
    active.positionError = 0;
    active.rotationError = 0;
    setEndEffectorControl(endEffectorPanelState(active));
    syncEndEffectorLockState(active.side);
    if (canvas) {
      canvas.dataset.endEffectorIkStatus = active.status;
      canvas.dataset.endEffectorPositionError = '0.00000e+0';
      canvas.dataset.endEffectorRotationError = '0.0000';
      canvas.dataset.endEffectorSpaceBallVisible = 'false';
      canvas.dataset.endEffectorTransformAttached = 'false';
      canvas.dataset.endEffectorFrozenJointCount = requestedMode === 'body'
        ? String(lock.jointValues.size)
        : '0';
    }
    if (requestedMode === 'map') solveGlobalEndEffectorLocks(true, [active.side]);
    reportRobotJointValues(true);
  };

  const toggleBodyEndEffectorLock = () => setEndEffectorLockMode('body');
  const toggleMapEndEffectorLock = () => setEndEffectorLockMode('map');

  const clearEndEffectorLocks = () => {
    lockedEndEffectorsRef.current = createEndEffectorLocks();
    setEndEffectorLockModesState({ left: null, right: null });
    writeEndEffectorLockDataset(controlsRef.current?.domElement, lockedEndEffectorsRef.current);
  };

  const writeRobotDragHistoryDataset = () => {
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.robotDragUndoDepth = String(robotDragHistoryRef.current.entries.length);
    }
  };

  const clearRobotDragHistory = () => {
    const history = robotDragHistoryRef.current;
    history.entries = [];
    history.pending = null;
    writeRobotDragHistoryDataset();
  };

  const captureRobotDragState = () => {
    const active = endEffectorControlRef.current;
    return {
      robot: loadedRobotRef.current,
      pose: normalizeRobotPose(robotPoseRef.current),
      joints: readRobotJointValues(loadedRobotRef.current),
      locks: cloneEndEffectorLocks(lockedEndEffectorsRef.current),
      control: active && {
        side: active.side,
        referenceJointValues: active.referenceJointValues && { ...active.referenceJointValues },
        pose: normalizeRobotPose(active.pose),
        status: active.status,
        positionError: active.positionError,
        rotationError: active.rotationError,
        ...(active.side === 'torso' && {
          heightError: active.heightError,
          armLockLimited: active.armLockLimited,
          referenceForward: active.referenceForward,
        }),
      },
    };
  };

  const beginRobotDrag = (kind) => {
    const history = robotDragHistoryRef.current;
    if (history.restoring || !loadedRobotRef.current || robotTrajectoryActiveRef.current) return;
    history.pending = { kind, before: captureRobotDragState(), moved: false };
  };

  const markRobotDragMovement = () => {
    const pending = robotDragHistoryRef.current.pending;
    if (!pending || pending.moved) return;
    const endEffector = pending.kind === 'end-effector';
    const before = endEffector ? pending.before.control?.pose : pending.before.pose;
    const current = endEffector
      ? poseFromWorldObject(endEffectorTargetRef.current)
      : robotPoseRef.current;
    pending.moved = Boolean(before && !sameRobotPose(before, current));
  };

  const finishRobotDrag = () => {
    const history = robotDragHistoryRef.current;
    const pending = history.pending;
    if (history.restoring || !pending) return;
    history.pending = null;
    if (!pending.moved) return;
    const after = captureRobotDragState();
    const before = pending.before;
    const targetChanged = before.control && after.control
      && !sameRobotPose(before.control.pose, after.control.pose);
    if (
      !targetChanged
      && sameRobotPose(before.pose, after.pose)
      && sameNumericValues(before.joints, after.joints)
    ) return;
    history.entries.push(pending);
    if (history.entries.length > ROBOT_DRAG_UNDO_LIMIT) history.entries.shift();
    writeRobotDragHistoryDataset();
  };

  const undoRobotDrag = () => {
    const history = robotDragHistoryRef.current;
    if (!renderActiveRef.current || robotTrajectoryActiveRef.current || history.restoring) {
      return false;
    }
    // A gesture still under the pointer takes priority over completed drags.
    const entry = history.pending || history.entries.pop();
    if (!entry) return false;
    const snapshot = entry.before;
    if (snapshot.robot !== loadedRobotRef.current) {
      clearRobotDragHistory();
      return false;
    }
    history.restoring = true;
    history.pending = null;
    try {
      const transform = transformControlsRef.current;
      if (transform?.dragging) transform.pointerUp(null);
      chassisDragInteractionRef.current?.cancel?.('undo');
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();

      lockedEndEffectorsRef.current = cloneEndEffectorLocks(snapshot.locks);
      robotPoseRef.current = applyRobotPose(robotLayerRef.current, snapshot.pose);
      applyRobotJointStateToScene(snapshot.joints, 'drag-undo');
      const canvas = controlsRef.current?.domElement;
      writeRobotPoseDataset(canvas, robotPoseRef.current);
      updateRobotParkingGhostGuide(robotParkingGhostVisualRef.current, snapshot.pose, canvas);

      const active = endEffectorControlRef.current;
      const target = endEffectorTargetRef.current;
      if (active && target && transform) {
        const lock = lockedEndEffectorsRef.current[active.side];
        const saved = snapshot.control?.side === active.side ? snapshot.control : null;
        const actualPose = poseFromWorldObject(active.controller.frame);
        active.pose = normalizeRobotPose(saved?.pose || lock?.pose || actualPose);
        active.status = lock?.type === 'body' ? 'locked' : saved?.status || 'tracking';
        active.positionError = saved?.positionError || 0;
        active.rotationError = saved?.rotationError || 0;
        active.referenceJointValues = { ...(saved?.referenceJointValues || snapshot.joints) };
        applyPoseToWorldTarget(target, active.pose);
        if (active.side === 'torso') {
          active.torsoPose = readRobotTorsoPose(active.controller);
          active.heightError = saved?.heightError || 0;
          active.armLockLimited = Boolean(saved?.armLockLimited);
          active.referenceForward = saved?.referenceForward ?? active.torsoPose.forward;
          configureTorsoTransform(active);
        }
        transform.detach();
        transform.enabled = !lock;
        target.visible = !lock;
        if (!lock) transform.attach(target);
        setEndEffectorControl(endEffectorPanelState(active));
        writeActiveEndEffectorDataset(canvas, active, { ...active, actualPose }, active.pose);
        canvas.dataset.endEffectorSpaceBallVisible = lock ? 'false' : 'true';
        canvas.dataset.endEffectorTransformAttached = lock ? 'false' : 'true';
      }
      syncEndEffectorLockState();
      // Restore saved joint angles exactly; another IK solve could choose a
      // different posture for the same target, especially near a joint limit.
      onRobotPoseChangeRef.current?.(normalizeRobotPose(snapshot.pose));
      cameraIkReferencesRef.current = { left: null, right: null };
      reportRobotJointValues(true);
      reportZividCameraPoses(true);
      if (canvas) {
        canvas.dataset.robotDragUndoCount = String(
          Number(canvas.dataset.robotDragUndoCount || 0) + 1,
        );
        canvas.dataset.robotDragUndoKind = entry.kind;
      }
    } finally {
      history.restoring = false;
      writeRobotDragHistoryDataset();
    }
    return true;
  };

  const cancelEndEffectorControl = () => {
    const snapshot = endEffectorControlRef.current?.initialState;
    const history = robotDragHistoryRef.current;
    if (
      !snapshot
      || snapshot.robot !== loadedRobotRef.current
      || robotTrajectoryActiveRef.current
      || history.restoring
    ) return false;

    // Stop an unfinished drag without committing it or running another IK solve.
    history.restoring = true;
    history.pending = null;
    try {
      exitEndEffectorControl();
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();
      setShiftPanArmed(false);
      lockedEndEffectorsRef.current = cloneEndEffectorLocks(snapshot.locks);
      robotPoseRef.current = applyRobotPose(robotLayerRef.current, snapshot.pose);
      applyRobotJointStateToScene(snapshot.joints, 'end-effector-cancel');
      cameraIkReferencesRef.current = { left: null, right: null };
      const canvas = controlsRef.current?.domElement;
      writeRobotPoseDataset(canvas, robotPoseRef.current);
      updateRobotParkingGhostGuide(robotParkingGhostVisualRef.current, snapshot.pose, canvas);
      syncEndEffectorLockState();
      onRobotPoseChangeRef.current?.(normalizeRobotPose(snapshot.pose));
      reportRobotJointValues(true);
      reportZividCameraPoses(true);
      history.entries = [...snapshot.undoEntries];
      canvas?.focus({ preventScroll: true });
    } finally {
      history.restoring = false;
      writeRobotDragHistoryDataset();
    }
    return true;
  };

  robotDragActionsRef.current = {
    begin: beginRobotDrag,
    markMovement: markRobotDragMovement,
    finish: finishRobotDrag,
    clear: clearRobotDragHistory,
    undo: undoRobotDrag,
  };

  endEffectorInteractionRef.current = {
    enter: enterEndEffectorControl,
    exit: exitEndEffectorControl,
    cancel: cancelEndEffectorControl,
  };
  endEffectorObjectChangeRef.current = () => updateEndEffectorTarget(false);

  useEffect(() => {
    const nextPose = normalizeRobotPose(robotPose);
    if (!sameRobotPose(nextPose, robotPoseRef.current)) clearRobotDragHistory();
    robotPoseRef.current = nextPose;
    applyRobotPose(robotLayerRef.current, nextPose);
    const canvas = controlsRef.current?.domElement;
    writeRobotPoseDataset(canvas, nextPose);
    updateRobotParkingGhostGuide(robotParkingGhostVisualRef.current, nextPose, canvas);
  }, [mapData?.geometry, robotPose]);

  useLayoutEffect(() => {
    const robot = loadedRobotRef.current;
    if (!robot || robotLoadStateRef.current?.status !== 'loaded') return;
    endEffectorInteractionRef.current?.exit?.();
    clearEndEffectorLocks();
    clearRobotDragHistory();
    cameraIkReferencesRef.current = { left: null, right: null };
    configureRobotJointCoupling(robot, robotArmJointCouplingEnabled);
    const movableJoints = configureRobotArmSoftLimits(robot, robotArmSoftLimitRatio);
    onRobotLoadStateRef.current?.({ ...robotLoadStateRef.current, movableJoints });
    reportRobotJointValues(true);
    reportZividCameraPoses(true);
  }, [robotArmSoftLimitRatio, robotArmJointCouplingEnabled]);

  useLayoutEffect(() => {
    const changed = !sameNumericValues(normalizeRobotJointValues(robotJointValues), robotJointValuesRef.current);
    if (changed) clearRobotDragHistory();
    const appliedValues = applyRobotJointStateToScene(robotJointValues, 'external-control');
    if (loadedRobotRef.current) {
      robotJointValuesRef.current = appliedValues;
      // Applying an older saved pose may clamp it to today's operating limits.
      // Publish the actual pose so the controls, iPad and new captures agree.
      if (!sameNumericValues(normalizeRobotJointValues(robotJointValues), appliedValues)) {
        onRobotJointValuesChangeRef.current?.(appliedValues);
      }
      reportZividCameraPoses(true);
      const active = endEffectorControlRef.current;
      if (changed) {
        cameraIkReferencesRef.current = { left: null, right: null };
        Object.values(lockedEndEffectorsRef.current).forEach((lock) => {
          if (lock?.type === 'map') lock.referenceJointValues = { ...appliedValues };
        });
        if (active && active.side !== 'torso') {
          // Sliders, presets and playback are explicit posture edits. Rebase
          // the preference, and keep a free gizmo on the newly edited tool.
          active.referenceJointValues = { ...appliedValues };
          if (!lockedEndEffectorsRef.current[active.side]) {
            active.pose = poseFromWorldObject(active.controller.frame);
            active.status = 'tracking';
            active.positionError = 0;
            active.rotationError = 0;
            applyPoseToWorldTarget(endEffectorTargetRef.current, active.pose);
            setEndEffectorControl(endEffectorPanelState(active));
            writeActiveEndEffectorDataset(controlsRef.current?.domElement, active, {
              ...active, actualPose: active.pose,
            }, active.pose);
          }
        }
      }
      if (changed && active?.side === 'torso') {
        active.torsoPose = readRobotTorsoPose(active.controller);
        active.referenceForward = active.torsoPose.forward;
        active.status = 'tracking';
        active.heightError = 0;
        active.positionError = 0;
        active.rotationError = 0;
        active.armLockLimited = false;
        syncTorsoTarget(active);
        setEndEffectorControl(endEffectorPanelState(active));
        writeActiveEndEffectorDataset(controlsRef.current?.domElement, active, {
          ...active, actualPose: active.pose,
        }, active.pose);
      }
    }
  }, [mapData?.geometry, robotJointValues]);

  useEffect(() => {
    writeRobotJointLockDataset(
      controlsRef.current?.domElement,
      lockedRobotJointNamesRef.current,
    );
  }, [lockedRobotJointNames, mapData?.geometry]);

  useEffect(() => {
    const revision = Number(cameraTeachingCommand?.revision) || 0;
    if (!revision || revision === appliedCameraTeachingRevisionRef.current) return;
    appliedCameraTeachingRevisionRef.current = revision;

    const side = cameraTeachingCommand?.side === 'right' ? 'right' : 'left';
    const actionId = String(cameraTeachingCommand?.action || '');
    const commandSource = cameraTeachingCommand?.source === 'spacemouse'
      ? 'spacemouse'
      : 'button';
    const action = CAMERA_TEACH_ACTIONS[actionId];
    const canvas = controlsRef.current?.domElement;
    const publishFailure = (message) => {
      if (canvas) {
        canvas.dataset.cameraTeachingState = 'error';
        canvas.dataset.cameraTeachingRevision = String(revision);
        canvas.dataset.cameraTeachingSide = side;
        canvas.dataset.cameraTeachingAction = actionId;
        canvas.dataset.cameraTeachingSource = commandSource;
        canvas.dataset.cameraTeachingIkStatus = 'error';
        canvas.dataset.cameraTeachingError = message;
      }
      onCameraTeachingResultRef.current?.({
        revision,
        side,
        action: actionId,
        status: 'error',
        message,
      });
    };

    const robot = loadedRobotRef.current;
    const armController = endEffectorControllersRef.current[side];
    const opticalFrame = zividCameraFramesRef.current[side];
    if (!action) {
      publishFailure('未知的相机示教动作');
      return;
    }
    if (!robot || !armController || !opticalFrame) {
      publishFailure(`${side === 'left' ? '左' : '右'}臂相机运动链尚未就绪`);
      return;
    }

    if (endEffectorControlRef.current) endEffectorInteractionRef.current?.exit?.();
    clearRobotDragHistory();
    if (lockedEndEffectorsRef.current[side]) {
      lockedEndEffectorsRef.current = {
        ...lockedEndEffectorsRef.current,
        [side]: null,
      };
      syncEndEffectorLockState(side);
    }
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();

    robot.updateMatrixWorld(true);
    const targetPosition = opticalFrame.getWorldPosition(new THREE.Vector3());
    const targetQuaternion = opticalFrame
      .getWorldQuaternion(new THREE.Quaternion())
      .normalize();
    const localAxis = new THREE.Vector3(...action.axis).normalize();
    if (action.kind === 'translate') {
      const linearStep = THREE.MathUtils.clamp(
        Math.abs(Number(cameraTeachingCommand?.linearStep) || 0.025),
        0.001,
        0.1,
      );
      targetPosition.addScaledVector(
        localAxis.applyQuaternion(targetQuaternion),
        linearStep * action.direction,
      );
    } else {
      const angularStep = THREE.MathUtils.clamp(
        Math.abs(Number(cameraTeachingCommand?.angularStep) || 3),
        0.2,
        15,
      );
      targetQuaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(
          localAxis,
          THREE.MathUtils.degToRad(angularStep * action.direction),
        ),
      ).normalize();
    }

    if (canvas) {
      canvas.dataset.cameraTeachingState = 'solving';
      canvas.dataset.cameraTeachingRevision = String(revision);
      canvas.dataset.cameraTeachingSide = side;
      canvas.dataset.cameraTeachingAction = actionId;
      canvas.dataset.cameraTeachingSource = commandSource;
      canvas.dataset.cameraTeachingTargetPosition = targetPosition
        .toArray()
        .map((value) => value.toFixed(7))
        .join(',');
      canvas.dataset.cameraTeachingTargetQuaternion = targetQuaternion
        .toArray()
        .map((value) => value.toFixed(9))
        .join(',');
      delete canvas.dataset.cameraTeachingError;
    }

    const frozenJoints = restoreLockedEndEffectorJoints(side);
    const previousReference = cameraIkReferencesRef.current[side];
    if (previousReference?.robot !== robot) {
      cameraIkReferencesRef.current[side] = { robot, joints: readRobotJointValues(robot) };
    }
    const result = solveEndEffectorIk(
      { ...armController, frame: opticalFrame },
      targetPosition,
      targetQuaternion,
      frozenJoints,
      { referenceJointValues: cameraIkReferencesRef.current[side].joints },
    );
    if (!result) {
      publishFailure('相机位姿逆解失败');
      return;
    }

    robot.updateMatrixWorld(true);
    const actualPose = zividOpticalPoseFromObject(opticalFrame, side);
    reportRobotJointValues(true);
    reportZividCameraPoses(true);
    const output = {
      revision,
      side,
      action: actionId,
      source: commandSource,
      status: result.status,
      positionError: result.positionError,
      rotationError: result.rotationError,
      frozenJointCount: result.frozenJointCount,
      chainJointCount: armController.joints.length,
      pose: actualPose,
    };
    if (canvas) {
      canvas.dataset.cameraTeachingState = 'settled';
      canvas.dataset.cameraTeachingIkStatus = result.status;
      canvas.dataset.cameraTeachingPositionError = result.positionError.toExponential(5);
      canvas.dataset.cameraTeachingRotationError = result.rotationError.toFixed(5);
      canvas.dataset.cameraTeachingChainJointCount = String(armController.joints.length);
      canvas.dataset.cameraTeachingActualPosition = [
        actualPose?.position.x || 0,
        actualPose?.position.y || 0,
        actualPose?.position.z || 0,
      ].map((value) => value.toFixed(7)).join(',');
    }
    onCameraTeachingResultRef.current?.(output);
  }, [cameraTeachingCommand, mapData?.geometry]);

  useEffect(() => {
    const mount = mountRef.current;
    const geometry = mapData?.geometry;
    if (!mount || !geometry) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071014);
    scene.fog = new THREE.FogExp2(0x071014, 0.0032);
    const hemisphereLight = new THREE.HemisphereLight(0xd8f4f3, 0x172229, 2.15);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.65);
    keyLight.position.set(-4, -6, 9);
    const fillLight = new THREE.DirectionalLight(0x76dce7, 1.15);
    fillLight.position.set(5, 3, 2);
    scene.add(hemisphereLight, keyLight, fillLight);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'three-canvas';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '三维点云交互画布');
    renderer.domElement.setAttribute(
      'aria-keyshortcuts',
      'W A S D Q E ArrowUp ArrowDown ArrowLeft ArrowRight Escape Shift+W Shift+A Shift+S Shift+D Shift+Q Shift+E Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight',
    );
    if (viewportCanvasRef) viewportCanvasRef.current = renderer.domElement;
    writeRobotJointLockDataset(renderer.domElement, lockedRobotJointNamesRef.current);
    renderer.domElement.dataset.geometrySource =
      mapData.geometrySource || geometry.userData.geometrySource || 'ply-parse';
    renderer.domElement.dataset.teachingSpaceMode = mapData.teachingSpaceMode || 'map';
    renderer.domElement.dataset.coordinateFrame = mapData.coordinateFrame || 'map';
    renderer.domElement.dataset.spaceOrigin = '0,0,0';
    mount.appendChild(renderer.domElement);

    const bounds = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    const center = sphere.center;
    const radius = Math.max(sphere.radius, 1);
    const overviewNear = Math.max(radius / 2000, 0.01);
    const detailDollyFloor = Math.max(radius * DETAIL_DOLLY_FLOOR_RATIO, 1e-7);
    const minimumEffectiveDistance = detailDollyFloor / MAX_OPTICAL_ZOOM;
    const camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, 1, overviewNear, radius * 30);
    camera.up.set(0, 0, 1);
    camera.position.set(
      center.x - radius * 0.6,
      center.y - radius * 0.85,
      center.z + radius * 0.48,
    );

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.target.copy(center);
    configureViewportTrackball(controls);
    controls.minDistance = detailDollyFloor;
    renderer.domElement.dataset.controlMode = 'free-trackball';
    renderer.domElement.dataset.zoomMode = 'hybrid-continuous-detail';
    renderer.domElement.dataset.keyboardPlane = 'xy-target-locked';
    renderer.domElement.dataset.keyboardVerticalAxis = 'q:+z,e:-z';
    renderer.domElement.dataset.keyboardLookMode = 'arrow-orbit-target';
    renderer.domElement.dataset.keyboardLookKeys =
      'arrowup:pitch-up,arrowdown:pitch-down,arrowleft:yaw-left,arrowright:yaw-right';
    renderer.domElement.dataset.keyboardYawOwnership = 'camera-unless-mecanum-control';
    renderer.domElement.dataset.keyboardPanMode = 'world-with-precision-offset';
    renderer.domElement.dataset.keyboardPanImplementation = 'world';
    renderer.domElement.dataset.keyboardVerticalPanMode = 'world-with-precision-offset';
    renderer.domElement.dataset.keyboardFocusPolicy = 'wheel-or-pointer-claims-canvas';
    renderer.domElement.dataset.keyboardDetailSpeed = 'constant-screen-space';
    renderer.domElement.dataset.shiftPanScope = 'camera-and-robot';
    renderer.domElement.dataset.shiftPanPriority = 'viewport-first';
    renderer.domElement.dataset.spacemouseConnected = spaceMouseInputRef?.current?.connected
      ? 'true'
      : 'false';
    renderer.domElement.dataset.spacemouseControlEnabled =
      spaceMouseInputRef?.current?.controlEnabled === false ? 'false' : 'true';
    renderer.domElement.dataset.spacemouseButtonGesture =
      'left-cycle-xyz,right-cycle-rpy,same-button-double-pause';
    renderer.domElement.dataset.spacemouseControlTarget = 'viewport';
    renderer.domElement.dataset.spacemouseCoexistence = 'parallel-input';
    renderer.domElement.dataset.spacemouseZoomPolicy = 'mouse-only';
    renderer.domElement.dataset.spacemouseXPolicy = 'camera-heading-translation-no-zoom';
    renderer.domElement.dataset.spacemouseYPolarity = '+y:left,-y:right';
    renderer.domElement.dataset.spacemouseZPolarity = '+z:up,-z:down';
    renderer.domElement.dataset.spacemouseWheelGuardMs = String(SPACEMOUSE_WHEEL_GUARD_MS);
    renderer.domElement.dataset.spacemouseWheelArbitrationMs = String(
      SPACEMOUSE_WHEEL_ARBITRATION_MS,
    );
    renderer.domElement.dataset.spacemouseWheelArbitration = 'idle';
    renderer.domElement.dataset.spacemouseWheelSuppressedCount = '0';
    renderer.domElement.dataset.spacemouseCalibrationIsolation = 'enabled';
    renderer.domElement.dataset.spacemouseMotionFilter = 'adaptive-frame-low-pass';
    renderer.domElement.dataset.spacemouseAxisPolicy = 'button-selected-only';
    renderer.domElement.dataset.spacemouseSelectedAxis =
      spaceMouseInputRef?.current?.selectedAxis || 'x';
    renderer.domElement.dataset.spacemouseAxisHudHoldMs = String(SPACEMOUSE_AXIS_HUD_HOLD_MS);
    renderer.domElement.dataset.spacemouseAxisHudState = 'hidden';
    renderer.domElement.dataset.spacemouseDominantAxis = '';
    renderer.domElement.dataset.spacemouseAppliedAxisCount = '0';
    renderer.domElement.dataset.spacemouseFilterAttackMs = String(
      SPACEMOUSE_FILTER_ATTACK_SECONDS * 1000,
    );
    renderer.domElement.dataset.spacemouseFilterReleaseMs = String(
      SPACEMOUSE_FILTER_RELEASE_SECONDS * 1000,
    );
    renderer.domElement.dataset.spacemouseMotionState = 'idle';
    renderer.domElement.dataset.spacemouseMode = spaceMouseInputRef?.current?.mode || 'xyz';
    renderer.domElement.dataset.spacemouseInputCount = '0';
    renderer.domElement.dataset.keyboardPrecisionMovementCount = '0';
    renderer.domElement.dataset.keyboardRotationSpeed = '72deg/s';
    renderer.domElement.dataset.minCameraDistance = detailDollyFloor.toPrecision(8);
    renderer.domElement.dataset.minEffectiveDistance = minimumEffectiveDistance.toExponential(6);
    renderer.domElement.dataset.maxOpticalZoom = MAX_OPTICAL_ZOOM.toExponential(0);
    renderer.domElement.dataset.cameraFov = String(camera.fov);
    renderer.domElement.dataset.cameraTeachingState = 'idle';
    renderer.domElement.dataset.cameraTeachingIkStatus = 'idle';
    controlsRef.current = controls;
    cameraRef.current = camera;
    const defaultCameraView = {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
      zoom: 1,
      projectionOffset: { x: 0, y: 0 },
    };
    const navigation = createViewportNavigation(camera, controls, radius);
    const { projectionPan, applyProjectionPan, getPanMetrics, needsPrecisionPanForDistance, zoomBoostForDistance } = navigation;

    const claimKeyboardFocus = (source) => {
      if (document.activeElement !== renderer.domElement) {
        renderer.domElement.focus({ preventScroll: true });
      }
      renderer.domElement.dataset.keyboardFocusSource = source;
      renderer.domElement.dataset.keyboardFocusClaimCount = String(
        Number(renderer.domElement.dataset.keyboardFocusClaimCount || 0) + 1,
      );
    };

    const topology = prepareMapGeometryTopology(geometry);
    const pointRenderOrder = geometry.userData.pointRenderOrder;
    const displayGeometry = new THREE.BufferGeometry();
    Object.entries(geometry.attributes).forEach(([name, attribute]) => {
      displayGeometry.setAttribute(name, attribute);
    });
    const teachingSurfaceCoverageAttribute = new THREE.Float32BufferAttribute(
      new Float32Array(geometry.getAttribute('position').count),
      1,
    );
    displayGeometry.setAttribute(
      TEACHING_SURFACE_COVERAGE_ATTRIBUTE,
      teachingSurfaceCoverageAttribute,
    );
    displayGeometry.setIndex(
      new THREE.BufferAttribute(pointRenderOrder, 1),
    );
    displayGeometry.boundingBox = geometry.boundingBox?.clone() || null;
    displayGeometry.boundingSphere = geometry.boundingSphere?.clone() || null;
    displayGeometryRef.current = displayGeometry;

    const overviewPointSize = Math.max(radius / 1200, 0.035);
    const material = new THREE.PointsMaterial({
      size: overviewPointSize,
      sizeAttenuation: true,
      vertexColors: Boolean(geometry.getAttribute('color')),
      color: geometry.getAttribute('color') ? 0xffffff : 0x9fc7ca,
      transparent: true,
      opacity: 0.92,
    });
    installMapColorShader(material, bounds, colorModeRef.current, { objectColorMode: placedObjectColorModeRef.current });
    cloudMaterialRef.current = material;
    renderer.domElement.dataset.colorMode = colorModeRef.current;
    const cloud = new THREE.Points(displayGeometry, material);
    cloud.name = 'scene-map-point-cloud';
    cloud.renderOrder = 2;

    const mapLayer = new THREE.Group();
    mapLayer.name = 'scene-map-render-layer';
    let surfaceGeometry = null;
    let meshMaterial = null;
    if (topology.hasMesh) {
      surfaceGeometry = new THREE.BufferGeometry();
      Object.entries(geometry.attributes).forEach(([name, attribute]) => {
        surfaceGeometry.setAttribute(name, attribute);
      });
      surfaceGeometry.setAttribute(
        TEACHING_SURFACE_COVERAGE_ATTRIBUTE,
        teachingSurfaceCoverageAttribute,
      );
      const sourceMeshIndex = geometry.getIndex();
      const sampledFaceCapacity = Math.max(
        0,
        ...MESH_RENDER_QUALITY_OPTIONS.flatMap((option) => (
          Number.isFinite(option.triangleBudget)
            && option.triangleBudget < topology.faceCount
            ? [option.triangleBudget]
            : []
        )),
      );
      const sampledMeshIndices = sampledFaceCapacity
        ? createUniformMeshIndex(sourceMeshIndex, sampledFaceCapacity)
        : sourceMeshIndex.array;
      const sampledMeshIndex = sampledMeshIndices === sourceMeshIndex.array
        ? sourceMeshIndex
        : new THREE.BufferAttribute(sampledMeshIndices, 1);
      surfaceGeometry.setIndex(meshQualityPlan.isFull ? sourceMeshIndex : sampledMeshIndex);
      surfaceGeometry.setDrawRange(0, meshQualityPlan.renderedFaceCount * 3);
      surfaceGeometry.boundingBox = geometry.boundingBox?.clone() || null;
      surfaceGeometry.boundingSphere = geometry.boundingSphere?.clone() || null;
      surfaceGeometryRef.current = {
        geometry: surfaceGeometry,
        sourceIndex: sourceMeshIndex,
        sampledIndex: sampledMeshIndex,
      };
      meshMaterial = new THREE.MeshBasicMaterial({
        vertexColors: Boolean(geometry.getAttribute('color')),
        color: geometry.getAttribute('color') ? 0xffffff : 0x9fc7ca,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        fog: true,
        toneMapped: false,
      });
      installMapColorShader(meshMaterial, bounds, colorModeRef.current, { surface: true, objectColorMode: placedObjectColorModeRef.current });
      meshMaterialRef.current = meshMaterial;
      const mesh = new THREE.Mesh(surfaceGeometry, meshMaterial);
      mesh.name = 'scene-map-embedded-mesh';
      mesh.renderOrder = 1;
      mapLayer.add(mesh);
    }
    mapLayer.add(cloud);
    cloud.visible = topology.unreferencedPointCount > 0;
    renderer.domElement.dataset.mapRenderMode = topology.hasMesh ? 'hybrid-mesh-points' : 'points';
    renderer.domElement.dataset.mapPointCloudVisible = cloud.visible ? 'true' : 'false';
    renderer.domElement.dataset.plyMeshVisible = topology.hasMesh ? 'true' : 'false';
    renderer.domElement.dataset.plyMeshFaceCount = String(topology.faceCount);
    renderer.domElement.dataset.plyMeshReferencedPointCount = String(
      topology.referencedPointCount,
    );
    renderer.domElement.dataset.plyUnmeshedPointCount = String(
      topology.unreferencedPointCount,
    );
    renderer.domElement.dataset.plyMeshRenderStrategy = topology.renderStrategy;
    renderer.domElement.dataset.meshRenderQuality = meshQualityPlan.requestedId;
    renderer.domElement.dataset.meshRenderQualityEffective = meshQualityPlan.effectiveId;
    renderer.domElement.dataset.renderMeshFaceCount = String(
      meshQualityPlan.renderedFaceCount,
    );
    renderer.domElement.dataset.mapRenderIsolation = 'scene-map-only';
    scene.add(mapLayer);

    // Dolly toward the target first, then continue optically before floating-point
    // precision can collapse camera.position onto controls.target.
    const syncDetailView = () => {
      if (independentTeachingSpace) {
        const mapOrigin = mapOriginGroupRef.current;
        navigation.setReferenceSphere(new THREE.Sphere(new THREE.Vector3(), Math.max(
          referencePlane.userData.size / Math.SQRT2,
          mapOrigin ? mapOrigin.position.length()
            + mapOrigin.userData.baseAxisLength * mapOrigin.scale.x * 1.5 : 0,
        )));
      }
      const { distance, opticalZoom, effectiveDistance, near: nextNear } = navigation.syncClipping();
      const normalizedDistance = Math.max(effectiveDistance / (radius * 0.35), 1e-24);
      const pointSizeScale = Math.min(1, Math.max(normalizedDistance ** 0.82, 2e-5));

      material.size = overviewPointSize * pointSizeScale;

      renderer.domElement.dataset.cameraDistance = distance.toPrecision(8);
      renderer.domElement.dataset.effectiveCameraDistance = effectiveDistance.toExponential(8);
      renderer.domElement.dataset.cameraNear = nextNear.toPrecision(8);
      renderer.domElement.dataset.cameraFar = camera.far.toPrecision(8);
      renderer.domElement.dataset.opticalZoom = opticalZoom.toExponential(8);
      renderer.domElement.dataset.zoomStage = opticalZoom > 1.000001 ? 'optical' : 'dolly';
      renderer.domElement.dataset.zoomBoost = zoomBoostForDistance(effectiveDistance).toFixed(3);
      renderer.domElement.dataset.pointSize = material.size.toPrecision(8);
      renderer.domElement.dataset.cameraX = camera.position.x.toPrecision(10);
      renderer.domElement.dataset.cameraY = camera.position.y.toPrecision(10);
      renderer.domElement.dataset.cameraZ = camera.position.z.toPrecision(10);
      renderer.domElement.dataset.targetX = controls.target.x.toPrecision(10);
      renderer.domElement.dataset.targetY = controls.target.y.toPrecision(10);
      renderer.domElement.dataset.targetZ = controls.target.z.toPrecision(10);
      renderer.domElement.dataset.cameraUpX = camera.up.x.toPrecision(10);
      renderer.domElement.dataset.cameraUpY = camera.up.y.toPrecision(10);
      renderer.domElement.dataset.cameraUpZ = camera.up.z.toPrecision(10);
    };

    const readLastSpaceMousePhysicalMotionAt = () => Math.max(
      Number(spaceMouseInputRef?.current?.lastPhysicalMotionTimestamp || 0),
      Number(spaceMouseInputRef?.current?.lastMotionTimestamp || 0),
    );
    const suppressSpaceMouseWheel = (reason, eventCount = 1) => {
      renderer.domElement.dataset.spacemouseWheelSuppressedCount = String(
        Number(renderer.domElement.dataset.spacemouseWheelSuppressedCount || 0)
          + eventCount,
      );
      renderer.domElement.dataset.lastZoomDecision = reason;
      renderer.domElement.dataset.spacemouseWheelArbitration = 'blocked';
    };
    const applyProgressiveWheelDelta = (delta) => {
      claimKeyboardFocus('wheel');
      if (navigation.applyWheelDelta(delta)) {
        syncDetailView();
        reportCameraView();
        renderer.domElement.dataset.lastZoomSource = 'wheel';
      }
      renderer.domElement.dataset.lastZoomDecision = 'accepted-mouse-wheel';
      renderer.domElement.dataset.spacemouseWheelArbitration = 'accepted';
    };
    let pendingWheelArbitration = null;
    let pendingWheelArbitrationTimer = null;
    const flushPendingWheelArbitration = () => {
      pendingWheelArbitrationTimer = null;
      const pending = pendingWheelArbitration;
      pendingWheelArbitration = null;
      if (!pending) return;

      const now = performance.now();
      const lastPhysicalMotionAt = readLastSpaceMousePhysicalMotionAt();
      const hidReportFollowedWheel = (
        lastPhysicalMotionAt >= pending.startedAt - 1
        && lastPhysicalMotionAt <= now
      );
      if (spaceMouseInputRef?.current?.connected && hidReportFollowedWheel) {
        // Some 3DxWare builds dispatch the mapped wheel event before the WebHID
        // report. Waiting one short frame window lets us classify that ordering
        // without making a real mouse wheel unavailable in RPY mode.
        suppressSpaceMouseWheel(
          'blocked-spacemouse-driver-wheel-race',
          pending.eventCount,
        );
        return;
      }
      applyProgressiveWheelDelta(pending.delta);
    };
    const progressiveWheelZoom = (event) => {
      const delta = viewportWheelDelta(event, renderer.domElement.clientHeight);
      if (!Number.isFinite(delta) || delta === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const now = performance.now();
      const spaceMouseInput = spaceMouseInputRef?.current;
      const lastPhysicalMotionAt = readLastSpaceMousePhysicalMotionAt();
      const spaceMouseMotionAge = now - lastPhysicalMotionAt;
      if (
        spaceMouseInput?.connected
        && lastPhysicalMotionAt > 0
        && spaceMouseMotionAge >= 0
        && spaceMouseMotionAge <= SPACEMOUSE_WHEEL_GUARD_MS
      ) {
        suppressSpaceMouseWheel('blocked-spacemouse-driver-wheel');
        return;
      }

      if (spaceMouseInput?.connected && spaceMouseInput.mode === 'rpy') {
        if (pendingWheelArbitration) {
          pendingWheelArbitration.delta += delta;
          pendingWheelArbitration.eventCount += 1;
        } else {
          pendingWheelArbitration = {
            delta,
            eventCount: 1,
            startedAt: now,
          };
          pendingWheelArbitrationTimer = window.setTimeout(
            flushPendingWheelArbitration,
            SPACEMOUSE_WHEEL_ARBITRATION_MS,
          );
        }
        renderer.domElement.dataset.lastZoomDecision = 'pending-rpy-wheel-arbitration';
        renderer.domElement.dataset.spacemouseWheelArbitration = 'pending';
        return;
      }
      applyProgressiveWheelDelta(delta);
    };
    renderer.domElement.addEventListener('wheel', progressiveWheelZoom, {
      passive: false,
      capture: true,
    });

    const size = new THREE.Vector3();
    bounds.getSize(size);
    const independentTeachingSpace = mapData.teachingSpaceMode === 'independent';
    const referencePlane = independentTeachingSpace
      ? createIndependentGround(bounds)
      : new THREE.GridHelper(Math.max(size.x, size.y, 10), 40, 0x3f7478, 0x173035);
    if (independentTeachingSpace) {
      navigation.setReferenceSphere(new THREE.Sphere(
        new THREE.Vector3(), referencePlane.userData.size / Math.SQRT2,
      ));
      renderer.domElement.dataset.virtualGroundZ = '0';
      renderer.domElement.dataset.referenceGridSpacing = String(referencePlane.userData.gridSpacing);
      renderer.domElement.dataset.referenceGridSize = String(referencePlane.userData.size);
    } else {
      referencePlane.rotation.x = Math.PI / 2;
      referencePlane.position.set(
        center.x, center.y, bounds.min.z - Math.max(size.z * 0.03, 0.03),
      );
      referencePlane.name = 'map-reference-plane';
      referencePlane.material.transparent = true;
      referencePlane.material.opacity = 0.28;
    }
    renderer.domElement.dataset.referencePlane = referencePlane.name;
    renderer.domElement.dataset.referencePlanePosition = [
      referencePlane.position.x,
      referencePlane.position.y,
      referencePlane.position.z,
    ].join(',');
    scene.add(referencePlane);

    const originGroup = createCoordinateOrigin(THREE.MathUtils.clamp(radius * 0.14, 1, 8));
    originGroup.name = 'ros-rviz-coordinate-origin';
    scene.add(originGroup);
    renderer.domElement.dataset.coordinateOrigin = '0,0,0';
    renderer.domElement.dataset.coordinateOriginStyle = 'ros-rviz';
    renderer.domElement.dataset.coordinateAxisColors = 'x:red,y:green,z:blue';

    const sliceGroup = new THREE.Group();
    sliceGroup.name = 'z-slice-range';
    const routeGroup = new THREE.Group();
    const waypointGroup = new THREE.Group();
    const visionCoverageGroup = new THREE.Group();
    const robotLayer = new THREE.Group();
    const robotParkingGhostLayer = new THREE.Group();
    routeGroup.name = 'directed-route-edges';
    waypointGroup.name = 'navigation-waypoint-markers';
    visionCoverageGroup.name = 'independent-teaching-vision-coverage';
    visionCoverageGroup.visible = visionCoverageRenderingEnabledRef.current;
    robotLayer.name = 'loaded-robot-model';
    robotParkingGhostLayer.name = 'robot-parking-ghost-layer';
    robotParkingGhostLayer.userData.ownedResources = new Set();
    robotLayer.visible = showRobotRef.current;
    robotParkingGhostLayer.visible = showRobotRef.current;
    scene.add(
      sliceGroup,
      visionCoverageGroup,
      robotLayer,
      robotParkingGhostLayer,
      routeGroup,
      waypointGroup,
    );
    sliceGroupRef.current = sliceGroup;
    routeGroupRef.current = routeGroup;
    waypointGroupRef.current = waypointGroup;
    visionCoverageGroupRef.current = visionCoverageGroup;
    robotLayerRef.current = robotLayer;
    robotParkingGhostLayerRef.current = robotParkingGhostLayer;
    robotPoseRef.current = applyRobotPose(robotLayer, robotPoseRef.current);
    writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
    renderer.domElement.dataset.robotLayerVisible = String(robotLayer.visible);
    renderer.domElement.dataset.robotLayerRenderIsolation = 'independent';
    renderer.domElement.dataset.robotControlEnabled = robotControlEnabledRef.current
      ? 'true'
      : 'false';
    renderer.domElement.dataset.robotHeightLocked = robotHeightLockedRef.current
      ? 'true'
      : 'false';
    renderer.domElement.dataset.robotHeightLockBlockedCount = '0';
    renderer.domElement.dataset.keyboardControlOwner = robotControlEnabledRef.current
      ? 'robot'
      : 'camera';
    renderer.domElement.dataset.robotDriveModel = 'mecanum-local-frame';
    renderer.domElement.dataset.robotForwardAxis = '+x';
    renderer.domElement.dataset.robotLeftAxis = '+y';
    renderer.domElement.dataset.robotLinearSpeed = `${ROBOT_LINEAR_SPEED}m/s`;
    renderer.domElement.dataset.robotVerticalSpeed = `${ROBOT_VERTICAL_SPEED}m/s`;
    renderer.domElement.dataset.robotRotationSpeed = '72deg/s';
    renderer.domElement.dataset.chassisDragMode = 'idle';
    renderer.domElement.dataset.chassisDragging = 'false';
    renderer.domElement.dataset.chassisDragPlane = 'map-xy';
    renderer.domElement.dataset.chassisDragPreserves = 'z,roll,pitch,yaw';
    renderer.domElement.dataset.chassisDragHandleReady = 'false';
    renderer.domElement.dataset.robotChassisScreenVisible = 'false';
    renderer.domElement.dataset.chassisControlGuideVisible = 'false';
    sceneRef.current = scene;

    const publishRobotPose = (force = false) => {
      globalEndEffectorUpdateRef.current?.(force);
      const now = performance.now();
      if (
        !force
        && now - lastRobotPoseReportRef.current < ROBOT_POSE_REPORT_INTERVAL
      ) {
        return;
      }
      lastRobotPoseReportRef.current = now;
      onRobotPoseChangeRef.current?.(normalizeRobotPose(robotPoseRef.current));
    };
    const robotPoseActions = { publish: publishRobotPose };
    robotPoseActionsRef.current = robotPoseActions;

    const endEffectorTarget = new THREE.Object3D();
    endEffectorTarget.name = 'end-effector-space-ball-target';
    endEffectorTarget.visible = false;
    const endEffectorSpaceBall = createEndEffectorSpaceBall();
    endEffectorTarget.add(endEffectorSpaceBall);
    scene.add(endEffectorTarget);

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setSize(0.74);
    transformControls.detach();
    const transformHelper = transformControls.getHelper();
    transformHelper.name = 'end-effector-six-dof-transform-controls';
    transformHelper.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach((transformMaterial) => {
        transformMaterial.depthTest = false;
        transformMaterial.depthWrite = false;
      });
      object.renderOrder = 36;
    });
    scene.add(transformHelper);
    transformControlsRef.current = transformControls;
    endEffectorTargetRef.current = endEffectorTarget;
    endEffectorSpaceBallRef.current = endEffectorSpaceBall;
    renderer.domElement.dataset.endEffectorInteraction = 'double-click-space-ball';
    renderer.domElement.dataset.endEffectorControlState = 'idle';
    renderer.domElement.dataset.endEffectorSpaceBallVisible = 'false';
    renderer.domElement.dataset.endEffectorTransformAttached = 'false';
    renderer.domElement.dataset.endEffectorCoordinateFrame = 'map';
    renderer.domElement.dataset.endEffectorIkMethod = 'damped-least-squares';
    renderer.domElement.dataset.endEffectorCenterMesh = 'none';
    renderer.domElement.dataset.endEffectorGuideStyle = 'rgb-rings-only';
    writeEndEffectorLockDataset(renderer.domElement, lockedEndEffectorsRef.current);

    const onTransformDraggingChanged = (event) => {
      controls.enabled = !event.value;
      renderer.domElement.dataset.endEffectorDragging = event.value ? 'true' : 'false';
      setEndEffectorControl((current) =>
        current ? { ...current, dragging: Boolean(event.value) } : current,
      );
      if (robotDragHistoryRef.current.restoring) return;
      if (event.value) {
        robotDragActionsRef.current?.begin('end-effector');
      } else {
        if (robotDragHistoryRef.current.pending?.moved) endEffectorObjectChangeRef.current?.();
        robotPoseActionsRef.current?.publish?.(true);
        reportRobotJointValues(true);
        robotDragActionsRef.current?.finish();
      }
    };
    const onTransformObjectChange = () => {
      if (robotDragHistoryRef.current.restoring) return;
      robotDragActionsRef.current?.markMovement();
      endEffectorObjectChangeRef.current?.();
    };
    transformControls.addEventListener('dragging-changed', onTransformDraggingChanged);
    transformControls.addEventListener('objectChange', onTransformObjectChange);

    const raycaster = new THREE.Raycaster();
    const normalizedPointer = new THREE.Vector2();
    let pointerStart = null;
    let lastPointerSelection = null;
    let firstClickWaypoint = null;
    let chassisPointerDrag = null;

    const clearProjectionPan = () => {
      projectionPan.x = 0;
      projectionPan.y = 0;
      applyProjectionPan();
      renderer.domElement.dataset.panImplementation = 'world';
    };

    const captureCameraView = () => ({
      version: 1,
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
      zoom: Math.max(camera.zoom, 1),
      projectionOffset: { x: projectionPan.x, y: projectionPan.y },
    });
    let lastReportedView = '';
    const reportCameraView = (force = false) => {
      const nextView = captureCameraView();
      const signature = cameraViewSignature(nextView);
      if (!signature || (!force && signature === lastReportedView)) return;
      lastReportedView = signature;
      renderer.domElement.dataset.viewSignature = signature;
      onViewChangeRef.current?.(nextView);
    };
    const applyCameraView = (candidate, state = 'restored') => {
      const nextView = normalizeCameraView(candidate);
      if (!nextView) return false;
      camera.position.set(nextView.position.x, nextView.position.y, nextView.position.z);
      controls.target.set(nextView.target.x, nextView.target.y, nextView.target.z);
      camera.up.set(nextView.up.x, nextView.up.y, nextView.up.z).normalize();
      camera.zoom = nextView.zoom;
      projectionPan.x = nextView.projectionOffset.x;
      projectionPan.y = nextView.projectionOffset.y;
      applyProjectionPan();
      controls.update();
      syncDetailView();
      renderer.domElement.dataset.viewState = state;
      renderer.domElement.dataset.viewRestored = state === 'restored' ? 'true' : 'false';
      reportCameraView(true);
      return true;
    };
    const resetCameraView = () => {
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
      }
      applyCameraView(defaultCameraView, 'reset');
      renderer.domElement.dataset.viewResetCount = String(
        Number(renderer.domElement.dataset.viewResetCount || 0) + 1,
      );
    };
    const onControlsChange = () => {
      syncDetailView();
      reportCameraView();
    };
    precisionPanRef.current = { clear: clearProjectionPan };
    viewActionsRef.current = {
      apply: applyCameraView,
      capture: captureCameraView,
      reset: resetCameraView,
      refreshClipping: syncDetailView,
    };
    const restoredCameraView = normalizeCameraView(initialViewRef.current);
    if (restoredCameraView) {
      appliedInitialViewRef.current = initialViewRef.current;
      applyCameraView(restoredCameraView, 'restored');
    } else {
      clearProjectionPan();
      renderer.domElement.dataset.viewState = 'default';
      renderer.domElement.dataset.viewRestored = 'false';
      syncDetailView();
      reportCameraView(true);
    }
    controls.addEventListener('change', onControlsChange);

    const panByPixels = (deltaX, deltaY) => {
      const implementation = navigation.panByPixels(deltaX, deltaY);
      if (!implementation) return null;
      syncDetailView();
      reportCameraView();
      return implementation;
    };

    const previewOrbitOffset = new THREE.Vector3();
    const previewOrbitAxis = new THREE.Vector3();
    const previewOrbitQuaternion = new THREE.Quaternion();
    const rotateFromPreview = (deltaX, deltaY, sourceWidth, sourceHeight) => {
      const width = Math.max(Number(sourceWidth) || renderer.domElement.clientWidth, 1);
      const height = Math.max(Number(sourceHeight) || renderer.domElement.clientHeight, 1);
      const yaw = -(Number(deltaX) || 0) * Math.PI * controls.rotateSpeed / width;
      const pitch = -(Number(deltaY) || 0) * Math.PI * controls.rotateSpeed / height;
      if (Math.abs(yaw) < 1e-9 && Math.abs(pitch) < 1e-9) return false;

      previewOrbitOffset.copy(camera.position).sub(controls.target);
      if (previewOrbitOffset.lengthSq() < 1e-18) return false;
      if (Math.abs(yaw) >= 1e-9) {
        previewOrbitAxis.copy(camera.up).normalize();
        previewOrbitQuaternion.setFromAxisAngle(previewOrbitAxis, yaw);
        previewOrbitOffset.applyQuaternion(previewOrbitQuaternion);
        camera.position.copy(controls.target).add(previewOrbitOffset);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);
      }
      if (Math.abs(pitch) >= 1e-9) {
        previewOrbitAxis.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        previewOrbitQuaternion.setFromAxisAngle(previewOrbitAxis, pitch);
        previewOrbitOffset.copy(camera.position).sub(controls.target)
          .applyQuaternion(previewOrbitQuaternion);
        camera.up.applyQuaternion(previewOrbitQuaternion).normalize();
        camera.position.copy(controls.target).add(previewOrbitOffset);
        camera.lookAt(controls.target);
      }
      camera.updateMatrixWorld(true);
      controls.update();
      syncDetailView();
      reportCameraView();
      return true;
    };

    const onMainViewPreviewControl = (event) => {
      const detail = event.detail || {};
      const kind = detail.kind === 'pan' ? 'pan' : 'rotate';
      const deltaX = Number(detail.deltaX) || 0;
      const deltaY = Number(detail.deltaY) || 0;
      if (!deltaX && !deltaY) return;
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
        renderer.domElement.dataset.synchronizedFocusState = 'interrupted-by-preview';
      }
      let changed = false;
      if (kind === 'pan') {
        const sourceWidth = Math.max(Number(detail.sourceWidth) || 1, 1);
        const sourceHeight = Math.max(Number(detail.sourceHeight) || 1, 1);
        changed = Boolean(panByPixels(
          deltaX * renderer.domElement.clientWidth / sourceWidth,
          deltaY * renderer.domElement.clientHeight / sourceHeight,
        ));
      } else {
        changed = rotateFromPreview(
          deltaX,
          deltaY,
          detail.sourceWidth,
          detail.sourceHeight,
        );
      }
      if (!changed) return;
      renderer.domElement.dataset.previewControlMode = kind;
      renderer.domElement.dataset.previewControlCount = String(
        Number(renderer.domElement.dataset.previewControlCount || 0) + 1,
      );
      const countKey = kind === 'pan'
        ? 'previewPanControlCount'
        : 'previewRotateControlCount';
      renderer.domElement.dataset[countKey] = String(
        Number(renderer.domElement.dataset[countKey] || 0) + 1,
      );
    };
    renderer.domElement.addEventListener(
      MAIN_VIEW_PREVIEW_CONTROL_EVENT,
      onMainViewPreviewControl,
    );

    const selectionAtPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      normalizedPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(normalizedPointer, camera);

      if (waypointGroup.visible) {
        const waypointHit = raycaster.intersectObjects(waypointGroup.children, true)[0];
        const waypointSelection = waypointHit
          ? selectionForObject(waypointHit.object)
          : null;
        if (waypointSelection) return waypointSelection;
      }

      if (!routeGroup.visible) return null;
      const edgeHit = raycaster.intersectObjects(routeGroup.children, true)[0];
      return edgeHit ? selectionForObject(edgeHit.object) : null;
    };

    const setRayFromPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      normalizedPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(normalizedPointer, camera);
      return true;
    };

    const chassisAtPointer = (event) => {
      const handle = robotChassisHandleRef.current;
      if (!showRobotRef.current || !handle?.target || !setRayFromPointer(event)) return null;
      return raycaster.intersectObject(handle.target, false).length ? handle : null;
    };

    const updatePickHover = (event) => {
      if (transformControls.dragging || transformControls.axis) {
        renderer.domElement.classList.remove(
          'is-pick-hover',
          'is-end-effector-hover',
          'is-chassis-drag-hover',
        );
        return;
      }
      if (chassisDragModeRef.current) {
        const hoveredChassis = Boolean(chassisAtPointer(event));
        renderer.domElement.classList.toggle('is-chassis-drag-hover', hoveredChassis);
        renderer.domElement.classList.remove('is-pick-hover', 'is-end-effector-hover');
        renderer.domElement.dataset.hoverRobotPart = hoveredChassis ? 'chassis' : 'none';
        return;
      }
      renderer.domElement.classList.remove('is-chassis-drag-hover');
      const hoveredEndEffector = endEffectorAtPointer(event);
      renderer.domElement.classList.toggle(
        'is-end-effector-hover',
        Boolean(hoveredEndEffector),
      );
      renderer.domElement.dataset.hoverEndEffector = hoveredEndEffector || 'none';
      if (hoveredEndEffector) {
        renderer.domElement.classList.remove('is-pick-hover');
        return;
      }
      const selection = selectionAtPointer(event);
      renderer.domElement.classList.toggle('is-pick-hover', Boolean(selection));
      renderer.domElement.dataset.hoverPickType = selection?.type || 'none';
      renderer.domElement.dataset.hoverPickId = selection?.id || '';
    };

    const cancelPointerGesture = (event, reason = 'cancelled') => {
      const pointerId = event?.pointerId ?? pointerStart?.id;
      const hadActiveGesture = Boolean(pointerStart) || controls.state !== -1;
      pointerStart = null;
      controls.state = -1;

      const capturedPointerIds = controls._pointers?.map((pointer) => pointer.pointerId) || [];
      const pointerIds = new Set([
        ...capturedPointerIds,
        ...(Number.isFinite(pointerId) ? [pointerId] : []),
      ]);
      pointerIds.forEach((id) => {
        if (!renderer.domElement.hasPointerCapture?.(id)) return;
        try {
          renderer.domElement.releasePointerCapture(id);
        } catch {
          // The browser may already have released capture while crossing the edge.
        }
      });
      if (controls._pointers) controls._pointers.length = 0;
      controls._pointerPositions = {};
      renderer.domElement.removeEventListener('pointermove', controls._onPointerMove);
      renderer.domElement.removeEventListener('pointerup', controls._onPointerUp);
      renderer.domElement.classList.remove('is-pick-hover', 'is-panning');
      renderer.domElement.dataset.pointerGestureState = hadActiveGesture ? reason : 'idle';
      if (hadActiveGesture) {
        renderer.domElement.dataset.pointerGestureCancelCount = String(
          Number(renderer.domElement.dataset.pointerGestureCancelCount || 0) + 1,
        );
      }
      return hadActiveGesture;
    };

    const finishChassisPointerDrag = (
      event,
      reason = 'ended',
      forcePublish = true,
      updateUi = true,
    ) => {
      if (!chassisPointerDrag) return false;
      const pointerId = event?.pointerId ?? chassisPointerDrag.pointerId;
      chassisPointerDrag = null;
      controls.enabled = true;
      if (Number.isFinite(pointerId) && renderer.domElement.hasPointerCapture?.(pointerId)) {
        try {
          renderer.domElement.releasePointerCapture(pointerId);
        } catch {
          // Pointer capture can already be gone after leaving the canvas.
        }
      }
      renderer.domElement.classList.remove('is-chassis-dragging');
      renderer.domElement.dataset.chassisDragging = 'false';
      renderer.domElement.dataset.chassisDragGestureState = reason;
      if (updateUi) setChassisDragging(false);
      if (!robotDragHistoryRef.current.restoring) {
        if (forcePublish) robotPoseActionsRef.current?.publish?.(true);
        robotDragActionsRef.current?.finish();
      }
      return true;
    };

    const updateChassisDragMode = (enabled, reason = 'user', updateUi = true) => {
      if (enabled && (!showRobotRef.current || robotTrajectoryActiveRef.current || teachingPoseEditingRef.current)) return false;
      const nextEnabled = Boolean(enabled && robotChassisHandleRef.current?.target);
      if (!nextEnabled) {
        finishChassisPointerDrag(null, reason, true, updateUi);
      }
      if (nextEnabled && endEffectorControlRef.current) {
        endEffectorInteractionRef.current?.exit?.();
      }
      if (nextEnabled && robotControlEnabledRef.current) {
        robotControlEnabledRef.current = false;
        onRobotControlChangeRef.current?.(false);
      }
      if (nextEnabled) {
        pressedKeysRef.current.clear();
        keyboardImpulseRef.current.clear();
        interactionModeRef.current = 'rotate';
        setInteractionMode('rotate');
        setShiftPanArmed(false);
        cancelPointerGesture(null, 'chassis-drag-mode');
      }
      chassisDragModeRef.current = nextEnabled;
      const handle = robotChassisHandleRef.current;
      if (handle?.guide) handle.guide.visible = nextEnabled;
      renderer.domElement.classList.toggle('is-chassis-drag-mode', nextEnabled);
      renderer.domElement.classList.remove('is-chassis-drag-hover');
      renderer.domElement.dataset.chassisDragMode = nextEnabled ? 'armed' : 'idle';
      renderer.domElement.dataset.chassisDragExitReason = nextEnabled ? '' : reason;
      renderer.domElement.dataset.keyboardControlOwner = nextEnabled
        ? 'camera'
        : robotControlEnabledRef.current ? 'robot' : 'camera';
      if (updateUi) {
        setChassisDragMode(nextEnabled);
        if (!nextEnabled) setChassisDragging(false);
      }
      if (nextEnabled) renderer.domElement.focus({ preventScroll: true });
      return nextEnabled;
    };

    const startChassisPointerDrag = (event) => {
      if (
        robotTrajectoryActiveRef.current
        || teachingPoseEditingRef.current
        ||
        !chassisDragModeRef.current
        || event.button !== 0
        || event.shiftKey
        || pressedKeysRef.current.has('ShiftLeft')
        || pressedKeysRef.current.has('ShiftRight')
        || transformControls.dragging
        || transformControls.axis
        || !chassisAtPointer(event)
      ) {
        return false;
      }
      const currentPose = normalizeRobotPose(robotPoseRef.current);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -currentPose.position.z);
      const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (!point) return false;

      cancelPointerGesture(event, 'chassis-drag-start');
      robotDragActionsRef.current?.begin('chassis');
      chassisPointerDrag = {
        pointerId: event.pointerId,
        plane,
        offsetX: currentPose.position.x - point.x,
        offsetY: currentPose.position.y - point.y,
        startX: currentPose.position.x,
        startY: currentPose.position.y,
      };
      controls.enabled = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      renderer.domElement.setPointerCapture?.(event.pointerId);
      renderer.domElement.classList.add('is-chassis-dragging');
      renderer.domElement.classList.remove('is-chassis-drag-hover');
      renderer.domElement.dataset.chassisDragging = 'true';
      renderer.domElement.dataset.chassisDragGestureState = 'active';
      renderer.domElement.dataset.chassisDragPlaneZ = currentPose.position.z.toFixed(6);
      renderer.domElement.dataset.chassisDragStartX = currentPose.position.x.toFixed(6);
      renderer.domElement.dataset.chassisDragStartY = currentPose.position.y.toFixed(6);
      setChassisDragging(true);
      return true;
    };

    const moveChassisPointerDrag = (event) => {
      if (!chassisPointerDrag || chassisPointerDrag.pointerId !== event.pointerId) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      const outside =
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom;
      if (outside) {
        finishChassisPointerDrag(event, 'cancelled-on-leave');
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
      if (!setRayFromPointer(event)) return false;
      const point = raycaster.ray.intersectPlane(
        chassisPointerDrag.plane,
        new THREE.Vector3(),
      );
      if (!point) return false;

      const nextPose = normalizeRobotPose(robotPoseRef.current);
      nextPose.position.x = point.x + chassisPointerDrag.offsetX;
      nextPose.position.y = point.y + chassisPointerDrag.offsetY;
      robotPoseRef.current = applyRobotPose(robotLayer, nextPose);
      robotDragActionsRef.current?.markMovement();
      writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
      renderer.domElement.dataset.chassisDragDeltaX = (
        nextPose.position.x - chassisPointerDrag.startX
      ).toFixed(6);
      renderer.domElement.dataset.chassisDragDeltaY = (
        nextPose.position.y - chassisPointerDrag.startY
      ).toFixed(6);
      renderer.domElement.dataset.chassisDragCount = String(
        Number(renderer.domElement.dataset.chassisDragCount || 0) + 1,
      );
      robotPoseActionsRef.current?.publish?.(false);
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };

    const chassisDragActions = {
      enter: (reason = 'double-click') => updateChassisDragMode(true, reason),
      exit: (reason = 'user') => updateChassisDragMode(false, reason),
      cancel: (reason = 'cancelled') => finishChassisPointerDrag(null, reason),
    };
    chassisDragInteractionRef.current = chassisDragActions;

    const promotePointerToShiftPan = () => {
      if (
        !pointerStart
        || pointerStart.button !== 0
        || pointerStart.panGesture
      ) {
        return false;
      }

      // A drag may already belong to TrackballControls when Shift is pressed
      // after pointerdown. Stop only its native gesture while retaining pointer
      // capture for the precision pan implementation below.
      controls.state = -1;
      controls.keyState = -1;
      if (controls._pointers) controls._pointers.length = 0;
      controls._pointerPositions = {};
      renderer.domElement.removeEventListener('pointermove', controls._onPointerMove);
      renderer.domElement.removeEventListener('pointerup', controls._onPointerUp);
      pointerStart.panGesture = true;
      pointerStart.shiftPanOverride = true;
      renderer.domElement.dataset.lastPointerGesture = 'shift-pan';
      renderer.domElement.dataset.effectiveInteractionMode = 'shift-pan';
      renderer.domElement.dataset.shiftPanActivationCount = String(
        Number(renderer.domElement.dataset.shiftPanActivationCount || 0) + 1,
      );
      return true;
    };
    pointerInteractionRef.current = { activateShiftPan: promotePointerToShiftPan };

    const onPickPointerDown = (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      lastPointerSelection = null;
      claimKeyboardFocus('pointer');
      const shiftPressed =
        event.shiftKey
        || pressedKeysRef.current.has('ShiftLeft')
        || pressedKeysRef.current.has('ShiftRight');
      const shiftPanOverride = event.button === 0 && shiftPressed;
      const persistentPanOverride = event.button === 0
        && interactionModeRef.current === 'pan';
      const viewportPanOverride = shiftPanOverride || persistentPanOverride;

      // Both persistent pan mode and Shift + left drag belong to the viewport.
      // Check them before chassis/TransformControls so the interaction contract
      // remains identical whether the user holds Shift or clicks the toolbar.
      if (!viewportPanOverride && startChassisPointerDrag(event)) return;
      if (
        !viewportPanOverride
        && transformControls.object
        && (transformControls.axis || transformControls.dragging)
      ) {
        controls.enabled = false;
        pointerStart = null;
        renderer.domElement.dataset.pointerGestureState = 'space-ball';
        return;
      }
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
        renderer.domElement.dataset.synchronizedFocusState = 'interrupted';
      }
      const panGesture =
        event.button === 2
        || viewportPanOverride;
      if (shiftPanOverride) {
        setShiftPanArmed(true);
      }
      if (viewportPanOverride) {
        event.stopImmediatePropagation();
      }
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        button: event.button,
        panGesture,
        shiftPanOverride,
        persistentPanOverride,
        moved: false,
      };
      if (panGesture) {
        event.preventDefault();
        renderer.domElement.setPointerCapture?.(event.pointerId);
      }
      renderer.domElement.dataset.lastPointerGesture = shiftPanOverride
        ? 'shift-pan'
        : persistentPanOverride ? 'mode-pan' : panGesture ? 'pan' : 'rotate-or-pick';
      renderer.domElement.dataset.pointerGestureState = 'active';
      renderer.domElement.classList.remove('is-pick-hover', 'is-end-effector-hover');
    };
    const onPickPointerMove = (event) => {
      if (moveChassisPointerDrag(event)) return;
      if (pointerStart?.id === event.pointerId) {
        const rect = renderer.domElement.getBoundingClientRect();
        const outside =
          event.clientX < rect.left
          || event.clientX > rect.right
          || event.clientY < rect.top
          || event.clientY > rect.bottom;
        if (outside) {
          cancelPointerGesture(event, 'cancelled-on-leave');
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const liveShiftPressed =
          event.shiftKey
          || pressedKeysRef.current.has('ShiftLeft')
          || pressedKeysRef.current.has('ShiftRight');
        if (
          liveShiftPressed
          && promotePointerToShiftPan()
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        pointerStart.moved =
          pointerStart.moved
          || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y)
            > PICK_DRAG_THRESHOLD;
        if (pointerStart.panGesture && pointerStart.moved) {
          panByPixels(
            event.clientX - pointerStart.lastX,
            event.clientY - pointerStart.lastY,
          );
          renderer.domElement.classList.add('is-panning');
        }
        pointerStart.lastX = event.clientX;
        pointerStart.lastY = event.clientY;
        return;
      }
      updatePickHover(event);
    };
    const onPickPointerUp = (event) => {
      if (chassisPointerDrag?.pointerId === event.pointerId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishChassisPointerDrag(event, 'ended');
        return;
      }
      if (!pointerStart || pointerStart.id !== event.pointerId) return;
      const start = pointerStart;
      pointerStart = null;
      renderer.domElement.dataset.pointerGestureState = 'ended';
      renderer.domElement.classList.remove('is-panning');
      if (renderer.domElement.hasPointerCapture?.(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      if (
        start.button !== 0
        ||
        start.moved
        || Math.hypot(event.clientX - start.x, event.clientY - start.y) > PICK_DRAG_THRESHOLD
      ) {
        return;
      }

      // Polyline clicks belong to the teaching panel; retain the camera's
      // pointer lifecycle without also selecting or clearing navigation items.
      if (polylineOpenRef.current) return;
      const selection = selectionAtPointer(event);
      lastPointerSelection = selection;
      renderer.domElement.dataset.lastPickType = selection?.type || 'none';
      renderer.domElement.dataset.lastPickId = selection?.id || '';
      if (selection?.type === 'waypoint') onSelectWaypointRef.current?.(selection.id);
      else if (selection?.type === 'edge') onSelectEdgeRef.current?.(selection.id);
      else onClearSelectionRef.current?.();
    };
    const resetPickPointer = (event) => {
      if (chassisPointerDrag?.pointerId === event.pointerId) {
        finishChassisPointerDrag(event, 'cancelled-by-browser');
      }
      cancelPointerGesture(event, 'cancelled-by-browser');
    };
    const onPickPointerLeave = (event) => {
      if (chassisPointerDrag?.pointerId === event.pointerId) {
        finishChassisPointerDrag(event, 'cancelled-on-leave');
        return;
      }
      if (pointerStart?.id === event.pointerId) {
        cancelPointerGesture(event, 'cancelled-on-leave');
        return;
      }
      renderer.domElement.classList.remove(
        'is-pick-hover',
        'is-end-effector-hover',
        'is-chassis-drag-hover',
      );
    };

    const endEffectorAtPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!showRobotRef.current || !rect.width || !rect.height || !robotLayer.children.length) return null;
      normalizedPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(normalizedPointer, camera);
      const hits = raycaster.intersectObjects(robotLayer.children, true);
      const firstVisual = hits.find((hit) => {
        let object = hit.object;
        while (object) {
          if (object.userData?.urdfType === 'collision') return false;
          if (object.userData?.urdfType === 'visual') return true;
          object = object.parent;
        }
        return false;
      });
      for (const hit of hits) {
        const side = endEffectorSideForObject(hit.object);
        if (side) return side;
        if (hit === firstVisual && torsoControllerRef.current) {
          let link = hit.object;
          while (link && link.userData?.urdfType !== 'link') link = link.parent;
          if (link === torsoControllerRef.current.chest) return 'torso';
        }
      }
      return null;
    };
    const onSceneClick = (event) => {
      if (event.detail === 1) {
        firstClickWaypoint = lastPointerSelection?.type === 'waypoint'
          ? lastPointerSelection : null;
      }
    };
    const onSceneDoubleClick = (event) => {
      // The first click can focus a teaching parking point and move the camera
      // before the second click. Keep that gesture's original waypoint target.
      const waypoint = firstClickWaypoint || selectionAtPointer(event);
      firstClickWaypoint = null;
      if (!renderActiveRef.current || robotTrajectoryActiveRef.current) return;
      if (transformControls.dragging || transformControls.axis) return;
      const robotLoaded = robotLoadStateRef.current?.status === 'loaded';
      const side = robotLoaded ? endEffectorAtPointer(event) : null;
      // A repeated double-click must also reopen navigation for an already
      // selected parking point; selecting the same ID does not rerun effects.
      if (!side && waypoint?.type === 'waypoint') {
        if (lastPointerSelection?.id !== waypoint.id) {
          onSelectWaypointRef.current?.(waypoint.id);
          renderer.domElement.dataset.lastPickType = 'waypoint';
          renderer.domElement.dataset.lastPickId = waypoint.id;
        }
        onInspectorPageRequestRef.current?.({ page: 'navigation' });
      }
      if (!robotLoaded) return;
      renderer.domElement.dataset.lastEndEffectorDoubleClick = side || 'none';
      const chassis = side ? null : chassisAtPointer(event);
      renderer.domElement.dataset.lastChassisDoubleClick = chassis ? 'chassis' : 'none';
      if (!side && !chassis) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelPointerGesture(
        event,
        side ? 'end-effector-double-click' : 'chassis-double-click',
      );
      if (side) {
        chassisDragInteractionRef.current?.exit?.('end-effector-control');
        const entered = endEffectorInteractionRef.current?.enter?.(side);
        if (entered && (side === 'left' || side === 'right')) {
          onInspectorPageRequestRef.current?.({ page: 'camera', cameraSide: side });
        }
      } else {
        robotControlInteractionRef.current?.enter?.();
        renderer.domElement.dataset.chassisDoubleClickCount = String(
          Number(renderer.domElement.dataset.chassisDoubleClickCount || 0) + 1,
        );
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPickPointerDown, true);
    renderer.domElement.addEventListener('pointermove', onPickPointerMove, true);
    renderer.domElement.addEventListener('pointerup', onPickPointerUp, true);
    renderer.domElement.addEventListener('pointercancel', resetPickPointer);
    renderer.domElement.addEventListener('pointerleave', onPickPointerLeave);
    renderer.domElement.addEventListener('click', onSceneClick, true);
    renderer.domElement.addEventListener('dblclick', onSceneDoubleClick, true);

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      applyProjectionPan();
      controls.handleResize();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    syncDetailView();

    const frameClock = new THREE.Clock();
    let lastDistanceScaleSignature = '';
    const worldUp = new THREE.Vector3(0, 0, 1);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();
    const verticalMovement = new THREE.Vector3();
    const screenRight = new THREE.Vector3();
    const screenUp = new THREE.Vector3();
    const cameraOffset = new THREE.Vector3();
    const lookForward = new THREE.Vector3();
    const lookRight = new THREE.Vector3();
    const keyboardRotation = new THREE.Quaternion();
    const waypointCameraPosition = new THREE.Vector3();
    const waypointNamePosition = new THREE.Vector3();
    const originCameraPosition = new THREE.Vector3();
    const endEffectorWorldPosition = new THREE.Vector3();
    const endEffectorCameraPosition = new THREE.Vector3();
    const endEffectorProjectedPosition = new THREE.Vector3();
    const chassisWorldPosition = new THREE.Vector3();
    const chassisProjectedPosition = new THREE.Vector3();
    const chassisCameraPosition = new THREE.Vector3();
    const filteredSpaceMouseAxes = Object.fromEntries(
      SPACEMOUSE_VIEW_AXES.map((axis) => [axis, 0]),
    );
    const targetSpaceMouseAxes = Object.fromEntries(
      SPACEMOUSE_VIEW_AXES.map((axis) => [axis, 0]),
    );
    let previousSpaceMouseMode = spaceMouseInputRef?.current?.mode || 'xyz';
    let previousSpaceMouseSelectedAxis = spaceMouseInputRef?.current?.selectedAxis || 'x';
    let spaceMouseHudMotionActive = false;
    let spaceMouseHudHideAt = -Infinity;
    let lastSpaceMouseTelemetryAt = -Infinity;
    const clearFilteredSpaceMouseAxes = () => {
      SPACEMOUSE_VIEW_AXES.forEach((axis) => {
        filteredSpaceMouseAxes[axis] = 0;
        targetSpaceMouseAxes[axis] = 0;
      });
    };
    const updateFilteredSpaceMouseAxis = (axis, target, duration) => {
      const current = filteredSpaceMouseAxes[axis];
      const boundedTarget = THREE.MathUtils.clamp(Number(target) || 0, -1, 1);
      targetSpaceMouseAxes[axis] = boundedTarget;
      const startsOrReverses = boundedTarget !== 0 && (
        current === 0
        || Math.sign(boundedTarget) !== Math.sign(current)
        || Math.abs(boundedTarget) > Math.abs(current)
      );
      const responseSeconds = startsOrReverses
        ? SPACEMOUSE_FILTER_ATTACK_SECONDS
        : SPACEMOUSE_FILTER_RELEASE_SECONDS;
      const blend = 1 - Math.exp(-duration / Math.max(responseSeconds, 1e-4));
      const next = current + (boundedTarget - current) * blend;
      filteredSpaceMouseAxes[axis] = (
        boundedTarget === 0 && Math.abs(next) < SPACEMOUSE_FILTER_EPSILON
      ) ? 0 : next;
    };
    const updateSpaceMouseAxisHud = (selectedAxis, motionActive, ready) => {
      const hud = spaceMouseAxisHudRef.current;
      if (!hud) return;
      const now = performance.now();
      const meta = SPACEMOUSE_AXIS_HUD_META[selectedAxis] || SPACEMOUSE_AXIS_HUD_META.x;
      hud.dataset.axis = selectedAxis;
      hud.querySelector('[data-axis-code]').textContent = meta.code;
      hud.querySelector('[data-axis-label]').textContent = meta.label;
      hud.querySelector('[data-axis-group]').textContent = `${meta.group} / SINGLE AXIS`;

      if (!ready) {
        spaceMouseHudMotionActive = false;
        spaceMouseHudHideAt = -Infinity;
        hud.classList.remove('is-visible', 'is-active');
        hud.dataset.state = 'hidden';
        hud.setAttribute('aria-hidden', 'true');
      } else if (motionActive) {
        spaceMouseHudMotionActive = true;
        spaceMouseHudHideAt = Infinity;
        hud.classList.add('is-visible', 'is-active');
        hud.dataset.state = 'active';
        hud.setAttribute('aria-hidden', 'false');
      } else if (spaceMouseHudMotionActive) {
        spaceMouseHudMotionActive = false;
        spaceMouseHudHideAt = now + SPACEMOUSE_AXIS_HUD_HOLD_MS;
        hud.classList.add('is-visible');
        hud.classList.remove('is-active');
        hud.dataset.state = 'holding';
      } else if (now >= spaceMouseHudHideAt && hud.classList.contains('is-visible')) {
        hud.classList.remove('is-visible', 'is-active');
        hud.dataset.state = 'fading';
        hud.setAttribute('aria-hidden', 'true');
        spaceMouseHudHideAt = Infinity;
      }
      renderer.domElement.dataset.spacemouseAxisHudState = hud.dataset.state;
      renderer.domElement.dataset.spacemouseAxisHudAxis = selectedAxis;
    };
    const writeSpaceMouseFilterTelemetry = (force = false) => {
      const now = performance.now();
      if (!force && now - lastSpaceMouseTelemetryAt < 50) return;
      lastSpaceMouseTelemetryAt = now;
      SPACEMOUSE_VIEW_AXES.forEach((axis) => {
        const suffix = `${axis[0].toUpperCase()}${axis.slice(1)}`;
        renderer.domElement.dataset[`spacemouseTarget${suffix}`] =
          targetSpaceMouseAxes[axis].toFixed(4);
        renderer.domElement.dataset[`spacemouseFiltered${suffix}`] =
          filteredSpaceMouseAxes[axis].toFixed(4);
      });
    };
    writeSpaceMouseFilterTelemetry(true);
    const keyboardPixelsForWorldDirection = (
      worldDirection,
      fallbackX,
      fallbackY,
      duration,
      speedMultiplier,
      metrics,
    ) => {
      camera.updateMatrixWorld(true);
      screenRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      screenUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      let projectedX = -worldDirection.dot(screenRight);
      let projectedY = worldDirection.dot(screenUp);
      const projectedLength = Math.hypot(projectedX, projectedY);
      if (projectedLength > KEYBOARD_MIN_PROJECTED_AXIS) {
        projectedX /= projectedLength;
        projectedY /= projectedLength;
      } else {
        const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1;
        projectedX = fallbackX / fallbackLength;
        projectedY = fallbackY / fallbackLength;
      }
      const pixelStep =
        (KEYBOARD_WORLD_SPEED_RATIO * speedMultiplier * duration * metrics.height)
        / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      return {
        deltaX: projectedX * pixelStep,
        deltaY: projectedY * pixelStep,
        pixelStep,
      };
    };
    // Capture synchronously after rendering, before WebGL discards its buffer.
    // This also refreshes the scene when the workbench's animation loop is hidden.
    const captureCollaborationViewport = (target) => {
      if (renderer.getContext().isContextLost()) return false;
      renderer.render(scene, camera);
      const source = renderer.domElement;
      if (!source.width || !source.height) return false;
      // Keep the source aspect ratio instead of baking colored bars into the
      // shared image. Use fixed bounds so resizing never shrinks it repeatedly.
      const scale = Math.min(960 / source.width, 600 / source.height);
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
      const context = target.getContext('2d');
      context.fillStyle = '#071119'; context.fillRect(0, 0, target.width, target.height);
      context.drawImage(source, 0, 0, width, height);
      return true;
    };
    const collaborationViewport = {
      capture: captureCollaborationViewport,
      getState: () => ({ enabled: !renderer.getContext().isContextLost(), aspect: camera.aspect }),
      navigate(command) {
        if (renderer.getContext().isContextLost()) return false;
        if (focusAnimationRef.current) { cancelAnimationFrame(focusAnimationRef.current); focusAnimationRef.current = null; }
        if (!applyScreenViewportGesture(camera, controls, navigation, command)) return false;
        syncDetailView(); reportCameraView();
        renderer.domElement.dataset.collaborationGesture = command.kind;
        renderer.domElement.dataset.collaborationGestureSequence = String(command.sequence);
        return true;
      },
    };
    if (collaborationViewportRef) collaborationViewportRef.current = collaborationViewport;
    renderer.setAnimationLoop(() => {
      const deltaSeconds = Math.min(frameClock.getDelta(), 0.05);
      if (!renderActiveRef.current) return;
      const pressedKeys = pressedKeysRef.current;
      const keyboardImpulses = keyboardImpulseRef.current;
      const robotControlActive =
        robotControlEnabledRef.current
        && !robotTrajectoryActiveRef.current
        && !teachingPoseEditingRef.current
        && robotLayer.children.length > 0;
      let keyboardMoved = false;
      let spaceMouseMoved = false;
      if (pressedKeys.size || keyboardImpulses.size) {
        const keyActive = (code) => pressedKeys.has(code) || keyboardImpulses.has(code);
        camera.getWorldDirection(forward);
        forward.z = 0;
        if (forward.lengthSq() < 1e-12) forward.set(0, 1, 0);
        else forward.normalize();
        right.crossVectors(forward, worldUp).normalize();
        const forwardInput = robotControlActive
          ? 0
          : Number(keyActive('KeyW')) - Number(keyActive('KeyS'));
        const strafeInput = robotControlActive
          ? 0
          : Number(keyActive('KeyD')) - Number(keyActive('KeyA'));
        const verticalInput = Number(keyActive('KeyQ')) - Number(keyActive('KeyE'));
        movement.copy(forward).multiplyScalar(forwardInput);
        movement.addScaledVector(right, strafeInput);

        if (movement.lengthSq() > 0) {
          const metrics = getPanMetrics();
          const baseSpeed = THREE.MathUtils.clamp(
            metrics.effectiveDistance * KEYBOARD_WORLD_SPEED_RATIO,
            radius * 1e-8,
            radius * 0.4,
          );
          const speedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 3 : 1;
          const hasTapImpulse =
            keyboardImpulses.has('KeyW')
            || keyboardImpulses.has('KeyA')
            || keyboardImpulses.has('KeyS')
            || keyboardImpulses.has('KeyD');
          const movementDuration = hasTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          const worldStep = baseSpeed * speedMultiplier * movementDuration;
          movement.normalize();

          if (needsPrecisionPanForDistance(worldStep, metrics)) {
            // At high optical zoom, adding the tiny XY delta to camera/target can
            // disappear when Three.js uploads float32 view matrices. Express the
            // same projected motion as pixels instead; setViewOffset remains
            // responsive throughout the full optical zoom range.
            const { deltaX, deltaY } = keyboardPixelsForWorldDirection(
              movement,
              -Math.sign(strafeInput),
              -Math.sign(forwardInput),
              movementDuration,
              speedMultiplier,
              metrics,
            );

            const implementation = panByPixels(deltaX, deltaY);
            renderer.domElement.dataset.keyboardPanImplementation = implementation;
            renderer.domElement.dataset.keyboardPrecisionPixels = Math.hypot(
              deltaX,
              deltaY,
            ).toFixed(3);
            renderer.domElement.dataset.keyboardPrecisionMovementCount = String(
              Number(renderer.domElement.dataset.keyboardPrecisionMovementCount || 0) + 1,
            );
          } else {
            movement.multiplyScalar(worldStep);
            camera.position.add(movement);
            controls.target.add(movement);
            renderer.domElement.dataset.keyboardPanImplementation = 'world';
          }
          keyboardMoved = true;
        }

        if (verticalInput) {
          const metrics = getPanMetrics();
          const baseSpeed = THREE.MathUtils.clamp(
            metrics.effectiveDistance * KEYBOARD_WORLD_SPEED_RATIO,
            radius * 1e-8,
            radius * 0.4,
          );
          const speedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 3 : 1;
          const hasTapImpulse =
            keyboardImpulses.has('KeyQ') || keyboardImpulses.has('KeyE');
          const movementDuration = hasTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          const worldStep = baseSpeed * speedMultiplier * movementDuration;
          verticalMovement.copy(worldUp).multiplyScalar(verticalInput);
          if (needsPrecisionPanForDistance(worldStep, metrics)) {
            const { deltaX, deltaY } = keyboardPixelsForWorldDirection(
              verticalMovement,
              0,
              -Math.sign(verticalInput),
              movementDuration,
              speedMultiplier,
              metrics,
            );
            const implementation = panByPixels(deltaX, deltaY);
            renderer.domElement.dataset.keyboardVerticalImplementation = implementation;
            renderer.domElement.dataset.keyboardPrecisionPixels = Math.hypot(
              deltaX,
              deltaY,
            ).toFixed(3);
            renderer.domElement.dataset.keyboardPrecisionMovementCount = String(
              Number(renderer.domElement.dataset.keyboardPrecisionMovementCount || 0) + 1,
            );
          } else {
            verticalMovement.multiplyScalar(worldStep);
            camera.position.add(verticalMovement);
            controls.target.add(verticalMovement);
            renderer.domElement.dataset.keyboardVerticalImplementation = 'world';
          }
          keyboardMoved = true;
        }

        const yawInput = robotControlActive
          ? 0
          : Number(keyActive('ArrowLeft')) - Number(keyActive('ArrowRight'));
        const pitchInput = robotControlActive
          ? 0
          : Number(keyActive('ArrowUp')) - Number(keyActive('ArrowDown'));
        if (yawInput || pitchInput) {
          const hasRotationTapImpulse =
            keyboardImpulses.has('ArrowUp')
            || keyboardImpulses.has('ArrowDown')
            || keyboardImpulses.has('ArrowLeft')
            || keyboardImpulses.has('ArrowRight');
          const rotationDuration = hasRotationTapImpulse
            ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
            : deltaSeconds;
          const rotationSpeedMultiplier =
            keyActive('ShiftLeft') || keyActive('ShiftRight') ? 1.8 : 1;
          const rotationStep =
            KEYBOARD_ROTATION_SPEED * rotationSpeedMultiplier * rotationDuration;

          cameraOffset.copy(camera.position).sub(controls.target);
          if (yawInput) {
            keyboardRotation.setFromAxisAngle(worldUp, yawInput * rotationStep);
            cameraOffset.applyQuaternion(keyboardRotation);
            camera.up.applyQuaternion(keyboardRotation);
          }
          if (pitchInput) {
            lookForward.copy(cameraOffset).multiplyScalar(-1).normalize();
            lookRight.crossVectors(lookForward, camera.up).normalize();
            if (lookRight.lengthSq() > 1e-12) {
              keyboardRotation.setFromAxisAngle(lookRight, pitchInput * rotationStep);
              cameraOffset.applyQuaternion(keyboardRotation);
              camera.up.applyQuaternion(keyboardRotation);
            }
          }
          camera.up.normalize();
          camera.position.copy(controls.target).add(cameraOffset);
          keyboardMoved = true;
        }

        if (robotControlActive) {
          const heightLocked = robotHeightLockedRef.current;
          const robotForwardInput =
            Number(keyActive('KeyW')) - Number(keyActive('KeyS'));
          const robotStrafeLeftInput =
            Number(keyActive('KeyA')) - Number(keyActive('KeyD'));
          const robotYawInput =
            Number(keyActive('ArrowLeft')) - Number(keyActive('ArrowRight'));
          const robotVerticalInput = heightLocked
            ? 0
            : Number(keyActive('ArrowUp')) - Number(keyActive('ArrowDown'));
          if (
            robotForwardInput
            || robotStrafeLeftInput
            || robotVerticalInput
            || robotYawInput
          ) {
            const robotTapImpulse = [...ROBOT_CONTROL_CODES].some((code) => (
              keyboardImpulses.has(code)
              && (!heightLocked || !ROBOT_VERTICAL_CONTROL_CODES.has(code))
            ));
            const movementDuration = robotTapImpulse
              ? Math.max(deltaSeconds, KEYBOARD_TAP_DURATION)
              : deltaSeconds;
            const speedMultiplier =
              keyActive('ShiftLeft') || keyActive('ShiftRight') ? 2.5 : 1;
            const currentPose = normalizeRobotPose(robotPoseRef.current);
            const nextPose = normalizeRobotPose(currentPose);
            const yawRadians = THREE.MathUtils.degToRad(currentPose.rpy.yaw);
            const inputMagnitude = Math.hypot(robotForwardInput, robotStrafeLeftInput);

            if (inputMagnitude > 0) {
              const inputScale = 1 / Math.max(1, inputMagnitude);
              const distance =
                ROBOT_LINEAR_SPEED * speedMultiplier * movementDuration * inputScale;
              // ROS base-frame convention: +X forward, +Y left. Rotate that
              // local mecanum command into the map's world XY plane.
              nextPose.position.x += (
                Math.cos(yawRadians) * robotForwardInput
                - Math.sin(yawRadians) * robotStrafeLeftInput
              ) * distance;
              nextPose.position.y += (
                Math.sin(yawRadians) * robotForwardInput
                + Math.cos(yawRadians) * robotStrafeLeftInput
              ) * distance;
            }
            if (robotYawInput) {
              nextPose.rpy.yaw = normalizeDegrees(
                currentPose.rpy.yaw
                + THREE.MathUtils.radToDeg(
                  robotYawInput
                    * ROBOT_ROTATION_SPEED
                    * speedMultiplier
                    * movementDuration,
                ),
              );
            }
            if (robotVerticalInput) {
              nextPose.position.z += (
                ROBOT_VERTICAL_SPEED
                * speedMultiplier
                * movementDuration
                * robotVerticalInput
              );
            }

            robotDragActionsRef.current?.clear();
            robotPoseRef.current = applyRobotPose(robotLayer, nextPose);
            writeRobotPoseDataset(renderer.domElement, robotPoseRef.current);
            renderer.domElement.dataset.lastRobotAction = [...ROBOT_CONTROL_CODES]
              .filter((code) => (
                keyActive(code)
                && (!heightLocked || !ROBOT_VERTICAL_CONTROL_CODES.has(code))
              ))
              .map((code) => ROBOT_CONTROL_ACTIONS[code])
              .join('+');
            renderer.domElement.dataset.robotSpeedMode = speedMultiplier > 1
              ? 'boost'
              : 'normal';
            renderer.domElement.dataset.robotInputCount = String(
              Number(renderer.domElement.dataset.robotInputCount || 0) + 1,
            );
            publishRobotPose(robotTapImpulse);
          }
        }
      }

      const spaceMouseInput = spaceMouseInputRef?.current;
      const spaceMouseMode = spaceMouseInput?.mode === 'rpy' ? 'rpy' : 'xyz';
      const spaceMouseControlTarget = spaceMouseInput?.controlTarget === 'zivid-camera'
        ? 'zivid-camera'
        : 'viewport';
      const spaceMouseReady = Boolean(
        spaceMouseInput?.connected
        && spaceMouseInput?.calibrated
        && !spaceMouseInput?.calibrating
        && spaceMouseInput?.controlEnabled !== false
        && spaceMouseControlTarget === 'viewport'
      );
      const spaceMouseReportFresh = Boolean(
        spaceMouseReady
        && performance.now() - Number(spaceMouseInput.timestamp || 0)
          <= SPACEMOUSE_INPUT_STALE_MS,
      );
      renderer.domElement.dataset.spacemouseConnected = spaceMouseInput?.connected
        ? 'true'
        : 'false';
      renderer.domElement.dataset.spacemouseCalibrated = spaceMouseInput?.calibrated
        ? 'true'
        : 'false';
      renderer.domElement.dataset.spacemouseCalibrating = spaceMouseInput?.calibrating
        ? 'true'
        : 'false';
      renderer.domElement.dataset.spacemouseControlEnabled =
        spaceMouseInput?.controlEnabled === false ? 'false' : 'true';
      renderer.domElement.dataset.spacemouseControlTarget = spaceMouseControlTarget;
      renderer.domElement.dataset.spacemouseMode = spaceMouseMode;

      SPACEMOUSE_VIEW_AXES.forEach((axis) => {
        targetSpaceMouseAxes[axis] = 0;
      });
      const candidateAxes = spaceMouseMode === 'rpy'
        ? SPACEMOUSE_ROTATION_AXES
        : SPACEMOUSE_TRANSLATION_AXES;
      const requestedAxis = String(spaceMouseInput?.selectedAxis || '');
      const selectedSpaceMouseAxis = candidateAxes.includes(requestedAxis)
        ? requestedAxis
        : spaceMouseMode === 'rpy' ? 'yaw' : 'x';
      const modeChanged = spaceMouseMode !== previousSpaceMouseMode;
      const selectedAxisChanged = selectedSpaceMouseAxis !== previousSpaceMouseSelectedAxis;
      renderer.domElement.dataset.spacemouseSelectedAxis = selectedSpaceMouseAxis;
      if (!spaceMouseReady) {
        clearFilteredSpaceMouseAxes();
      } else {
        if (modeChanged || selectedAxisChanged) {
          clearFilteredSpaceMouseAxes();
        }
        const axes = spaceMouseReportFresh ? (spaceMouseInput.axes || {}) : {};
        SPACEMOUSE_VIEW_AXES.forEach((axis) => {
          if (axis === selectedSpaceMouseAxis) {
            updateFilteredSpaceMouseAxis(
              axis,
              Number(axes[axis]) || 0,
              deltaSeconds,
            );
          } else {
            // Button selection is an explicit output gate. Sensor coupling can
            // still be decoded for quality, but it never reaches another view axis.
            targetSpaceMouseAxes[axis] = 0;
            filteredSpaceMouseAxes[axis] = 0;
          }
        });
      }
      previousSpaceMouseMode = spaceMouseMode;
      previousSpaceMouseSelectedAxis = selectedSpaceMouseAxis;
      updateSpaceMouseAxisHud(
        selectedSpaceMouseAxis,
        Boolean(
          spaceMouseReady
          && spaceMouseReportFresh
          && spaceMouseInput?.motionActive
        ),
        spaceMouseReady,
      );

      const targetSpaceMouseMagnitude = Math.max(
        ...SPACEMOUSE_VIEW_AXES.map((axis) => Math.abs(targetSpaceMouseAxes[axis])),
      );
      const filteredSpaceMouseMagnitude = Math.max(
        ...SPACEMOUSE_VIEW_AXES.map((axis) => Math.abs(filteredSpaceMouseAxes[axis])),
      );
      const appliedSpaceMouseAxis = (
        selectedSpaceMouseAxis
        && Math.abs(filteredSpaceMouseAxes[selectedSpaceMouseAxis])
          >= SPACEMOUSE_FILTER_EPSILON
      ) ? selectedSpaceMouseAxis : '';
      renderer.domElement.dataset.spacemouseDominantAxis = appliedSpaceMouseAxis;
      renderer.domElement.dataset.spacemouseAppliedAxisCount = appliedSpaceMouseAxis ? '1' : '0';
      renderer.domElement.dataset.spacemouseMotionState = spaceMouseInput?.calibrating
        ? 'calibrating'
        : targetSpaceMouseMagnitude >= SPACEMOUSE_FILTER_EPSILON
          ? 'active'
          : filteredSpaceMouseMagnitude >= SPACEMOUSE_FILTER_EPSILON
            ? 'settling'
            : 'idle';
      writeSpaceMouseFilterTelemetry();

      if (filteredSpaceMouseMagnitude >= SPACEMOUSE_FILTER_EPSILON) {
        if (spaceMouseMode === 'rpy') {
          const rollInput = filteredSpaceMouseAxes.roll;
          const pitchInput = filteredSpaceMouseAxes.pitch;
          const yawInput = filteredSpaceMouseAxes.yaw;
          if (rollInput || pitchInput || yawInput) {
            cameraOffset.copy(camera.position).sub(controls.target);
            const lockedOrbitDistance = cameraOffset.length();
            if (yawInput) {
              keyboardRotation.setFromAxisAngle(
                worldUp,
                yawInput * SPACEMOUSE_ROTATION_SPEED * deltaSeconds,
              );
              cameraOffset.applyQuaternion(keyboardRotation);
              camera.up.applyQuaternion(keyboardRotation);
            }
            if (pitchInput) {
              lookForward.copy(cameraOffset).multiplyScalar(-1).normalize();
              lookRight.crossVectors(lookForward, camera.up).normalize();
              if (lookRight.lengthSq() > 1e-12) {
                keyboardRotation.setFromAxisAngle(
                  lookRight,
                  -pitchInput * SPACEMOUSE_ROTATION_SPEED * deltaSeconds,
                );
                cameraOffset.applyQuaternion(keyboardRotation);
                camera.up.applyQuaternion(keyboardRotation);
              }
            }
            if (lockedOrbitDistance > 0) cameraOffset.setLength(lockedOrbitDistance);
            camera.position.copy(controls.target).add(cameraOffset);
            if (rollInput) {
              camera.getWorldDirection(lookForward).normalize();
              keyboardRotation.setFromAxisAngle(
                lookForward,
                rollInput * SPACEMOUSE_ROTATION_SPEED * deltaSeconds,
              );
              camera.up.applyQuaternion(keyboardRotation);
            }
            camera.up.normalize();
            renderer.domElement.dataset.spacemouseLastMotion = [
              rollInput ? 'roll' : '',
              pitchInput ? 'pitch' : '',
              yawInput ? 'yaw' : '',
            ].filter(Boolean).join('+');
            renderer.domElement.dataset.spacemouseRotationDistancePolicy = 'locked';
            spaceMouseMoved = true;
          }
        } else {
          // XYZ is translation-only: X moves the camera and target together
          // along the current XY heading, while Y/Z pan laterally/vertically.
          // Camera-target distance and optical zoom therefore remain untouched.
          const xInput = filteredSpaceMouseAxes.x;
          const yInput = filteredSpaceMouseAxes.y;
          const zInput = filteredSpaceMouseAxes.z;
          if (xInput) {
            camera.getWorldDirection(forward);
            forward.z = 0;
            if (forward.lengthSq() < 1e-12) forward.set(0, 1, 0);
            else forward.normalize();
            const metrics = getPanMetrics();
            const forwardSpeed = THREE.MathUtils.clamp(
              metrics.effectiveDistance * SPACEMOUSE_FORWARD_SPEED_RATIO,
              radius * 1e-5,
              radius * 0.45,
            );
            movement.copy(forward).multiplyScalar(
              xInput * forwardSpeed * deltaSeconds,
            );
            camera.position.add(movement);
            controls.target.add(movement);
            renderer.domElement.dataset.spacemouseForwardImplementation = 'world-xy';
            spaceMouseMoved = true;
          }
          if (yInput || zInput) {
            panByPixels(
              yInput * SPACEMOUSE_PAN_PIXELS_PER_SECOND * deltaSeconds,
              zInput * SPACEMOUSE_PAN_PIXELS_PER_SECOND * deltaSeconds,
            );
            spaceMouseMoved = true;
          }
          if (spaceMouseMoved) {
            renderer.domElement.dataset.spacemouseLastMotion = [
              xInput ? 'x' : '',
              yInput ? 'y' : '',
              zInput ? 'z' : '',
            ].filter(Boolean).join('+');
          }
        }
      }
      if (spaceMouseMoved) {
        renderer.domElement.dataset.spacemouseInputCount = String(
          Number(renderer.domElement.dataset.spacemouseInputCount || 0) + 1,
        );
        renderer.domElement.dataset.spacemouseLastInputAt = String(
          Number(spaceMouseInput.timestamp || 0).toFixed(2),
        );
      }
      keyboardImpulses.clear();
      controls.update();
      reportZividCameraPoses();
      if (keyboardMoved || spaceMouseMoved) {
        syncDetailView();
        // Application-owned keyboard and SpaceMouse transforms need an explicit
        // persisted view update because TrackballControls did not originate them.
        reportCameraView();
      }

      camera.updateMatrixWorld(true);
      const focalPixels =
        (Math.max(renderer.domElement.clientHeight, 1) / 2)
        / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

      if (distanceScaleRef.current) {
        const metersPerPixel = camera.position.distanceTo(controls.target)
          / (camera.zoom * focalPixels);
        const scale = viewportDistanceScale(metersPerPixel);
        const signature = scale ? `${scale.meters}:${scale.pixels.toFixed(2)}:${metersPerPixel}` : '';
        if (signature !== lastDistanceScaleSignature) {
          lastDistanceScaleSignature = signature;
          const element = distanceScaleRef.current;
          element.dataset.ready = scale ? 'true' : 'false';
          if (scale) {
            element.style.setProperty('--distance-scale-width', `${scale.pixels.toFixed(2)}px`);
            element.dataset.meters = String(scale.meters);
            element.dataset.metersPerPixel = String(metersPerPixel);
            distanceScaleLabelRef.current.textContent = scale.label;
          }
        }
      }

      const chassisHandle = robotChassisHandleRef.current;
      if (chassisHandle?.target) {
        chassisHandle.target.getWorldPosition(chassisWorldPosition);
        chassisProjectedPosition.copy(chassisWorldPosition).project(camera);
        renderer.domElement.dataset.robotChassisWorldX = chassisWorldPosition.x.toFixed(6);
        renderer.domElement.dataset.robotChassisWorldY = chassisWorldPosition.y.toFixed(6);
        renderer.domElement.dataset.robotChassisWorldZ = chassisWorldPosition.z.toFixed(6);
        renderer.domElement.dataset.robotChassisScreenX = (
          (chassisProjectedPosition.x + 1) * 0.5 * renderer.domElement.clientWidth
        ).toFixed(2);
        renderer.domElement.dataset.robotChassisScreenY = (
          (1 - chassisProjectedPosition.y) * 0.5 * renderer.domElement.clientHeight
        ).toFixed(2);
        renderer.domElement.dataset.robotChassisScreenVisible =
          showRobotRef.current && Math.abs(chassisProjectedPosition.x) <= 1
          && Math.abs(chassisProjectedPosition.y) <= 1
          && chassisProjectedPosition.z >= -1
          && chassisProjectedPosition.z <= 1
            ? 'true'
            : 'false';

        const guide = chassisHandle.controlGuide;
        if (guide) {
          // Keep this helper outside the robot model: it must not affect robot
          // framing, collision geometry or cloned parking-point previews.
          guide.group.position.copy(chassisWorldPosition);
          guide.group.rotation.set(0, 0, THREE.MathUtils.degToRad(robotPoseRef.current.rpy.yaw));
          chassisCameraPosition.copy(chassisWorldPosition).applyMatrix4(camera.matrixWorldInverse);
          const depth = -chassisCameraPosition.z;
          guide.group.visible = showRobotRef.current && robotControlActive && depth > 1e-9;
          if (guide.group.visible) {
            guide.group.scale.setScalar(
              (CHASSIS_CONTROL_AXIS_SCREEN_LENGTH * depth) / (camera.zoom * focalPixels),
            );
            const locked = robotHeightLockedRef.current;
            if (guide.heightLocked !== locked) {
              guide.heightLocked = locked;
              guide.heightMaterials.forEach((material) => {
                material.transparent = true;
                material.opacity = locked ? 0.28 : 1;
              });
            }
            renderer.domElement.dataset.chassisControlGuideScreenLength = String(CHASSIS_CONTROL_AXIS_SCREEN_LENGTH);
            renderer.domElement.dataset.chassisControlGuideScale = guide.group.scale.x.toFixed(6);
            renderer.domElement.dataset.chassisControlGuideYaw = robotPoseRef.current.rpy.yaw.toFixed(6);
            renderer.domElement.dataset.chassisControlGuidePosition = chassisWorldPosition.toArray()
              .map((value) => value.toFixed(6)).join(',');
            renderer.domElement.dataset.chassisControlGuideHeightLocked = locked ? 'true' : 'false';
          }
          renderer.domElement.dataset.chassisControlGuideVisible = guide.group.visible ? 'true' : 'false';
        }
      } else {
        renderer.domElement.dataset.robotChassisScreenVisible = 'false';
        renderer.domElement.dataset.chassisControlGuideVisible = 'false';
      }

      Object.entries({ ...endEffectorControllersRef.current, torso: torsoControllerRef.current }).forEach(([side, controller]) => {
        if (!controller?.frame) return;
        controller.frame.getWorldPosition(endEffectorWorldPosition);
        endEffectorProjectedPosition.copy(endEffectorWorldPosition).project(camera);
        const prefix = side === 'torso' ? 'robotTorso' : side === 'left' ? 'robotLeftTool' : 'robotRightTool';
        renderer.domElement.dataset[`${prefix}WorldX`] = endEffectorWorldPosition.x.toFixed(6);
        renderer.domElement.dataset[`${prefix}WorldY`] = endEffectorWorldPosition.y.toFixed(6);
        renderer.domElement.dataset[`${prefix}WorldZ`] = endEffectorWorldPosition.z.toFixed(6);
        renderer.domElement.dataset[`${prefix}ScreenX`] = (
          (endEffectorProjectedPosition.x + 1) * 0.5 * renderer.domElement.clientWidth
        ).toFixed(2);
        renderer.domElement.dataset[`${prefix}ScreenY`] = (
          (1 - endEffectorProjectedPosition.y) * 0.5 * renderer.domElement.clientHeight
        ).toFixed(2);
        renderer.domElement.dataset[`${prefix}ScreenVisible`] =
          showRobotRef.current && Math.abs(endEffectorProjectedPosition.x) <= 1
          && Math.abs(endEffectorProjectedPosition.y) <= 1
          && endEffectorProjectedPosition.z >= -1
          && endEffectorProjectedPosition.z <= 1
            ? 'true'
            : 'false';
        if (side === 'torso') {
          const torso = readRobotTorsoPose(controller);
          ['height', 'yaw', 'pitch'].forEach((axis) => {
            renderer.domElement.dataset[`torso${axis[0].toUpperCase()}${axis.slice(1)}`] = torso[axis].toFixed(6);
          });
        }
      });

      if (endEffectorTarget.visible && endEffectorSpaceBall.visible) {
        endEffectorTarget.getWorldPosition(endEffectorWorldPosition);
        endEffectorProjectedPosition.copy(endEffectorWorldPosition).project(camera);
        renderer.domElement.dataset.endEffectorTargetScreenX = (
          (endEffectorProjectedPosition.x + 1) * 0.5 * renderer.domElement.clientWidth
        ).toFixed(2);
        renderer.domElement.dataset.endEffectorTargetScreenY = (
          (1 - endEffectorProjectedPosition.y) * 0.5 * renderer.domElement.clientHeight
        ).toFixed(2);
        endEffectorCameraPosition
          .copy(endEffectorWorldPosition)
          .applyMatrix4(camera.matrixWorldInverse);
        const targetDepth = -endEffectorCameraPosition.z;
        if (targetDepth > 1e-9) {
          const baseRadius = endEffectorSpaceBall.userData.baseRadius || 0.12;
          const naturalDiameter =
            (2 * baseRadius * camera.zoom * focalPixels) / targetDepth;
          const lodScale = THREE.MathUtils.clamp(
            END_EFFECTOR_SCREEN_DIAMETER / Math.max(naturalDiameter, 1e-30),
            1e-30,
            1e30,
          );
          endEffectorSpaceBall.scale.setScalar(lodScale);
          renderer.domElement.dataset.endEffectorSpaceBallScreenDiameter = (
            naturalDiameter * lodScale
          ).toFixed(2);
          renderer.domElement.dataset.endEffectorSpaceBallScale = lodScale.toExponential(5);
        }
      }
      originCameraPosition.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
      const originDepth = -originCameraPosition.z;
      if (originDepth > 1e-9) {
        const naturalAxisPixels =
          (originGroup.userData.baseAxisLength * camera.zoom * focalPixels)
          / originDepth;
        const originLodScale = THREE.MathUtils.clamp(
          ROS_AXIS_SCREEN_LENGTH / Math.max(naturalAxisPixels, 1e-30),
          MIN_ROS_AXIS_LOD_SCALE,
          1,
        );
        originGroup.scale.setScalar(originLodScale);
        renderer.domElement.dataset.coordinateAxisScale = originLodScale.toExponential(5);
        renderer.domElement.dataset.coordinateAxisScreenLength = (
          naturalAxisPixels * originLodScale
        ).toFixed(2);
      }

      const mapOrigin = mapOriginGroupRef.current;
      if (mapOrigin) {
        originCameraPosition.copy(mapOrigin.position).applyMatrix4(camera.matrixWorldInverse);
        const depth = -originCameraPosition.z;
        if (depth > 1e-9) {
          const naturalPixels = mapOrigin.userData.baseAxisLength * camera.zoom * focalPixels / depth;
          const scale = THREE.MathUtils.clamp(
            ROS_AXIS_SCREEN_LENGTH / Math.max(naturalPixels, 1e-30), 1e-30, 1e30,
          );
          if (mapOrigin.scale.x !== scale) {
            mapOrigin.scale.setScalar(scale);
            syncDetailView();
          }
        }
      }

      if (waypointGroup.visible && waypointGroup.children.length) {
        let smallestDiameter = Number.POSITIVE_INFINITY;
        let largestDiameter = 0;
        let largestLodScale = 1;
        waypointGroup.children.forEach((markerGroup) => {
          waypointCameraPosition
            .copy(markerGroup.position)
            .applyMatrix4(camera.matrixWorldInverse);
          const depth = -waypointCameraPosition.z;
          if (depth <= 1e-9) {
            markerGroup.scale.setScalar(1);
            return;
          }
          const naturalDiameter =
            (2 * (markerGroup.userData.baseRadius || 0) * camera.zoom * focalPixels)
            / depth;
          // Keep distant points readable and close-up points small enough to
          // see the robot chassis beneath them. The hit sphere stays wider.
          const targetDiameter = THREE.MathUtils.clamp(
            naturalDiameter,
            MIN_WAYPOINT_SCREEN_DIAMETER,
            MAX_WAYPOINT_SCREEN_DIAMETER,
          );
          const lodScale = THREE.MathUtils.clamp(
            targetDiameter / Math.max(naturalDiameter, 1e-30),
            1e-30,
            MAX_WAYPOINT_LOD_SCALE,
          );
          markerGroup.scale.setScalar(lodScale);
          const renderedDiameter = naturalDiameter * lodScale;
          markerGroup.userData.screenDiameter = renderedDiameter;
          smallestDiameter = Math.min(smallestDiameter, renderedDiameter);
          largestDiameter = Math.max(largestDiameter, renderedDiameter);
          largestLodScale = Math.max(largestLodScale, lodScale);
        });
        renderer.domElement.dataset.smallestWaypointScreenDiameter =
          Number.isFinite(smallestDiameter) ? smallestDiameter.toFixed(2) : '0';
        renderer.domElement.dataset.largestWaypointScreenDiameter = largestDiameter.toFixed(2);
        renderer.domElement.dataset.waypointMaxLodScale = largestLodScale.toFixed(3);
      }

      // Project labels in CSS pixels so they follow the scene without growing
      // with zoom. This overlay never participates in route/robot picking.
      const labelWidth = renderer.domElement.clientWidth;
      const labelHeight = renderer.domElement.clientHeight;
      const mapOriginLabel = mapOriginLabelRef.current;
      if (mapOrigin && mapOriginLabel) {
        waypointNamePosition.copy(mapOrigin.position).project(camera);
        const visible = originCameraPosition.z < 0
          && Math.abs(waypointNamePosition.x) <= 1
          && Math.abs(waypointNamePosition.y) <= 1
          && Math.abs(waypointNamePosition.z) <= 1;
        mapOriginLabel.style.visibility = visible ? 'visible' : 'hidden';
        renderer.domElement.dataset.mapOriginScreenVisible = String(visible);
        if (visible) {
          const x = (waypointNamePosition.x + 1) * labelWidth / 2;
          const y = (1 - waypointNamePosition.y) * labelHeight / 2;
          mapOriginLabel.style.transform = `translate(${x}px, ${y}px) translate(-50%, 18px)`;
        }
      }
      waypointNameElementsRef.current.forEach(({ element, pose }) => {
        waypointNamePosition.set(pose.x, pose.y, pose.z);
        waypointCameraPosition.copy(waypointNamePosition).applyMatrix4(camera.matrixWorldInverse);
        waypointNamePosition.project(camera);
        const visible = waypointCameraPosition.z < 0
          && Math.abs(waypointNamePosition.x) <= 1
          && Math.abs(waypointNamePosition.y) <= 1
          && Math.abs(waypointNamePosition.z) <= 1;
        element.style.visibility = visible ? 'visible' : 'hidden';
        if (visible) {
          const x = (waypointNamePosition.x + 1) * labelWidth / 2;
          const y = (1 - waypointNamePosition.y) * labelHeight / 2
            - MAX_WAYPOINT_SCREEN_DIAMETER / 2 - 5;
          element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        }
      });
      pathNameElementsRef.current.forEach(({ element, pose }) => {
        waypointNamePosition.set(pose.x, pose.y, pose.z);
        waypointCameraPosition.copy(waypointNamePosition).applyMatrix4(camera.matrixWorldInverse);
        waypointNamePosition.project(camera);
        const visible = waypointCameraPosition.z < 0
          && Math.abs(waypointNamePosition.x) <= 1
          && Math.abs(waypointNamePosition.y) <= 1
          && Math.abs(waypointNamePosition.z) <= 1;
        element.style.visibility = visible ? 'visible' : 'hidden';
        if (visible) {
          const x = (waypointNamePosition.x + 1) * labelWidth / 2;
          const y = (1 - waypointNamePosition.y) * labelHeight / 2 + 8;
          element.style.transform = `translate(${x}px, ${y}px) translateX(-50%)`;
        }
      });

      const selectedHalo = selectedWaypointPulseRef.current;
      if (selectedHalo) {
        const pulse = 1.06 + Math.sin(performance.now() * 0.0042) * 0.12;
        selectedHalo.scale.setScalar(pulse);
        selectedHalo.material.opacity = 0.22 + ((pulse - 0.94) / 0.24) * 0.34;
        renderer.domElement.dataset.selectedWaypointPulse = pulse.toFixed(3);
      }
      const parkingGhostVisual = robotParkingGhostVisualRef.current;
      if (parkingGhostVisual) {
        updateRobotParkingGhostGuide(parkingGhostVisual, robotPoseRef.current, null);
        const ghostPulse = 1.04 + Math.sin(performance.now() * 0.0034) * 0.08;
        parkingGhostVisual.pulseRing.scale.setScalar(ghostPulse);
        parkingGhostVisual.pulseRing.material.opacity = 0.18
          + ((ghostPulse - 0.96) / 0.16) * 0.22;
        renderer.domElement.dataset.parkingGhostPulse = ghostPulse.toFixed(3);
      }
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      if (collaborationViewportRef?.current === collaborationViewport) collaborationViewportRef.current = null;
      if (pendingWheelArbitrationTimer) {
        window.clearTimeout(pendingWheelArbitrationTimer);
        pendingWheelArbitrationTimer = null;
      }
      pendingWheelArbitration = null;
      updateChassisDragMode(false, 'scene-dispose');
      observer.disconnect();
      renderer.domElement.removeEventListener('wheel', progressiveWheelZoom, true);
      renderer.domElement.removeEventListener('pointerdown', onPickPointerDown, true);
      renderer.domElement.removeEventListener('pointermove', onPickPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', onPickPointerUp, true);
      renderer.domElement.removeEventListener('pointercancel', resetPickPointer);
      renderer.domElement.removeEventListener('pointerleave', onPickPointerLeave);
      renderer.domElement.removeEventListener('click', onSceneClick, true);
      renderer.domElement.removeEventListener('dblclick', onSceneDoubleClick, true);
      renderer.domElement.removeEventListener(
        MAIN_VIEW_PREVIEW_CONTROL_EVENT,
        onMainViewPreviewControl,
      );
      transformControls.removeEventListener('dragging-changed', onTransformDraggingChanged);
      transformControls.removeEventListener('objectChange', onTransformObjectChange);
      transformControls.detach();
      transformControls.dispose();
      scene.remove(transformHelper, endEffectorTarget);
      disposeObject(endEffectorTarget);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      displayGeometry.dispose();
      material.dispose();
      disposeTeachingSurfaceProjectionOverlay(surfaceCoverageProjectionRef.current);
      surfaceCoverageProjectionRef.current = null;
      surfaceGeometry?.dispose();
      meshMaterial?.dispose();
      disposeObject(referencePlane);
      disposeObject(originGroup);
      disposeObject(sliceGroup);
      disposeObject(routeGroup);
      disposeObject(waypointGroup);
      disposeObject(visionCoverageGroup);
      clearRobotParkingGhostLayer(robotParkingGhostLayer);
      renderer.dispose();
      if (viewportCanvasRef?.current === renderer.domElement) {
        viewportCanvasRef.current = null;
      }
      renderer.domElement.remove();
      sceneRef.current = null;
      sliceGroupRef.current = null;
      routeGroupRef.current = null;
      waypointGroupRef.current = null;
      visionCoverageGroupRef.current = null;
      robotLayerRef.current = null;
      robotFollowPositionRef.current = null;
      loadedRobotRef.current = null;
      robotParkingGhostLayerRef.current = null;
      robotParkingGhostVisualRef.current = null;
      robotChassisHandleRef.current = null;
      endEffectorControllersRef.current = { left: null, right: null };
      torsoControllerRef.current = null;
      endEffectorControlRef.current = null;
      lockedEndEffectorsRef.current = createEndEffectorLocks();
      robotDragActionsRef.current?.clear();
      if (transformControlsRef.current === transformControls) transformControlsRef.current = null;
      if (endEffectorTargetRef.current === endEffectorTarget) endEffectorTargetRef.current = null;
      if (endEffectorSpaceBallRef.current === endEffectorSpaceBall) {
        endEffectorSpaceBallRef.current = null;
      }
      if (robotPoseActionsRef.current === robotPoseActions) {
        robotPoseActionsRef.current = null;
      }
      selectedWaypointPulseRef.current = null;
      if (precisionPanRef.current?.clear === clearProjectionPan) {
        precisionPanRef.current = null;
      }
      if (viewActionsRef.current?.reset === resetCameraView) {
        viewActionsRef.current = null;
      }
      if (pointerInteractionRef.current?.activateShiftPan === promotePointerToShiftPan) {
        pointerInteractionRef.current = null;
      }
      if (chassisDragInteractionRef.current === chassisDragActions) {
        chassisDragInteractionRef.current = null;
      }
      chassisDragModeRef.current = false;
      controlsRef.current = null;
      cameraRef.current = null;
      displayGeometryRef.current = null;
      if (surfaceGeometryRef.current?.geometry === surfaceGeometry) {
        surfaceGeometryRef.current = null;
      }
      if (cloudMaterialRef.current === material) cloudMaterialRef.current = null;
      if (meshMaterialRef.current === meshMaterial) meshMaterialRef.current = null;
    };
  }, [mapData?.geometry, mapData?.teachingSpaceMode, viewportCanvasRef]);

  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!scene || !canvas || teachingSpaceMode !== 'independent' || !mapOriginPose) return undefined;
    const radius = Math.max(mapData.geometry.boundingSphere.radius, 1);
    const group = createCoordinateOrigin(THREE.MathUtils.clamp(radius * 0.14, 1, 8));
    group.name = 'absolute-map-origin';
    group.position.set(mapOriginPose.position.x, mapOriginPose.position.y, mapOriginPose.position.z);
    group.rotation.set(...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(mapOriginPose.rpy[axis])), 'ZYX');
    scene.add(group);
    mapOriginGroupRef.current = group;
    canvas.dataset.mapOriginPosition = JSON.stringify(group.position.toArray());
    canvas.dataset.mapOriginQuaternion = JSON.stringify(group.quaternion.toArray());
    viewActionsRef.current?.refreshClipping?.();
    return () => {
      scene.remove(group);
      disposeObject(group);
      if (mapOriginGroupRef.current === group) mapOriginGroupRef.current = null;
      delete canvas.dataset.mapOriginPosition;
      delete canvas.dataset.mapOriginQuaternion;
      delete canvas.dataset.mapOriginScreenVisible;
      viewActionsRef.current?.refreshClipping?.();
    };
  }, [mapData?.geometry, teachingSpaceMode, mapOriginPose, viewportCanvasRef]);

  useEffect(() => {
    if (!sceneRef.current) return undefined;
    const layer = createIPadCaptureLayer(teachingTasks);
    sceneRef.current.add(layer);
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.mobileCaptureVisible = layer.children.length ? 'true' : 'false';
    return () => {
      disposeIPadCaptureLayer(layer);
      if (canvas) delete canvas.dataset.mobileCaptureVisible;
    };
  }, [mapData?.geometry, mapData?.teachingSpaceMode, teachingTasks, viewportCanvasRef]);

  useEffect(() => {
    if (!sceneRef.current || !selectedMobilePose) return undefined;
    const { task, sample } = selectedMobilePose;
    const layer = createMobilePosePreview(task, sample);
    sceneRef.current.add(layer);
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.mobileSelectedSample = sample.id;
    return () => {
      disposeIPadCaptureLayer(layer);
      if (canvas) delete canvas.dataset.mobileSelectedSample;
    };
  }, [mapData?.geometry, selectedMobilePose]);

  useEffect(() => {
    const layer = robotLayerRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!layer || !canvas) return undefined;

    collisionHighlightCleanupRef.current?.();
    collisionHighlightCleanupRef.current = null;
    chassisDragInteractionRef.current?.exit?.('robot-change');
    clearRobotDragHistory();
    robotChassisHandleRef.current = null;
    loadedRobotRef.current = null;
    canvas.dataset.chassisDragHandleReady = 'false';
    canvas.dataset.robotChassisScreenVisible = 'false';
    canvas.dataset.chassisControlGuideVisible = 'false';
    endEffectorInteractionRef.current?.exit?.();
    clearEndEffectorLocks();
    endEffectorControllersRef.current = { left: null, right: null };
    torsoControllerRef.current = null;
    zividCameraFramesRef.current = { left: null, right: null };
    lastZividCameraPoseSignatureRef.current = '';
    onZividCameraPoseChangeRef.current?.({});
    [...layer.children].forEach((child) => disposeRobotModel(child));
    clearRobotJointDataset(canvas);
    robotPoseRef.current = applyRobotPose(layer, robotPoseRef.current);
    writeRobotPoseDataset(canvas, robotPoseRef.current);
    if (!robotDescriptor) {
      canvas.dataset.robotModelState = 'idle';
      canvas.dataset.robotModelName = '';
      canvas.dataset.robotOrigin = '';
      return undefined;
    }

    const controller = new AbortController();
    let loadedRobot = null;
    let chassisControlGuide = null;
    canvas.dataset.robotModelState = 'loading';
    canvas.dataset.robotModelName = robotDescriptor.name;
    canvas.dataset.robotModelFormat = robotDescriptor.format;
    writeRobotPoseDataset(canvas, robotPoseRef.current);
    onRobotLoadStateRef.current?.({
      status: 'loading',
      robotId: robotDescriptor.id,
      name: robotDescriptor.name,
      loaded: 0,
      total: 0,
      phase: '读取机器人描述',
    });

    loadRobotModel(robotDescriptor, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (controller.signal.aborted) return;
        onRobotLoadStateRef.current?.({
          status: 'loading',
          robotId: robotDescriptor.id,
          name: robotDescriptor.name,
          ...progress,
        });
      },
    })
      .then((robot) => {
        if (controller.signal.aborted || robotLayerRef.current !== layer) {
          disposeRobotModel(robot);
          return;
        }
        loadedRobot = robot;
        configureRobotJointCoupling(robot, robotArmJointCouplingEnabledRef.current);
        configureRobotArmSoftLimits(robot, robotArmSoftLimitRatioRef.current);
        layer.add(robot);
        loadedRobotRef.current = robot;
        applyRobotModelOpacity(robot, robotOpacityRef.current);
        canvas.dataset.robotModelOpacity = String(robotOpacityRef.current);
        applyRobotPose(layer, robotPoseRef.current);
        robotJointValuesRef.current = applyRobotJointStateToScene(
          robotJointValuesRef.current,
          'robot-load',
        );
        layer.updateMatrixWorld(true);
        const groundLift = robotGroundLift(robot);
        if (groundLift > 0) {
          const groundedPose = normalizeRobotPose(robotPoseRef.current);
          groundedPose.position.z += groundLift;
          robotPoseRef.current = applyRobotPose(layer, groundedPose);
          onRobotPoseChangeRef.current?.(groundedPose);
        }
        canvas.dataset.robotGroundLift = String(groundLift);
        canvas.dataset.robotLoadedBottomZ = String(
          setRobotVisualBounds(new THREE.Box3(), robot).min.z,
        );
        const metadata = robot.userData.robot || {};
        const chassisHandle = createRobotChassisDragHandle(robot, metadata);
        chassisControlGuide = createChassisControlGuide();
        chassisHandle.controlGuide = chassisControlGuide;
        sceneRef.current.add(chassisControlGuide.group);
        robotChassisHandleRef.current = chassisHandle;
        const bounds = metadata.bounds || {};
        const modelSize = Array.isArray(bounds.size)
          ? Math.max(...bounds.size.map((value) => Math.abs(Number(value) || 0)))
          : 1;
        const pickRadius = THREE.MathUtils.clamp(modelSize * 0.045, 0.055, 0.14);
        const endEffectors = {
          left: getRobotEndEffector(robot, 'left'),
          right: getRobotEndEffector(robot, 'right'),
        };
        Object.entries(endEffectors).forEach(([side, endEffector]) => {
          if (!endEffector) return;
          const pickTarget = new THREE.Mesh(
            new THREE.SphereGeometry(pickRadius, 12, 8),
            new THREE.MeshBasicMaterial({
              transparent: true,
              opacity: 0,
              depthWrite: false,
              colorWrite: false,
            }),
          );
          pickTarget.name = `end-effector-${side}-double-click-target`;
          pickTarget.userData.endEffectorSide = side;
          endEffector.frame.add(pickTarget);
        });
        endEffectorControllersRef.current = endEffectors;
        const chest = robot.getObjectByName('waist_yaw_L');
        const chestBounds = new THREE.Box3();
        if (chest) {
          const inverse = chest.matrixWorld.clone().invert();
          chest.children.filter((child) => child.userData?.urdfType === 'visual').forEach((visual) => {
            expandObjectBoundsInFrame(chestBounds, visual, inverse);
          });
        }
        torsoControllerRef.current = createRobotTorsoController(robot,
          chestBounds.isEmpty() ? new THREE.Vector3() : chestBounds.getCenter(new THREE.Vector3()));
        canvas.dataset.robotTorsoControlAvailable = torsoControllerRef.current ? 'true' : 'false';
        zividCameraFramesRef.current = {
          left: robot.getObjectByName('zivid_left_optical_frame') || null,
          right: robot.getObjectByName('zivid_right_optical_frame') || null,
        };
        robot.updateMatrixWorld(true);
        const leftPosition = endEffectors.left?.frame
          .getWorldPosition(new THREE.Vector3()).toArray() || [];
        const rightPosition = endEffectors.right?.frame
          .getWorldPosition(new THREE.Vector3()).toArray() || [];
        canvas.dataset.robotModelState = 'loaded';
        canvas.dataset.robotModelName = robotDescriptor.name;
        canvas.dataset.robotModelFormat = metadata.format || robotDescriptor.format;
        writeRobotPoseDataset(canvas, robotPoseRef.current);
        canvas.dataset.robotLinkCount = String(metadata.linkCount || 0);
        canvas.dataset.robotJointCount = String(metadata.jointCount || 0);
        canvas.dataset.robotVisualCount = String(metadata.visualCount || 0);
        canvas.dataset.robotZividCount = String(metadata.zividCount || 0);
        canvas.dataset.robotOpticalFrameCount = String(metadata.opticalFrameCount || 0);
        canvas.dataset.robotWebOverrideCount = String(metadata.webOverrideCount || 0);
        canvas.dataset.robotEndEffectorCount = String(
          Object.values(endEffectors).filter(Boolean).length,
        );
        canvas.dataset.chassisDragHandleReady = 'true';
        canvas.dataset.chassisDragTargetFrame = chassisHandle.frame.name || 'robot-root';
        canvas.dataset.chassisDragTargetSize = chassisHandle.size
          .toArray()
          .map((value) => value.toFixed(6))
          .join(',');
        canvas.dataset.robotBoundsMin = (bounds.min || []).join(',');
        canvas.dataset.robotBoundsMax = (bounds.max || []).join(',');
        canvas.dataset.robotLeftToolPosition = leftPosition.join(',');
        canvas.dataset.robotRightToolPosition = rightPosition.join(',');
        canvas.dataset.robotWaistPosition = (metadata.framePositions?.waist_yaw_L || []).join(',');
        onRobotLoadStateRef.current?.({
          status: 'loaded',
          robotId: robotDescriptor.id,
          name: robotDescriptor.name,
          loaded: metadata.visualCount || 1,
          total: metadata.visualCount || 1,
          ...metadata,
        });
        reportRobotJointValues(true);
        reportZividCameraPoses(true);
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        canvas.dataset.robotModelState = 'error';
        canvas.dataset.robotModelError = error.message || '未知错误';
        onRobotLoadStateRef.current?.({
          status: 'error',
          robotId: robotDescriptor.id,
          name: robotDescriptor.name,
          message: error.message || '未知错误',
        });
      });

    return () => {
      controller.abort();
      collisionHighlightCleanupRef.current?.();
      collisionHighlightCleanupRef.current = null;
      chassisDragInteractionRef.current?.exit?.('robot-change');
      robotChassisHandleRef.current = null;
      canvas.dataset.chassisDragHandleReady = 'false';
      canvas.dataset.robotChassisScreenVisible = 'false';
      canvas.dataset.chassisControlGuideVisible = 'false';
      endEffectorInteractionRef.current?.exit?.();
      endEffectorControllersRef.current = { left: null, right: null };
      torsoControllerRef.current = null;
      canvas.dataset.robotTorsoControlAvailable = 'false';
      canvas.dataset.robotTorsoScreenVisible = 'false';
      zividCameraFramesRef.current = { left: null, right: null };
      lastZividCameraPoseSignatureRef.current = '';
      onZividCameraPoseChangeRef.current?.({});
      if (loadedRobotRef.current === loadedRobot) loadedRobotRef.current = null;
      clearRobotJointDataset(canvas);
      if (chassisControlGuide) disposeRobotModel(chassisControlGuide.group);
      if (loadedRobot) disposeRobotModel(loadedRobot);
    };
  }, [mapData?.geometry, robotDescriptor]);

  useEffect(() => {
    const layer = robotParkingGhostLayerRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!layer || !canvas) return undefined;

    clearRobotParkingGhostLayer(layer);
    robotParkingGhostVisualRef.current = null;
    writeRobotParkingGhostHiddenDataset(canvas);
    if (
      !robotParkingGhost
      || !loadedRobotRef.current
      || robotLoadState?.status !== 'loaded'
    ) return undefined;

    let visual = null;
    try {
      visual = createRobotParkingGhostVisual(
        loadedRobotRef.current,
        robotParkingGhost,
      );
      visual.objects.forEach((object) => layer.add(object));
      layer.userData.ownedResources = visual.resources;
      layer.userData.parkingPointId = robotParkingGhost.parkingPointId;
      robotParkingGhostVisualRef.current = visual;
      applyRobotModelOpacity(visual.ghostRobot, robotOpacityRef.current);
      updateRobotParkingGhostGuide(visual, robotPoseRef.current, canvas);
      canvas.dataset.parkingGhostState = showRobotRef.current ? 'visible' : 'hidden';
      canvas.dataset.parkingGhostKind = robotParkingGhost.kind || 'parking';
      canvas.dataset.parkingGhostTargetId = robotParkingGhost.parkingPointId;
      canvas.dataset.parkingGhostPoseId = robotParkingGhost.poseId || '';
      canvas.dataset.parkingGhostMeshCount = String(visual.meshCount);
      canvas.dataset.parkingGhostJointCount = String(visual.jointCount);
      canvas.dataset.parkingGhostJointValues = JSON.stringify(
        normalizeRobotJointValues(robotParkingGhost.jointValues),
      );
      canvas.dataset.parkingGhostOpacity = String(ROBOT_PARKING_GHOST_OPACITY * robotOpacityRef.current);
      canvas.dataset.parkingGhostTargetPose = [
        visual.targetPose.position.x,
        visual.targetPose.position.y,
        visual.targetPose.position.z,
        visual.targetPose.rpy.roll,
        visual.targetPose.rpy.pitch,
        visual.targetPose.rpy.yaw,
      ].join(',');
    } catch (error) {
      clearRobotParkingGhostLayer(layer);
      robotParkingGhostVisualRef.current = null;
      canvas.dataset.parkingGhostState = 'error';
      canvas.dataset.parkingGhostError = error?.message || '机器人虚影创建失败';
      console.error('Failed to create robot parking ghost', error);
      return undefined;
    }

    return () => {
      if (robotParkingGhostVisualRef.current === visual) {
        robotParkingGhostVisualRef.current = null;
        clearRobotParkingGhostLayer(layer);
        writeRobotParkingGhostHiddenDataset(canvas);
      }
    };
  }, [mapData?.geometry, robotDescriptor, robotLoadState?.status, robotParkingGhost, robotArmSoftLimitRatio, robotArmJointCouplingEnabled]);

  useEffect(() => {
    const scene = sceneRef.current, robot = loadedRobotRef.current, canvas = controlsRef.current?.domElement;
    if (!scene || !robot || !canvas || !polylineOpen || !isActive || !polylineSuggestion) return undefined;
    const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(polylineSuggestion.basePose.quaternion), 'XYZ');
    const [x, y, z] = polylineSuggestion.basePose.position;
    const visual = createRobotParkingGhostVisual(robot, { parkingPointName: '折线参考姿态', jointValues: polylineSuggestion.joints,
      targetPose: { position: { x, y, z }, rpy: { roll: THREE.MathUtils.radToDeg(rotation.x),
        pitch: THREE.MathUtils.radToDeg(rotation.y), yaw: THREE.MathUtils.radToDeg(rotation.z) } } });
    const layer = new THREE.Group(); layer.name = 'polyline-start-suggestion';
    layer.userData.ownedResources = visual.resources;
    visual.objects.forEach((object) => layer.add(object));
    scene.add(layer); layer.visible = showRobotRef.current;
    polylineGhostRef.current = { layer, visual };
    applyRobotModelOpacity(visual.ghostRobot, robotOpacityRef.current);
    updateRobotParkingGhostGuide(visual, robotPoseRef.current, null);
    canvas.dataset.polylineGhostState = layer.visible ? 'visible' : 'hidden';
    canvas.dataset.polylineGhostJointValues = JSON.stringify(polylineSuggestion.joints);
    canvas.dataset.polylineGhostBasePose = JSON.stringify(polylineSuggestion.basePose);
    canvas.dataset.polylineGhostMeshCount = String(visual.meshCount);
    if (layer.visible) getPolylineContext().focusSuggestion();
    return () => {
      if (polylineGhostRef.current?.visual === visual) polylineGhostRef.current = null;
      clearRobotParkingGhostLayer(layer); layer.removeFromParent();
      canvas.dataset.polylineGhostState = 'hidden';
      delete canvas.dataset.polylineGhostJointValues;
      delete canvas.dataset.polylineGhostBasePose;
      delete canvas.dataset.polylineGhostMeshCount;
    };
  }, [polylineSuggestion, polylineOpen, isActive, mapData?.geometry, robotDescriptor, robotLoadState?.status]);

  useEffect(() => {
    applyRobotModelOpacity(loadedRobotRef.current, robotOpacity);
    applyRobotModelOpacity(robotParkingGhostVisualRef.current?.ghostRobot, robotOpacity);
    applyRobotModelOpacity(polylineGhostRef.current?.visual.ghostRobot, robotOpacity);
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.robotModelOpacity = String(robotOpacity);
      if (robotParkingGhostVisualRef.current) canvas.dataset.parkingGhostOpacity = String(ROBOT_PARKING_GHOST_OPACITY * robotOpacity);
    }
  }, [robotOpacity, mapData?.geometry]);

  useEffect(() => {
    if (robotLayerRef.current) robotLayerRef.current.visible = showRobot;
    if (robotParkingGhostLayerRef.current) robotParkingGhostLayerRef.current.visible = showRobot;
    if (polylineGhostRef.current) polylineGhostRef.current.layer.visible = showRobot;
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.robotLayerVisible = String(showRobot);
      canvas.dataset.parkingGhostState = showRobot && robotParkingGhostVisualRef.current ? 'visible' : 'hidden';
      canvas.dataset.polylineGhostState = showRobot && polylineGhostRef.current ? 'visible' : 'hidden';
    }
    if (!showRobot) {
      chassisDragInteractionRef.current?.exit?.('robot-hidden');
      endEffectorInteractionRef.current?.exit?.();
    }
  }, [mapData?.geometry, showRobot]);

  useEffect(() => {
    const canvas = controlsRef.current?.domElement;
    const geometry = mapData?.geometry;
    const generation = collisionMonitorGenerationRef.current + 1;
    collisionMonitorGenerationRef.current = generation;
    let disposed = false;
    let worker = null;
    let workerReady = false;
    let workerBusy = false;
    let collisionCheckPending = false;
    let checkTimer = null;
    let deferredCheckTimer = null;
    let lastCheckSubmittedAt = Number.NEGATIVE_INFINITY;
    let observedRobot = null;
    let observedIgnoredJoints = '';
    let proxyCollection = null;
    let lastPoseSignature = '';
    let lastPublishedSignature = '';
    let checkRevision = 0;
    let checkCount = 0;
    let indexMetrics = {
      sourcePointCount: geometry?.getAttribute?.('position')?.count || 0,
      indexedPointCount: 0,
      meshSampleCount: 0,
    };
    let currentStatus = createRobotCollisionStatus({
      enabled: Boolean(collisionProtectionEnabled),
    });

    const writeStatusDataset = (status) => {
      if (!canvas) return;
      canvas.dataset.collisionProtectionEnabled = status.enabled ? 'true' : 'false';
      canvas.dataset.collisionState = status.state;
      canvas.dataset.collisionBackend = status.backend || 'local';
      canvas.dataset.collisionRequestedBackend = status.requestedBackend || 'local';
      canvas.dataset.collisionEngine = status.engine || '';
      canvas.dataset.collisionSafetyDistance = String(ROBOT_COLLISION_SAFETY_DISTANCE);
      canvas.dataset.collisionContactMargin = String(ROBOT_COLLISION_CONTACT_MARGIN);
      canvas.dataset.collisionMinimumDistance = Number.isFinite(status.minimumDistance)
        ? Number(status.minimumDistance).toFixed(6)
        : '';
      canvas.dataset.collisionLinks = (status.collisionLinks || []).join(',');
      canvas.dataset.collisionNearLinks = (status.nearLinks || []).join(',');
      canvas.dataset.collisionExcludedLinks = (status.excludedLinks || []).join(',');
      canvas.dataset.collisionIgnoredJoints = (status.ignoredJointNames || []).join(',');
      canvas.dataset.collisionIgnoredLinks = (status.ignoredLinks || []).join(',');
      canvas.dataset.collisionMonitoredLinkCount = String(status.monitoredLinkCount || 0);
      canvas.dataset.collisionMonitoredProxyCount = String(status.monitoredProxyCount || 0);
      canvas.dataset.collisionModelProxyCount = String(status.collisionModelProxyCount || 0);
      canvas.dataset.collisionVisualFallbackProxyCount = String(
        status.visualFallbackProxyCount || 0,
      );
      canvas.dataset.collisionSourcePoints = String(status.sourcePointCount || 0);
      canvas.dataset.collisionIndexedPoints = String(status.indexedPointCount || 0);
      canvas.dataset.collisionMeshSamples = String(status.meshSampleCount || 0);
      canvas.dataset.collisionCheckCount = String(status.checkCount || 0);
      canvas.dataset.collisionHighlightedLinks = [
        ...(status.collisionLinks || []),
        ...(status.nearLinks || []),
      ].join(',');
      canvas.dataset.collisionHighlightColor = status.state === 'collision'
        ? '#ff4545'
        : status.state === 'near'
          ? '#ffc84a'
          : 'none';
    };

    const publishStatus = (patch) => {
      currentStatus = createRobotCollisionStatus({
        ...currentStatus,
        ...patch,
        enabled: Boolean(collisionProtectionEnabled),
        threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
      });
      writeStatusDataset(currentStatus);
      const signature = collisionStatusSignature(currentStatus);
      if (signature === lastPublishedSignature) return;
      lastPublishedSignature = signature;
      setRobotCollisionStatus(currentStatus);
      onCollisionProtectionStatusRef.current?.(currentStatus);
    };

    const clearProxyCollection = () => {
      if (proxyCollection) disposeRobotCollisionProxies(proxyCollection);
      proxyCollection = null;
      observedRobot = null;
      if (canvas) {
        canvas.dataset.collisionProbePoint = '';
        canvas.dataset.collisionProbeLink = '';
      }
    };
    if (!collisionProtectionEnabled) {
      if (canvas) canvas.dataset.collisionWorker = 'inactive';
      publishStatus({
        state: 'disabled',
        message: '碰撞保护未开启',
        detail: '专用空间索引与距离检测尚未占用硬件资源',
      });
      return undefined;
    }

    const positionAttribute = geometry?.getAttribute?.('position');
    if (
      !canvas
      || !positionAttribute?.count
      || !robotDescriptor
      || robotLoadState?.status !== 'loaded'
      || !loadedRobotRef.current
    ) {
      if (canvas) canvas.dataset.collisionWorker = 'inactive';
      const robotFailed = robotDescriptor && robotLoadState?.status === 'error';
      publishStatus({
        state: robotFailed ? 'error' : 'waiting',
        message: robotFailed ? '机器人检测体不可用' : '等待地图与机器人就绪',
        detail: robotFailed
          ? '机器人模型加载失败，请重新选择模型'
          : '碰撞保护已开启，模型加载完成后自动开始检测',
      });
      return undefined;
    }
    collisionHighlightCleanupRef.current = clearProxyCollection;

    publishStatus({
      state: 'building',
      message: '正在连接碰撞后端',
      detail: `${positionAttribute.count.toLocaleString('zh-CN')} 个地图顶点等待建立环境模型`,
      ...indexMetrics,
    });

    const ensureRobotProxies = () => {
      const robot = loadedRobotRef.current;
      if (!robot) return false;
      const ignoredJointNames = ignoredCollisionJointNamesRef.current;
      const ignoredSignature = JSON.stringify(ignoredJointNames);
      if (observedRobot === robot && proxyCollection && observedIgnoredJoints === ignoredSignature) {
        return proxyCollection.proxies.length > 0;
      }
      clearProxyCollection();
      observedRobot = robot;
      observedIgnoredJoints = ignoredSignature;
      proxyCollection = collectRobotCollisionProxies(robot, ignoredJointNames);
      // Discard an in-flight response for the previous detection scope.
      checkRevision += 1;
      lastPoseSignature = '';
      publishStatus({
        state: 'waiting', minimumDistance: null, collisionLinks: [], nearLinks: [],
        ignoredJointNames, ignoredLinks: proxyCollection.ignoredLinks,
        excludedLinks: proxyCollection.excludedLinks,
        monitoredLinkCount: proxyCollection.monitoredLinks.length,
        monitoredProxyCount: proxyCollection.proxies.length,
        collisionModelProxyCount: proxyCollection.collisionModelProxyCount,
        visualFallbackProxyCount: proxyCollection.visualFallbackProxyCount,
        message: '正在更新检测范围', detail: '',
      });
      const serialized = serializeRobotCollisionProxies(proxyCollection);
      const probe = selectRobotCollisionProbe(serialized.records);
      if (probe && canvas) {
        canvas.dataset.collisionProbePoint = probe.center
          .map((value) => Number(value).toFixed(6))
          .join(',');
        canvas.dataset.collisionProbeLink = probe.linkName;
      }
      return proxyCollection.proxies.length > 0;
    };

    const requestCollisionCheck = () => {
      if (disposed) return;
      canvas.dataset.collisionRequestCount = String(
        Number(canvas.dataset.collisionRequestCount || 0) + 1,
      );
      if (!ensureRobotProxies()) {
        const excluded = proxyCollection?.ignoredLinks.length > 0;
        const failed = robotLoadStateRef.current?.status === 'error';
        publishStatus({
          state: excluded ? 'excluded' : failed ? 'error' : 'waiting',
          minimumDistance: null, collisionLinks: [], nearLinks: [],
          message: excluded ? '所有可检测部件已忽略' : failed ? '机器人检测体不可用' : '等待机器人检测体',
          detail: excluded ? '可在距离警告设置中恢复关节检测' : failed ? '机器人模型加载失败，请重新选择模型' : '模型装配完成后将自动开始检测',
          ...indexMetrics,
        });
        return;
      }
      if (!workerReady || !worker) {
        collisionCheckPending = true;
        return;
      }
      if (workerBusy) {
        collisionCheckPending = true;
        return;
      }
      const timeUntilNextCheck = ROBOT_COLLISION_CHECK_INTERVAL_MS
        - (performance.now() - lastCheckSubmittedAt);
      if (timeUntilNextCheck > 1) {
        collisionCheckPending = true;
        if (!deferredCheckTimer) {
          deferredCheckTimer = window.setTimeout(() => {
            deferredCheckTimer = null;
            requestCollisionCheck();
          }, timeUntilNextCheck);
        }
        return;
      }
      collisionCheckPending = false;
      robotLayerRef.current?.updateMatrixWorld(true);
      const serialized = serializeRobotCollisionProxies(proxyCollection);
      const probe = selectRobotCollisionProbe(serialized.records);
      if (probe) {
        canvas.dataset.collisionProbePoint = probe.center
          .map((value) => Number(value).toFixed(6))
          .join(',');
        canvas.dataset.collisionProbeLink = probe.linkName;
      }
      if (serialized.signature === lastPoseSignature) {
        canvas.dataset.collisionSkippedPoseCount = String(
          Number(canvas.dataset.collisionSkippedPoseCount || 0) + 1,
        );
        return;
      }
      lastPoseSignature = serialized.signature;
      workerBusy = true;
      lastCheckSubmittedAt = performance.now();
      checkRevision += 1;
      canvas.dataset.collisionSubmittedRevision = String(checkRevision);
      worker.postMessage({
        type: 'check',
        revision: checkRevision,
        proxies: serialized.records,
        threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
        contactMargin: ROBOT_COLLISION_CONTACT_MARGIN,
      });
    };
    const requestCollisionCheckFromScene = () => {
      collisionCheckPending = true;
      requestCollisionCheck();
    };
    collisionCheckRequestRef.current = requestCollisionCheckFromScene;

    const startCollisionBackend = async () => {
      try {
        worker = await createRobotCollisionBackend();
        if (disposed || collisionMonitorGenerationRef.current !== generation) {
          worker.terminate();
          return;
        }
        const backend = worker.atlasBackend || 'local';
        const requestedBackend = worker.atlasRequestedBackend || backend;
        const engine = worker.atlasEngine || (
          backend === 'isaac' ? 'NVIDIA PhysX' : 'Browser spatial worker'
        );
        publishStatus({
          state: 'building',
          backend,
          requestedBackend,
          engine,
          message: backend === 'isaac' ? '正在同步 Isaac Sim 环境' : '正在建立环境空间索引',
          detail: worker.atlasFallbackReason
            ? `Isaac 暂不可用，已回退本地检测：${worker.atlasFallbackReason}`
            : `${positionAttribute.count.toLocaleString('zh-CN')} 个地图顶点正在${backend === 'isaac' ? '构建 PhysX 场景' : '专用 Worker 中处理'}`,
        });
        canvas.dataset.collisionWorker = 'building';

        const stopFailedBackend = () => {
          workerBusy = false;
          workerReady = false;
          if (checkTimer) {
            window.clearInterval(checkTimer);
            checkTimer = null;
          }
          canvas.dataset.collisionWorker = 'error';
          applyRobotCollisionHighlights(proxyCollection, {});
          const failedWorker = worker;
          worker = null;
          failedWorker?.terminate();
        };

        worker.onmessage = (event) => {
          if (disposed || collisionMonitorGenerationRef.current !== generation) return;
          const message = event.data || {};
          if (message.type === 'ready') {
            workerReady = true;
            indexMetrics = {
              sourcePointCount: Number(message.sourcePointCount) || 0,
              indexedPointCount: Number(message.indexedPointCount) || 0,
              meshSampleCount: Number(message.meshSampleCount) || 0,
            };
            canvas.dataset.collisionWorker = backend === 'isaac' ? 'isaac' : 'dedicated';
            canvas.dataset.collisionPhysxMeshReady = message.physxMeshReady === true
              ? 'true'
              : message.physxMeshReady === false ? 'false' : '';
            canvas.dataset.collisionIndexBuildMs = Number(message.buildMs || 0).toFixed(2);
            canvas.dataset.collisionIndexCellSize = String(
              message.cellSize || COLLISION_INDEX_CELL_SIZE,
            );
            canvas.dataset.collisionIndexBuckets = String(message.bucketCount || 0);
            publishStatus({
              state: 'waiting',
              backend,
              requestedBackend,
              engine: message.engine || engine,
              message: '环境索引已就绪',
              detail: `${backend === 'isaac' ? 'Isaac Sim / PhysX' : '本地 Worker'} 已索引 ${indexMetrics.indexedPointCount.toLocaleString('zh-CN')} 个环境样本，正在同步机器人`,
              ...indexMetrics,
            });
            requestCollisionCheck();
            return;
          }
          if (message.type === 'result') {
            workerBusy = false;
            if (Number(message.revision) !== checkRevision || !proxyCollection) {
              if (collisionCheckPending) window.setTimeout(requestCollisionCheck, 0);
              return;
            }
            checkCount += 1;
            const collisionLinks = Array.isArray(message.collisionLinks)
              ? message.collisionLinks
              : [];
            const nearLinks = Array.isArray(message.nearLinks) ? message.nearLinks : [];
            const minimumDistance = Number.isFinite(message.minimumDistance)
              ? Number(message.minimumDistance)
              : null;
            const state = collisionLinks.length ? 'collision' : nearLinks.length ? 'near' : 'safe';
            applyRobotCollisionHighlights(proxyCollection, { collisionLinks, nearLinks });
            canvas.dataset.collisionLastCheckMs = Number(message.checkMs || 0).toFixed(2);
            publishStatus({
              state,
              minimumDistance,
              collisionLinks,
              nearLinks,
              excludedLinks: proxyCollection.excludedLinks,
              monitoredLinkCount: proxyCollection.monitoredLinks.length,
              monitoredProxyCount: proxyCollection.proxies.length,
              collisionModelProxyCount: proxyCollection.collisionModelProxyCount,
              visualFallbackProxyCount: proxyCollection.visualFallbackProxyCount,
              checkCount,
              message: state === 'collision'
                ? '检测到环境干涉'
                : state === 'near'
                  ? '进入 100 mm 安全边界'
                  : proxyCollection.ignoredLinks.length ? '检测范围内的部件安全' : '非底盘结构安全',
              detail: state === 'collision'
                ? `红色部件：${collisionLinks.slice(0, 4).join(' / ')}${collisionLinks.length > 4 ? ` +${collisionLinks.length - 4}` : ''}`
                : state === 'near'
                  ? `最近直线距离 ${Math.max(0, minimumDistance * 1000).toFixed(0)} mm · ${nearLinks.slice(0, 3).join(' / ')}`
                  : `最近环境样本距离不小于 100 mm${proxyCollection.ignoredLinks.length ? ` · 已忽略 ${proxyCollection.ignoredLinks.length} 个部件` : ''}`,
              ...indexMetrics,
            });
            if (collisionCheckPending) window.setTimeout(requestCollisionCheck, 0);
            return;
          }
          if (message.type === 'error') {
            stopFailedBackend();
            publishStatus({
              state: 'error',
              message: '干涉检测中断',
              detail: message.message || `${engine} 返回了未知错误`,
              ...indexMetrics,
            });
          }
        };
        worker.onerror = (event) => {
          if (disposed || collisionMonitorGenerationRef.current !== generation) return;
          stopFailedBackend();
          publishStatus({
            state: 'error',
            message: '干涉检测中断',
            detail: event.message || `${engine} 无法建立环境索引`,
          });
        };

        const positions = packCollisionPositions(positionAttribute);
        const indices = packCollisionIndices(geometry.getIndex?.());
        worker.postMessage({
          type: 'init',
          positions,
          indices,
          requestedCellSize: COLLISION_INDEX_CELL_SIZE,
        }, [positions.buffer, indices.buffer]);
        checkTimer = window.setInterval(
          requestCollisionCheck,
          ROBOT_COLLISION_CHECK_INTERVAL_MS,
        );
      } catch (error) {
        publishStatus({
          state: 'error',
          message: '干涉检测无法启动',
          detail: error.message || '碰撞后端初始化失败',
        });
      }
    };
    void startCollisionBackend();

    return () => {
      disposed = true;
      if (collisionMonitorGenerationRef.current === generation) {
        collisionMonitorGenerationRef.current += 1;
      }
      if (checkTimer) window.clearInterval(checkTimer);
      if (deferredCheckTimer) window.clearTimeout(deferredCheckTimer);
      worker?.terminate();
      applyRobotCollisionHighlights(proxyCollection, {});
      clearProxyCollection();
      if (collisionCheckRequestRef.current === requestCollisionCheckFromScene) {
        collisionCheckRequestRef.current = null;
      }
      if (collisionHighlightCleanupRef.current === clearProxyCollection) {
        collisionHighlightCleanupRef.current = null;
      }
      canvas.dataset.collisionWorker = 'terminated';
      canvas.dataset.collisionHighlightedLinks = '';
      canvas.dataset.collisionHighlightColor = 'none';
    };
  }, [collisionProtectionEnabled, mapData?.geometry, robotDescriptor, robotLoadState?.status]);

  useEffect(() => {
    collisionCheckRequestRef.current?.();
  }, [robotJointValues, robotPose, ignoredCollisionJointNames]);

  useEffect(() => {
    if (!initialView || appliedInitialViewRef.current === initialView) return;
    if (viewActionsRef.current?.apply?.(initialView, 'restored')) {
      appliedInitialViewRef.current = initialView;
    }
  }, [initialView, mapData?.geometry]);

  useEffect(() => {
    const revision = Number(resetRequest?.revision) || 0;
    if (!revision || revision === appliedResetRevisionRef.current || !mapData?.geometry) return;
    appliedResetRevisionRef.current = revision;
    viewActionsRef.current?.reset?.();
  }, [mapData?.geometry, resetRequest]);

  useEffect(() => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const canvas = controls?.domElement;
    const sphere = mapData?.geometry?.boundingSphere;
    if (!focusRequest || !controls || !camera || !canvas || !sphere || robotFollowEnabled) {
      return undefined;
    }

    const pointById = new Map(waypoints.map((point) => [point.id, point]));
    let target = null;
    let subjectSpan = 0;
    if (focusRequest.type === 'mobile-pose') {
      if (selectedMobilePose?.sample.id === focusRequest.id) {
        target = mobileSamplePosition(selectedMobilePose.sample, selectedMobilePose.task);
        subjectSpan = 0.5;
      }
    } else if (focusRequest.type === 'waypoint') {
      const point = pointById.get(focusRequest.id);
      if (point) target = new THREE.Vector3(point.pose.x, point.pose.y, point.pose.z);
    } else if (focusRequest.type === 'edge') {
      const edge = edges.find((item) => item.id === focusRequest.id);
      const source = edge ? pointById.get(edge.from) : null;
      const destination = edge ? pointById.get(edge.to) : null;
      if (source && destination) {
        const start = new THREE.Vector3(source.pose.x, source.pose.y, source.pose.z);
        const end = new THREE.Vector3(
          destination.pose.x,
          destination.pose.y,
          destination.pose.z,
        );
        target = start.clone().add(end).multiplyScalar(0.5);
        subjectSpan = start.distanceTo(end);
      }
    } else if (focusRequest.type === 'robot') {
      const robot = robotLayerRef.current;
      if (robot?.children.length) {
        const robotSphere = setRobotVisualBounds(new THREE.Box3(), robot)
          .getBoundingSphere(new THREE.Sphere());
        if (Number.isFinite(robotSphere.radius) && robotSphere.radius > 0) {
          target = robotSphere.center.clone();
          subjectSpan = robotSphere.radius * 2;
          camera.updateMatrixWorld(true);
          const screenUp = new THREE.Vector3()
            .setFromMatrixColumn(camera.matrixWorld, 1)
            .normalize();
          target.addScaledVector(screenUp, -robotSphere.radius * 0.28);
        }
      }
    } else if (focusRequest.type === 'robot-ghost') {
      const robot = robotLayerRef.current;
      const ghostPoseRoot = robotParkingGhostVisualRef.current?.poseRoot;
      if (robot?.children.length && ghostPoseRoot) {
        const comparisonBounds = setRobotVisualBounds(new THREE.Box3(), robot);
        comparisonBounds.union(setRobotVisualBounds(new THREE.Box3(), ghostPoseRoot));
        const comparisonSphere = comparisonBounds.getBoundingSphere(new THREE.Sphere());
        if (Number.isFinite(comparisonSphere.radius) && comparisonSphere.radius > 0) {
          target = comparisonSphere.center.clone();
          subjectSpan = comparisonSphere.radius * 2;
        }
      }
    }
    if (!target) return undefined;

    if (focusAnimationRef.current) cancelAnimationFrame(focusAnimationRef.current);
    precisionPanRef.current?.clear?.();
    const startTarget = controls.target.clone();
    const startPosition = camera.position.clone();
    const startZoom = Math.max(camera.zoom, 1);
    const viewDirection = startPosition.clone().sub(startTarget);
    if (viewDirection.lengthSq() < 1e-18) viewDirection.set(-0.5, -0.8, 0.45);
    viewDirection.normalize();
    const routeScale = Math.max(sphere.radius * 0.006, 0.12);
    const isParkingPointFocus = Boolean(pointById.get(focusRequest.id)?.teachingTaskId)
      && (focusRequest.type === 'waypoint'
        || (focusRequest.type === 'robot-ghost' && !robotParkingGhost?.poseId));
    const baseDistance = focusRequest.type === 'edge'
      ? Math.max(subjectSpan * 1.45, sphere.radius * 0.12, routeScale * 12)
      : focusRequest.type === 'robot'
        ? Math.max(subjectSpan * 1.72, 0.9)
        : focusRequest.type === 'mobile-pose'
          ? 2.2
          : focusRequest.type === 'robot-ghost'
            ? Math.max(subjectSpan * 1.48, 1.05)
            : Math.max(sphere.radius * WAYPOINT_FOCUS_DISTANCE_RATIO, routeScale * 12);
    const desiredDistance = THREE.MathUtils.clamp(
      baseDistance * (isParkingPointFocus ? PARKING_POINT_FOCUS_DISTANCE_SCALE : 1),
      controls.minDistance * 2,
      controls.maxDistance * 0.82,
    );
    const endPosition = target.clone().addScaledVector(viewDirection, desiredDistance);
    const startedAt = performance.now();
    const duration = 560;

    canvas.dataset.synchronizedFocusType = focusRequest.type;
    canvas.dataset.synchronizedFocusId = focusRequest.id;
    canvas.dataset.synchronizedFocusRevision = String(focusRequest.revision);
    canvas.dataset.synchronizedFocusState = 'animating';
    canvas.dataset.synchronizedFocusTargetDistance = desiredDistance.toPrecision(8);
    if (focusRequest.type === 'waypoint') {
      canvas.dataset.waypointFocusDistanceRatio = String(WAYPOINT_FOCUS_DISTANCE_RATIO);
    }

    const animateFocus = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      controls.target.lerpVectors(startTarget, target, eased);
      camera.position.lerpVectors(startPosition, endPosition, eased);
      camera.zoom = Math.exp(Math.log(startZoom) * (1 - eased));
      camera.updateProjectionMatrix();
      controls.update();
      canvas.dataset.synchronizedFocusProgress = progress.toFixed(3);
      if (progress < 1) {
        focusAnimationRef.current = requestAnimationFrame(animateFocus);
      } else {
        focusAnimationRef.current = null;
        canvas.dataset.synchronizedFocusState = 'settled';
      }
    };
    focusAnimationRef.current = requestAnimationFrame(animateFocus);

    return () => {
      if (focusAnimationRef.current) {
        cancelAnimationFrame(focusAnimationRef.current);
        focusAnimationRef.current = null;
      }
    };
  }, [focusRequest, mapData?.geometry]);

  useEffect(() => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const canvas = controls?.domElement;
    const robot = robotLayerRef.current;
    if (canvas) canvas.dataset.robotFollowEnabled = String(robotFollowEnabled);
    if (!robotFollowEnabled || !isActive || !controls || !camera || !loadedRobotRef.current) {
      robotFollowPositionRef.current = null;
      return;
    }

    if (focusAnimationRef.current) {
      cancelAnimationFrame(focusAnimationRef.current);
      focusAnimationRef.current = null;
      canvas.dataset.synchronizedFocusState = 'interrupted-by-follow';
    }
    const { position } = normalizeRobotPose(robotPose);
    const nextPosition = new THREE.Vector3(position.x, position.y, position.z);
    let movement;
    if (robotFollowPositionRef.current) {
      movement = nextPosition.clone().sub(robotFollowPositionRef.current);
    } else {
      // Center once, then track base translation. Joint motion must not make
      // the camera sway as the robot's visual bounds change.
      const sphere = setRobotVisualBounds(new THREE.Box3(), robot)
        .getBoundingSphere(new THREE.Sphere());
      camera.updateMatrixWorld(true);
      const screenUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      // Match robot focus framing so the bottom playback dock leaves room for
      // the chassis instead of obscuring it.
      movement = sphere.center.addScaledVector(screenUp, -sphere.radius * 0.28).sub(controls.target);
      precisionPanRef.current?.clear?.();
    }
    robotFollowPositionRef.current = nextPosition;
    camera.position.add(movement);
    controls.target.add(movement);
    controls.update();
  }, [isActive, mapData?.geometry, robotDescriptor, robotFollowEnabled, robotLoadState?.status, robotPose]);

  useEffect(() => {
    const display = displayGeometryRef.current;
    if (!display) return;
    let attribute = display.getAttribute('atlasPlacedObject');
    if (objectLayers?.objectRanges.length) {
      const mask = placedObjectMask(sourcePointCount, objectLayers.objectRanges);
      if (attribute?.count === sourcePointCount) {
        attribute.array.set(mask);
        attribute.needsUpdate = true;
      } else attribute = new THREE.BufferAttribute(mask, 1);
      display.setAttribute('atlasPlacedObject', attribute);
      surfaceGeometryRef.current?.geometry.setAttribute('atlasPlacedObject', attribute);
    } else if (attribute) {
      attribute.array.fill(0);
      attribute.needsUpdate = true;
    }
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.placedObjectPointCount = String(placedObjectPointCount);
  }, [mapData?.geometry, objectLayers, sourcePointCount, placedObjectPointCount]);

  useEffect(() => {
    const materials = [cloudMaterialRef.current, meshMaterialRef.current].filter(Boolean);
    const canvas = controlsRef.current?.domElement;
    if (!materials.length || !canvas) return;

    materials.forEach((material) => {
      material.userData.mapColorMode = colorMode;
      material.userData.objectColorMode = placedObjectColorMode;
      const shader = material.userData.mapColorShader;
      if (shader) shader.uniforms.atlasPointColorMode.value = colorModeValue(colorMode);
      if (shader) shader.uniforms.atlasObjectColorMode.value = colorModeValue(placedObjectColorMode);
    });
    canvas.dataset.colorMode = colorMode;
    canvas.dataset.plyMeshColorMode = colorMode;
    canvas.dataset.placedObjectColorMode = placedObjectColorMode;
  }, [colorMode, placedObjectColorMode, mapData?.geometry]);

  useEffect(() => {
    const surfaceState = surfaceGeometryRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!surfaceState || !canvas || !hasEmbeddedMesh) return;
    const plan = resolveMeshRenderQuality(meshRenderQuality, meshInfo.faceCount);
    surfaceState.geometry.setIndex(
      plan.isFull ? surfaceState.sourceIndex : surfaceState.sampledIndex,
    );
    surfaceState.geometry.setDrawRange(0, plan.renderedFaceCount * 3);
    canvas.dataset.meshRenderQuality = plan.requestedId;
    canvas.dataset.meshRenderQualityEffective = plan.effectiveId;
    canvas.dataset.renderMeshFaceCount = String(plan.renderedFaceCount);
    canvas.dataset.meshFaceBudget = Number.isFinite(plan.triangleBudget)
      ? String(plan.triangleBudget)
      : 'full';
  }, [hasEmbeddedMesh, mapData?.geometry, meshInfo?.faceCount, meshRenderQuality]);

  useEffect(() => {
    const displayGeometry = displayGeometryRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!displayGeometry || !canvas || !sourcePointCount) return;

    displayGeometry.setDrawRange(0, renderedPointCount);
    canvas.dataset.resolutionPercent = String(Math.round(resolution.ratio * 100));
    canvas.dataset.renderPointCount = String(renderedPointCount);
    canvas.dataset.sourcePointCount = String(sourcePointCount);
    canvas.dataset.renderablePointCount = String(renderablePointCount);
    canvas.dataset.resolutionSelection = resolutionSelection;
    canvas.dataset.autoPointBudget = String(AUTO_POINT_BUDGET);
  }, [
    renderablePointCount,
    renderedPointCount,
    resolution.ratio,
    resolutionSelection,
    sourcePointCount,
  ]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const temporaryShiftPan = shiftPanArmed;
    controls.mouseButtons.LEFT = interactionMode === 'pan'
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.domElement.dataset.interactionMode = interactionMode;
    controls.domElement.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
    controls.domElement.dataset.effectiveInteractionMode = temporaryShiftPan
      ? 'shift-pan'
      : interactionMode;
    controls.domElement.dataset.interactionModeSource = interactionMode === 'pan'
      ? 'toolbar-toggle'
      : 'default';
    controls.domElement.dataset.keyboardEnabled = 'true';
    controls.domElement.dataset.keyboardMode = 'always-on';
  }, [interactionMode, mapData?.geometry, shiftPanArmed]);

  const updateRobotKeyboardControl = useCallback((enabled, focus = false) => {
    enabled = Boolean(enabled && showRobotRef.current && !teachingPoseEditingRef.current);
    if (enabled && chassisDragModeRef.current) {
      chassisDragInteractionRef.current?.exit?.('robot-keyboard-control');
    }
    if (enabled && endEffectorControlRef.current) {
      endEffectorInteractionRef.current?.exit?.();
    }
    robotControlEnabledRef.current = enabled;
    pressedKeysRef.current.clear();
    keyboardImpulseRef.current.clear();
    setShiftPanArmed(false);
    const canvas = controlsRef.current?.domElement;
    if (!canvas) return;
    canvas.dataset.robotControlEnabled = enabled ? 'true' : 'false';
    canvas.dataset.keyboardControlOwner = enabled ? 'robot' : 'camera';
    canvas.dataset.shiftPanArmed = 'false';
    canvas.dataset.effectiveInteractionMode = interactionModeRef.current;
    if (focus) canvas.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const available = Boolean(showRobot && robotDescriptor && robotLoadState?.status === 'loaded');
    updateRobotKeyboardControl(Boolean(robotControlEnabled && available));
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.robotControlAvailable = available ? 'true' : 'false';
  }, [mapData?.geometry, showRobot, robotControlEnabled, robotDescriptor, robotLoadState?.status, updateRobotKeyboardControl]);

  useEffect(() => {
    const locked = Boolean(robotHeightLocked && robotDescriptor);
    robotHeightLockedRef.current = locked;
    if (locked) {
      ROBOT_VERTICAL_CONTROL_CODES.forEach((code) => {
        pressedKeysRef.current.delete(code);
        keyboardImpulseRef.current.delete(code);
      });
    }
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.robotHeightLocked = locked ? 'true' : 'false';
  }, [mapData?.geometry, robotDescriptor, robotHeightLocked]);

  useEffect(() => {
    const canvas = controlsRef.current?.domElement;
    const active = Boolean(robotTrajectoryActive);
    if (active) {
      chassisDragInteractionRef.current?.exit?.('teaching-trajectory-playback');
      endEffectorInteractionRef.current?.exit?.();
      robotControlEnabledRef.current = false;
      clearRobotDragHistory();
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();
      setShiftPanArmed(false);
    }
    if (canvas) {
      canvas.dataset.robotTrajectoryActive = active ? 'true' : 'false';
      if (active) canvas.dataset.keyboardControlOwner = 'camera';
    }
  }, [mapData?.geometry, robotTrajectoryActive]);

  useEffect(() => {
    if (!robotParkingGhost?.editing || !isActive || robotLoadState?.status !== 'loaded') {
      return undefined;
    }
    const keyboardEnabled = !robotParkingGhost.poseId;
    chassisDragInteractionRef.current?.exit?.('teaching-preview-edit');
    clearRobotDragHistory();
    updateRobotKeyboardControl(keyboardEnabled, true);
    onRobotControlChangeRef.current?.(keyboardEnabled, { announce: false });
    return () => {
      chassisDragInteractionRef.current?.exit?.('parking-point-edit-ended');
      if (!keyboardEnabled && endEffectorControlRef.current) {
        endEffectorInteractionRef.current?.exit?.();
      }
      updateRobotKeyboardControl(false);
      onRobotControlChangeRef.current?.(false, { announce: false });
    };
  }, [
    isActive,
    mapData?.geometry,
    robotDescriptor,
    robotLoadState?.status,
    robotParkingGhost?.editing,
    robotParkingGhost?.poseId,
    robotParkingGhost?.revision,
    updateRobotKeyboardControl,
  ]);

  useEffect(() => {
    if (!mapData?.geometry) return undefined;
    const resetKeys = (updateUi = true) => {
      const hadRobotInput = [...ROBOT_CONTROL_CODES].some(
        (code) => pressedKeysRef.current.has(code),
      );
      pressedKeysRef.current.clear();
      keyboardImpulseRef.current.clear();
      if (hadRobotInput && robotControlEnabledRef.current) {
        robotPoseActionsRef.current?.publish?.(true);
      }
      if (updateUi) setShiftPanArmed(false);
      const canvas = controlsRef.current?.domElement;
      if (canvas) {
        canvas.dataset.shiftPanArmed = 'false';
        canvas.dataset.effectiveInteractionMode = interactionModeRef.current;
      }
    };
    const onKeyDown = (event) => {
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase();
      if (
        (target?.isContentEditable
          || tagName === 'input'
          || tagName === 'textarea'
          || tagName === 'select')
        && !(event.code === 'Escape' && (
          teachingPoseEditingRef.current || endEffectorControlRef.current
        ))
      ) {
        return;
      }
      if (
        (event.ctrlKey || event.metaKey)
        && !event.shiftKey
        && !event.altKey
        && (event.code === 'KeyZ' || event.key?.toLowerCase() === 'z')
      ) {
        if (
          !event.defaultPrevented
          && !event.repeat
          && !target?.closest?.('[aria-modal="true"], dialog[open]')
          && robotDragActionsRef.current?.undo()
        ) event.preventDefault();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Escape' && event.repeat) return;
      if (
        event.code === 'Escape'
        && renderActiveRef.current
        && endEffectorControlRef.current
        && !event.defaultPrevented
        && !target?.closest?.('[aria-modal="true"], dialog[open]')
      ) {
        event.preventDefault();
        resetKeys();
        endEffectorInteractionRef.current?.cancel?.();
        return;
      }
      if (
        event.code === 'Escape'
        && renderActiveRef.current
        && robotParkingGhostRef.current?.editing
        && !event.defaultPrevented
        && !target?.closest?.('[aria-modal="true"], dialog[open]')
      ) {
        event.preventDefault();
        updateRobotKeyboardControl(false);
        chassisDragInteractionRef.current?.exit?.('parking-point-edit-cancelled');
        if (teachingPoseEditingRef.current && endEffectorControlRef.current) {
          endEffectorInteractionRef.current?.exit?.();
        }
        onCancelTeachingPreviewEditRef.current?.();
        return;
      }
      if (event.code === 'Escape' && chassisDragModeRef.current) {
        event.preventDefault();
        chassisDragInteractionRef.current?.exit?.('escape');
        return;
      }
      if (
        event.code === 'Escape'
        && renderActiveRef.current
        && robotParkingGhostRef.current
        && !event.defaultPrevented
        && !document.querySelector('[aria-modal="true"], dialog[open]')
      ) {
        event.preventDefault();
        onClearRobotParkingGhostRef.current?.();
        return;
      }
      if (
        event.code === 'Escape'
        && renderActiveRef.current
        && robotControlEnabledRef.current
        && !event.defaultPrevented
        && !target?.closest?.('[aria-modal="true"], dialog[open]')
      ) {
        event.preventDefault();
        updateRobotKeyboardControl(false);
        onRobotControlChangeRef.current?.(false);
        return;
      }
      const code = movementCodeForEvent(event);
      if (!code) return;
      const isActionKey = code !== 'ShiftLeft' && code !== 'ShiftRight';
      if (isActionKey) event.preventDefault();
      pressedKeysRef.current.add(code);
      if (!event.repeat && isActionKey) keyboardImpulseRef.current.add(code);
      const canvas = controlsRef.current?.domElement;
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        setShiftPanArmed(true);
        if (canvas) {
          canvas.dataset.shiftPanArmed = 'true';
          canvas.dataset.effectiveInteractionMode = 'shift-pan';
        }
        pointerInteractionRef.current?.activateShiftPan?.();
      }
      if (canvas && isActionKey) {
        const robotOwnsKey =
          robotControlEnabledRef.current
          && ROBOT_CONTROL_CODES.has(code)
          && robotLayerRef.current?.children.length > 0;
        canvas.dataset.lastKeyboardKey = code.startsWith('Key') ? code.slice(3) : code;
        canvas.dataset.keyboardControlOwner = robotOwnsKey ? 'robot' : 'camera';
        if (robotOwnsKey) {
          const heightChangeBlocked =
            robotHeightLockedRef.current
            && ROBOT_VERTICAL_CONTROL_CODES.has(code);
          if (heightChangeBlocked) {
            pressedKeysRef.current.delete(code);
            keyboardImpulseRef.current.delete(code);
            canvas.dataset.lastRobotAction = 'z-locked';
            canvas.dataset.lastRobotBlockedAction = ROBOT_CONTROL_ACTIONS[code];
            if (!event.repeat) {
              canvas.dataset.robotHeightLockBlockedCount = String(
                Number(canvas.dataset.robotHeightLockBlockedCount || 0) + 1,
              );
            }
          } else {
            canvas.dataset.lastRobotAction = ROBOT_CONTROL_ACTIONS[code];
          }
        } else if (KEYBOARD_ROTATION_ACTIONS[code]) {
          canvas.dataset.lastKeyboardRotation = KEYBOARD_ROTATION_ACTIONS[code];
        }
        if (KEYBOARD_VERTICAL_ACTIONS[code]) {
          canvas.dataset.lastKeyboardVertical = KEYBOARD_VERTICAL_ACTIONS[code];
        }
        canvas.dataset.keyboardInputCount = String(
          Number(canvas.dataset.keyboardInputCount || 0) + 1,
        );
      }
    };
    const onKeyUp = (event) => {
      const code = movementCodeForEvent(event);
      if (!code) return;
      pressedKeysRef.current.delete(code);
      if (robotControlEnabledRef.current && ROBOT_CONTROL_CODES.has(code)) {
        robotPoseActionsRef.current?.publish?.(true);
      }
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        const shiftStillPressed =
          pressedKeysRef.current.has('ShiftLeft')
          || pressedKeysRef.current.has('ShiftRight');
        const temporaryShiftPan = shiftStillPressed;
        setShiftPanArmed(temporaryShiftPan);
        const canvas = controlsRef.current?.domElement;
        if (canvas) {
          canvas.dataset.shiftPanArmed = temporaryShiftPan ? 'true' : 'false';
          canvas.dataset.effectiveInteractionMode = temporaryShiftPan
            ? 'shift-pan'
            : interactionModeRef.current;
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') resetKeys();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', resetKeys);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', resetKeys);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resetKeys(false);
    };
  }, [mapData?.geometry, updateRobotKeyboardControl]);

  useEffect(() => {
    const group = sliceGroupRef.current;
    if (!group) return;
    group.visible = showSlice;
    const canvas = controlsRef.current?.domElement;
    if (canvas) canvas.dataset.sliceVisible = String(group.visible);
  }, [showSlice, mapData?.geometry, mapData?.teachingSpaceMode]);

  useEffect(() => {
    const group = sliceGroupRef.current;
    const bounds = mapData?.geometry?.boundingBox;
    if (!group || !bounds) return;
    while (group.children.length) {
      const child = group.children.pop();
      disposeObject(child);
    }

    const size = new THREE.Vector3();
    bounds.getSize(size);
    const thickness = Math.max(heightRange[1] - heightRange[0], 0.015);
    const geometry = new THREE.BoxGeometry(size.x, size.y, thickness);
    const fill = new THREE.MeshBasicMaterial({
      color: 0x36cbd4,
      transparent: true,
      opacity: 0.035,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, fill);
    mesh.position.set(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (heightRange[0] + heightRange[1]) / 2,
    );
    group.add(mesh);

    const edgesGeometry = new THREE.EdgesGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x50dce6,
      transparent: true,
      opacity: 0.42,
    });
    const outline = new THREE.LineSegments(edgesGeometry, lineMaterial);
    outline.position.copy(mesh.position);
    group.add(outline);

    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.sliceMode = 'range';
      canvas.dataset.sliceGeometry = 'box';
      canvas.dataset.sliceMin = Number(heightRange[0]).toPrecision(10);
      canvas.dataset.sliceMax = Number(heightRange[1]).toPrecision(10);
      canvas.dataset.sliceSpan = Math.max(0, heightRange[1] - heightRange[0]).toPrecision(10);
    }
  }, [heightRange, mapData?.geometry]);

  useEffect(() => {
    const group = visionCoverageGroupRef.current;
    const displayGeometry = displayGeometryRef.current;
    const sourcePosition = mapData?.geometry?.getAttribute('position');
    if (!group || !displayGeometry || !sourcePosition) return undefined;
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      disposeObject(child);
    }

    const canvas = controlsRef.current?.domElement;
    const independent = teachingSpaceMode === 'independent';
    const records = independent
      ? visionCoveragePlaybackSelection.records
      : [];
    const preparedFrames = prepareTeachingVisionCoverageFrames(records);
    disposeTeachingSurfaceProjectionOverlay(surfaceCoverageProjectionRef.current);
    surfaceCoverageProjectionRef.current = null;
    const surfaceProjection = independent
      ? createTeachingSurfaceProjectionOverlay(
          surfaceGeometryRef.current?.geometry,
          preparedFrames,
          {
            color: 0x2df098,
            opacity: teachingSurfaceTintOpacityRef.current,
          },
        )
      : null;
    if (surfaceProjection && sceneRef.current) {
      surfaceProjection.mesh.visible = visionCoverageRenderingEnabledRef.current;
      sceneRef.current.add(surfaceProjection.mesh);
      surfaceCoverageProjectionRef.current = surfaceProjection;
    }
    const clearSurfaceProjection = () => {
      if (surfaceCoverageProjectionRef.current === surfaceProjection) {
        surfaceCoverageProjectionRef.current = null;
      }
      disposeTeachingSurfaceProjectionOverlay(surfaceProjection);
    };
    const poseIds = new Set();
    let frameCount = 0;
    let opticalPointCount = 0;
    let coordinateFrameCount = 0;
    let coordinateAxisCount = 0;
    let cellCount = 0;
    let hitCellCount = 0;
    let renderCellCount = 0;
    let omittedCellCount = 0;
    let minimumDepth = Number.POSITIVE_INFINITY;
    let maximumDepth = Number.NEGATIVE_INFINITY;

    preparedFrames.forEach((preparedFrame) => {
      const { record, grid } = preparedFrame;
      const volume = createTeachingVisionCoverageVolume(record, { grid });
      if (!volume) return;
      const coverage = volume.userData.coverage || {};
      group.add(volume);
      frameCount += 1;
      opticalPointCount += Number(coverage.opticalPointCount) || 0;
      coordinateFrameCount += Number(coverage.coordinateFrameCount) || 0;
      coordinateAxisCount += Number(coverage.coordinateAxisCount) || 0;
      cellCount += Number(coverage.sampleCellCount)
        || (Number(coverage.columns) || 0) * (Number(coverage.rows) || 0);
      hitCellCount += Number(coverage.surfaceCellCount) || 0;
      renderCellCount += Number(coverage.renderCellCount) || 0;
      omittedCellCount += Number(coverage.rangeLimitedCellCount) || 0;
      if (record.poseId) poseIds.add(record.poseId);
      if (Number.isFinite(coverage.minimumDepth)) {
        minimumDepth = Math.min(minimumDepth, coverage.minimumDepth);
      }
      if (Number.isFinite(coverage.maximumDepth)) {
        maximumDepth = Math.max(maximumDepth, coverage.maximumDepth);
      }
    });

    const nextStats = {
      poseCount: poseIds.size,
      frameCount,
      opticalPointCount,
      coordinateFrameCount,
      coordinateAxisCount,
      cellCount,
      hitCellCount,
      renderCellCount,
      omittedCellCount,
      minimumDepth: Number.isFinite(minimumDepth) ? minimumDepth : null,
      maximumDepth: Number.isFinite(maximumDepth) ? maximumDepth : null,
    };
    setVisionCoverageStats((current) => (
      current.poseCount === nextStats.poseCount
      && current.frameCount === nextStats.frameCount
      && current.opticalPointCount === nextStats.opticalPointCount
      && current.coordinateFrameCount === nextStats.coordinateFrameCount
      && current.coordinateAxisCount === nextStats.coordinateAxisCount
      && current.cellCount === nextStats.cellCount
      && current.hitCellCount === nextStats.hitCellCount
      && current.renderCellCount === nextStats.renderCellCount
      && current.omittedCellCount === nextStats.omittedCellCount
      && current.minimumDepth === nextStats.minimumDepth
      && current.maximumDepth === nextStats.maximumDepth
        ? current
        : nextStats
    ));

    const opticalPoseSignature = preparedFrames.map(({ record }) => {
      const opticalPose = record?.frame?.opticalPose;
      const components = [
        opticalPose?.position?.x,
        opticalPose?.position?.y,
        opticalPose?.position?.z,
        opticalPose?.quaternion?.x,
        opticalPose?.quaternion?.y,
        opticalPose?.quaternion?.z,
        opticalPose?.quaternion?.w,
      ].map((value, index) => {
        const numericValue = Number(value);
        const fallback = index === 6 ? 1 : 0;
        return (Number.isFinite(numericValue) ? numericValue : fallback).toFixed(8);
      });
      return `${record?.key || record?.side || 'camera'}:${components.join(',')}`;
    }).join('|');

    if (canvas) {
      const waitingForPlaybackPose = Boolean(
        visionCoveragePlaybackSelection.progressive
        && visionCoveragePlaybackSelection.availableFrameCount > 0
        && !frameCount,
      );
      canvas.dataset.visionCoverageState = frameCount
        ? 'visible'
        : independent
          ? waitingForPlaybackPose ? 'waiting' : 'empty'
          : 'hidden';
      canvas.dataset.visionCoverageMode = VISION_COVERAGE_MODE;
      canvas.dataset.visionCoverageSurfaceStop = VISION_COVERAGE_SURFACE_STOP;
      canvas.dataset.visionCoverageEmptyCellMode = VISION_COVERAGE_EMPTY_CELL_MODE;
      canvas.dataset.visionCoverageVisualMode = 'continuous-volume';
      canvas.dataset.visionCoverageOutlineMode = 'outer-silhouette';
      canvas.dataset.visionCoverageInternalRays = 'false';
      canvas.dataset.visionCoverageIndependentOnly = 'true';
      canvas.dataset.visionCoverageInfinite = 'false';
      canvas.dataset.visionCoveragePoseCount = String(nextStats.poseCount);
      canvas.dataset.visionCoverageFrameCount = String(frameCount);
      canvas.dataset.visionCoverageOpticalPointCount = String(opticalPointCount);
      canvas.dataset.visionCoverageCoordinateFrameCount = String(coordinateFrameCount);
      canvas.dataset.visionCoverageCoordinateAxisCount = String(coordinateAxisCount);
      canvas.dataset.visionCoverageRetentionMode = 'captured-pose-static';
      canvas.dataset.visionCoverageOpticalPoseSignature = opticalPoseSignature;
      canvas.dataset.visionCoverageCellCount = String(cellCount);
      canvas.dataset.visionCoverageHitCellCount = String(hitCellCount);
      canvas.dataset.visionCoverageRenderCellCount = String(renderCellCount);
      canvas.dataset.visionCoverageOmittedCellCount = String(omittedCellCount);
      canvas.dataset.visionCoverageMinimumDepth = nextStats.minimumDepth?.toFixed(6) || '';
      canvas.dataset.visionCoverageMaximumDepth = nextStats.maximumDepth?.toFixed(6) || '';
      canvas.dataset.visionCoverageGenerationMode = visionCoveragePlaybackSelection.mode;
      canvas.dataset.visionCoveragePlaybackTask = visionCoveragePlaybackSelection.taskId;
      canvas.dataset.visionCoverageAvailablePoseCount = String(
        visionCoveragePlaybackSelection.availablePoseCount,
      );
      canvas.dataset.visionCoverageAvailableFrameCount = String(
        visionCoveragePlaybackSelection.availableFrameCount,
      );
      canvas.dataset.visionCoverageReachedPoseCount = String(
        visionCoveragePlaybackSelection.reachedPoseCount,
      );
      canvas.dataset.visionCoveragePlaybackPoseCount = String(
        visionCoveragePlaybackSelection.playbackPoseCount,
      );
    }

    const coverageAttributes = [...new Set([
      displayGeometry.getAttribute(TEACHING_SURFACE_COVERAGE_ATTRIBUTE),
      surfaceGeometryRef.current?.geometry?.getAttribute(
        TEACHING_SURFACE_COVERAGE_ATTRIBUTE,
      ),
    ].filter(Boolean))];
    const commitSurfaceMask = (mask) => {
      coverageAttributes.forEach((attribute) => {
        if (attribute.array.length !== mask.length) return;
        attribute.array.set(mask);
        attribute.needsUpdate = true;
      });
    };
    const updateSurfaceTintStats = (nextTintStats) => {
      setTeachingSurfaceTintStats((current) => (
        current.status === nextTintStats.status
        && current.coveredPointCount === nextTintStats.coveredPointCount
        && current.totalPointCount === nextTintStats.totalPointCount
          ? current
          : nextTintStats
      ));
      if (!canvas) return;
      canvas.dataset.teachingSurfaceTintState = nextTintStats.status;
      canvas.dataset.teachingSurfaceTintCoveredPointCount = String(
        nextTintStats.coveredPointCount,
      );
      canvas.dataset.teachingSurfaceTintTotalPointCount = String(
        nextTintStats.totalPointCount,
      );
      canvas.dataset.teachingSurfaceTintOverlapMode = 'binary-union';
      canvas.dataset.teachingSurfaceTintMaximumWeight = '1';
      canvas.dataset.teachingSurfaceTintCameraIsolation = 'main-view-only';
      canvas.dataset.teachingSurfaceTintProjectionMode = TEACHING_SURFACE_PROJECTION_MODE;
      canvas.dataset.teachingSurfaceTintRasterization = surfaceProjection
        ? 'per-fragment-depth-atlas+vertex-points'
        : 'vertex-points';
      canvas.dataset.teachingSurfaceTintMeshProjection = surfaceProjection
        ? 'active'
        : 'unavailable';
      canvas.dataset.teachingSurfaceTintColor = '#2df098';
      canvas.dataset.teachingSurfaceTintOpacity = String(
        teachingSurfaceTintOpacityRef.current,
      );
    };

    const totalPointCount = sourcePosition.count;
    if (!independent || !preparedFrames.length || !coverageAttributes.length) {
      commitSurfaceMask(new Float32Array(totalPointCount));
      updateSurfaceTintStats({
        status: independent ? 'empty' : 'hidden',
        coveredPointCount: 0,
        totalPointCount,
      });
      if (canvas) canvas.dataset.teachingSurfaceTintProgress = '1';
      return clearSurfaceProjection;
    }

    let cancelled = false;
    let scheduledWork = null;
    let cursor = 0;
    let coveredPointCount = 0;
    const mask = new Float32Array(totalPointCount);
    const surfaceTintChunkSize = Math.max(
      2_000,
      Math.floor(
        TEACHING_SURFACE_TINT_CHUNK_SIZE
        / Math.max(1, preparedFrames.length / 2),
      ),
    );
    updateSurfaceTintStats({
      status: 'computing',
      coveredPointCount: 0,
      totalPointCount,
    });
    if (canvas) canvas.dataset.teachingSurfaceTintProgress = '0';

    const cancelScheduledWork = () => {
      if (!scheduledWork) return;
      if (scheduledWork.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(scheduledWork.id);
      } else {
        window.cancelAnimationFrame(scheduledWork.id);
      }
      scheduledWork = null;
    };
    const scheduleWork = (callback) => {
      if (typeof window.requestIdleCallback === 'function') {
        scheduledWork = {
          type: 'idle',
          id: window.requestIdleCallback(callback, { timeout: 80 }),
        };
      } else {
        scheduledWork = {
          type: 'frame',
          id: window.requestAnimationFrame(() => callback({
            didTimeout: true,
            timeRemaining: () => 0,
          })),
        };
      }
    };
    const processSurfaceTintChunk = (deadline) => {
      scheduledWork = null;
      if (cancelled) return;
      const startedAt = performance.now();
      do {
        const nextCursor = Math.min(
          totalPointCount,
          cursor + surfaceTintChunkSize,
        );
        coveredPointCount += markTeachingSurfaceCoverageRange(
          sourcePosition,
          preparedFrames,
          mask,
          cursor,
          nextCursor,
        );
        cursor = nextCursor;
      } while (
        cursor < totalPointCount
        && deadline?.timeRemaining?.() > 3
        && performance.now() - startedAt < 12
      );

      if (canvas) {
        canvas.dataset.teachingSurfaceTintProgress = String(
          totalPointCount ? cursor / totalPointCount : 1,
        );
      }
      if (cursor < totalPointCount) {
        scheduleWork(processSurfaceTintChunk);
        return;
      }

      commitSurfaceMask(mask);
      updateSurfaceTintStats({
        status: coveredPointCount || surfaceProjection ? 'visible' : 'empty',
        coveredPointCount,
        totalPointCount,
      });
      if (canvas) canvas.dataset.teachingSurfaceTintProgress = '1';
    };
    scheduleWork(processSurfaceTintChunk);

    return () => {
      cancelled = true;
      cancelScheduledWork();
      clearSurfaceProjection();
    };
  }, [mapData?.geometry, teachingSpaceMode, visionCoveragePlaybackSelection]);

  useEffect(() => {
    const enabled = visionCoverageRenderingEnabled;
    const group = visionCoverageGroupRef.current;
    const surfaceProjection = surfaceCoverageProjectionRef.current;
    const canvas = controlsRef.current?.domElement;
    const tintOpacity = THREE.MathUtils.clamp(teachingSurfaceTintOpacity, 0, 1);

    if (group) group.visible = enabled;
    if (surfaceProjection?.mesh) surfaceProjection.mesh.visible = enabled;
    const projectionOpacityUniform = surfaceProjection?.material
      ?.uniforms?.atlasCoverageOpacity;
    if (projectionOpacityUniform) projectionOpacityUniform.value = tintOpacity;

    [cloudMaterialRef.current, meshMaterialRef.current]
      .filter(Boolean)
      .forEach((material) => {
        material.userData.teachingTintVisibility = enabled ? 1 : 0;
        material.userData.teachingTintOpacity = tintOpacity;
        const visibilityUniform = material.userData.mapColorShader
          ?.uniforms?.atlasTeachingTintVisibility;
        const opacityUniform = material.userData.mapColorShader
          ?.uniforms?.atlasTeachingTintOpacity;
        if (visibilityUniform) visibilityUniform.value = enabled ? 1 : 0;
        if (opacityUniform) opacityUniform.value = tintOpacity;
      });

    if (canvas) {
      const hasFrames = visionCoverageStats.frameCount > 0;
      const waitingForPlaybackPose = Boolean(
        visionCoveragePlaybackSelection.progressive
        && visionCoveragePlaybackSelection.availableFrameCount > 0
        && !hasFrames,
      );
      canvas.dataset.visionCoverageRenderEnabled = enabled ? 'true' : 'false';
      canvas.dataset.visionCoverageRenderState = enabled ? 'enabled' : 'disabled';
      canvas.dataset.teachingSurfaceTintRenderEnabled = enabled ? 'true' : 'false';
      canvas.dataset.teachingSurfaceTintOpacity = String(tintOpacity);
      canvas.dataset.teachingSurfaceTintOpacityPercent = String(
        Math.round(tintOpacity * 100),
      );
      canvas.dataset.visionCoveragePlaybackStatus = visionCoveragePlaybackSelection.progressive
        ? visionCoveragePlaybackStatus
        : 'idle';
      canvas.dataset.visionCoverageState = teachingSpaceMode === 'independent'
        ? hasFrames
          ? enabled ? 'visible' : 'disabled'
          : waitingForPlaybackPose
            ? enabled ? 'waiting' : 'disabled'
            : 'empty'
        : 'hidden';
    }
  }, [
    mapData?.geometry,
    teachingSpaceMode,
    visionCoveragePlaybackSelection,
    visionCoveragePlaybackStatus,
    visionCoverageRenderingEnabled,
    visionCoverageStats.frameCount,
    teachingSurfaceTintOpacity,
  ]);

  useEffect(() => {
    const group = routeGroupRef.current;
    const waypointGroup = waypointGroupRef.current;
    const sphere = mapData?.geometry?.boundingSphere;
    if (!group || !waypointGroup || !sphere) return;
    while (group.children.length) {
      const child = group.children.pop();
      disposeObject(child);
    }
    while (waypointGroup.children.length) {
      const child = waypointGroup.children.pop();
      disposeObject(child);
    }
    selectedWaypointPulseRef.current = null;

    const pointById = new Map(waypoints.map((point) => [point.id, point]));
    const edgeKeys = new Set(edges.map((edge) => JSON.stringify([edge.from, edge.to])));
    const routeScale = Math.max(sphere.radius * 0.006, 0.12);
    const waypointRadius = routeScale * WAYPOINT_RADIUS_SCALE;
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.waypointCount = String(waypoints.length);
      canvas.dataset.waypointVolumeRatio = String(WAYPOINT_VOLUME_RATIO);
      canvas.dataset.waypointRadiusScale = WAYPOINT_RADIUS_SCALE.toFixed(6);
      canvas.dataset.waypointHitRadiusScale = WAYPOINT_HIT_RADIUS_SCALE.toFixed(6);
      canvas.dataset.waypointRadius = waypointRadius.toPrecision(8);
      canvas.dataset.waypointVisibilityMode = 'screen-clamped-lod';
      canvas.dataset.minimumWaypointScreenDiameter = String(MIN_WAYPOINT_SCREEN_DIAMETER);
      canvas.dataset.maximumWaypointScreenDiameter = String(MAX_WAYPOINT_SCREEN_DIAMETER);
    }

    edges.forEach((edge) => {
      const source = pointById.get(edge.from);
      const target = pointById.get(edge.to);
      if (!source || !target) return;
      const start = new THREE.Vector3(
        source.pose.x,
        source.pose.y,
        source.pose.z + routeScale * 0.25,
      );
      const end = new THREE.Vector3(
        target.pose.x,
        target.pose.y,
        target.pose.z + routeScale * 0.25,
      );
      const direction = end.clone().sub(start);
      const fullLength = direction.length();
      if (fullLength < 0.001) return;
      direction.normalize();
      const hasReverse = edgeKeys.has(JSON.stringify([edge.to, edge.from]));
      const inset = Math.min(waypointRadius * 1.6, fullLength * 0.2);
      // Share the same centerline, with an independently selectable half for
      // each direction and arrow tips outside the waypoint markers.
      start.addScaledVector(
        direction,
        hasReverse && edge.directed !== false ? fullLength / 2 : inset,
      );
      end.addScaledVector(direction, -inset);
      const length = start.distanceTo(end);
      const selected = edge.id === selectedEdgeId;
      const edgeGroup = new THREE.Group();
      const arrow = new THREE.ArrowHelper(
        direction,
        start,
        length,
        statusColor(edge.status, selected),
        Math.min(routeScale * 2.1, length * 0.24),
        routeScale * 0.72,
      );
      const hitGeometry = new THREE.CylinderGeometry(
        Math.max(routeScale * 0.55, waypointRadius * 0.9),
        Math.max(routeScale * 0.55, waypointRadius * 0.9),
        length,
        8,
        1,
        true,
      );
      const hitMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
        side: THREE.DoubleSide,
      });
      const hitTarget = new THREE.Mesh(hitGeometry, hitMaterial);
      hitTarget.position.copy(start).addScaledVector(direction, length / 2);
      hitTarget.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      edgeGroup.add(arrow, hitTarget);
      if (edge.directed === false) {
        edgeGroup.add(new THREE.ArrowHelper(
          direction.clone().negate(),
          end,
          length,
          statusColor(edge.status, selected),
          Math.min(routeScale * 2.1, length * 0.24),
          routeScale * 0.72,
        ));
      }
      tagSelectionTarget(edgeGroup, 'edge', edge.id);
      group.add(edgeGroup);
    });

    waypoints.forEach((point) => {
      const selected = point.id === selectedWaypointId;
      const markerGroup = new THREE.Group();
      markerGroup.userData.baseRadius = waypointRadius;
      const markerGeometry = new THREE.SphereGeometry(
        waypointRadius,
        16,
        12,
      );
      const markerMaterial = new THREE.MeshBasicMaterial({
        color: selected ? WAYPOINT_SELECTED_BODY_COLOR : WAYPOINT_DEFAULT_COLOR,
        depthTest: false,
      });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.renderOrder = 10;
      if (selected) {
        const haloGeometry = new THREE.SphereGeometry(waypointRadius * 1.25, 18, 12);
        const haloMaterial = new THREE.MeshBasicMaterial({
          color: WAYPOINT_SELECTED_HALO_COLOR,
          transparent: true,
          opacity: 0.36,
          wireframe: true,
          depthTest: false,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(haloGeometry, haloMaterial);
        halo.renderOrder = 9;
        markerGroup.add(halo);
        selectedWaypointPulseRef.current = halo;
      }
      const hitGeometry = new THREE.SphereGeometry(
        Math.max(routeScale * WAYPOINT_HIT_RADIUS_SCALE, routeScale * 0.9),
        10,
        8,
      );
      const hitMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      });
      const hitTarget = new THREE.Mesh(hitGeometry, hitMaterial);
      markerGroup.position.set(point.pose.x, point.pose.y, point.pose.z);
      markerGroup.add(marker, hitTarget);
      tagSelectionTarget(markerGroup, 'waypoint', point.id);
      waypointGroup.add(markerGroup);
    });
    if (canvas) {
      canvas.dataset.routeEdgeCount = String(group.children.length);
      canvas.dataset.renderedWaypointCount = String(waypointGroup.children.length);
      canvas.dataset.selectedWaypointPulseState = selectedWaypointId ? 'active' : 'idle';
      canvas.dataset.selectedWaypointBodyColor = WAYPOINT_SELECTED_BODY_COLOR;
      canvas.dataset.selectedWaypointHaloColor = WAYPOINT_SELECTED_HALO_COLOR;
    }
  }, [edges, mapData?.geometry, selectedEdgeId, selectedWaypointId, waypoints]);

  useEffect(() => {
    const group = routeGroupRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!group || !canvas) return;
    group.visible = showPaths;
    canvas.dataset.pathsVisible = String(showPaths);
  }, [mapData?.geometry, showPaths]);

  useEffect(() => {
    const waypointGroup = waypointGroupRef.current;
    const canvas = controlsRef.current?.domElement;
    if (!waypointGroup || !canvas) return;
    const visible = showParkingPoints && showWaypoints;
    waypointGroup.visible = visible;
    canvas.dataset.parkingPointsVisible = String(showParkingPoints);
    canvas.dataset.waypointsVisible = String(visible);
    canvas.dataset.waypointVisualStatus = visible
      ? waypointGroup.children.length ? 'visible' : 'no-waypoints'
      : 'hidden-by-user';
  }, [mapData?.geometry, showParkingPoints, showWaypoints, waypoints.length]);

  const focusOrigin = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;
    precisionPanRef.current?.clear?.();
    const offset = camera.position.clone().sub(controls.target);
    controls.target.set(0, 0, 0);
    camera.position.copy(offset);
    controls.update();
  };

  const focusMapOrigin = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const mapOrigin = mapOriginGroupRef.current;
    if (!controls || !camera || !mapOrigin || !mapData?.geometry?.boundingBox) return;
    if (focusAnimationRef.current) {
      cancelAnimationFrame(focusAnimationRef.current);
      focusAnimationRef.current = null;
    }
    // Frame both coordinate origins and the independent model without moving
    // any source geometry or changing the default/reset view.
    const sphere = mapData.geometry.boundingBox.clone()
      .expandByPoint(new THREE.Vector3()).expandByPoint(mapOrigin.position)
      .getBoundingSphere(new THREE.Sphere());
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const limitingHalfFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
    const distance = Math.max(sphere.radius, 1) / Math.sin(limitingHalfFov) * 1.3;
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(-0.55, -0.8, 0.42);
    precisionPanRef.current?.clear?.();
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction.normalize(), distance);
    controls.update();
  };

  const focusRobot = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const robot = robotLayerRef.current;
    if (!controls || !camera || !robot?.children.length) return;
    const sphere = setRobotVisualBounds(new THREE.Box3(), robot)
      .getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
    precisionPanRef.current?.clear?.();
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(-0.55, -0.8, 0.42);
    direction.normalize();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 2.85);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.update();
  };

  const setRobotControlMode = (enabled) => {
    if (!showRobotRef.current || robotTrajectoryActiveRef.current || teachingPoseEditingRef.current) return;
    if (robotLoadState?.status !== 'loaded' || !robotDescriptor) return;
    if (enabled) focusRobot();
    updateRobotKeyboardControl(enabled, true);
    onRobotControlChangeRef.current?.(enabled);
  };

  robotControlInteractionRef.current = {
    enter: () => setRobotControlMode(true),
  };

  const toggleInteractionMode = () => {
    const nextMode = interactionModeRef.current === 'pan' ? 'rotate' : 'pan';
    if (nextMode === 'pan' && chassisDragModeRef.current) {
      chassisDragInteractionRef.current?.exit?.('viewport-pan-mode');
    }
    interactionModeRef.current = nextMode;
    setInteractionMode(nextMode);
    const canvas = controlsRef.current?.domElement;
    if (canvas) {
      canvas.dataset.interactionMode = nextMode;
      canvas.dataset.interactionModeSource = nextMode === 'pan'
        ? 'toolbar-toggle'
        : 'default';
      canvas.dataset.effectiveInteractionMode = shiftPanArmed ? 'shift-pan' : nextMode;
      canvas.dataset.lastInteractionModeAction = `toolbar:${nextMode}`;
      canvas.focus({ preventScroll: true });
    }
  };

  const resetView = () => viewActionsRef.current?.reset?.();
  const robotControlActive = Boolean(
    showRobot && robotControlEnabled
    && isActive
    && !robotTrajectoryActive
    && !teachingPoseEditing
    && robotDescriptor
    && robotLoadState?.status === 'loaded',
  );
  const robotHeightLockActive = Boolean(
    robotHeightLocked
    && robotDescriptor
    && robotLoadState?.status === 'loaded'
  );
  const displayedRobotPose = normalizeRobotPose(robotPose);
  const robotParkingGhostVisible = Boolean(
    showRobot && robotParkingGhost
    && robotDescriptor
    && robotLoadState?.status === 'loaded',
  );
  const robotParkingGhostMetrics = robotParkingGhostVisible
    ? measureRobotParkingGhost(displayedRobotPose, robotParkingGhost.targetPose)
    : null;
  const endEffectorControlActive = Boolean(endEffectorControl);
  const mapLockedSides = ['left', 'right'].filter(
    (side) => endEffectorLockModesState[side] === 'map',
  );
  const mapLockSideLabel = mapLockedSides
    .map((side) => side === 'left' ? 'L' : 'R')
    .join('+');
  const persistentPanMode = interactionMode === 'pan';
  const temporaryShiftPan = shiftPanArmed && !persistentPanMode;
  const effectiveViewportPan = persistentPanMode || shiftPanArmed;
  const collisionStatusState = robotCollisionStatus?.state || 'disabled';
  const collisionDistanceMillimeters = Number.isFinite(robotCollisionStatus?.minimumDistance)
    ? Math.max(0, robotCollisionStatus.minimumDistance * 1000)
    : null;
  const collisionControlReady = Boolean(
    robotDescriptor && robotLoadState?.status === 'loaded',
  );
  const collisionButtonState = collisionProtectionEnabled
    ? collisionStatusState
    : 'disabled';
  const collisionButtonLabel = collisionProtectionEnabled
    ? {
        building: '建立索引',
        waiting: '等待检测',
        safe: '保护开启',
        near: '距离过近',
        collision: '环境干涉',
        error: '检测异常',
        excluded: '已全部忽略',
      }[collisionStatusState] || '保护开启'
    : '碰撞保护';
  const collisionDistanceLabel = !collisionProtectionEnabled ? '检测关闭'
    : ['building', 'waiting', 'error', 'excluded'].includes(collisionStatusState)
    ? { building: '检测中', waiting: '等待检测', error: '检测异常', excluded: '已全部忽略' }[collisionStatusState]
    : collisionDistanceMillimeters !== null
      ? `${collisionDistanceMillimeters.toFixed(0)} mm`
      : collisionStatusState === 'safe'
        ? `≥${ROBOT_COLLISION_SAFETY_DISTANCE * 1000} mm`
        : '— mm';
  const canShowSurfaceCoverage = teachingSpaceMode === 'independent' && teachingDevice === 'desktop';
  const showVisionCoverageControls = teachingSpaceMode === 'independent' && (
    visionCoverageStats.frameCount > 0
    || (
      visionCoveragePlaybackSelection.progressive
      && visionCoveragePlaybackSelection.availableFrameCount > 0
    )
  );

  const mouseHelp = temporaryShiftPan
    ? 'Shift + 左键平移 · 松开恢复旋转'
    : persistentPanMode
      ? '左键平移 · 点击“平移”切回旋转'
      : chassisDragMode
        ? '按住底盘拖拽 · 保持 Z / RPY'
        : '左键旋转 · 点 / 路径可选';
  const keyboardHelp = endEffectorControlActive
    ? `Ctrl+Z 撤销拖拽 · Esc 取消${endEffectorControl.side === 'torso' ? '躯干' : '末端'}调整`
    : chassisDragMode
    ? 'Ctrl+Z 撤销最近一次拖拽'
    : robotControlActive
    ? robotHeightLockActive
      ? 'W/S 前后 · A/D 麦轮横移 · ←→ 旋转 · Z 高度已锁'
      : 'W/S 前后 · A/D 麦轮横移 · ←→ 旋转 · ↑↓ 高度'
    : 'WASD 平移 · Q/E 升降 · ←→ Yaw · ↑↓ Pitch';
  const navigationHelp = endEffectorControlActive
    ? endEffectorControl.side === 'torso'
      ? '胸甲高度 / YAW / PITCH · 躯干关节联动'
      : endEffectorControl.locked
      ? endEffectorControl.lockMode === 'map'
        ? '地图绝对姿态锁定 · 底盘移动时全链 IK 补偿'
        : '本体关节姿态锁定 · 双击另一末端继续调整'
      : '空间球拖拽 XYZ / RPY · 面板支持精确输入'
    : chassisDragMode
      ? 'Esc 退出拖拽 · 双击底盘启用 WASD'
    : robotControlActive
    ? mapLockedSides.length
      ? `全局锁定 ${mapLockSideLabel} · 移动底盘观察全链关节补偿`
      : 'Shift + 左键视角平移 · Q/E 视角升降'
    : 'Shift + 左键临时平移 · 右键平移';
  const geometryHelp = hasEmbeddedMesh
    ? `内嵌网格 ${formatPointCount(meshInfo.faceCount)} 面 · 档位仅调整未成面点`
    : resolutionSelection === 'auto'
      ? '点数超限 · 已自动降采样'
      : '分辨率仅影响 3D 显示';
  const robotHelp = robotLoadState?.status === 'loaded' && !endEffectorControlActive && !chassisDragMode
    ? '双击底盘启用 WASD · 双击胸甲联动躯干 · 双击末端进入 6D 控制' : '';

  return (
    <div
      className={`point-cloud-view ${shiftPanArmed ? 'is-shift-pan-armed' : ''} ${effectiveViewportPan ? 'is-viewport-pan-mode' : ''} ${persistentPanMode ? 'is-persistent-pan-mode' : ''} ${robotControlActive ? 'is-robot-driving' : ''} ${endEffectorControlActive ? 'is-end-effector-control' : ''} ${chassisDragMode ? 'is-chassis-drag-mode' : ''} ${chassisDragging ? 'is-chassis-dragging' : ''} ${robotTrajectoryActive ? 'is-teaching-trajectory-active' : ''} ${robotParkingGhostVisible ? 'is-parking-ghost-visible' : ''} ${visionCoverageRenderingEnabled && visionCoverageStats.frameCount ? 'is-vision-coverage-active' : ''} ${visionCoverageRenderingEnabled && teachingSurfaceTintStats.status === 'visible' ? 'is-teaching-surface-tinted' : ''}`}
      ref={mountRef}
      data-teaching-space-mode={teachingSpaceMode}
      data-robot-trajectory-active={robotTrajectoryActive ? 'true' : 'false'}
      data-parking-ghost-state={robotParkingGhostVisible ? 'visible' : 'hidden'}
      data-parking-ghost-target={robotParkingGhost?.parkingPointId || ''}
      data-parking-ghost-planar-distance={robotParkingGhostMetrics?.planarDistance.toFixed(6) || ''}
      data-parking-ghost-straight-distance={robotParkingGhostMetrics?.straightDistance.toFixed(6) || ''}
    >
      {!mapData?.geometry && (
        <div className="viewer-placeholder">
          <div className="placeholder-orbit">
            <Box size={34} strokeWidth={1.3} />
          </div>
          <strong>等待点云地图</strong>
          <span>加载 PLY 文件后，这里会生成可旋转、缩放和平移的三维场景</span>
        </div>
      )}
      {mapData?.geometry && (
        <>
          <PolylineTeachingPanel key={`${resolutionMapKey}-${robotDescriptor?.id || ''}`}
            open={polylineOpen} active={isActive && !externalRobotTrajectoryActive && robotLoadState?.status === 'loaded'}
            container={polylineContainer}
            getContext={getPolylineContext} sceneRevision={mapData.geometry.uuid}
            savedPaths={teachingTasks.flatMap((task) => (task.polylines || []).map((path) => ({ taskId: task.id, taskName: task.name, path })))}
            onSave={onSavePolyline} onDelete={onDeletePolyline} onClose={() => onPolylineOpenChange?.(false)}
            openRequest={pendingPolylineRequest} onRequestHandled={onPolylineRequestHandled}
            onSuggestionChange={setPolylineSuggestion} showRobot={showRobot}
            onBusyChange={onPolylineBusyChange || (() => {})} />
          {canShowSurfaceCoverage && showSurfaceCoverage && (
            <TeachingSurfaceCoverage geometry={mapData.geometry} tasks={teachingTasks} />
          )}
          {teachingSpaceMode === 'independent' && mapOriginPose && (
            <div className="coordinate-reference-layer" role="group" aria-label="地图坐标原点参考">
              <span ref={mapOriginLabelRef} className="map-origin-label">地图原点 · (0, 0, 0)</span>
            </div>
          )}
          {showPaths && showPathNames && (
            <div className="path-name-layer" role="group" aria-label="3D路径名称">
              {pathLabels.map(({ id, name, pose }) => (
                <span
                  key={id}
                  ref={(element) => {
                    if (element) pathNameElementsRef.current.set(id, { element, pose });
                    else pathNameElementsRef.current.delete(id);
                  }}
                  className={`path-name-label${id === selectedEdgeId ? ' is-selected' : ''}`}
                  data-edge-id={id}
                >
                  {name}
                </span>
              ))}
            </div>
          )}
          {showParkingPoints && showWaypointNames && (
            <div className="waypoint-name-layer" role="group" aria-label="3D停车点名称">
              {waypointLabels.map(({ point, waypointIds }) => (
                <span
                  key={point.id}
                  ref={(element) => {
                    if (element) {
                      waypointNameElementsRef.current.set(point.id, { element, pose: point.pose });
                    } else {
                      waypointNameElementsRef.current.delete(point.id);
                    }
                  }}
                  className={`waypoint-name-label${waypointIds.includes(selectedWaypointId) ? ' is-selected' : ''}`}
                  data-waypoint-id={point.id}
                  data-waypoint-ids={JSON.stringify(waypointIds)}
                >
                  {point.name || point.id}
                </span>
              ))}
            </div>
          )}
          {showDistanceWarnings && collisionProtectionEnabled && (
            <RobotDistanceWarning status={robotCollisionStatus} />
          )}
          <div
            ref={spaceMouseAxisHudRef}
            className="spacemouse-axis-hud"
            data-axis="x"
            data-state="hidden"
            aria-label="SpaceMouse 当前控制轴"
            aria-hidden="true"
          >
            <small data-axis-group>XYZ / SINGLE AXIS</small>
            <strong data-axis-code>X</strong>
            <span data-axis-label>前进 / 后退</span>
          </div>
          {robotParkingGhostVisible && robotParkingGhostMetrics && robotParkingGhost.showReadout !== false && (
            <aside
              className="robot-parking-ghost-readout"
              role="status"
              aria-live="polite"
              aria-label={robotParkingGhost.kind === 'mobile-solve' ? '计算姿态机器人虚影' : '停车点机器人虚影'}
              data-parking-point-id={robotParkingGhost.parkingPointId}
              data-pose-id={robotParkingGhost.poseId || ''}
              data-parking-edit-state={robotParkingGhost.editing && !robotParkingGhost.poseId ? 'editing' : 'idle'}
              data-pose-edit-state={teachingPoseEditing ? 'editing' : 'idle'}
              aria-busy={teachingPoseEditing && teachingCaptureBusy}
              data-frozen-joint-count={Object.keys(robotParkingGhost.jointValues || {}).length}
            >
              <span className="robot-parking-ghost-readout__mark" aria-hidden="true">
                <Bot size={16} />
                <MapPin size={10} />
              </span>
              <div className="robot-parking-ghost-readout__body">
                <small>{robotParkingGhost.kind === 'mobile-solve' ? 'ROBOT GHOST · COMPUTED POSE' : 'ROBOT GHOST · MAP COMPARISON'}</small>
                <strong>
                  <span>{robotParkingGhost.sourceName || '当前机器人'}</span>
                  <i>→</i>
                  <span>{robotParkingGhost.parkingPointName || '目标停车点'}</span>
                  {robotParkingGhost.poseId && (
                    <span className="robot-parking-ghost-readout__pose" title={robotParkingGhost.poseName}>
                      姿态 · {robotParkingGhost.poseName}
                    </span>
                  )}
                </strong>
                <div className="robot-parking-ghost-readout__metrics">
                  <span><Ruler size={10} /><small>XY 平面</small><b>{robotParkingGhostMetrics.planarDistance.toFixed(2)} m</b></span>
                  <span><small>3D 直线</small><b>{robotParkingGhostMetrics.straightDistance.toFixed(2)} m</b></span>
                  <span><small>ΔZ</small><b>{robotParkingGhostMetrics.deltaZ >= 0 ? '+' : ''}{robotParkingGhostMetrics.deltaZ.toFixed(2)} m</b></span>
                </div>
                <em>{robotParkingGhost.editing
                  ? robotParkingGhost.poseId
                    ? '调整关节 · 确认修改保存 · Esc 取消'
                    : 'WASD 移动 · ←/→ 转向 · Esc 取消修改'
                  : robotParkingGhost.kind === 'mobile-solve'
                    ? `${robotParkingGhost.side === 'left' ? '左臂' : '右臂'}可达 · 在进度面板回看已计算姿态`
                    : `${Object.keys(robotParkingGhost.jointValues || {}).length} JOINTS FROZEN · 虚影不改变当前机器人`}</em>
              </div>
              <div className="robot-parking-ghost-readout__actions">
                {robotParkingGhost.kind !== 'mobile-solve' && <>
                {robotParkingGhost.poseId && (
                  <button
                    type="button"
                    className="robot-parking-ghost-readout__edit"
                    aria-pressed={teachingPoseEditing}
                    title={teachingPoseEditing
                      ? '保存当前关节姿态并更新双目快照，保持所属停车点不变'
                      : '恢复所选姿态并打开关节控制，保留原姿态虚影；Esc 取消修改'}
                    disabled={teachingCaptureBusy || (teachingPoseEditing ? !onConfirmTeachingPose : !onEditTeachingPose)}
                    onClick={() => {
                      updateRobotKeyboardControl(false);
                      chassisDragInteractionRef.current?.exit?.('teaching-pose-edit');
                      if (endEffectorControlRef.current) endEffectorInteractionRef.current?.exit?.();
                      if (teachingPoseEditing) {
                        reportRobotJointValues(true);
                        const cameraPoses = reportZividCameraPoses(true);
                        onConfirmTeachingPose?.({
                          taskId: robotParkingGhost.taskId,
                          parkingPointId: robotParkingGhost.parkingPointId,
                          replacePoseId: robotParkingGhost.poseId,
                          jointValues: { ...robotJointValuesRef.current },
                          cameraPoses,
                        });
                      } else {
                        onEditTeachingPose?.(
                          robotParkingGhost.taskId,
                          robotParkingGhost.parkingPointId,
                          robotParkingGhost.poseId,
                        );
                      }
                    }}
                  >
                    {teachingPoseEditing ? <Save size={12} /> : <SlidersHorizontal size={12} />}
                    {teachingPoseEditing ? '确认修改' : '调整姿态'}
                  </button>
                )}
                {!robotParkingGhost.poseId && (
                  <button
                    type="button"
                    className="robot-parking-ghost-readout__edit"
                    aria-pressed={Boolean(robotParkingGhost.editing)}
                    title={robotParkingGhost.editing
                      ? '将当前底盘位姿录入该停车点，并同步所属姿态的基座位置'
                      : '启用机器人键盘控制调整停车位置，保留原位置虚影；Esc 取消修改'}
                    disabled={robotParkingGhost.editing ? !onRecordParkingPointPosition : !onEditParkingPoint}
                    onClick={() => {
                      if (robotParkingGhost.editing) {
                        updateRobotKeyboardControl(false);
                        chassisDragInteractionRef.current?.cancel?.('parking-point-record');
                        onRecordParkingPointPosition?.(
                          robotParkingGhost.taskId,
                          robotParkingGhost.parkingPointId,
                          normalizeRobotPose(robotPoseRef.current),
                        );
                      } else {
                        onEditParkingPoint?.(robotParkingGhost.taskId, robotParkingGhost.parkingPointId);
                      }
                    }}
                  >
                    {robotParkingGhost.editing ? <Save size={12} /> : <Move3D size={12} />}
                    {robotParkingGhost.editing ? '录入新位置' : '修改停车点'}
                  </button>
                )}
                <button
                  type="button"
                  className="robot-parking-ghost-readout__move"
                  title={robotParkingGhost.poseId
                    ? `移动到 ${robotParkingGhost.parkingPointName || '当前停车点'} 并应用 ${robotParkingGhost.poseName || '当前姿态'} 的全部关节角度`
                    : `移动到 ${robotParkingGhost.parkingPointName || '当前停车点'} 的位置与朝向，保留当前关节姿态`}
                  onClick={() => onMoveToParkingPoint?.(
                    robotParkingGhost.taskId,
                    robotParkingGhost.parkingPointId,
                    robotParkingGhost.poseId,
                  )}
                  disabled={!onMoveToParkingPoint || teachingCaptureBusy}
                >
                  {robotParkingGhost.poseId ? <Bot size={12} /> : <MapPin size={12} />}
                  {robotParkingGhost.poseId ? '使用当前姿态' : '移动到当前停车点'}
                </button>
                </>}
              </div>
              <button
                type="button"
                className="robot-parking-ghost-readout__close"
                aria-label={robotParkingGhost.kind === 'mobile-solve' ? '隐藏计算姿态虚影' : '清除停车点机器人虚影'}
                aria-keyshortcuts="Escape"
                title={robotParkingGhost.kind === 'mobile-solve' ? '隐藏当前计算虚影，关闭跟随最新 · Esc' : '移除停车点机器人虚影与距离连线 · Esc'}
                onClick={() => onClearRobotParkingGhost?.()}
              >
                <X size={12} />
              </button>
            </aside>
          )}
          {displaySettingsContainer && createPortal(<>
            <button type="button" className="polyline-teaching-launch" aria-label={polylineOpen ? '图谱控制台' : '表面折线示教'} aria-pressed={polylineOpen}
              aria-controls={polylineOpen ? 'inspector-panel-content' : 'inspector-polyline-content'}
              disabled={!isActive || (!polylineOpen && (robotLoadState?.status !== 'loaded' || externalRobotTrajectoryActive || teachingCaptureBusy || teachingPoseEditing || !mapData?.faceCount))}
              title={polylineOpen ? '返回图谱控制台，隐藏示教线条并停止当前检查或回放'
                : !mapData?.faceCount ? '第一版需要带三角面的模型；纯点云暂不支持表面点选' : '在右侧打开折线示教，点选表面并检查、执行轨迹'}
              onClick={() => {
                if (!polylineOpen) {
                  updateRobotKeyboardControl(false);
                  chassisDragInteractionRef.current?.exit?.('polyline-teaching');
                  endEffectorInteractionRef.current?.exit?.();
                  clearEndEffectorLocks();
                  onClearRobotParkingGhost?.();
                }
                onPolylineOpenChange?.(!polylineOpen);
              }}><Route size={13} />{polylineOpen ? '图谱控制台' : '折线示教'}</button>
            <ViewerMenu
              key={`distance-${resolutionMapKey}`}
              label="距离警告"
              triggerLabel="碰撞保护距离"
              triggerClassName={`robot-collision-distance is-${collisionButtonState}`}
              triggerContent={<>
                {collisionButtonState === 'safe'
                  ? <ShieldCheck size={13} aria-hidden="true" />
                  : <ShieldAlert size={13} aria-hidden="true" />}
                <span aria-live="polite" aria-atomic="true">{collisionDistanceLabel}</span>
              </>}
              triggerProps={{
                'data-collision-state': collisionButtonState,
                'data-collision-distance': collisionProtectionEnabled ? collisionDistanceMillimeters ?? '' : '',
              }}
              title={['距离警告设置', robotCollisionStatus.message, robotCollisionStatus.detail].filter(Boolean).join(' · ')}
              icon={ShieldAlert}
              isActive={isActive}
              open={distanceSettingsOpen}
              onOpenChange={setDistanceSettingsOpen}
            >
              <div className="robot-distance-settings__visibility">
                <span><Eye size={13} /> 显示警告</span>
                <button
                  type="button"
                  role="switch"
                  className="distance-warning-toggle"
                  aria-label="显示距离警告"
                  aria-checked={showDistanceWarnings}
                  title="在 3D 视图右上角显示距离警告"
                  onClick={() => setShowDistanceWarnings((current) => !current)}
                >
                  {showDistanceWarnings ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showDistanceWarnings ? '显示' : '隐藏'}</span>
                </button>
              </div>
              <RobotCollisionJointSettings
                options={collisionJointOptions}
                ignoredJointNames={ignoredCollisionJointNames}
                onChange={onIgnoredCollisionJointNamesChange}
                expanded={collisionJointSettingsOpen}
                onExpandedChange={setCollisionJointSettingsOpen}
                ready={collisionControlReady}
              />
            </ViewerMenu>
            <ViewerMenu
              key={`tools-${resolutionMapKey}`}
              label="视图工具"
              title="视角、路径点与机器人控制"
              icon={MousePointer2}
              isActive={isActive}
            >
              <div className="viewer-tool-switch" role="group" aria-label="视图操作">
                <p className="viewer-tool-switch__title">视图操作</p>
                <ViewportInteractionModeButton
                  mode={interactionMode}
                  shiftPanArmed={shiftPanArmed}
                  onClick={toggleInteractionMode}
                />
                <button
                  type="button"
                  className={showWaypoints ? 'is-active' : 'is-hidden-state'}
                  aria-label={showWaypoints ? '隐藏3D路径点' : '显示3D路径点'}
                  aria-pressed={showWaypoints}
                  disabled={!showParkingPoints}
                  title={!showParkingPoints ? '请先在显示设置中开启停车点显示' : showWaypoints ? '隐藏3D导航点小球，保留路径连线' : '显示3D导航点小球'}
                  onClick={() => onShowWaypointsChange?.(!showWaypoints)}
                >
                  {showWaypoints ? <Eye size={13} /> : <EyeOff size={13} />}
                  {showWaypoints ? '路径点' : '点已隐藏'}
                </button>
                <button type="button" onClick={focusOrigin} title="将三维视图中心定位到坐标原点">
                  <Crosshair size={13} /> 原点
                </button>
                {teachingSpaceMode === 'independent' && mapOriginPose && (
                  <button type="button" onClick={focusMapOrigin} title="查看地图原点与独立模型的相对位置">
                    <Crosshair size={13} /> 地图原点
                  </button>
                )}
                <button
                  type="button"
                  onClick={resetView}
                  title="恢复点云初始相机位置、旋转与缩放"
                  aria-label="重置3D视角"
                >
                  <RotateCcw size={13} /> 重置视角
                </button>
              </div>
              <div className="viewer-tool-switch" role="group" aria-label="机器人控制">
                <p className="viewer-tool-switch__title">机器人控制</p>
                {robotLoadState?.status === 'loaded' && (
                  <>
                    <button
                      type="button"
                      className={`robot-control-toggle ${robotControlActive ? 'is-active' : ''}`}
                      disabled={!showRobot || robotTrajectoryActive || teachingPoseEditing}
                      onClick={() => setRobotControlMode(!robotControlEnabledRef.current)}
                      aria-label="定位机器人模型"
                      aria-pressed={robotControlActive}
                      title={
                        teachingPoseEditing
                          ? '姿态调整期间固定所属停车点；确认修改或按 Esc 结束后可移动底盘'
                          : robotTrajectoryActive
                          ? '示教轨迹播放期间由规划器接管机器人，暂停或停止后可恢复手动控制'
                          : endEffectorControlActive
                          ? '退出机械臂末端控制，定位机器人并启用麦轮底盘控制'
                          : robotControlActive
                            ? '底盘控制已启用；再次点击将键盘交还相机'
                            : '定位机器人并启用麦轮底盘控制：W/S 前后、A/D 横移、←/→ 旋转、↑/↓ 微调底盘高度'
                      }
                    >
                      <Bot size={13} /> 机器人
                    </button>
                    <button
                      type="button"
                      className={chassisDragMode ? 'is-active' : ''}
                      aria-label="拖动底盘"
                      aria-pressed={chassisDragMode}
                      disabled={!showRobot || robotTrajectoryActive || teachingPoseEditing}
                      title={teachingPoseEditing
                        ? '姿态调整期间固定所属停车点；确认修改或按 Esc 结束后可移动底盘'
                        : chassisDragMode
                        ? '退出底盘平面拖拽，也可按 Esc 退出'
                        : '按住底盘在地图 XY 平面拖动，保持当前 Z 高度与朝向'}
                      onClick={() => {
                        if (chassisDragModeRef.current) {
                          chassisDragInteractionRef.current?.exit?.('toolbar');
                        } else {
                          focusRobot();
                          chassisDragInteractionRef.current?.enter?.('toolbar');
                        }
                      }}
                    >
                      <Move3D size={13} /> 拖动底盘
                    </button>
                    <button
                      type="button"
                      className={`robot-height-lock-toggle ${robotHeightLockActive ? 'is-active' : ''}`}
                      aria-label={robotHeightLockActive ? '解锁机器人高度' : '锁定机器人高度'}
                      aria-pressed={robotHeightLockActive}
                      data-height-lock-state={robotHeightLockActive ? 'locked' : 'unlocked'}
                      title={robotHeightLockActive
                        ? `机器人 Z=${displayedRobotPose.position.z.toFixed(3)} m 已锁定；点击后允许 ↑/↓ 调整`
                        : '锁定当前机器人 Z 高度，避免之后误触 ↑/↓ 改变底盘高度'}
                      onClick={() => onRobotHeightLockChange?.(!robotHeightLockActive)}
                    >
                      {robotHeightLockActive ? <Lock size={12} /> : <Unlock size={12} />}
                      {robotHeightLockActive ? '高度已锁' : '锁定高度'}
                    </button>
                    <button
                      type="button"
                      className="robot-pose-reset"
                      aria-label="复位机器人关节姿态"
                      data-resettable-joint-count={robotLoadState?.movableJoints?.length || 0}
                      disabled={
                        robotTrajectoryActive
                        || !robotLoadState?.movableJoints?.length
                      }
                      title={robotTrajectoryActive
                        ? '示教轨迹播放期间由规划器接管机器人，停止后可复位姿态'
                        : robotLoadState?.movableJoints?.length
                          ? '将全部可动关节恢复为初始角度，不改变机器人底盘位置与朝向'
                          : '当前机器人模型没有可复位的关节'}
                      onClick={() => onResetRobotJointPose?.()}
                    >
                      <RotateCcw size={12} /> 姿态复位
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`collision-protection-toggle is-${collisionButtonState} ${collisionProtectionEnabled ? 'is-active' : ''}`}
                  aria-label={collisionProtectionEnabled ? '关闭碰撞保护' : '开启碰撞保护'}
                  aria-pressed={collisionProtectionEnabled}
                  data-collision-control-state={collisionButtonState}
                  disabled={!collisionProtectionEnabled && !collisionControlReady}
                  onClick={() => onCollisionProtectionChange?.(!collisionProtectionEnabled)}
                  title={!collisionControlReady && !collisionProtectionEnabled
                    ? '请先加载机器人；模型装配完成后即可开启碰撞保护'
                    : collisionProtectionEnabled
                      ? '关闭碰撞保护并释放环境空间索引'
                      : '开启非底盘结构的环境干涉与 10 cm 安全距离检测'}
                >
                  {collisionProtectionEnabled && collisionStatusState === 'safe'
                    ? <ShieldCheck size={13} />
                    : <ShieldAlert size={13} />}
                  {collisionButtonLabel}
                </button>
              </div>
            </ViewerMenu>
            <ViewerMenu
              key={`display-${resolutionMapKey}`}
              label="显示设置"
              title={`机器人模型、路径、停车点、名称、点云颜色、高程色卡${canShowSurfaceCoverage ? '、表面覆盖率' : ''}${showVisionCoverageControls ? '、投影渲染、表面透明度' : ''}与显示质量`}
              icon={SlidersHorizontal}
              isActive={isActive}
            >
              <div className="viewer-display-settings__robot">
                <span><Bot size={13} /> 机器人模型</span>
                <button
                  type="button"
                  role="switch"
                  className="viewer-display-settings__toggle"
                  aria-label="显示机器人模型"
                  aria-checked={showRobot}
                  disabled={!onShowRobotChange || teachingCaptureBusy || robotLoadState?.status !== 'loaded'}
                  title={robotLoadState?.status !== 'loaded' ? '加载机器人后可切换显示' : showRobot ? '隐藏机器人模型，方便点选附近表面' : '显示机器人模型'}
                  onClick={() => onShowRobotChange?.(!showRobot)}
                >
                  {showRobot ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showRobot ? '显示' : '隐藏'}</span>
                </button>
              </div>
              <label className="viewer-display-settings__opacity">
                <span>机器人模型透明度</span>
                <input type="range" min="0" max="100" step="1"
                  value={Math.round(robotOpacity * 100)} aria-label="机器人模型透明度"
                  aria-valuetext={`${Math.round(robotOpacity * 100)}%`}
                  title="100% 为完全不透明，调低可透过机器人观察表面"
                  disabled={teachingCaptureBusy || robotLoadState?.status !== 'loaded'}
                  style={{ '--vision-coverage-opacity': `${Math.round(robotOpacity * 100)}%` }}
                  onChange={(event) => setRobotOpacity(Math.max(0, Math.min(100, Number(event.target.value) || 0)) / 100)} />
                <output>{Math.round(robotOpacity * 100)}%</output>
              </label>
              <div className="viewer-display-settings__color">
                <span><Palette size={13} /> {hasObjectColorControl ? '地图颜色' : '点云颜色'}</span>
                <button
                  type="button"
                  className={`height-color-toggle mode-${colorModeMeta.id}`}
                  aria-label={hasObjectColorControl ? '切换地图颜色模式' : '切换点云颜色模式'}
                  data-color-mode={colorModeMeta.id}
                  title={`当前为${colorModeMeta.label}，点击切换为${nextColorMode.label}`}
                  onClick={() => onColorModeChange?.(nextColorMode.id)}
                >
                  <i aria-hidden="true" />
                  <span>{colorModeMeta.label}</span>
                </button>
              </div>
              {hasObjectColorControl && <div className="viewer-display-settings__color">
                <span><Box size={13} /> 独立对象颜色</span>
                <button type="button" className={`height-color-toggle mode-${objectColorModeMeta.id}`}
                  aria-label="切换独立对象颜色模式" data-color-mode={objectColorModeMeta.id}
                  disabled={!placedObjectPointCount}
                  title={placedObjectPointCount ? `当前为${objectColorModeMeta.label}，点击切换为${nextObjectColorMode.label}`
                    : '尚未识别出独立对象，请加载包含原独立示教缓存的完整工程以恢复分组'}
                  onClick={() => onPlacedObjectColorModeChange?.(nextObjectColorMode.id)}>
                  <i aria-hidden="true" /><span>{objectColorModeMeta.label}</span>
                </button>
              </div>}
              {hasObjectColorControl && !objectLayers?.complete && <p className="viewer-display-settings__layer-notice">
                旧工程中未识别的对象沿用地图颜色；加载含原独立示教缓存的完整工程可恢复分组。
              </p>}
              {isHeightColor && <div className="viewer-display-settings__height-legend">
                <span><Palette size={13} /> 高程色卡</span>
                <button
                  type="button"
                  className="viewer-display-settings__toggle"
                  aria-label={showHeightLegend ? '隐藏高程色卡' : '显示高程色卡'}
                  aria-pressed={showHeightLegend}
                  title={showHeightLegend ? '隐藏3D窗口右下角的高程色卡' : '显示3D窗口右下角的高程色卡'}
                  onClick={() => onShowHeightLegendChange?.(!showHeightLegend)}
                >
                  {showHeightLegend ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showHeightLegend ? '显示' : '隐藏'}</span>
                </button>
              </div>}
              <div className="viewer-display-settings__layer">
                <span><MapPin size={13} /> 停车点</span>
                <button type="button" role="switch" className="viewer-display-settings__toggle"
                  aria-label="显示停车点" aria-checked={showParkingPoints}
                  title={showParkingPoints ? '隐藏3D停车点标记及名称，保留路径连线' : '显示3D停车点，恢复原有标记及名称设置'}
                  onClick={() => onShowParkingPointsChange?.(!showParkingPoints)}>
                  {showParkingPoints ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showParkingPoints ? '显示' : '隐藏'}</span>
                </button>
              </div>
              <div className="viewer-display-settings__waypoint-names">
                <span><MapPin size={13} /> 停车点名</span>
                <button
                  type="button"
                  className="viewer-display-settings__toggle"
                  aria-label={showWaypointNames ? '隐藏停车点名' : '显示停车点名'}
                  aria-pressed={showWaypointNames}
                  disabled={!showParkingPoints}
                  title={!showParkingPoints ? '请先开启停车点显示；名称偏好已保留' : showWaypointNames ? '隐藏3D导航点名称' : '显示3D导航点名称'}
                  onClick={() => onShowWaypointNamesChange?.(!showWaypointNames)}
                >
                  {showWaypointNames ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showWaypointNames ? '显示' : '隐藏'}</span>
                </button>
              </div>
              <div className="viewer-display-settings__layer">
                <span><Route size={13} /> 路径</span>
                <button type="button" role="switch" className="viewer-display-settings__toggle"
                  aria-label="显示路径" aria-checked={showPaths}
                  title={showPaths ? '隐藏3D路径连线、方向箭头及名称，保留停车点' : '显示3D路径连线及方向箭头，恢复原有名称设置'}
                  onClick={() => onShowPathsChange?.(!showPaths)}>
                  {showPaths ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showPaths ? '显示' : '隐藏'}</span>
                </button>
              </div>
              <div className="viewer-display-settings__path-names">
                <span><Route size={13} /> 路径名</span>
                <button
                  type="button"
                  className="viewer-display-settings__toggle"
                  aria-label={showPathNames ? '隐藏路径名' : '显示路径名'}
                  aria-pressed={showPathNames}
                  disabled={!showPaths}
                  title={!showPaths ? '请先开启路径显示；名称偏好已保留' : showPathNames ? '隐藏3D路径名称' : '显示3D路径的起点与终点名称'}
                  onClick={() => onShowPathNamesChange?.(!showPathNames)}
                >
                  {showPathNames ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showPathNames ? '显示' : '隐藏'}</span>
                </button>
              </div>
              {canShowSurfaceCoverage && <div className="viewer-display-settings__coverage">
                <span><Gauge size={13} /> 表面覆盖率</span>
                <button
                  type="button"
                  className="viewer-display-settings__toggle"
                  aria-label={showSurfaceCoverage ? '隐藏表面覆盖率' : '显示表面覆盖率'}
                  aria-pressed={showSurfaceCoverage}
                  title={showSurfaceCoverage ? '隐藏3D窗口左上角的表面覆盖率浮窗' : '显示3D窗口左上角的表面覆盖率浮窗'}
                  onClick={() => setShowSurfaceCoverage((current) => !current)}
                >
                  {showSurfaceCoverage ? <Eye size={12} /> : <EyeOff size={12} />}
                  <span>{showSurfaceCoverage ? '显示' : '隐藏'}</span>
                </button>
              </div>}
              {showVisionCoverageControls && <>
                <div className="viewer-display-settings__coverage">
                  <span><Camera size={13} /> 投影渲染</span>
                  <button
                    type="button"
                    className="viewer-display-settings__toggle"
                    aria-label={visionCoverageRenderingEnabled ? '关闭投影渲染' : '开启投影渲染'}
                    aria-pressed={visionCoverageRenderingEnabled}
                    title={visionCoverageRenderingEnabled
                      ? '隐藏视域体、光学坐标轴和表面染色'
                      : '显示视域体、光学坐标轴和表面染色'}
                    onClick={() => setVisionCoverageRenderingEnabled((current) => !current)}
                  >
                    {visionCoverageRenderingEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
                    <span>{visionCoverageRenderingEnabled ? '显示' : '隐藏'}</span>
                  </button>
                </div>
                <label className="viewer-display-settings__opacity">
                  <span>表面透明度</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(teachingSurfaceTintOpacity * 100)}
                    aria-label="表面贴图渲染透明度"
                    aria-valuetext={`${Math.round(teachingSurfaceTintOpacity * 100)}%`}
                    title="调整物体表面绿色覆盖贴图的透明度"
                    style={{
                      '--vision-coverage-opacity': `${Math.round(
                        teachingSurfaceTintOpacity * 100,
                      )}%`,
                    }}
                    onChange={(event) => {
                      const percentage = Math.max(
                        0,
                        Math.min(100, Number(event.target.value) || 0),
                      );
                      setTeachingSurfaceTintOpacity(percentage / 100);
                    }}
                  />
                  <output>{Math.round(teachingSurfaceTintOpacity * 100)}%</output>
                </label>
              </>}
              <div
                className="viewer-resolution-control"
                role="group"
                aria-label="点云显示分辨率"
                title={
                  !hasManualResolution
                    ? `自动档会在源点数超过 ${AUTO_POINT_BUDGET.toLocaleString('zh-CN')} 时选择合适密度；可用下拉框手动覆盖`
                    : '仅调整 3D 显示采样，不改变 2D 截面和导航数据'
                }
              >
                <p className="viewer-display-settings__section-title">显示质量</p>
                <label
                  className={`mesh-quality-control point-density-control tone-${resolution.tone} ${!hasManualResolution ? 'is-auto' : ''}`}
                  title={`${hasManualResolution ? '手动' : '自动'}档：当前渲染 ${renderedPointCount.toLocaleString('zh-CN')} / ${renderablePointCount.toLocaleString('zh-CN')} 个点`}
                >
                  <Gauge size={13} />
                  <span>
                    <small>点云密度</small>
                    <select
                      aria-label="点云显示密度"
                      value={hasManualResolution ? String(resolutionIndex) : 'auto'}
                      onChange={(event) => chooseResolutionMode(event.target.value)}
                    >
                      <option value="auto">
                        自动 · {suggestedResolution.label} {Math.round(suggestedResolution.ratio * 100)}%（推荐）
                      </option>
                      {RESOLUTION_LEVELS.map((option, index) => (
                        <option key={option.ratio} value={index}>
                          {option.label} · {Math.round(option.ratio * 100)}%
                        </option>
                      ))}
                    </select>
                  </span>
                  <em>{Math.round(resolution.ratio * 100)}% · {formatPointCount(renderedPointCount)} 点</em>
                </label>
                {hasEmbeddedMesh && (
                  <label
                    className={`mesh-quality-control tone-${meshQualityPlan.effectiveId}`}
                    title={`${meshQualityPlan.requestedLabel}：当前渲染 ${meshQualityPlan.renderedFaceCount.toLocaleString('zh-CN')} / ${meshQualityPlan.faceCount.toLocaleString('zh-CN')} 个三角面`}
                  >
                    <Gauge size={13} />
                    <span>
                      <small>网格质量</small>
                      <select
                        aria-label="网格渲染质量"
                        value={meshQualityPlan.requestedId}
                        onChange={(event) => onMeshRenderQualityChange?.(event.target.value)}
                      >
                        {MESH_RENDER_QUALITY_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}{option.id === 'auto' ? '（推荐）' : ''}
                          </option>
                        ))}
                      </select>
                    </span>
                    <em>{formatPointCount(meshQualityPlan.renderedFaceCount)} 面</em>
                  </label>
                )}
              </div>
              {hasEmbeddedMesh && (
                <div
                  className="mesh-topology-readout"
                  role="status"
                  aria-label={`PLY 内嵌网格 ${meshInfo.faceCount.toLocaleString('zh-CN')} 个三角面，另有 ${renderablePointCount.toLocaleString('zh-CN')} 个未成面点`}
                  title="PLY 自带 face 索引：成面区域以实体网格显示，未被引用的顶点继续显示为点云"
                >
                  <Box size={12} />
                  <span>内嵌网格</span>
                  <strong>{formatPointCount(meshInfo.faceCount)} 面</strong>
                </div>
              )}
            </ViewerMenu></>, displaySettingsContainer)}
          <aside
            ref={distanceScaleRef}
            className="viewport-distance-scale"
            aria-label="三维距离比例尺"
            aria-description={`以视图焦点深度的屏幕水平方向为参考；透视视图中不同深度的比例不同。${teachingSpaceMode === 'independent' ? '地面网格固定为 1 米。' : ''}`}
            data-ready="false"
          >
            <div className="viewport-distance-scale__meta">
              <Ruler size={12} />
              <span>{teachingSpaceMode === 'independent' ? 'Z=0 · 网格 1 m' : '三维距离'}</span>
            </div>
            <div className="viewport-distance-scale__ruler">
              <div className="viewport-distance-scale__labels">
                <span>0</span>
                <strong ref={distanceScaleLabelRef}>—</strong>
              </div>
              <div className="viewport-distance-scale__bar" aria-hidden="true" />
            </div>
            <small>视图焦点处比例</small>
          </aside>
          {isHeightColor && showHeightLegend && (
            <aside className="height-color-legend" aria-label="点云高程比例尺">
              <div className="height-color-legend__heading">
                <span>ELEVATION</span>
                <strong>Z · m</strong>
              </div>
              <div className="height-color-legend__scale">
                <div className="height-color-legend__bar" aria-hidden="true" />
                <div className="height-color-legend__ticks">
                  {heightLegendTicks.map((value, index) => (
                    <span key={`${index}-${value}`}>{formatHeight(value)}</span>
                  ))}
                </div>
              </div>
              <div className="height-color-legend__footer">
                <span>LOW</span>
                <i />
                <span>HIGH</span>
              </div>
            </aside>
          )}
          {endEffectorControl?.side === 'torso' ? <TorsoControlPanel
            control={endEffectorControl}
            onModeChange={setTorsoControlMode}
            onPoseChange={setTorsoPose}
            onCancel={cancelEndEffectorControl}
            onClose={exitEndEffectorControl}
          /> : <EndEffectorControlPanel
            control={endEffectorControl}
            viewportRef={mountRef}
            lockModes={endEffectorLockModesState}
            onModeChange={setEndEffectorMode}
            onPoseChange={setEndEffectorPose}
            onReset={resetEndEffectorJoints}
            onToggleBodyLock={toggleBodyEndEffectorLock}
            onToggleMapLock={toggleMapEndEffectorLock}
            onClose={exitEndEffectorControl}
          />}
          <div className="viewer-help">
            <div className="viewer-help__row" title={[geometryHelp, robotHelp].filter(Boolean).join(' · ')}>
              <span><Gauge size={12} />{geometryHelp}</span>
              {robotHelp && <span><Bot size={12} />{robotHelp}</span>}
            </div>
            <div className="viewer-help__row" title={[mouseHelp, keyboardHelp, navigationHelp].join(' · ')}>
              <span>{effectiveViewportPan || chassisDragMode ? <Move3D size={12} /> : <Rotate3D size={12} />}{mouseHelp}</span>
              <span><Keyboard size={12} />{keyboardHelp}</span>
              <span><MousePointer2 size={12} />{navigationHelp}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
