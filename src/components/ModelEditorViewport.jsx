import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { Focus, Grid3X3, Scan, Box } from 'lucide-react';
import { MODEL_EDITOR_DISPLAY_QUALITIES } from '../lib/modelEditorDisplay.js';
import { configureViewportTrackball, createViewportNavigation, VIEWPORT_DRAG_THRESHOLD, VIEWPORT_FOV, viewportWheelDelta } from '../lib/viewportNavigation.js';
import ViewportInteractionModeButton from './ViewportInteractionModeButton.jsx';
import { createModelOriginGizmo } from '../lib/modelOriginGizmo.js';

const VIEWS = { perspective: [1.25, -1.7, 1.1], top: [0, 0, 1], front: [0, -1, 0], side: [1, 0, 0] };
const toBox = (b) => b ? new THREE.Box3(new THREE.Vector3(Number(b.min.x), Number(b.min.y), Number(b.min.z)), new THREE.Vector3(Number(b.max.x), Number(b.max.y), Number(b.max.z))) : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
const meshMaterial = (hasColors, wireframe) => wireframe
  ? new THREE.MeshBasicMaterial({ color: hasColors ? 0xffffff : 0xb5d2d8, vertexColors: hasColors, side: THREE.DoubleSide, wireframe: true })
  : new THREE.MeshStandardMaterial({ color: hasColors ? 0xffffff : 0x9fbdc3, vertexColors: hasColors, roughness: 0.9, side: THREE.DoubleSide, flatShading: true });

export default function ModelEditorViewport({ fileName, preview, crop, sourceView, onSourceViewChange, revision, display, onDisplayChange, originPose, previewOrigin, sourceBounds, originMode, onOriginModeChange, originDisabled, onOriginChange, onOriginDragChange, onUndo }) {
  const hostRef = useRef(null), canvasRef = useRef(null), sceneRef = useRef(null), dataRef = useRef(null);
  const [error, setError] = useState(''), [view, setView] = useState('perspective');
  const [gridVisible, setGridVisible] = useState(true), [wireframe, setWireframe] = useState(false);
  const [interactionMode, setInteractionMode] = useState('rotate'), [shiftPanArmed, setShiftPanArmed] = useState(false);
  const interactionModeRef = useRef('rotate');
  const editingOrigin = !sourceView && originMode !== 'view';
  dataRef.current = { preview, crop, gridVisible, wireframe, pointSize: display.pointSize, sourceView, originPose, previewOrigin, sourceBounds, originMode, onOriginModeChange, originDisabled, onOriginChange, onOriginDragChange, onUndo };

  useEffect(() => {
    const canvas = canvasRef.current, host = hostRef.current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
    catch { setError('三维预览初始化失败，请检查浏览器 WebGL 支持或重新打开页面。'); return undefined; }
    setError('');
    renderer.setClearColor(0x070f13);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, 1, 0.001, 10000);
    camera.up.set(0, 0, 1); camera.position.set(4, -6, 4);
    const controls = new TrackballControls(camera, canvas);
    configureViewportTrackball(controls);
    const navigation = createViewportNavigation(camera, controls, 1);
    canvas.dataset.controlMode = 'free-trackball';
    canvas.dataset.zoomMode = 'hybrid-continuous-detail';
    const model = new THREE.Group(); scene.add(model);
    const axes = new THREE.AxesHelper(1); axes.material.depthTest = false; axes.renderOrder = 10; scene.add(axes);
    const origin = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    origin.renderOrder = 11; scene.add(origin);
    const grid = new THREE.GridHelper(1, 20, 0x28444c, 0x16282f);
    grid.rotation.x = Math.PI / 2; scene.add(grid);
    const box = new THREE.Box3Helper(new THREE.Box3(), 0xf4c95d); scene.add(box);
    scene.add(new THREE.HemisphereLight(0xdcefff, 0x394139, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2.4); light.position.set(4, -5, 8); scene.add(light);
    let frame = 0, disposed = false, currentPreview = null, referenceBounds = null, fitted = false, originEditing = false;
    const isOriginEditing = () => !dataRef.current.sourceView && dataRef.current.originMode !== 'view';
    const currentInteractionMode = () => isOriginEditing() ? (dataRef.current.originMode === 'translate' ? 'pan' : 'rotate') : interactionModeRef.current;
    const render = () => {
      frame = 0; if (disposed) return;
      controls.update();
      const { distance, effectiveDistance, opticalZoom } = navigation.syncClipping();
      renderer.render(scene, camera);
      originGizmo.writeTelemetry();
      canvas.dataset.groundTransform = JSON.stringify(grid.matrixWorld.toArray());
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
      onDraggingChange: (dragging) => {
        if (dragging) cancelGesture();
        controls.enabled = !dragging && !isOriginEditing();
        dataRef.current.onOriginDragChange(dragging);
      },
    });
    const clearModel = () => {
      for (const object of [...model.children]) { object.geometry.dispose(); object.material.dispose(); model.remove(object); }
    };
    const fit = (direction = null) => {
      const bounds = toBox(dataRef.current.preview?.bounds).applyMatrix4(model.matrix);
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
      controls.enabled = !editing && !originGizmo.dragging;
      controls.noRotate = editing;
      originGizmo.sync();
      const previewChanged = data !== currentPreview;
      if (previewChanged) {
        clearModel(); currentPreview = data;
        if (data?.positions.length) {
          const geometry = () => {
            const value = new THREE.BufferGeometry();
            value.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
            if (data.colors) value.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
            if (data.normals) value.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
            return value;
          };
          if (data.indices.length) {
            const meshGeometry = geometry(); meshGeometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
            model.add(new THREE.Mesh(meshGeometry, meshMaterial(Boolean(data.colors), current.wireframe)));
          }
          if (data.pointIndices.length) {
            const pointsGeometry = geometry(); pointsGeometry.setIndex(new THREE.BufferAttribute(data.pointIndices, 1));
            model.add(new THREE.Points(pointsGeometry, new THREE.PointsMaterial({
              color: data.colors ? 0xffffff : 0x85d6df, vertexColors: Boolean(data.colors), size: current.pointSize, sizeAttenuation: false,
            })));
          }
        }
      }
      // All modes share the same world Z=0 reference. Only a new source model
      // changes its scale; edits, preview replacements and tool switches do not.
      if (current.sourceBounds !== referenceBounds || !fitted) {
        referenceBounds = current.sourceBounds;
        const size = toBox(referenceBounds).getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z, 0.1), gridSize = 10 ** Math.ceil(Math.log10(span * 1.5));
        grid.scale.setScalar(gridSize);
        grid.position.set(0, 0, 0);
        axes.scale.setScalar(span * 0.2); origin.scale.setScalar(span * 0.4);
      }
      if (!fitted && data) { fitted = true; fit('perspective'); }
      if (editing && editingChanged) {
        camera.updateMatrixWorld(true);
        const projected = new THREE.Vector3().project(camera);
        if (![projected.x, projected.y, projected.z].every(Number.isFinite) || Math.abs(projected.x) > 0.85 || Math.abs(projected.y) > 0.85 || Math.abs(projected.z) > 1) fit();
      }
      originEditing = editing;
      canvas.dataset.originLocked = String(editing);
      canvas.classList.toggle('is-origin-edit', editing);
      syncInteractionMode();
      for (const object of model.children) if (object.isMesh && object.material.wireframe !== current.wireframe) {
        object.material.dispose(); object.material = meshMaterial(Boolean(data.colors), current.wireframe);
      }
      for (const object of model.children) if (object.isPoints) object.material.size = current.pointSize;
      grid.visible = current.gridVisible;
      box.visible = Boolean(current.crop?.enabled);
      if (box.visible) box.box.copy(toBox(current.crop));
      canvas.dataset.previewPoints = String(data?.pointIndices.length || 0);
      canvas.dataset.previewFaces = String((data?.indices.length || 0) / 3);
      canvas.dataset.displayQuality = data?.quality || 'balanced';
      canvas.dataset.pointSize = String(current.pointSize);
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
      if (originGizmo.dragging) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      claimFocus();
      if (event.shiftKey) updateShift(true);
      const shiftPan = event.button === 0 && (event.shiftKey || shiftPressed);
      const modePan = event.button === 0 && currentInteractionMode() === 'pan';
      const panGesture = event.button === 2 || shiftPan || modePan;
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
      if (!event.buttons) originGizmo.hover(event, !event.shiftKey && !shiftPressed);
    };
    const pointerUp = (event) => {
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
    const pointerCancel = () => { originGizmo.finish(true); if (pointerStart || controls.state !== -1) cancelGesture('cancelled-by-browser'); };
    const keyDown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.target?.closest?.('[aria-modal="true"], dialog[open]')) return;
      if (event.code === 'Escape' && isOriginEditing()) {
        event.preventDefault(); event.stopPropagation();
        originGizmo.finish(true);
        dataRef.current.onOriginModeChange('view');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ' && !event.shiftKey && !event.altKey) {
        if (event.target?.isContentEditable || event.target?.closest?.('textarea')) return;
        event.preventDefault(); event.stopPropagation();
        if (!dataRef.current.originDisabled && !originGizmo.finish(true)) dataRef.current.onUndo();
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
    const resetInput = () => { originGizmo.finish(true); shiftKeys.clear(); updateShift(false); cancelGesture(); };
    const visibilityChange = () => { if (document.visibilityState !== 'visible') resetInput(); };
    const wheel = (event) => {
      if (originGizmo.dragging) { event.preventDefault(); event.stopImmediatePropagation(); return; }
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
      originGizmo.dispose();
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
      controls.dispose(); clearModel();
      scene.traverse((object) => { object.geometry?.dispose(); if (object.material) object.material.dispose(); });
      // React StrictMode reuses this canvas immediately after effect cleanup.
      // Losing its WebGL context here prevents the next renderer from starting.
      renderer.dispose(); sceneRef.current = null;
    };
  }, []);

  useEffect(() => { sceneRef.current?.sync(); }, [preview, crop, gridVisible, wireframe, display.pointSize, sourceView, originPose, previewOrigin, sourceBounds, originMode, originDisabled]);
  useEffect(() => { if (preview) { sceneRef.current?.fit('perspective'); setView('perspective'); } }, [revision]); // New file only; retain the camera while editing.
  const toggleInteractionMode = () => {
    if (canvasRef.current?.dataset.originDragging === 'true') return;
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
      <div className="model-editor__segmented" aria-label="预览内容">
        <button type="button" aria-pressed={!sourceView} onClick={() => onSourceViewChange(false)}>编辑结果</button>
        <button type="button" aria-pressed={sourceView} onClick={() => onSourceViewChange(true)}>原始模型</button>
      </div>
      <span className="model-editor__filename" title={fileName}>{fileName}</span>
      <div className="model-editor__display-controls">
        <label>显示质量<select aria-label="显示质量" value={display.quality} onChange={(event) => onDisplayChange({ ...display, quality: event.target.value })}>
          {MODEL_EDITOR_DISPLAY_QUALITIES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <label className="model-editor__point-size">点大小<input type="range" aria-label="点大小" min="1" max="8" step="0.5" value={display.pointSize} onChange={(event) => onDisplayChange({ ...display, pointSize: Number(event.target.value) })} /><output>{display.pointSize}px</output></label>
      </div>
      <div className="model-editor__view-actions">
        <button type="button" aria-label="显示网格" aria-pressed={gridVisible} onClick={() => setGridVisible(!gridVisible)} title="显示地面网格"><Grid3X3 size={15} /></button>
        <button type="button" aria-label="显示线框" aria-pressed={wireframe} onClick={() => setWireframe(!wireframe)} title="网格线框"><Box size={15} /></button>
        <button type="button" aria-label="适应模型视图" onClick={() => sceneRef.current?.fit()} title="适应模型"><Focus size={15} /></button>
      </div>
    </div>
    <div className="model-editor__viewport" ref={hostRef}>
      <canvas ref={canvasRef} aria-label="模型编辑三维预览" tabIndex={0} />
      <div className="model-editor__view-label"><Scan size={13} /><span>{sourceView ? '原始坐标系' : editingOrigin ? '原点已固定' : '编辑后坐标系'}</span><i />{view === 'custom' ? '自由视角' : 'Z 向上'}</div>
      <ViewportInteractionModeButton className="model-editor__interaction-mode" mode={editingOrigin ? (originMode === 'translate' ? 'pan' : 'rotate') : interactionMode} shiftPanArmed={shiftPanArmed} onClick={toggleInteractionMode} />
      {error && <div className="model-editor__viewport-message" role="alert">{error}</div>}
      {!error && !preview?.positions.length && <div className="model-editor__viewport-message">裁剪范围内没有模型，请扩大范围。</div>}
      <div className="model-editor__directions" aria-label="模型视角">
        {[['perspective', '透视'], ['top', '俯视'], ['front', '正视'], ['side', '侧视']].map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => { setView(id); sceneRef.current?.fit(id); }}>{label}</button>)}
      </div>
      <div className="model-editor__axis-key"><span>X</span><span>Y</span><span>Z</span><small>原点 (0, 0, 0)</small></div>
    </div>
  </div>;
}
