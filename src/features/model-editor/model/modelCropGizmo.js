import { Box3, Box3Helper, Group, Mesh, MeshBasicMaterial, Plane, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';

const AXES = ['x', 'y', 'z'];

export function createModelCropGizmo({ camera, canvas, scene, getState, invalidate, onDraggingChange }) {
  const group = new Group(); scene.add(group);
  const box = new Box3Helper(new Box3(), 0xf4c95d); group.add(box);
  box.material.depthTest = false; box.material.transparent = true; box.material.opacity = 0.8; box.renderOrder = 20;
  const handles = AXES.flatMap((axis) => ['min', 'max'].map((edge) => {
    const handle = new Mesh(new SphereGeometry(1, 12, 8), new MeshBasicMaterial({ color: 0xf4c95d, depthTest: false, transparent: true }));
    handle.userData = { axis, edge, id: `${axis}-${edge}` }; handle.renderOrder = 22;
    group.add(handle); return handle;
  }));
  const raycaster = new Raycaster();
  let gesture = null, hovered = null;
  const enabled = () => Boolean(getState().cropEditing && getState().crop?.enabled && !getState().originDisabled && getState().originMode === 'view');
  const project = (point) => {
    const p = point.clone().project(camera);
    return { x: (p.x + 1) * canvas.clientWidth / 2, y: (1 - p.y) * canvas.clientHeight / 2, z: p.z };
  };
  const unitsPerPixel = (point) => {
    const depth = Math.max(-point.clone().applyMatrix4(camera.matrixWorldInverse).z, camera.near);
    return 2 * depth * Math.tan(camera.fov * Math.PI / 360) / camera.zoom / Math.max(canvas.clientHeight, 1);
  };
  const update = () => {
    camera.updateMatrixWorld();
    const telemetry = {};
    for (const handle of handles) {
      handle.scale.setScalar(unitsPerPixel(handle.position) * (handle === hovered ? 7 : 5));
      handle.material.color.setHex(handle === hovered ? 0xffffff : 0xf4c95d);
      handle.visible = enabled();
      telemetry[handle.userData.id] = project(handle.position);
    }
    canvas.dataset.cropHandles = JSON.stringify(telemetry);
  };
  const sync = () => {
    const crop = getState().crop;
    group.visible = Boolean(getState().cropEditing && crop?.enabled);
    if (crop) {
      box.box.min.set(...AXES.map((axis) => crop.min[axis])); box.box.max.set(...AXES.map((axis) => crop.max[axis]));
      const center = box.box.getCenter(new Vector3());
      for (const handle of handles) { handle.position.copy(center); handle.position[handle.userData.axis] = crop[handle.userData.edge][handle.userData.axis]; }
    }
    if (!enabled()) hovered = null;
    canvas.dataset.cropBoxVisible = String(group.visible);
    canvas.dataset.cropBoxBounds = JSON.stringify(crop ? { min: crop.min, max: crop.max } : null);
    canvas.dataset.cropDragging = String(Boolean(gesture));
    update(); invalidate();
  };
  const hover = (event, allowed = true) => {
    if (gesture) return true;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let closest = null, score = Infinity;
    if (enabled() && allowed) for (const handle of handles) {
      const p = project(handle.position), distance = Math.hypot(p.x - x, p.y - y);
      const rank = distance + (p.z + 1) * 0.01;
      if (Math.abs(p.z) <= 1 && distance <= 12 && rank < score) { closest = handle; score = rank; }
    }
    if (closest !== hovered) { hovered = closest; invalidate(); }
    canvas.dataset.cropHandle = hovered?.userData.id || '';
    canvas.classList.toggle('is-crop-handle', Boolean(hovered));
    return Boolean(hovered);
  };
  const ray = (event) => {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
    return raycaster.ray;
  };
  const begin = (event) => {
    if (event.button !== 0 || event.shiftKey || !hover(event)) return false;
    const { axis, edge } = hovered.userData;
    const direction = new Vector3(); direction[axis] = 1;
    const normal = camera.getWorldDirection(new Vector3()); normal.addScaledVector(direction, -normal.dot(direction));
    const plane = normal.lengthSq() > 1e-4 ? new Plane().setFromNormalAndCoplanarPoint(normal.normalize(), hovered.position) : null;
    const start = plane ? ray(event).intersectPlane(plane, new Vector3()) : null;
    gesture = { id: event.pointerId, before: structuredClone(getState().crop), axis, edge, plane, start,
      startY: event.clientY, units: unitsPerPixel(hovered.position) };
    onDraggingChange(true); canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-crop-dragging'); canvas.dataset.cropDragging = 'true';
    canvas.dataset.lastPointerGesture = 'crop-resize';
    return true;
  };
  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.id) return false;
    const { before, axis, edge, plane, start, startY, units } = gesture;
    const hit = plane && start ? ray(event).intersectPlane(plane, new Vector3()) : null;
    const delta = hit ? hit[axis] - start[axis] : (startY - event.clientY) * units;
    const span = Math.max(...AXES.map((a) => before.max[a] - before.min[a]), 1);
    const minimum = span * 1e-6;
    const value = before[edge][axis] + delta;
    const limited = edge === 'min' ? Math.min(value, before.max[axis] - minimum) : Math.max(value, before.min[axis] + minimum);
    if (Number.isFinite(limited)) {
      const next = structuredClone(before); next[edge][axis] = Number(limited.toPrecision(12));
      getState().onCropChange(next);
    }
    return true;
  };
  const finish = (cancelled = false, event = null) => {
    if (!gesture || (event && event.pointerId !== gesture.id)) return false;
    const completed = gesture; gesture = null;
    if (cancelled) getState().onCropChange(completed.before);
    if (canvas.hasPointerCapture(completed.id)) canvas.releasePointerCapture(completed.id);
    hovered = null; canvas.classList.remove('is-crop-dragging', 'is-crop-handle');
    canvas.dataset.cropDragging = 'false'; canvas.dataset.cropHandle = '';
    onDraggingChange(false, cancelled); invalidate(); return true;
  };
  return { sync, update, hover, begin, move, finish,
    get dragging() { return Boolean(gesture); },
    dispose() { finish(true); scene.remove(group); group.traverse((object) => { object.geometry?.dispose(); object.material?.dispose(); }); },
  };
}
