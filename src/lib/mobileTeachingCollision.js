import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { collisionHullsSeparated } from './robotCollisionHull.js';

// Static, conservative screening: robot collision meshes become oriented boxes.
// Every environment triangle (or point) is indexed; large triangles are tested
// by triangle/box SAT, not by sparse surface samples. Connected links are exempt
// from self checks, but the chassis still participates in environment checks.
const CONTACT_MARGIN = 0.008;
const xyz = ['x', 'y', 'z'];
const adjacent = (left, right) => {
  const a = left.chain, b = right.chain;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  if (a.length + b.length - 2 * common <= 1) return true;
  // Two consecutive axes at the same joint centre form a wrist/elbow housing.
  // Exempt its joint housings, not mounted cameras or arbitrary links two
  // joints apart.
  const longer = a.length > b.length ? left : right;
  return common === Math.min(a.length, b.length) && Math.abs(a.length - b.length) === 2
    && left.jointLink === true && right.jointLink === true
    && Number.isFinite(longer.jointSpacing?.[common + 1]) && longer.jointSpacing[common + 1] < 1e-6;
};

// Projection gaps along unit separating axes are lower bounds on Euclidean
// box separation. Taking the largest of the 15 OBB SAT gaps remains
// conservative, including edge/corner cases; never report it as mesh distance.
function obbSignedSeparation(a, b, cap = Infinity) {
  const aa = a.rotation.elements, bb = b.rotation.elements;
  const dx = b.center.x - a.center.x, dy = b.center.y - a.center.y, dz = b.center.z - a.center.z;
  let gap = -Infinity;
  const project = (x, y, z) => {
    const length = Math.hypot(x, y, z);
    if (length < 1e-10) return;
    x /= length; y /= length; z /= length;
    const radius = (axes, half) => Math.abs(x * axes[0] + y * axes[1] + z * axes[2]) * half.x
      + Math.abs(x * axes[3] + y * axes[4] + z * axes[5]) * half.y
      + Math.abs(x * axes[6] + y * axes[7] + z * axes[8]) * half.z;
    gap = Math.max(gap, Math.abs(dx * x + dy * y + dz * z) - radius(aa, a.halfSize) - radius(bb, b.halfSize));
  };
  for (const axes of [aa, bb]) for (let i = 0; i < 9; i += 3) {
    project(axes[i], axes[i + 1], axes[i + 2]);
    if (gap >= cap) return cap;
  }
  for (let i = 0; i < 9; i += 3) for (let j = 0; j < 9; j += 3) {
    project(aa[i + 1] * bb[j + 2] - aa[i + 2] * bb[j + 1],
      aa[i + 2] * bb[j] - aa[i] * bb[j + 2], aa[i] * bb[j + 1] - aa[i + 1] * bb[j]);
    if (gap >= cap) return cap;
  }
  return gap;
}

export const obbSeparationLowerBound = (a, b, cap = Infinity) => Math.max(0, obbSignedSeparation(a, b, cap));

function armJointBranches(robot) {
  const chains = Object.fromEntries(['left', 'right'].map((side) => {
    const chain = [];
    const frame = robot.getObjectByName(`tool_${side}`) || robot.getObjectByName(`zivid_${side}_optical_frame`);
    for (let node = frame; node && node !== robot; node = node.parent) {
      chain.push(node);
    }
    return [side, chain];
  }));
  // Branches are inferred from kinematics, not collision-mesh naming. A
  // shared torso joint belongs to the body, including when it moves in IK.
  return Object.fromEntries(['left', 'right'].map((side) => {
    const other = chains[side === 'left' ? 'right' : 'left'];
    const branch = chains[side].filter((node) => !other.includes(node));
    return [side, { root: branch.at(-1), joints: new Set(branch
      .filter((node) => ['revolute', 'continuous', 'prismatic'].includes(node.userData.jointType)).map((node) => node.name)) }];
  }));
}

async function buildEnvironmentIndex(environment, checkpoint) {
  const positions = environment?.positions, indices = environment?.indices;
  if (!positions?.length || positions.length % 3) throw new Error('碰撞筛选缺少当前工件几何，请重新加载工件');
  const mesh = environment.kind === 'mesh' || Boolean(indices?.length);
  if (mesh && (indices?.length || positions.length / 3) % 3) throw new Error('碰撞筛选的工件三角面不完整');
  const count = mesh ? Math.floor((indices?.length || positions.length / 3) / 3) : positions.length / 3;
  if (!count) throw new Error('碰撞筛选的工件几何为空');
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  const bounds = new Float32Array(count * 6);
  const vertex = (item, corner = 0) => mesh ? (indices?.length ? indices[item * 3 + corner] : item * 3 + corner) : item;
  for (let i = 0; i < count; i += 1) {
    if (i % 8192 === 0) await checkpoint();
    const offset = i * 6;
    bounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], offset);
    for (let corner = 0; corner < (mesh ? 3 : 1); corner += 1) {
      const index = vertex(i, corner);
      if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= positions.length) throw new Error('碰撞筛选的工件索引无效');
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[index * 3 + axis];
        if (!Number.isFinite(value)) throw new Error('碰撞筛选的工件坐标无效');
        bounds[offset + axis] = Math.min(bounds[offset + axis], value);
        bounds[offset + 3 + axis] = Math.max(bounds[offset + 3 + axis], value);
      }
    }
  }
  const root = { start: 0, end: count }, pending = [root];
  let processed = 0;
  while (pending.length) {
    const node = pending.pop(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    if (processed++ % 128 === 0) await checkpoint();
    for (let i = node.start; i < node.end; i += 1) {
      const offset = order[i] * 6;
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], bounds[offset + axis]);
        max[axis] = Math.max(max[axis], bounds[offset + 3 + axis]);
      }
    }
    node.box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
    if (node.end - node.start <= 16) continue;
    const spans = max.map((value, axis) => value - min[axis]);
    const axis = spans.indexOf(Math.max(...spans)), middle = (min[axis] + max[axis]) / 2;
    let left = node.start, right = node.end - 1;
    while (left <= right) {
      const offset = order[left] * 6;
      if ((bounds[offset + axis] + bounds[offset + 3 + axis]) / 2 < middle) left += 1;
      else { [order[left], order[right]] = [order[right], order[left]]; right -= 1; }
    }
    // Degenerate/coincident geometry still gets bounded leaves and depth.
    if (left <= node.start || left >= node.end) left = (node.start + node.end) >>> 1;
    node.left = { start: node.start, end: left }; node.right = { start: left, end: node.end };
    pending.push(node.left, node.right);
  }
  const triangle = new THREE.Triangle(), point = new THREE.Vector3();
  const intersects = (worldBox, localBox, inverse, supportZ) => {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node.box.intersectsBox(worldBox)) continue;
      if (node.left) { stack.push(node.left, node.right); continue; }
      for (let i = node.start; i < node.end; i += 1) {
        const item = order[i];
        // Horizontal support-plane contact is expected. Geometry extending
        // above that plane remains an obstacle, including the chassis area.
        if (bounds[item * 6 + 5] <= supportZ + CONTACT_MARGIN) continue;
        if (mesh) {
          [triangle.a, triangle.b, triangle.c].forEach((v, corner) => v.fromArray(positions, vertex(item, corner) * 3).applyMatrix4(inverse));
          if (localBox.intersectsTriangle(triangle)) return true;
        } else if (localBox.containsPoint(point.fromArray(positions, item * 3).applyMatrix4(inverse))) return true;
      }
    }
    return false;
  };
  const ray = new THREE.Ray(), hit = new THREE.Vector3();
  const directions = [new THREE.Vector3(1, 0.371, 0.127), new THREE.Vector3(-0.19, 1, 0.417), new THREE.Vector3(0.23, -0.31, 1)]
    .flatMap((direction) => [direction.normalize(), direction.clone().normalize().negate()]);
  const encloses = (center) => {
    if (!mesh || !root.box.containsPoint(center)) return false;
    // Surface intersection alone misses a robot entirely inside a closed solid.
    // Require odd crossings in both directions along three independent rays;
    // a single open wall/ground plane must not act like an infinite solid.
    for (const direction of directions) {
      ray.set(center, direction);
      const stack = [root], distances = [];
      while (stack.length) {
        const node = stack.pop();
        if (!ray.intersectsBox(node.box)) continue;
        if (node.left) { stack.push(node.left, node.right); continue; }
        for (let i = node.start; i < node.end; i += 1) {
          [triangle.a, triangle.b, triangle.c].forEach((v, corner) => v.fromArray(positions, vertex(order[i], corner) * 3));
          if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) distances.push(center.distanceTo(hit));
        }
      }
      distances.sort((a, b) => a - b);
      let crossings = 0, last = -Infinity;
      for (const distance of distances) if (distance > 1e-7 && distance - last > 1e-5) { crossings += 1; last = distance; }
      if (crossings % 2 === 0) return false;
    }
    return true;
  };
  const intersectsSegment = (from, to, endpointTolerance = 0.0002) => {
    if (!mesh) return false;
    const length = from.distanceTo(to);
    if (length <= endpointTolerance * 2) return false;
    ray.set(from, to.clone().sub(from).divideScalar(length));
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!ray.intersectsBox(node.box)) continue;
      if (node.left) { stack.push(node.left, node.right); continue; }
      for (let i = node.start; i < node.end; i += 1) {
        [triangle.a, triangle.b, triangle.c].forEach((v, corner) => v.fromArray(positions, vertex(order[i], corner) * 3));
        if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) {
          const distance = from.distanceTo(hit);
          if (distance > endpointTolerance && distance < length - endpointTolerance) return true;
        }
      }
    }
    return false;
  };
  return { intersects, encloses, intersectsSegment, kind: mesh ? 'mesh' : 'points', count };
}

const preparedEnvironments = new WeakMap();

// Scoped to one planning request with immutable transferred geometry. Reuse
// only the workpiece index; robot transforms, boxes and collision results are
// private to each checker. The token cannot be applied to another environment.
export async function prepareMobileCollisionEnvironment(environment, checkpoint = async () => {}) {
  const started = performance.now();
  const index = await buildEnvironmentIndex(environment, checkpoint);
  const token = Object.freeze({ buildMs: performance.now() - started });
  preparedEnvironments.set(token, { environment, index });
  return token;
}

export async function createMobileCollisionChecker(robot, environment, checkpoint = async () => {}, { armBodyClearance = 0, preparedEnvironment = null } = {}) {
  const proxies = [];
  const branches = armJointBranches(robot);
  robot.traverse((node) => {
    const data = node.userData.mobileCollision;
    if (!data) return;
    const center = new THREE.Vector3().fromArray(data.center), half = new THREE.Vector3().fromArray(data.halfSize);
    const armSide = ['left', 'right'].find((side) => data.chain.some((name) => branches[side].joints.has(name))) || null;
    let mountSide = null;
    if (!armSide) for (let parent = node; parent && parent !== robot; parent = parent.parent) {
      mountSide ||= ['left', 'right'].find((side) => branches[side].root === parent) || null;
    }
    const armDepth = armSide ? data.chain.filter((name) => branches[armSide].joints.has(name)).length : 0;
    proxies.push({ node, ...data, armSide, mountSide, armDepth, localBox: new THREE.Box3(center.clone().sub(half), center.clone().add(half)),
      localObb: new OBB(center, half), obb: new OBB(), worldBox: new THREE.Box3(), inverse: new THREE.Matrix4() });
  });
  if (!proxies.length) throw new Error('机器人缺少碰撞检测体，请重新加载模型或关闭碰撞筛选');
  const prepared = preparedEnvironment && preparedEnvironments.get(preparedEnvironment);
  if (preparedEnvironment && prepared?.environment !== environment) throw new Error('碰撞索引与本次工件不匹配，请重新检查');
  const index = prepared ? prepared.index : await buildEnvironmentIndex(environment, checkpoint);
  const pairs = [];
  for (let i = 0; i < proxies.length; i += 1) for (let j = 0; j < i; j += 1) {
    if (proxies[i].linkName !== proxies[j].linkName && !adjacent(proxies[i], proxies[j])) pairs.push([proxies[i], proxies[j]]);
  }
  const bodyPairs = pairs.filter(([a, b]) => {
    if (Boolean(a.armSide) === Boolean(b.armSide)) return false;
    const [arm, body] = a.armSide ? [a, b] : [b, a];
    // The first two shoulder housings sit directly beside their own mount
    // and its supporting chest link (BOTX's boxes can be only ~13 mm apart).
    // A 50 mm buffer is physically impossible there. Exempt only those
    // structural pairs from the buffer, not intersection checks, other body
    // links, the upper-arm span, elbows, wrists or mounted cameras.
    const supportingLink = body.jointLink && arm.chain.length - body.chain.length === arm.armDepth
      && body.chain.every((name, i) => arm.chain[i] === name);
    const shoulderHousing = arm.jointLink && arm.armDepth <= 2 && arm.chain.slice(-arm.armDepth)
      .every((name) => ['revolute', 'continuous'].includes(robot.getObjectByName(name)?.userData.jointType));
    return !(shoulderHousing && (body.mountSide === arm.armSide || supportingLink));
  });
  if (armBodyClearance > 0 && (!bodyPairs.length || ['left', 'right'].some((side) => branches[side].joints.size
    && !bodyPairs.some(([a, b]) => a.armSide === side || b.armSide === side)))) {
    throw new Error('机器人缺少可识别的机械臂与躯干检测体，无法检查躯干间距');
  }
  const updateBoxes = () => {
    robot.parent.updateMatrixWorld(true);
    for (const proxy of proxies) {
      proxy.obb.copy(proxy.localObb).applyMatrix4(proxy.node.matrixWorld);
      // OBB.applyMatrix4 does not rotate an offset local centre.
      proxy.obb.center.copy(proxy.localObb.center).applyMatrix4(proxy.node.matrixWorld);
    }
  };
  const measureClearance = (cap = Infinity) => {
    let minimum = Infinity, limitingPair = null;
    const bySide = { left: null, right: null };
    for (const [a, b] of bodyPairs) {
      const side = a.armSide || b.armSide;
      const distance = obbSeparationLowerBound(a.obb, b.obb, Math.min(cap, bySide[side] ?? Infinity));
      if (bySide[side] === null || distance < bySide[side]) bySide[side] = distance;
      if (distance < minimum) { minimum = distance; limitingPair = [a.linkName, b.linkName]; }
    }
    return { checked: bodyPairs.length > 0, method: 'obb-separation-lower-bound', required: armBodyClearance,
      minimum: Number.isFinite(minimum) ? minimum : null, bySide, limitingPair,
      clear: armBodyClearance === 0 || (bodyPairs.length > 0 && Number.isFinite(minimum) && minimum + 1e-9 >= armBodyClearance) };
  };
  const measureArmBodyClearance = (cap) => { updateBoxes(); return measureClearance(cap); };
  const measurePostureClearance = (cap) => {
    updateBoxes();
    const clearance = measureClearance(cap);
    // Signed SAT separation supplies a recovery gradient for intersecting
    // housings too. The torso buffer never exempts them from self collision.
    let selfSeparation = 0.001;
    for (const [a, b] of pairs) selfSeparation = Math.min(selfSeparation, obbSignedSeparation(a.obb, b.obb, selfSeparation));
    return { ...clearance, selfSeparation };
  };
  const check = ({ detailedEnvironment = false } = {}) => {
    updateBoxes();
    const selfPairs = [], environmentLinks = new Set(), groundLinks = new Set();
    const environmentIntersectingLinks = new Set(), environmentClearanceLinks = new Set();
    for (const proxy of proxies) {
      proxy.worldBox.copy(proxy.localBox).applyMatrix4(proxy.node.matrixWorld).expandByScalar(CONTACT_MARGIN);
      proxy.inverse.copy(proxy.node.matrixWorld).invert();
      const scale = proxy.node.getWorldScale(new THREE.Vector3());
      const local = proxy.localBox.clone().expandByVector(new THREE.Vector3(...xyz.map((axis) => CONTACT_MARGIN / Math.max(1e-9, Math.abs(scale[axis])))));
      const paddedIntersection = index.intersects(proxy.worldBox, local, proxy.inverse, robot.parent.position.z);
      const inside = !paddedIntersection && index.encloses(proxy.obb.center);
      if (inside || paddedIntersection) {
        environmentLinks.add(proxy.linkName);
        if (detailedEnvironment) {
          // Preserve the same conservative rejection, but distinguish an
          // intersection of the collision box itself from its padded shell.
          // The per-axis shell is not an exact Euclidean distance measurement.
          const intersects = inside || index.intersects(proxy.worldBox, proxy.localBox, proxy.inverse, robot.parent.position.z)
            || index.encloses(proxy.obb.center);
          (intersects ? environmentIntersectingLinks : environmentClearanceLinks).add(proxy.linkName);
        }
      }
      // Search stays on the current horizontal support plane. Wheel/base contact
      // is intentional; arm/torso penetration below that plane is not.
      if (!/(base|wheel|caster|chassis)/i.test(proxy.linkName)
        && proxy.worldBox.min.z + CONTACT_MARGIN < robot.parent.position.z - CONTACT_MARGIN) groundLinks.add(proxy.linkName);
    }
    for (const pair of pairs) {
      const [a, b] = pair;
      if (!a.worldBox.intersectsBox(b.worldBox) || !a.obb.intersectsOBB(b.obb)) continue;
      if (a.hull && b.hull) {
        const relative = new THREE.Matrix4().copy(a.inverse).multiply(b.node.matrixWorld);
        // Fixed torso pairs share this result throughout an arm trajectory.
        // Recompute as soon as either link's relative transform changes.
        if (!pair.hullTransform?.equals(relative)) {
          pair.hullTransform = relative;
          pair.hullSeparated = collisionHullsSeparated(a.hull, b.hull, relative);
        }
        if (pair.hullSeparated) continue;
      }
      selfPairs.push([a.linkName, b.linkName]);
    }
    const clearance = measureClearance();
    return { checked: true, method: proxies.some((proxy) => proxy.hull) ? 'conservative-obb-convex' : 'conservative-obb', environment: index.kind,
      clear: !selfPairs.length && !environmentLinks.size && !groundLinks.size && clearance.clear,
      selfPairs, environmentLinks: [...environmentLinks], groundLinks: [...groundLinks], armBodyClearance: clearance,
      ...(detailedEnvironment ? { environmentMargin: CONTACT_MARGIN,
        environmentIntersectingLinks: [...environmentIntersectingLinks],
        environmentClearanceLinks: [...environmentClearanceLinks].filter((name) => !environmentIntersectingLinks.has(name)) } : {}) };
  };
  return { check, measureArmBodyClearance, measurePostureClearance, containsPoint: index.encloses, intersectsSegment: index.intersectsSegment,
    proxyCount: proxies.length, environmentKind: index.kind, environmentCount: index.count };
}
