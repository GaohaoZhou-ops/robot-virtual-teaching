import * as THREE from 'three';

// Fit the current robot pose, independent of the map's size or coordinate origin.
// Reserve the bottom of the viewport for the playback dock when it is visible.
export function robotFocusView(camera, currentTarget, bounds, {
  aspect = camera.aspect,
  bottomFraction = 0,
  minDistance = 0,
} = {}) {
  if (!bounds || bounds.isEmpty()) return null;
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0
    || !sphere.center.toArray().every(Number.isFinite)) return null;

  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(aspect, 0.01));
  const reservedBottom = THREE.MathUtils.clamp(bottomFraction, 0, 0.45);
  const distance = Math.max(
    sphere.radius * 1.18 / Math.min(
      Math.sin(horizontalHalfFov),
      Math.sin(verticalHalfFov) * (1 - reservedBottom),
    ),
    minDistance * 2,
    0.9,
  );
  const direction = camera.position.clone().sub(currentTarget);
  if (direction.lengthSq() < 1e-12) direction.set(-0.55, -0.8, 0.42);
  direction.normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const screenUp = new THREE.Vector3().crossVectors(direction, right).normalize();
  const target = sphere.center.clone().addScaledVector(
    screenUp, -distance * Math.tan(verticalHalfFov) * reservedBottom,
  );
  return { target, position: target.clone().addScaledVector(direction, distance), distance };
}
