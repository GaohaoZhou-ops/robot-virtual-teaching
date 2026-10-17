import { Object3D } from 'three';

// Transfer only the kinematic hierarchy. Mesh buffers, textures, picking
// helpers and the live scene never enter the background worker.
export function serializeMobileTeachingRobot(robot) {
  const keep = new Set([robot]);
  robot.traverse((node) => {
    if (!node.userData?.jointType && !/^(tool_(left|right)|zivid_(left|right)_optical_frame|waist_yaw_L)$/.test(node.name)) return;
    for (let parent = node; parent; parent = parent.parent) {
      keep.add(parent);
      if (parent === robot) break;
    }
  });
  const serialize = (node) => ({
    name: node.name, position: node.position.toArray(), quaternion: node.quaternion.toArray(), scale: node.scale.toArray(),
    userData: Object.fromEntries(['jointType', 'jointAxis', 'jointLimit', 'restPosition', 'restQuaternion', 'jointValue']
      .filter((key) => node.userData[key] !== undefined).map((key) => [key, node.userData[key]])),
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
