import { Object3D, Vector3 } from 'three';
import { collectRobotCollisionProxies } from './robotCollision.js';
import { serializeCollisionHull } from './robotCollisionHull.js';

// Transfer only the kinematic hierarchy. Mesh buffers, textures, picking
// helpers and the live scene never enter the background worker.
export function serializeMobileTeachingRobot(robot, { includeCollision = false, includeCollisionHulls = false } = {}) {
  const keep = new Set([robot]);
  const collision = new Map();
  if (includeCollision) {
    robot.updateWorldMatrix(true, true);
    const collection = collectRobotCollisionProxies(robot, [], { includeChassis: true, highlights: false });
    for (const proxy of collection.proxies) {
      const joints = [];
      for (let node = proxy.mesh; node && node !== robot; node = node.parent) {
        if (['revolute', 'continuous', 'prismatic'].includes(node.userData?.jointType)) joints.unshift(node);
      }
      const chain = joints.map((node) => node.name);
      let link = proxy.mesh;
      while (link && link !== robot && link.userData.urdfType !== 'link') link = link.parent;
      const jointLink = link?.parent === joints.at(-1);
      const jointSpacing = joints.map((node, i) => !i || [node, joints[i - 1]].some((joint) => joint.userData.jointType === 'prismatic') ? null
        : node.getWorldPosition(new Vector3()).distanceTo(joints[i - 1].getWorldPosition(new Vector3())));
      collision.set(proxy.mesh, { linkName: proxy.linkName, source: proxy.source, chain, jointSpacing, jointLink,
        center: proxy.localCenter.toArray(), halfSize: proxy.localHalfSize.toArray(),
        ...(includeCollisionHulls ? { hull: serializeCollisionHull(proxy.mesh.geometry) } : {}) });
    }
  }
  robot.traverse((node) => {
    if (!node.userData?.jointType && !collision.has(node) && !(includeCollision && node.userData?.mobileCollision)
      && !/^(tool_(left|right)|zivid_(left|right)_optical_frame|waist_yaw_L)$/.test(node.name)) return;
    for (let parent = node; parent; parent = parent.parent) {
      keep.add(parent);
      if (parent === robot) break;
    }
  });
  const serialize = (node) => ({
    name: node.name, position: node.position.toArray(), quaternion: node.quaternion.toArray(), scale: node.scale.toArray(),
    userData: { ...Object.fromEntries(['urdfType', 'jointType', 'jointAxis', 'jointLimit', 'armSoftLimitRatio', 'armJointCouplingEnabled', 'restPosition', 'restQuaternion', 'jointValue']
      .filter((key) => node.userData[key] !== undefined).map((key) => [key, node.userData[key]])),
    ...(includeCollision && (collision.has(node) || node.userData.mobileCollision)
      ? { mobileCollision: collision.get(node) || node.userData.mobileCollision } : {}) },
    children: node.children.filter((child) => keep.has(child)).map(serialize),
  });
  return serialize(robot);
}

export function restoreMobileTeachingRobot(snapshot) {
  const node = new Object3D();
  node.name = snapshot.name;
  node.position.fromArray(snapshot.position); node.quaternion.fromArray(snapshot.quaternion); node.scale.fromArray(snapshot.scale);
  node.userData = structuredClone(snapshot.userData);
  snapshot.children.forEach((child) => node.add(restoreMobileTeachingRobot(child)));
  return node;
}

export function createMobileTeachingPauseGate() {
  let paused = false, release = null;
  return {
    pause: () => { paused = true; },
    resume: () => { paused = false; release?.(); release = null; },
    waitIfPaused: async () => { while (paused) await new Promise((resolve) => { release = resolve; }); },
  };
}
