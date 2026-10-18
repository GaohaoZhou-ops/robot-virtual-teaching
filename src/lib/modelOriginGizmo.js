import { MathUtils, Object3D, Quaternion, Vector3 } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { modelMatrixFromOrigin, modelPoseFromOrigin, originFromModelPose, readModelOrigin } from './modelOriginTransform.js';
import { VIEWPORT_DRAG_THRESHOLD } from './viewportNavigation.js';

export function createModelOriginGizmo({ camera, canvas, scene, model, getState, invalidate, onDraggingChange, rotateSpeed }) {
  const pivot = new Object3D();
  scene.add(pivot);
  const transform = new TransformControls(camera, canvas);
  // The viewport routes pointer ownership explicitly, so camera navigation and
  // model editing cannot both consume the same drag.
  transform.disconnect();
  canvas.style.touchAction = 'none';
  transform.setSpace('world');
  transform.setSize(1.1);
  const helper = transform.getHelper();
  scene.add(helper);
  model.matrixAutoUpdate = false;
  let gesture = null;

  const centerFor = (bounds) => new Vector3(...['x', 'y', 'z'].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2));
  const pointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1, button: event.button };
  };
  const updateModel = (origin) => {
    const state = getState();
    const desired = modelMatrixFromOrigin(origin), base = modelMatrixFromOrigin(state.previewOrigin);
    if (!state.sourceView && desired && base) model.matrix.copy(desired).multiply(base.invert());
    else model.matrix.identity();
    model.matrixWorldNeedsUpdate = true;
    canvas.dataset.modelTransform = JSON.stringify(model.matrix.toArray());
  };
  const sync = () => {
    const state = getState();
    const origin = gesture?.latest || state.originPose;
    updateModel(origin);
    const available = !state.sourceView && !state.originDisabled && state.sourceBounds && readModelOrigin(origin);
    const enabled = Boolean(available && state.originMode !== 'view');
    if (!gesture) {
      transform.enabled = enabled;
      if (available) {
        const pose = modelPoseFromOrigin(origin, centerFor(state.sourceBounds));
        pivot.position.copy(pose.position); pivot.quaternion.copy(pose.quaternion);
      }
      if (enabled) {
        if (transform.mode !== state.originMode) transform.setMode(state.originMode);
        if (!transform.object) transform.attach(pivot);
      } else if (transform.object) transform.detach();
    }
    canvas.dataset.originEditMode = state.originMode;
    canvas.dataset.originGizmoVisible = String(enabled);
    canvas.dataset.originDragging = String(Boolean(gesture));
    invalidate();
  };
  const objectChange = () => {
    if (!gesture) return;
    gesture.latest = originFromModelPose(pivot.position, pivot.quaternion, gesture.center, gesture.latest, gesture.mode);
    updateModel(gesture.latest);
    getState().onOriginChange(gesture.latest);
    invalidate();
  };
  const hover = (event, allowed = true) => {
    if (gesture) return;
    if (allowed && transform.enabled && transform.object) {
      scene.updateMatrixWorld(true);
      transform.pointerHover(pointer(event));
    } else transform.axis = null;
    canvas.dataset.originGizmoAxis = transform.axis || '';
    canvas.classList.toggle('is-origin-handle', Boolean(transform.axis));
  };
  const prepareFreeDrag = () => {
    camera.updateMatrixWorld(true);
    gesture.right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    gesture.up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const backward = new Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
    const depth = Math.max(camera.position.clone().sub(pivot.position).dot(backward), camera.near);
    gesture.unitsPerPixel = 2 * depth * Math.tan(MathUtils.degToRad(camera.fov / 2)) / camera.zoom / Math.max(canvas.clientHeight, 1);
  };
  const begin = (event, { mode, allowHandles = true }) => {
    hover(event, allowHandles);
    if (!transform.enabled || !transform.object || (event.button !== 0 && event.button !== 2)) return false;
    const state = getState();
    const handle = allowHandles && event.button === 0 && transform.axis && mode === transform.mode;
    gesture = {
      id: event.pointerId, button: event.button, mode, kind: handle ? 'handle' : 'free',
      before: { ...state.originPose }, latest: readModelOrigin(state.originPose), center: centerFor(state.sourceBounds),
      lastX: event.clientX, lastY: event.clientY, moved: false,
    };
    if (handle) {
      transform.pointerDown(pointer(event));
      if (!transform.dragging) { gesture = null; return false; }
    } else prepareFreeDrag();
    onDraggingChange(true);
    canvas.setPointerCapture(event.pointerId);
    canvas.dataset.originDragging = 'true';
    canvas.dataset.lastPointerGesture = `model-${mode}`;
    canvas.dataset.originDragKind = gesture.kind;
    canvas.classList.add('is-origin-dragging');
    invalidate();
    return true;
  };
  const promoteToTranslation = () => {
    if (!gesture || gesture.button !== 0 || gesture.mode === 'translate') return;
    if (transform.dragging) transform.pointerUp({ button: 0 });
    gesture.mode = 'translate'; gesture.kind = 'free';
    prepareFreeDrag();
    canvas.dataset.lastPointerGesture = 'model-translate';
    canvas.dataset.originDragKind = 'free';
  };
  const move = (event) => {
    if (gesture?.id !== event.pointerId) return false;
    if (event.shiftKey) promoteToTranslation();
    if (gesture.kind === 'handle') {
      scene.updateMatrixWorld(true);
      transform.pointerMove(pointer(event));
    } else {
      const dx = event.clientX - gesture.lastX, dy = event.clientY - gesture.lastY;
      gesture.moved ||= Math.hypot(dx, dy) > VIEWPORT_DRAG_THRESHOLD;
      if (!gesture.moved || (!dx && !dy)) return true;
      if (gesture.mode === 'translate') {
        pivot.position.addScaledVector(gesture.right, dx * gesture.unitsPerPixel).addScaledVector(gesture.up, -dy * gesture.unitsPerPixel);
      } else {
        // Rotate the model with the same screen-space sensitivity as browsing.
        const axis = gesture.up.clone().multiplyScalar(dx).addScaledVector(gesture.right, dy).normalize();
        const angle = 2 * Math.hypot(dx, dy) / Math.max(canvas.clientWidth, 1) * rotateSpeed;
        pivot.quaternion.premultiply(new Quaternion().setFromAxisAngle(axis, angle)).normalize();
      }
      objectChange();
    }
    gesture.lastX = event.clientX; gesture.lastY = event.clientY;
    return true;
  };
  const finish = (cancel = false, event = null) => {
    if (!gesture) return false;
    if (event && (gesture.id !== event.pointerId || gesture.button !== event.button)) return false;
    const completed = gesture;
    gesture = null;
    if (transform.dragging) transform.pointerUp({ button: 0 });
    if (cancel) {
      const pose = modelPoseFromOrigin(completed.before, completed.center);
      pivot.position.copy(pose.position); pivot.quaternion.copy(pose.quaternion);
      updateModel(completed.before);
      getState().onOriginChange(completed.before);
    }
    if (canvas.hasPointerCapture(completed.id)) canvas.releasePointerCapture(completed.id);
    canvas.classList.remove('is-origin-dragging', 'is-origin-handle');
    canvas.dataset.originGizmoAxis = '';
    canvas.dataset.originDragging = 'false';
    onDraggingChange(false);
    invalidate();
    return true;
  };
  const writeTelemetry = () => {
    const projected = pivot.position.clone().project(camera);
    canvas.dataset.originGizmoCenter = JSON.stringify([(projected.x + 1) * canvas.clientWidth / 2, (1 - projected.y) * canvas.clientHeight / 2]);
    canvas.dataset.modelPivotPosition = JSON.stringify(pivot.position.toArray());
    canvas.dataset.modelPivotQuaternion = JSON.stringify(pivot.quaternion.toArray());
  };
  transform.addEventListener('change', invalidate);
  transform.addEventListener('objectChange', objectChange);
  return {
    sync, hover, begin, move, finish, promoteToTranslation, writeTelemetry,
    get dragging() { return Boolean(gesture); },
    dispose() {
      finish(true);
      transform.removeEventListener('change', invalidate);
      transform.removeEventListener('objectChange', objectChange);
      transform.dispose(); scene.remove(helper, pivot);
    },
  };
}
