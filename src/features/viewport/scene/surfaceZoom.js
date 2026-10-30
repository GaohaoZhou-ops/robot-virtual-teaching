import * as THREE from 'three';

// A target in empty space can stop a dolly long before the visible workpiece.
// Keep the viewing direction and screen centre, but use the visible surface's
// depth as the pivot. Reuse that pick through a zoom sequence: large scans
// must not be raycast again for every wheel / trackpad event.
export function createSurfaceZoomAnchor(camera, controls, objects) {
  const raycaster = new THREE.Raycaster();
  const forward = new THREE.Vector3(), lastForward = new THREE.Vector3();
  const lastTarget = new THREE.Vector3(), lastUp = new THREE.Vector3();
  const point = new THREE.Vector3(), projected = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  let cached = false, lastOffsetX, lastOffsetY, lastAspect, lastGeometryState = [];
  const canvas = controls.domElement;

  return () => {
    forward.subVectors(controls.target, camera.position).normalize();
    if (forward.lengthSq() < 0.5) return false;
    const offsetX = camera.view?.enabled ? camera.view.offsetX : 0;
    const offsetY = camera.view?.enabled ? camera.view.offsetY : 0;
    const geometryState = objects.flatMap((object) => [object.visible, object.geometry?.index,
      object.geometry?.drawRange.start, object.geometry?.drawRange.count]);
    if (cached && lastTarget.distanceToSquared(controls.target) < 1e-20
      && lastForward.distanceToSquared(forward) < 1e-20 && lastUp.equals(camera.up)
      && lastOffsetX === offsetX && lastOffsetY === offsetY && lastAspect === camera.aspect
      && geometryState.length === lastGeometryState.length
      && geometryState.every((value, index) => value === lastGeometryState[index])) return false;

    const visible = objects.filter((object) => object.visible && object.material?.visible !== false);
    let farthest = 0;
    for (const object of visible) {
      object.updateWorldMatrix(true, false);
      if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
      sphere.copy(object.geometry.boundingSphere).applyMatrix4(object.matrixWorld);
      farthest = Math.max(farthest, camera.position.distanceTo(sphere.center) + sphere.radius);
    }
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(new THREE.Vector2(), camera);
    raycaster.near = camera.near;
    raycaster.far = camera.far;
    // Three's point threshold is in world units. Use a conservative cone,
    // then reject points more than three actual screen pixels from the centre.
    const halfHeight = Math.max(canvas.clientHeight, 1) / 2;
    const halfWidth = Math.max(canvas.clientWidth, 1) / 2;
    raycaster.params.Points.threshold = farthest * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      * 3 / (halfHeight * Math.max(camera.zoom, 1));
    let depth = null;
    for (const hit of raycaster.intersectObjects(visible, false)) {
      point.copy(hit.point);
      if (hit.object.isPoints) {
        point.fromBufferAttribute(hit.object.geometry.attributes.position, hit.index).applyMatrix4(hit.object.matrixWorld);
        projected.copy(point).project(camera);
        if (Math.hypot(projected.x * halfWidth, projected.y * halfHeight) > 3) continue;
      }
      const candidate = point.sub(camera.position).dot(forward);
      if (Number.isFinite(candidate) && candidate > 0) { depth = candidate; break; }
    }
    if (depth !== null) controls.target.copy(camera.position).addScaledVector(forward, depth);
    lastTarget.copy(controls.target); lastForward.copy(forward); lastUp.copy(camera.up);
    lastOffsetX = offsetX; lastOffsetY = offsetY; lastAspect = camera.aspect;
    lastGeometryState = geometryState; cached = true;
    canvas.dataset.zoomAnchorSource = depth !== null ? 'surface' : 'target';
    canvas.dataset.zoomAnchorPickCount = String(Number(canvas.dataset.zoomAnchorPickCount || 0) + 1);
    return depth !== null;
  };
}
