const COLORS = ['#62c7a0', '#6baff2', '#e7b55e', '#c498ed', '#ed859c', '#55c8d3', '#accb68', '#f39865',
  '#8e99ef', '#d4c881', '#72bcb4', '#cf8bca', '#d79579', '#80badc', '#c4acdf', '#b1bf85'];

export function robotTwinColor(id, used = new Set()) {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const start = (hash >>> 0) % COLORS.length;
  for (let offset = 0; offset < COLORS.length; offset++) {
    const color = COLORS[(start + offset) % COLORS.length];
    if (!used.has(color)) return color;
  }
  return COLORS[start];
}

export function isRobotTwinBodyMesh(mesh) {
  if (!mesh.isMesh || mesh.userData.robotChassisDragTarget) return false;
  let visual = false, link = false;
  for (let node = mesh; node; node = node.parent) {
    const data = node.userData || {};
    // End-effector frames are marked by the loader, including the last arm
    // link. Preserve everything attached below them, regardless of vendor/name.
    if (data.endEffectorSide || data.urdfType === 'collision' || data.robotCollisionGeometry) return false;
    if (data.urdfType === 'link') {
      link = true;
      if (/^(tool_|[a-z]*_?gripper|[a-z]*_?end_effector|zivid_|camera_|mid360_)|^(left|right)_L7$/i.test(node.name)) return false;
    }
    visual ||= data.urdfType === 'visual';
  }
  // A monolithic mesh cannot safely separate the body from external tools.
  return visual && link;
}

const sourceMaterials = new WeakMap();

export function tintRobotTwinBody(robot, color) {
  const assignments = [], materials = new Map();
  let preservedMeshes = 0;
  robot.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (!isRobotTwinBodyMesh(mesh)) { preservedMeshes++; return; }
    const original = mesh.material;
    const tint = (material) => {
      const source = sourceMaterials.get(material) || material;
      if (!source?.color || source.colorWrite === false) return source;
      if (!materials.has(source)) {
        const copy = source.clone(); copy.color.set(color);
        sourceMaterials.set(copy, source); materials.set(source, copy);
      }
      return materials.get(source);
    };
    mesh.material = Array.isArray(original) ? original.map(tint) : tint(original);
    assignments.push({ mesh, original });
  });
  return { bodyMeshes: assignments.length, preservedMeshes,
    dispose() {
      assignments.forEach(({ mesh, original }) => { mesh.material = original; });
      materials.forEach((material) => material.dispose()); materials.clear();
    } };
}
