// Retain source material properties so display opacity never changes which
// meshes count as robot geometry, or compounds when a slider is moved again.
export const robotSourceMaterialOpacity = (material) => (
  material?.userData?.robotDisplayOriginal?.opacity ?? material?.opacity ?? 1
);

export function applyRobotMaterialOpacity(materials, opacity) {
  for (const material of Array.isArray(materials) ? materials : [materials]) {
    if (!material || material.visible === false || material.colorWrite === false) continue;
    const original = material.userData.robotDisplayOriginal ||= {
      opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite,
    };
    const transparent = original.transparent || opacity < 1;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    material.opacity = original.opacity * opacity;
    material.depthWrite = opacity < 1 ? false : original.depthWrite;
  }
}

export function applyRobotModelOpacity(robot, value) {
  const opacity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  if (!robot) return opacity;
  robot.userData.robotDisplayOpacity = opacity;
  robot.traverse((object) => applyRobotMaterialOpacity(object.material, opacity));
  return opacity;
}
