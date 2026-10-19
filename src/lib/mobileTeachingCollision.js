import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';

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
  return { intersects, encloses, kind: mesh ? 'mesh' : 'points', count };
}

export async function createMobileCollisionChecker(robot, environment, checkpoint = async () => {}) {
  const proxies = [];
  robot.traverse((node) => {
    const data = node.userData.mobileCollision;
    if (!data) return;
    const center = new THREE.Vector3().fromArray(data.center), half = new THREE.Vector3().fromArray(data.halfSize);
    proxies.push({ node, ...data, localBox: new THREE.Box3(center.clone().sub(half), center.clone().add(half)),
      localObb: new OBB(center, half), obb: new OBB(), worldBox: new THREE.Box3(), inverse: new THREE.Matrix4() });
  });
  if (!proxies.length) throw new Error('机器人缺少碰撞检测体，请重新加载模型或关闭碰撞筛选');
  const index = await buildEnvironmentIndex(environment, checkpoint);
  const pairs = [];
  for (let i = 0; i < proxies.length; i += 1) for (let j = 0; j < i; j += 1) {
    if (proxies[i].linkName !== proxies[j].linkName && !adjacent(proxies[i], proxies[j])) pairs.push([proxies[i], proxies[j]]);
  }
  const check = () => {
    robot.parent.updateMatrixWorld(true);
    const selfPairs = [], environmentLinks = new Set(), groundLinks = new Set();
    for (const proxy of proxies) {
      proxy.obb.copy(proxy.localObb).applyMatrix4(proxy.node.matrixWorld);
      // OBB.applyMatrix4 transforms the axes/size but only translates its centre.
      // URDF collision mesh centres are usually offset from their link origin.
      proxy.obb.center.copy(proxy.localObb.center).applyMatrix4(proxy.node.matrixWorld);
      proxy.worldBox.copy(proxy.localBox).applyMatrix4(proxy.node.matrixWorld).expandByScalar(CONTACT_MARGIN);
      proxy.inverse.copy(proxy.node.matrixWorld).invert();
      const scale = proxy.node.getWorldScale(new THREE.Vector3());
      const local = proxy.localBox.clone().expandByVector(new THREE.Vector3(...xyz.map((axis) => CONTACT_MARGIN / Math.max(1e-9, Math.abs(scale[axis])))));
      if (index.intersects(proxy.worldBox, local, proxy.inverse, robot.parent.position.z) || index.encloses(proxy.obb.center)) environmentLinks.add(proxy.linkName);
      // Search stays on the current horizontal support plane. Wheel/base contact
      // is intentional; arm/torso penetration below that plane is not.
      if (!/(base|wheel|caster|chassis)/i.test(proxy.linkName)
        && proxy.worldBox.min.z + CONTACT_MARGIN < robot.parent.position.z - CONTACT_MARGIN) groundLinks.add(proxy.linkName);
    }
    for (const [a, b] of pairs) {
      if (a.worldBox.intersectsBox(b.worldBox) && a.obb.intersectsOBB(b.obb)) selfPairs.push([a.linkName, b.linkName]);
    }
    return { checked: true, method: 'conservative-obb', environment: index.kind,
      clear: !selfPairs.length && !environmentLinks.size && !groundLinks.size,
      selfPairs, environmentLinks: [...environmentLinks], groundLinks: [...groundLinks] };
  };
  return { check, proxyCount: proxies.length, environmentKind: index.kind, environmentCount: index.count };
}
