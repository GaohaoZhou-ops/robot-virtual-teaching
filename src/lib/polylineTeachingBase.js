import * as THREE from 'three';
import { setRobotJointValue } from './robotLoader.js';
import { getRobotJointLimits } from './robotJointLimits.js';

// Numerical joints live above the robot, never inside its saved URDF state.
// They share the arm's bounded Jacobian solver, enabling holonomic XY + yaw.
export function createPolylineBase(layer, options) {
  const reference = { position: layer.position.toArray(), quaternion: layer.quaternion.toArray() };
  const root = new THREE.Group(), joints = [];
  let parent = root;
  for (const [key, axis, limit] of [['x', [1, 0, 0], options.range], ['y', [0, 1, 0], options.range],
    ['yaw', [0, 0, 1], THREE.MathUtils.degToRad(options.yawRange)]]) {
    const joint = new THREE.Group(); joint.name = `__polyline_base_${key}`;
    joint.userData = { jointType: key === 'yaw' ? 'revolute' : 'prismatic', jointAxis: axis,
      jointLimit: { lower: -limit, upper: limit }, jointValue: 0,
      restPosition: key === 'x' ? [reference.position[0], 0, 0] : key === 'y' ? [0, reference.position[1], 0] : [0, 0, 0] };
    parent.add(joint); joints.push(joint); parent = joint; setRobotJointValue(joint, 0);
  }
  layer.position.x = 0; layer.position.y = 0; parent.add(layer); root.updateMatrixWorld(true);
  return { root, joints, reference,
    read: () => ({ x: joints[0].userData.jointValue, y: joints[1].userData.jointValue,
      yaw: THREE.MathUtils.radToDeg(joints[2].userData.jointValue) }),
    apply: (value) => {
      joints.forEach((joint, i) => setRobotJointValue(joint, i === 2 ? THREE.MathUtils.degToRad(value.yaw) : value[i === 0 ? 'x' : 'y']));
      root.updateMatrixWorld(true);
    } };
}

// Bounded, deterministic seeds around the whole stroke, including the current
// base. The full solver checks transit and every edge for the ranked finalists.
export function polylineBaseCandidates(vertices, tcp, reference, options) {
  let length = 0;
  const center = new THREE.Vector3();
  for (let i = 1; i < vertices.length; i += 1) {
    const weight = vertices[i].distanceTo(vertices[i - 1]); length += weight;
    center.addScaledVector(vertices[i].clone().add(vertices[i - 1]).multiplyScalar(0.5), weight);
  }
  if (length) center.divideScalar(length); else center.copy(vertices[0]);
  const candidates = [], keys = new Set(), origin = new THREE.Vector3().fromArray(reference.position);
  const offset = tcp.clone().sub(origin);
  const add = (x, y, yaw) => {
    if (Math.hypot(x, y) > options.range + 1e-9 || Math.abs(yaw) > options.yawRange + 1e-9) return;
    const key = [x, y, yaw].map((value) => value.toFixed(5)).join(':');
    if (!keys.has(key)) { keys.add(key); candidates.push({ x, y, yaw }); }
  };
  add(0, 0, 0);
  const turns = [...new Set([0, 30, -30, 60, -60, 90, -90, 180, -180,
    options.yawRange, -options.yawRange])].filter((yaw) => Math.abs(yaw) <= options.yawRange);
  for (const yaw of turns) {
    const rotated = offset.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(yaw));
    const anchors = yaw === 0 ? [center, vertices[0], vertices.at(-1)] : [center];
    for (const anchor of anchors) {
      const x = anchor.x - origin.x - rotated.x, y = anchor.y - origin.y - rotated.y;
      // Clip far guesses onto the permitted disk, so a distant but reachable
      // arm target still gets candidates at the edge of the search range.
      const scale = Math.min(1, options.range / Math.max(1e-12, Math.hypot(x, y)));
      add(x * scale, y * scale, yaw);
      if (anchor === center) for (const [dx, dy] of [[0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]]) {
        add(x * scale + dx, y * scale + dy, yaw);
      }
    }
  }
  return candidates;
}

export function polylinePostureCost(joints) {
  const costs = joints.map((joint) => {
    const { lower, upper } = getRobotJointLimits(joint);
    if (!Number.isFinite(upper - lower) || upper - lower < 1e-8) return 0;
    return ((2 * joint.userData.jointValue - lower - upper) / (upper - lower)) ** 2;
  });
  return 2 * Math.max(0, ...costs) + costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length);
}
