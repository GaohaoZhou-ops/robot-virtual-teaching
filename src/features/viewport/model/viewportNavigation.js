import * as THREE from 'three';

// Shared by both teaching workspaces and the model editor.
export const VIEWPORT_FOV = 46;
export const DETAIL_DOLLY_FLOOR_RATIO = 1e-5;
// Stay below the float32 projection ceiling during optical zoom.
export const MAX_OPTICAL_ZOOM = 1e30;
export const VIEWPORT_DRAG_THRESHOLD = 5;

export function configureViewportTrackball(controls) {
  controls.rotateSpeed = 1.35;
  controls.noZoom = true;
  controls.noPan = true;
  controls.staticMoving = true;
  controls.keys = [];
}

export function viewportWheelDelta(event, height) {
  let delta = event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  if (event.deltaMode === 2) delta *= Math.max(height, 1);
  return Number.isFinite(delta) ? delta : 0;
}

export function createViewportNavigation(camera, controls, initialRadius) {
  const canvas = controls.domElement;
  const projectionPan = { x: 0, y: 0 };
  let radius, detailDollyFloor, minimumEffectiveDistance;
  let referenceSphere = null;
  // Include display-only ground in clipping without changing the model's
  // framing, wheel sensitivity or close-up precision.
  const setReferenceSphere = (sphere) => { referenceSphere = sphere?.clone() || null; };
  const setRadius = (value) => {
    radius = Math.max(value, 1);
    detailDollyFloor = Math.max(radius * DETAIL_DOLLY_FLOOR_RATIO, 1e-7);
    minimumEffectiveDistance = detailDollyFloor / MAX_OPTICAL_ZOOM;
    controls.minDistance = detailDollyFloor;
    controls.maxDistance = Infinity;
  };
  setRadius(initialRadius);

  const zoomBoostForDistance = (effectiveDistance) => Math.min(
    3.5,
    1 + Math.max(0, Math.log10(radius / Math.max(effectiveDistance, minimumEffectiveDistance))) * 0.24,
  );
  const applyZoomFactor = (factor) => {
    if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-12) return false;
    const offset = camera.position.clone().sub(controls.target);
    const distance = offset.length();
    if (!distance) return false;
    const effectiveDistance = distance / Math.max(camera.zoom, 1);
    const nextEffectiveDistance = Math.max(effectiveDistance * factor, minimumEffectiveDistance);
    if (!Number.isFinite(nextEffectiveDistance)) return false;
    const nextDistance = Math.max(nextEffectiveDistance, detailDollyFloor);
    camera.position.copy(controls.target).addScaledVector(offset.normalize(), nextDistance);
    camera.zoom = Math.min(MAX_OPTICAL_ZOOM, nextDistance / nextEffectiveDistance);
    camera.updateProjectionMatrix();
    controls.update();
    return true;
  };
  const applyWheelDelta = (delta) => {
    const effectiveDistance = camera.position.distanceTo(controls.target) / Math.max(camera.zoom, 1);
    const normalizedDelta = Math.sign(delta) * Math.min(Math.abs(delta), 160);
    return applyZoomFactor(Math.exp(normalizedDelta * 0.0017 * zoomBoostForDistance(effectiveDistance)));
  };
  const syncClipping = () => {
    const distance = camera.position.distanceTo(controls.target);
    const opticalZoom = Math.max(camera.zoom, 1);
    const effectiveDistance = distance / opticalZoom;
    const near = Math.max(
      radius * 1e-10, 1e-10,
      Math.min(Math.max(radius / 2000, 0.01), distance / 1000),
      distance / 10000,
    );
    const far = Math.max(
      radius * 8, distance * 1.25 + radius * 4,
      referenceSphere ? camera.position.distanceTo(referenceSphere.center) + referenceSphere.radius : 0,
    );
    if (camera.near !== near || camera.far !== far) {
      camera.near = near; camera.far = far; camera.updateProjectionMatrix();
    }
    return { distance, opticalZoom, effectiveDistance, near, far };
  };

  const applyProjectionPan = () => {
    const width = Math.max(canvas.clientWidth, 1), height = Math.max(canvas.clientHeight, 1);
    if (Math.abs(projectionPan.x) < 1e-9 && Math.abs(projectionPan.y) < 1e-9) camera.clearViewOffset();
    else camera.setViewOffset(width, height, projectionPan.x, projectionPan.y, width, height);
    camera.updateProjectionMatrix();
    canvas.dataset.precisionPanX = projectionPan.x.toFixed(3);
    canvas.dataset.precisionPanY = projectionPan.y.toFixed(3);
  };
  const getPanMetrics = () => {
    const height = Math.max(canvas.clientHeight, 1);
    const effectiveDistance = camera.position.distanceTo(controls.target) / Math.max(camera.zoom, 1);
    const unitsPerPixel = (2 * effectiveDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
    const largestCoordinate = Math.max(1, radius, ...camera.position.toArray().map(Math.abs), ...controls.target.toArray().map(Math.abs));
    // Account for float32 GPU matrices as well as JS doubles before motion
    // becomes too small to represent in world coordinates.
    const representableFloor = Math.max(Number.EPSILON * largestCoordinate * 64, largestCoordinate * (2 ** -21));
    canvas.dataset.keyboardGpuPrecisionFloor = representableFloor.toExponential(6);
    return { effectiveDistance, height, representableFloor, unitsPerPixel };
  };
  const needsPrecisionPanForDistance = (intendedWorldDistance, metrics) => camera.zoom > 1.000001
    || intendedWorldDistance <= metrics.representableFloor
    || Math.abs(projectionPan.x) > 1e-9 || Math.abs(projectionPan.y) > 1e-9;
  const panByPixels = (deltaX, deltaY) => {
    if (!deltaX && !deltaY) return null;
    const metrics = getPanMetrics();
    if (needsPrecisionPanForDistance(metrics.unitsPerPixel * Math.hypot(deltaX, deltaY), metrics)) {
      projectionPan.x -= deltaX; projectionPan.y -= deltaY;
      applyProjectionPan();
      canvas.dataset.panImplementation = 'precision-offset';
    } else {
      camera.updateMatrixWorld(true);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      const translation = right.multiplyScalar(-deltaX * metrics.unitsPerPixel).add(up.multiplyScalar(deltaY * metrics.unitsPerPixel));
      camera.position.add(translation);
      controls.target.add(translation);
      controls.update();
      canvas.dataset.panImplementation = 'world';
    }
    canvas.dataset.panMovementCount = String(Number(canvas.dataset.panMovementCount || 0) + 1);
    return canvas.dataset.panImplementation;
  };

  return { setRadius, setReferenceSphere, projectionPan, applyProjectionPan, getPanMetrics, needsPrecisionPanForDistance, panByPixels, zoomBoostForDistance, applyZoomFactor, applyWheelDelta, syncClipping };
}
