import { Box3 } from 'three';
import { normalizeRobotPose, ROBOT_GROUND_CLEARANCE } from './robotLoader.js';

export const ROBOT_AIRBORNE_THRESHOLD = 0.05;
export const isRobotChassisAirborne = (height) => Number.isFinite(height)
  && height > ROBOT_AIRBORNE_THRESHOLD + 1e-7;

export function robotChassisGroundedPose(pose, height) {
  if (!Number.isFinite(height) || height <= ROBOT_GROUND_CLEARANCE + 1e-7) return null;
  const grounded = normalizeRobotPose(pose);
  // Match the tiny clearance used on model load, without resetting its origin,
  // orientation or articulated pose. Repeating the action cannot add drift.
  grounded.position.z += ROBOT_GROUND_CLEARANCE - height;
  return grounded;
}

// Index physical chassis visuals once. Arms, collision shapes and interaction
// helpers must not change the distance between the chassis and the floor.
export function createRobotChassisClearance(robot) {
  const links = [], meshes = [];
  robot?.traverse((node) => {
    if (node.userData.urdfType === 'link') links.push(node);
    if (node.isMesh && node.geometry?.getAttribute('position')) meshes.push(node);
  });
  const base = links.find((link) => link.name === 'base_link') || links[0];
  const parts = meshes.filter((mesh) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some((material) => material?.colorWrite === false)) return false;
    let link = null, visual = false;
    for (let node = mesh; node; node = node.parent) {
      if (node.userData.urdfType === 'collision' || node.userData.robotCollisionGeometry
        || node.userData.robotChassisDragTarget) return false;
      if (node.userData.urdfType === 'visual') visual = true;
      if (!link && node.userData.urdfType === 'link') link = node;
      if (node === robot) break;
    }
    if (!links.length) return true; // Plain meshes have no articulated links.
    return visual && (link === base || /(?:^|_)(?:wheel|caster|track|chassis)(?:_|$)/i.test(link?.name || ''));
  }).map((mesh) => ({ mesh, row: [], extent: 0, position: null, version: -1, bounds: new Box3() }));

  return () => {
    let bottom = Infinity;
    for (const part of parts) {
      const { mesh } = part;
      // Updating just these ancestor chains avoids a full model traversal on
      // each reading, including while live twins interpolate their poses.
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements, position = mesh.geometry.getAttribute('position');
      const version = position.isInterleavedBufferAttribute ? position.data.version : position.version;
      if (part.position !== position || part.version !== version || ![e[2], e[6], e[10]].every((v, i) => Math.abs(v - part.row[i]) < 1e-12)) {
        part.position = position; part.version = version;
        part.row = [e[2], e[6], e[10]];
        // For upright models an axis-aligned bound is exact. On a tilted
        // chassis use actual vertices, avoiding empty bounding-box corners.
        const axes = part.row.filter((value) => Math.abs(value) > 1e-12).length;
        let extent = Infinity;
        if (axes <= 1) {
          part.bounds.setFromBufferAttribute(position);
          const { min, max } = part.bounds;
          extent = e[2] * (e[2] < 0 ? max.x : min.x)
            + e[6] * (e[6] < 0 ? max.y : min.y) + e[10] * (e[10] < 0 ? max.z : min.z);
        } else {
          for (let i = 0; i < position.count; i++) {
            extent = Math.min(extent, e[2] * position.getX(i) + e[6] * position.getY(i) + e[10] * position.getZ(i));
          }
        }
        part.extent = extent;
      }
      bottom = Math.min(bottom, part.extent + e[14]);
    }
    return Number.isFinite(bottom) ? bottom : null;
  };
}
