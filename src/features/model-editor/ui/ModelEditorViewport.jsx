import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { Focus, Grid3X3, Box } from 'lucide-react';
import { MODEL_EDITOR_DISPLAY_QUALITIES } from "../model/modelEditorDisplay.js";
import { configureViewportTrackball, createViewportNavigation, VIEWPORT_DRAG_THRESHOLD, VIEWPORT_FOV, viewportWheelDelta } from "../../viewport/model/viewportNavigation.js";
import { createViewportTouchNavigation } from "../../viewport/model/viewportTouchNavigation.js";
import ViewportInteractionModeButton from "../../viewport/ui/ViewportInteractionModeButton.jsx";
import { createModelOriginGizmo } from "../model/modelOriginGizmo.js";
import { createModelCropGizmo } from "../model/modelCropGizmo.js";
import { modelMatrixFromOrigin } from "../model/modelOriginTransform.js";

const VIEWS = { perspective: [1.25, -1.7, 1.1], top: [0, 0, 1], front: [0, -1, 0], side: [1, 0, 0] };
const toBox = (b) => b ? new THREE.Box3(new THREE.Vector3(Number(b.min.x), Number(b.min.y), Number(b.min.z)), new THREE.Vector3(Number(b.max.x), Number(b.max.y), Number(b.max.z))) : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
const meshMaterial = (hasColors, wireframe) => wireframe
  ? new THREE.MeshBasicMaterial({ color: hasColors ? 0xffffff : 0xb5d2d8, vertexColors: hasColors, side: THREE.DoubleSide, wireframe: true })
  : new THREE.MeshStandardMaterial({ color: hasColors ? 0xffffff : 0x9fbdc3, vertexColors: hasColors, roughness: 0.9, side: THREE.DoubleSide, flatShading: true });

const clearPreview = (group) => {
  for (const object of [...group.children]) { object.geometry.dispose(); object.material.dispose(); group.remove(object); }
};
const addPreview = (group, data, { pointSize, wireframe }, ghost = false, ghostColor = 0x8bbdce) => {
  if (!data?.positions.length) return;
  const geometry = () => {
    const value = new THREE.BufferGeometry();
    value.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    if (!ghost && data.colors) value.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    if (!ghost && data.normals) value.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    return value;
  };
  if (data.indices.length) {
    const meshGeometry = geometry(); meshGeometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    group.add(new THREE.Mesh(meshGeometry, ghost
      ? new THREE.MeshBasicMaterial({ color: ghostColor, transparent: true, opacity: ghostColor === 0xffa12f ? 0.34 : 0.22, depthWrite: false, side: THREE.DoubleSide,
        forceSinglePass: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      : meshMaterial(Boolean(data.colors), wireframe)));
  }
  if (data.pointIndices.length) {
    const pointsGeometry = geometry(); pointsGeometry.setIndex(new THREE.BufferAttribute(data.pointIndices, 1));
    group.add(new THREE.Points(pointsGeometry, new THREE.PointsMaterial({
      color: ghost ? ghostColor : data.colors ? 0xffffff : 0x85d6df, vertexColors: !ghost && Boolean(data.colors),
      size: pointSize, sizeAttenuation: false, transparent: ghost, opacity: ghost ? (ghostColor === 0xffa12f ? 0.4 : 0.28) : 1, depthWrite: !ghost,
    })));
  }
};

const clipPreview = (group, crop, outside, matrix = null) => {
  // Expand the preview planes slightly to avoid camera-space roundoff flicker
  // on surfaces exactly on the box. CPU clipping/export uses the exact bounds.
  const epsilon = crop ? Math.max(...['x', 'y', 'z'].map((axis) => crop.max[axis] - crop.min[axis]), 1) * 1e-5 : 0;
  const planes = crop?.enabled ? ['x', 'y', 'z'].flatMap((axis) => {
    const normal = new THREE.Vector3(); normal[axis] = 1;
    return [new THREE.Plane(normal, -crop.min[axis] + epsilon), new THREE.Plane(normal.clone().negate(), crop.max[axis] + epsilon)];
  }) : [];
  if (outside) {
    // Include boundary points in the inside set, matching the exported crop.
    for (const plane of planes) plane.negate();
  }
  if (matrix) for (const plane of planes) plane.applyMatrix4(matrix);
  for (const object of group.children) {
    const material = object.material;
    if (material.clippingPlanes?.length !== planes.length || material.clipIntersection !== outside) material.needsUpdate = true;
    material.clippingPlanes = planes; material.clipIntersection = outside;
  }
};

export default function ModelEditorViewport({ fileName, preview, originalPreview, crop, cropPreview, cropEditing, onCropChange, onCropDragChange, showOriginal, onShowOriginalChange, revision, display, onDisplayChange, qualityControls, originPose, previewOrigin, sourceBounds, originMode, onOriginModeChange, originDisabled, onOriginChange, onOriginDragChange, onUndo, composition, ariaLabel = '模型编辑三维预览' }) {
  const hostRef = useRef(null), canvasRef = useRef(null), sceneRef = useRef(null), dataRef = useRef(null);
  const [error, setError] = useState(''), [view, setView] = useState('perspective');
  const [gridVisible, setGridVisible] = useState(true), [wireframe, setWireframe] = useState(false);
  const [interactionMode, setInteractionMode] = useState('rotate'), [shiftPanArmed, setShiftPanArmed] = useState(false);
  const interactionModeRef = useRef('rotate');
  const editingOrigin = originMode !== 'view';
  dataRef.current = { preview, originalPreview, crop, cropPreview, cropEditing, onCropChange, onCropDragChange, gridVisible, wireframe, pointSize: display.pointSize, showOriginal, originPose, previewOrigin, sourceBounds, originMode, onOriginModeChange, originDisabled, onOriginChange, onOriginDragChange, onUndo, composition };

  useEffect(() => {
    const canvas = canvasRef.current, host = hostRef.current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
    catch { setError('三维预览初始化失败，请检查浏览器 WebGL 支持或重新打开页面。'); return undefined; }
    setError('');
    renderer.setClearColor(0x070f13);
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, 1, 0.001, 10000);
    camera.up.set(0, 0, 1); camera.position.set(4, -6, 4);
    const controls = new TrackballControls(camera, canvas);
    configureViewportTrackball(controls);
    const navigation = createViewportNavigation(camera, controls, 1);
    canvas.dataset.controlMode = 'free-trackball';
    canvas.dataset.zoomMode = 'hybrid-continuous-detail';
    const model = new THREE.Group(); scene.add(model);
    const baseModel = new THREE.Group(); scene.add(baseModel);
    const envelope = new THREE.Group(); envelope.matrixAutoUpdate = false; scene.add(envelope);
    const envelopeBox = new THREE.Box3Helper(new THREE.Box3(), 0xf4c95d); envelope.add(envelopeBox);
    envelopeBox.material.depthTest = false; envelopeBox.material.transparent = true; envelopeBox.material.opacity = 0.8; envelopeBox.renderOrder = 20;
    // The reference stays in the imported coordinates, independent of edits.
    const original = new THREE.Group(); scene.add(original);
    const removed = new THREE.Group(); removed.matrixAutoUpdate = false; removed.renderOrder = 1; scene.add(removed);
    const axes = new THREE.AxesHelper(1); axes.material.depthTest = false; axes.renderOrder = 10; scene.add(axes);
    const origin = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    origin.renderOrder = 11; scene.add(origin);
    const grid = new THREE.GridHelper(1, 20, 0x28444c, 0x16282f);
    grid.rotation.x = Math.PI / 2; scene.add(grid);
    scene.add(new THREE.HemisphereLight(0xdcefff, 0x394139, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2.4); light.position.set(4, -5, 8); scene.add(light);
    let frame = 0, disposed = false, currentPreview = null, currentBasePreview = null, currentOriginalPreview = null, currentRemovedPreview = null, referenceBounds = null, fitted = false, originEditing = false;
    const isOriginEditing = () => dataRef.current.originMode !== 'view';
    const currentInteractionMode = () => isOriginEditing() ? (dataRef.current.originMode === 'translate' ? 'pan' : 'rotate') : interactionModeRef.current;
    const render = () => {
      frame = 0; if (disposed) return;
      controls.update();
      const { distance, effectiveDistance, opticalZoom } = navigation.syncClipping();
      cropGizmo.update();
      const pair = dataRef.current.composition;
      if (pair) {
        envelope.visible = Boolean(pair.bounds && pair.showEnvelope);
        envelope.matrix.copy(model.matrix); envelope.matrixWorldNeedsUpdate = true;
        if (pair.bounds) envelopeBox.box.copy(toBox(pair.bounds));
        const region = pair.bounds ? { ...pair.bounds, enabled: pair.mode === 'replace' } : null;
        clipPreview(baseModel, region, true, model.matrix);
        clipPreview(removed, region, false, model.matrix);
      } else envelope.visible = false;
      renderer.render(scene, camera);
      originGizmo.writeTelemetry();
      canvas.dataset.groundTransform = JSON.stringify(grid.matrixWorld.toArray());
      canvas.dataset.originalTransform = JSON.stringify(original.matrixWorld.toArray());
      canvas.dataset.removedTransform = JSON.stringify(removed.matrixWorld.toArray());
      canvas.dataset.baseModelTransform = JSON.stringify(baseModel.matrixWorld.toArray());
      canvas.dataset.envelopeTransform = JSON.stringify(envelope.matrixWorld.toArray());
      canvas.dataset.envelopeVisible = String(envelope.visible);
      const projectedOrigin = new THREE.Vector3().project(camera);
      canvas.dataset.originScreenPosition = JSON.stringify([(projectedOrigin.x + 1) * canvas.clientWidth / 2, (1 - projectedOrigin.y) * canvas.clientHeight / 2]);
      canvas.dataset.renderState = 'ready';
      canvas.dataset.cameraPosition = JSON.stringify(camera.position.toArray());
      canvas.dataset.cameraTarget = JSON.stringify(controls.target.toArray());
      canvas.dataset.cameraUp = JSON.stringify(camera.up.toArray());
      canvas.dataset.cameraDistance = String(distance);
      canvas.dataset.effectiveCameraDistance = String(effectiveDistance);
      canvas.dataset.opticalZoom = String(opticalZoom);
      canvas.dataset.zoomStage = opticalZoom > 1.000001 ? 'optical' : 'dolly';
    };
    const invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(render); };
    const originGizmo = createModelOriginGizmo({
      camera, canvas, scene, model, getState: () => dataRef.current, invalidate, rotateSpeed: controls.rotateSpeed,
      onDraggingChange: (dragging, cancelled) => {
        if (dragging) cancelGesture();
        controls.enabled = !dragging && !isOriginEditing();
        dataRef.current.onOriginDragChange(dragging, cancelled);
      },
    });
    const cropGizmo = createModelCropGizmo({ camera, canvas, scene, getState: () => dataRef.current, invalidate,
      onDraggingChange: (dragging, cancelled) => {
        if (dragging) cancelGesture();
        controls.enabled = !dragging && !isOriginEditing();
        dataRef.current.onCropDragChange(dragging, cancelled);
      },
    });
    const fit = (direction = null) => {
      const bounds = toBox(dataRef.current.preview?.bounds).applyMatrix4(model.matrix);
      if (dataRef.current.composition?.basePreview) bounds.union(toBox(dataRef.current.composition.basePreview.bounds));
      if (dataRef.current.showOriginal) bounds.union(toBox(dataRef.current.originalPreview?.bounds));
      if (dataRef.current.crop?.enabled) bounds.union(toBox(dataRef.current.crop));
      const center = isOriginEditing() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      // In origin editing, explicit view presets frame both the fixed origin
      // and the model. Ordinary editing never refits the camera.
      const radius = Math.max(isOriginEditing()
        ? new THREE.Vector3(...['x', 'y', 'z'].map((axis) => Math.max(Math.abs(bounds.min[axis]), Math.abs(bounds.max[axis])))).length()
        : bounds.getSize(new THREE.Vector3()).length() / 2, 0.05);
      const angle = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
      const distance = radius / Math.sin(angle) * 1.18;
      const offset = direction ? new THREE.Vector3(...VIEWS[direction]) : camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 0.001) offset.set(...VIEWS.perspective);
      if (direction) camera.up.set(0, direction === 'top' ? 1 : 0, direction === 'top' ? 0 : 1);
      navigation.setRadius(radius);
      // A narrow viewport may need more distance to fit the whole model.
      controls.maxDistance = Math.max(controls.maxDistance, distance);
      camera.zoom = 1;
      navigation.projectionPan.x = 0; navigation.projectionPan.y = 0; navigation.applyProjectionPan();
      camera.position.copy(center).addScaledVector(offset.normalize(), distance); controls.target.copy(center);
      camera.lookAt(center); camera.updateProjectionMatrix(); controls.update(); invalidate();
    };
    const sync = () => {
      const current = dataRef.current, data = current.preview;
      const editing = isOriginEditing(), editingChanged = editing !== originEditing;
      if (editingChanged) cancelGesture();
      controls.enabled = !editing && !originGizmo.dragging && !cropGizmo.dragging;
      controls.noRotate = editing;
      originGizmo.sync();
      cropGizmo.sync();
      const previewChanged = data !== currentPreview;
      if (previewChanged) {
        clearPreview(model); currentPreview = data;
        addPreview(model, data, current);
      }
      const baseData = current.composition?.basePreview || null;
      if (baseData !== currentBasePreview) {
        clearPreview(baseModel); currentBasePreview = baseData;
        addPreview(baseModel, baseData, current);
      }
      const originalData = current.showOriginal ? current.originalPreview : null;
      if (originalData !== currentOriginalPreview) {
        clearPreview(original); currentOriginalPreview = originalData;
        addPreview(original, originalData, current, true);
      }
      original.visible = Boolean(current.showOriginal);
      const removedData = current.composition
        ? current.composition.mode === 'replace' && current.composition.bounds ? baseData : null
        : current.crop?.enabled ? current.originalPreview : null;
      if (removedData !== currentRemovedPreview) {
        clearPreview(removed); currentRemovedPreview = removedData;
        addPreview(removed, removedData, current, true, 0xffa12f);
      }
      const sourceTransform = modelMatrixFromOrigin(current.originPose);
      if (current.composition) removed.matrix.identity();
      else if (sourceTransform) removed.matrix.copy(sourceTransform);
      removed.matrixWorldNeedsUpdate = true;
      removed.visible = Boolean(removedData);
      // All modes share the same world Z=0 reference. Only a new source model
      // changes its scale; edits, preview replacements and tool switches do not.
      const groundBounds = current.composition?.baseBounds || current.sourceBounds;
      if (groundBounds !== referenceBounds || !fitted) {
        referenceBounds = groundBounds;
        const size = toBox(referenceBounds).getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z, 0.1), gridSize = 10 ** Math.ceil(Math.log10(span * 1.5));
        grid.scale.setScalar(gridSize);
        grid.position.set(0, 0, 0);
        axes.scale.setScalar(span * 0.2); origin.scale.setScalar(span * 0.4);
      }
      if (!fitted && (data || baseData)) { fitted = true; fit('perspective'); }
      // Tool switches preserve the user's view, even with the origin off screen.
      // Reframe only for a new model or an explicit view/fit action.
      originEditing = editing;
      canvas.dataset.originLocked = String(editing);
      canvas.classList.toggle('is-origin-edit', editing);
      syncInteractionMode();
      for (const object of model.children) if (object.isMesh && object.material.wireframe !== current.wireframe) {
        object.material.dispose(); object.material = meshMaterial(Boolean(data.colors), current.wireframe);
      }
      for (const object of baseModel.children) {
        if (object.isMesh && object.material.wireframe !== current.wireframe) {
          object.material.dispose(); object.material = meshMaterial(Boolean(baseData.colors), current.wireframe);
        }
        if (object.isPoints) object.material.size = current.pointSize;
      }
      for (const object of model.children) if (object.isPoints) object.material.size = current.pointSize;
      for (const object of original.children) if (object.isPoints) object.material.size = current.pointSize;
      for (const object of removed.children) if (object.isPoints) object.material.size = current.pointSize;
      clipPreview(model, current.crop, current.crop?.mode === 'outside');
      clipPreview(removed, current.crop, current.crop?.mode !== 'outside');
      grid.visible = current.gridVisible;
      canvas.dataset.previewPoints = String(data?.pointIndices.length || 0);
      canvas.dataset.previewFaces = String((data?.indices.length || 0) / 3);
      canvas.dataset.displayQuality = data?.quality || 'balanced';
      canvas.dataset.baseModelPoints = String(baseData?.pointIndices.length || 0);
      canvas.dataset.baseModelFaces = String((baseData?.indices.length || 0) / 3);
      canvas.dataset.baseModelQuality = baseData?.quality || '';
      canvas.dataset.compositionMode = current.composition?.mode || '';
      canvas.dataset.pointSize = String(current.pointSize);
      canvas.dataset.originalVisible = String(original.visible && original.children.length > 0);
      canvas.dataset.originalPoints = String(original.children.find((object) => object.isPoints)?.geometry.index.count || 0);
      canvas.dataset.originalFaces = String((original.children.find((object) => object.isMesh)?.geometry.index.count || 0) / 3);
      canvas.dataset.originalQuality = originalData?.quality || '';
      canvas.dataset.originalOpacity = String(original.children[0]?.material.opacity || 0);
      canvas.dataset.originalColor = original.children[0]?.material.color.getHexString() || '';
      canvas.dataset.cropPreview = String(current.cropPreview);
      canvas.dataset.cropMode = current.crop?.mode || 'inside';
      canvas.dataset.removedVisible = String(removed.visible && removed.children.length > 0);
      canvas.dataset.removedColor = removed.children[0]?.material.color.getHexString() || '';
      canvas.dataset.removedOpacity = String(removed.children[0]?.material.opacity || 0);
      canvas.dataset.removedPoints = String(removed.children.find((object) => object.isPoints)?.geometry.index.count || 0);
      canvas.dataset.removedFaces = String((removed.children.find((object) => object.isMesh)?.geometry.index.count || 0) / 3);
      canvas.dataset.removedQuality = removedData?.quality || '';
      canvas.dataset.removedClipIntersection = String(removed.children[0]?.material.clipIntersection || false);
      invalidate();
    };
    let pointerStart = null;
    const shiftKeys = new Set();
    let shiftPressed = false;
    const syncInteractionMode = () => {
      const mode = currentInteractionMode();
      controls.mouseButtons.LEFT = mode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      canvas.dataset.interactionMode = mode;
      canvas.dataset.shiftPanArmed = String(shiftPressed);
      canvas.dataset.effectiveInteractionMode = shiftPressed ? 'shift-pan' : mode;
      canvas.classList.toggle('is-pan-mode', mode === 'pan' || shiftPressed);
    };
    const updateShift = (pressed) => {
      shiftPressed = pressed; setShiftPanArmed(pressed); syncInteractionMode();
    };
    const claimFocus = () => { if (document.activeElement !== canvas) canvas.focus({ preventScroll: true }); };
    const stopTrackballGesture = () => {
      controls.state = -1; controls.keyState = -1;
      controls._pointers.length = 0; controls._pointerPositions = {};
      controls._movePrev.copy(controls._moveCurr);
      canvas.removeEventListener('pointermove', controls._onPointerMove);
      canvas.removeEventListener('pointerup', controls._onPointerUp);
    };
    const cancelGesture = (reason = 'cancelled') => {
      const ids = new Set(controls._pointers.map((pointer) => pointer.pointerId));
      if (pointerStart) ids.add(pointerStart.id);
      pointerStart = null;
      stopTrackballGesture();
      for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      canvas.classList.remove('is-panning');
      canvas.dataset.pointerGestureState = reason;
      invalidate();
    };
    const promoteToShiftPan = () => {
      if (!pointerStart || pointerStart.button !== 0 || pointerStart.panGesture) return;
      // Finish the pending rotation before transferring this drag to panning.
      controls.update(); stopTrackballGesture();
      pointerStart.panGesture = true;
      canvas.dataset.lastPointerGesture = 'shift-pan';
    };
    const pointerDown = (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      if (originGizmo.dragging || cropGizmo.dragging) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      claimFocus();
      if (event.shiftKey) updateShift(true);
      const shiftPan = event.button === 0 && (event.shiftKey || shiftPressed);
      const modePan = event.button === 0 && currentInteractionMode() === 'pan';
      const panGesture = event.button === 2 || shiftPan || modePan;
      if (!shiftPan && cropGizmo.begin(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (isOriginEditing()) {
        originGizmo.begin(event, { mode: panGesture ? 'translate' : 'rotate', allowHandles: !shiftPan && event.button === 0 });
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      pointerStart = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, panGesture, moved: false };
      if (panGesture) {
        event.preventDefault(); event.stopImmediatePropagation();
        canvas.setPointerCapture(event.pointerId);
      }
      canvas.dataset.lastPointerGesture = shiftPan ? 'shift-pan' : modePan ? 'mode-pan' : panGesture ? 'pan' : 'rotate';
      canvas.dataset.pointerGestureState = 'active';
    };
    const pointerMove = (event) => {
      if (event.shiftKey) updateShift(true);
      if (cropGizmo.move(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (originGizmo.move(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (pointerStart?.id === event.pointerId) {
        const rect = canvas.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
          cancelGesture('cancelled-on-leave'); event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        if (event.shiftKey) { updateShift(true); promoteToShiftPan(); }
        pointerStart.moved ||= Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > VIEWPORT_DRAG_THRESHOLD;
        if (pointerStart.panGesture && pointerStart.moved) {
          event.preventDefault(); event.stopImmediatePropagation();
          navigation.panByPixels(event.clientX - pointerStart.lastX, event.clientY - pointerStart.lastY);
          canvas.classList.add('is-panning'); setView('custom');
        }
        pointerStart.lastX = event.clientX; pointerStart.lastY = event.clientY;
      }
      // Native Trackball rotation emits change only after update().
      if (event.buttons || event.pointerType === 'touch') invalidate();
      if (!event.buttons) {
        const cropHandle = cropGizmo.hover(event, !event.shiftKey && !shiftPressed);
        originGizmo.hover(event, !cropHandle && !event.shiftKey && !shiftPressed);
      }
    };
    const pointerUp = (event) => {
      if (cropGizmo.dragging) { cropGizmo.finish(false, event); event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (originGizmo.dragging) {
        originGizmo.finish(false, event);
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (pointerStart?.id !== event.pointerId) return;
      const { panGesture } = pointerStart;
      pointerStart = null;
      canvas.classList.remove('is-panning'); canvas.dataset.pointerGestureState = 'ended';
      if (panGesture) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      }
      invalidate();
    };
    const pointerLeave = () => { if (pointerStart) cancelGesture('cancelled-on-leave'); };
    const pointerCancel = () => { cropGizmo.finish(true); originGizmo.finish(true); if (pointerStart || controls.state !== -1) cancelGesture('cancelled-by-browser'); };
    const keyDown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.target?.closest?.('[aria-modal="true"], dialog[open]')) return;
      if (event.code === 'Escape' && cropGizmo.dragging) {
        event.preventDefault(); event.stopPropagation(); cropGizmo.finish(true); return;
      }
      if (event.code === 'Escape' && isOriginEditing()) {
        event.preventDefault(); event.stopPropagation();
        originGizmo.finish(true);
        dataRef.current.onOriginModeChange('view');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ' && !event.shiftKey && !event.altKey) {
        if (!dataRef.current.onUndo) return;
        if (event.target?.isContentEditable || event.target?.closest?.('textarea')) return;
        event.preventDefault(); event.stopPropagation();
        // Invalid pose fields disable manipulation, but must still be undoable.
        // The page owns busy-state restrictions for its history.
        if (!cropGizmo.finish(true) && !originGizmo.finish(true)) dataRef.current.onUndo();
        return;
      }
      if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.target?.isContentEditable || event.target?.closest?.('input, textarea, select, [aria-modal="true"], dialog[open]')) return;
      shiftKeys.add(event.code); updateShift(true); originGizmo.promoteToTranslation(); promoteToShiftPan();
    };
    const keyUp = (event) => {
      if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') return;
      shiftKeys.delete(event.code); updateShift(shiftKeys.size > 0);
    };
    const resetInput = () => { cropGizmo.finish(true); originGizmo.finish(true); shiftKeys.clear(); updateShift(false); cancelGesture(); };
    const visibilityChange = () => { if (document.visibilityState !== 'visible') resetInput(); };
    const wheel = (event) => {
      if (originGizmo.dragging || cropGizmo.dragging) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const delta = viewportWheelDelta(event, canvas.clientHeight);
      if (!delta) return;
      event.preventDefault(); event.stopImmediatePropagation(); claimFocus();
      const locked = isOriginEditing();
      const beforePosition = camera.position.clone(), beforeTarget = controls.target.clone();
      const beforeOrigin = new THREE.Vector3().project(camera);
      if (navigation.applyWheelDelta(delta)) {
        if (locked) {
          // Dolly about (0, 0, 0), keeping the origin at its current screen
          // position. Compensate optical zoom with the same projection offset
          // mechanism used by high-magnification navigation.
          const ratio = camera.position.distanceTo(controls.target) / beforePosition.distanceTo(beforeTarget);
          camera.position.copy(beforePosition).multiplyScalar(ratio); controls.target.copy(beforeTarget).multiplyScalar(ratio);
          controls.update(); camera.updateMatrixWorld(true);
          const afterOrigin = new THREE.Vector3().project(camera);
          navigation.projectionPan.x += (afterOrigin.x - beforeOrigin.x) * canvas.clientWidth / 2;
          navigation.projectionPan.y -= (afterOrigin.y - beforeOrigin.y) * canvas.clientHeight / 2;
          navigation.applyProjectionPan();
        }
        setView('custom'); invalidate();
      }
    };
    const startInteraction = () => { setView('custom'); invalidate(); };
    syncInteractionMode();
    const disposeTouchNavigation = createViewportTouchNavigation({ controls, navigation,
      onStart: () => { cropGizmo.finish(true); originGizmo.finish(true); cancelGesture('touch-navigation'); claimFocus(); },
      onCancel: () => { cropGizmo.finish(true); originGizmo.finish(true); cancelGesture('touch-cancelled'); },
      onChange: startInteraction, onEnd: invalidate,
    });
    canvas.addEventListener('pointerdown', pointerDown, true);
    canvas.addEventListener('pointermove', pointerMove, true);
    canvas.addEventListener('pointerup', pointerUp, true);
    canvas.addEventListener('pointerleave', pointerLeave);
    canvas.addEventListener('pointercancel', pointerCancel, true);
    canvas.addEventListener('lostpointercapture', pointerCancel);
    canvas.addEventListener('wheel', wheel, { passive: false, capture: true });
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', resetInput);
    document.addEventListener('visibilitychange', visibilityChange);
    controls.addEventListener('start', startInteraction);
    controls.addEventListener('end', invalidate);
    controls.addEventListener('change', invalidate);
    const resize = () => {
      const width = Math.max(host.clientWidth, 1), height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false); camera.aspect = width / height; navigation.applyProjectionPan(); controls.handleResize(); invalidate();
    };
    const observer = new ResizeObserver(resize); observer.observe(host);
    sceneRef.current = { sync, fit, syncInteractionMode }; resize(); sync();
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      disposeTouchNavigation();
      originGizmo.dispose();
      cropGizmo.dispose();
      cancelGesture();
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove, true);
      canvas.removeEventListener('pointerup', pointerUp, true);
      canvas.removeEventListener('pointerleave', pointerLeave);
      canvas.removeEventListener('pointercancel', pointerCancel, true);
      canvas.removeEventListener('lostpointercapture', pointerCancel);
      canvas.removeEventListener('wheel', wheel, true);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', resetInput);
      document.removeEventListener('visibilitychange', visibilityChange);
      controls.removeEventListener('start', startInteraction);
      controls.removeEventListener('end', invalidate);
      controls.removeEventListener('change', invalidate);
      controls.dispose(); clearPreview(model); clearPreview(baseModel); clearPreview(original); clearPreview(removed);
      scene.traverse((object) => { object.geometry?.dispose(); if (object.material) object.material.dispose(); });
      // React StrictMode reuses this canvas immediately after effect cleanup.
      // Losing its WebGL context here prevents the next renderer from starting.
      renderer.dispose(); sceneRef.current = null;
    };
  }, []);

  useEffect(() => { sceneRef.current?.sync(); }, [preview, originalPreview, crop, cropPreview, cropEditing, gridVisible, wireframe, display.pointSize, showOriginal, originPose, previewOrigin, sourceBounds, originMode, originDisabled, composition]);
  useEffect(() => { if (preview || composition?.basePreview) { sceneRef.current?.fit('perspective'); setView('perspective'); } }, [revision]); // New file only; retain the camera while editing.
  const toggleInteractionMode = () => {
    if (canvasRef.current?.dataset.originDragging === 'true' || canvasRef.current?.dataset.cropDragging === 'true') return;
    if (editingOrigin) {
      onOriginModeChange(originMode === 'translate' ? 'rotate' : 'translate');
      canvasRef.current?.focus({ preventScroll: true });
      return;
    }
    const nextMode = interactionModeRef.current === 'pan' ? 'rotate' : 'pan';
    interactionModeRef.current = nextMode; setInteractionMode(nextMode);
    sceneRef.current?.syncInteractionMode(); canvasRef.current?.focus({ preventScroll: true });
  };

  return <div className="model-editor__viewport-shell">
    <div className="model-editor__view-toolbar">
      {onShowOriginalChange && <div className="model-editor__segmented" aria-label="原始模型对照">
        <button type="button" aria-pressed={showOriginal} onClick={() => onShowOriginalChange(!showOriginal)}>{showOriginal ? '继续编辑' : '原始模型'}</button>
      </div>}
      {fileName && <span className="model-editor__filename" title={fileName}>{fileName}</span>}
      <div className="model-editor__display-controls">
        {qualityControls ?? <label>显示质量<select aria-label="显示质量" value={display.quality} onChange={(event) => onDisplayChange({ ...display, quality: event.target.value })}>
          {MODEL_EDITOR_DISPLAY_QUALITIES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>}
        <div className="model-editor__pointer-controls">
          <label className="model-editor__point-size">点大小<input type="range" aria-label="点大小" min="1" max="8" step="0.5" value={display.pointSize} onChange={(event) => onDisplayChange({ ...display, pointSize: Number(event.target.value) })} /><output>{display.pointSize}px</output></label>
          <ViewportInteractionModeButton className="model-editor__interaction-mode" mode={editingOrigin ? (originMode === 'translate' ? 'pan' : 'rotate') : interactionMode} shiftPanArmed={shiftPanArmed} onClick={toggleInteractionMode} />
        </div>
      </div>
      <div className="model-editor__view-actions">
        <button type="button" aria-label="显示网格" aria-pressed={gridVisible} onClick={() => setGridVisible(!gridVisible)} title="显示地面网格"><Grid3X3 size={15} /></button>
        <button type="button" aria-label="显示线框" aria-pressed={wireframe} onClick={() => setWireframe(!wireframe)} title="网格线框"><Box size={15} /></button>
        <button type="button" aria-label="适应模型视图" onClick={() => sceneRef.current?.fit()} title="适应模型"><Focus size={15} /></button>
      </div>
    </div>
    <div className="model-editor__viewport" ref={hostRef}>
      <canvas ref={canvasRef} aria-label={ariaLabel} tabIndex={0} />
      {error && <div className="model-editor__viewport-message" role="alert">{error}</div>}
      {!error && !preview?.positions.length && !composition?.basePreview?.positions.length && !crop?.enabled && <div className="model-editor__viewport-message">当前编辑结果为空。</div>}
      <div className="model-editor__directions" aria-label="模型视角">
        {[['perspective', '透视'], ['top', '俯视'], ['front', '正视'], ['side', '侧视']].map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => { setView(id); sceneRef.current?.fit(id); }}>{label}</button>)}
      </div>
      <div className="model-editor__axis-key"><span>X</span><span>Y</span><span>Z</span><small>原点 (0, 0, 0)</small></div>
    </div>
  </div>;
}
