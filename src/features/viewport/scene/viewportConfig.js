import { VIEWPORT_DRAG_THRESHOLD } from "../model/viewportNavigation.js";
import * as THREE from 'three';

export const RESOLUTION_LEVELS = [
  { ratio: 0.05, label: '极速', tone: 'turbo' },
  { ratio: 0.1, label: '性能', tone: 'performance' },
  { ratio: 0.25, label: '性能', tone: 'performance' },
  { ratio: 0.5, label: '均衡', tone: 'balanced' },
  { ratio: 0.75, label: '高精', tone: 'precision' },
  { ratio: 1, label: '原始', tone: 'native' },
];

export const DEFAULT_RESOLUTION_INDEX = RESOLUTION_LEVELS.length - 1;

export const AUTO_POINT_BUDGET = 1_000_000;

export const WAYPOINT_VOLUME_RATIO = 0.14;

export const WAYPOINT_RADIUS_SCALE = Math.cbrt(WAYPOINT_VOLUME_RATIO);

export const WAYPOINT_HIT_RADIUS_SCALE = Math.cbrt(0.2) * 2.2;

export const WAYPOINT_FOCUS_DISTANCE_RATIO = 0.17;

export const PARKING_POINT_FOCUS_DISTANCE_SCALE = 1.5;

export const WAYPOINT_DEFAULT_COLOR = '#ffd166';

export const WAYPOINT_SELECTED_BODY_COLOR = '#59dbe8';

export const WAYPOINT_SELECTED_HALO_COLOR = '#9b8cff';

export const MIN_WAYPOINT_SCREEN_DIAMETER = 8;

export const MAX_WAYPOINT_SCREEN_DIAMETER = 10;

export const MAX_WAYPOINT_LOD_SCALE = 24;

export const ROS_AXIS_SCREEN_LENGTH = 68;

export const MIN_ROS_AXIS_LOD_SCALE = 1e-30;

export const PICK_DRAG_THRESHOLD = VIEWPORT_DRAG_THRESHOLD;

export const KEYBOARD_TAP_DURATION = 0.065;

export const KEYBOARD_WORLD_SPEED_RATIO = 0.75;

export const KEYBOARD_MIN_PROJECTED_AXIS = 1e-4;

export const KEYBOARD_ROTATION_SPEED = THREE.MathUtils.degToRad(72);

export const SPACEMOUSE_INPUT_STALE_MS = 180;

export const SPACEMOUSE_WHEEL_GUARD_MS = 420;

export const SPACEMOUSE_WHEEL_ARBITRATION_MS = 48;

export const SPACEMOUSE_FILTER_ATTACK_SECONDS = 0.038;

export const SPACEMOUSE_FILTER_RELEASE_SECONDS = 0.068;

export const SPACEMOUSE_FILTER_EPSILON = 0.0025;

export const SPACEMOUSE_FORWARD_SPEED_RATIO = 0.9;

export const SPACEMOUSE_PAN_PIXELS_PER_SECOND = 640;

export const SPACEMOUSE_ROTATION_SPEED = THREE.MathUtils.degToRad(125);

export const SPACEMOUSE_AXIS_HUD_HOLD_MS = 1000;

export const MAIN_VIEW_PREVIEW_CONTROL_EVENT = 'atlas-main-view-preview-control';

export const SPACEMOUSE_VIEW_AXES = Object.freeze(['x', 'y', 'z', 'roll', 'pitch', 'yaw']);

export const SPACEMOUSE_TRANSLATION_AXES = Object.freeze(['x', 'y', 'z']);

export const SPACEMOUSE_ROTATION_AXES = Object.freeze(['roll', 'pitch', 'yaw']);

export const SPACEMOUSE_AXIS_HUD_META = Object.freeze({
  x: { code: 'X', label: '前进 / 后退', group: 'XYZ' },
  y: { code: 'Y', label: '向左 / 向右', group: 'XYZ' },
  z: { code: 'Z', label: '向上 / 向下', group: 'XYZ' },
  roll: { code: 'ROLL', label: '左翻滚 / 右翻滚', group: 'RPY' },
  pitch: { code: 'PITCH', label: '前倾 / 后仰', group: 'RPY' },
  yaw: { code: 'YAW', label: '左偏航 / 右偏航', group: 'RPY' },
});

export const ROBOT_LINEAR_SPEED = 0.9;

export const ROBOT_VERTICAL_SPEED = 0.12;

export const ROBOT_ROTATION_SPEED = THREE.MathUtils.degToRad(72);

export const ROBOT_PARKING_GHOST_COLOR = 0x63e6ee;

export const ROBOT_PARKING_GHOST_OPACITY = 0.24;

export const EMPTY_VISION_COVERAGE_STATS = Object.freeze({
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

export const EMPTY_TEACHING_SURFACE_TINT_STATS = Object.freeze({
  status: 'hidden',
  coveredPointCount: 0,
  totalPointCount: 0,
});

export const TEACHING_SURFACE_COVERAGE_ATTRIBUTE = 'atlasTeachingCoverage';

export const TEACHING_SURFACE_TINT_CHUNK_SIZE = 50_000;

export const TEACHING_SURFACE_TINT_OPACITY = 0.05;

export const PROGRESSIVE_COVERAGE_PLAYBACK_STATUSES = new Set(['playing', 'paused', 'completed']);

export const ROBOT_POSE_REPORT_INTERVAL = 70;

export const ROBOT_JOINT_REPORT_INTERVAL = 70;

export const ZIVID_CAMERA_POSE_REPORT_INTERVAL = 70;

export const CHASSIS_CONTROL_AXIS_SCREEN_LENGTH = 72;

export const COLLISION_INDEX_CELL_SIZE = 0.12;

export const END_EFFECTOR_SCREEN_DIAMETER = 58;

export const ROBOT_CONTROL_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export const ROBOT_VERTICAL_CONTROL_CODES = new Set(['ArrowUp', 'ArrowDown']);

export const KEYBOARD_CONTROL_CODES = new Set([
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

export const KEYBOARD_KEY_CODES = {
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

export const KEYBOARD_ROTATION_ACTIONS = {
  ArrowUp: 'pitch-up',
  ArrowDown: 'pitch-down',
  ArrowLeft: 'yaw-left',
  ArrowRight: 'yaw-right',
};

export const KEYBOARD_VERTICAL_ACTIONS = {
  KeyQ: 'z-up',
  KeyE: 'z-down',
};

export const ROBOT_CONTROL_ACTIONS = {
  KeyW: 'forward',
  KeyA: 'strafe-left',
  KeyS: 'backward',
  KeyD: 'strafe-right',
  ArrowUp: 'z-up',
  ArrowDown: 'z-down',
  ArrowLeft: 'yaw-left',
  ArrowRight: 'yaw-right',
};

export const CAMERA_TEACH_ACTIONS = Object.freeze({
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
