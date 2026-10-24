import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Check, MousePointer2, Pause, Play, Plus, RotateCcw, Save, Square, Trash2, X } from 'lucide-react';
import { getRobotEndEffector, readRobotJointValues } from '../lib/robotLoader.js';
import { normalizePolyline, POLYLINE_DEFAULTS, POLYLINE_BASE_DEFAULTS, POLYLINE_MAX_POINTS, polylineVertices, samplePolylinePlan, readPolylineTcp, polylineBasePose, isPolylinePlanExecutable } from '../lib/polylineTeaching.js';
import { planPolylineInWorker } from '../lib/polylineTeachingWorker.js';
import { POLYLINE_EXECUTED_COLOR, polylinePreviewParts, writePolylinePreview } from '../lib/polylineTeachingPreview.js';
import { VIEWPORT_DRAG_THRESHOLD } from '../lib/viewportNavigation.js';
import './PolylineTeachingPanel.css';

const fresh = () => ({ id: '', name: '表面折线', side: 'left', closed: false, points: [], quaternion: null, tcpOffset: [0, 0, -0.2], settings: { ...POLYLINE_DEFAULTS }, base: { ...POLYLINE_BASE_DEFAULTS } });
const sameJoints = (a, b) => a && b && Object.keys(a).every((name) => Math.abs(a[name] - (b[name] ?? Infinity)) < 1e-6)
  && Object.keys(b).every((name) => name in a);
const disposeLayer = (group) => {
  group?.removeFromParent();
  group?.traverse((object) => { object.geometry?.dispose(); object.material?.map?.dispose(); object.material?.dispose(); });
};
const statusLabels = { editing: '编辑折线', checking: '正在检查', ready: '路径检查通过', playing: '正在执行', paused: '已暂停', saving: '正在保存', completed: '执行完成', failed: '需要调整' };
const busyStatuses = ['checking', 'playing', 'paused', 'saving'];
const pickingHint = '单击表面添加点，左键拖动场景旋转；拖动已有点可修改位置。';
const checkLocation = (issue, count) => issue.phase === 'initial' ? '当前机器人姿态（尚未移动）'
  : issue.phase === 'positioning' ? '底盘预定位'
  : issue.segmentIndex < 0 ? '到起点的移动' : `P${issue.segmentIndex} → P${(issue.segmentIndex + 1) % count}`;
const robotState = (context) => ({ joints: readRobotJointValues(context.robot), matrix: context.robot?.parent.matrixWorld.toArray() });
const partialSummary = (plan) => `${(plan.distance * 1000).toFixed(1)} / ${(plan.requestedDistance * 1000).toFixed(1)} mm（${(Math.floor(plan.coverage * 1000) / 10).toFixed(1)}%）`;

const formatNumber = (value) => String(Number(value.toFixed(6)));

function PolylineNumberInput({ value, onCommit, min, max, ...props }) {
  // Without a draft, reflect linked fields/undo directly. Once typing starts,
  // a linked value update must not overwrite the text the user is entering.
  const [draft, setDraft] = useState(null);
  const commit = () => {
    // Keep incomplete input (empty, minus sign, decimal) out of the path state.
    // Focusing a rounded value alone must not invalidate the checked plan.
    const text = draft ?? formatNumber(value);
    setDraft(null);
    if (text === formatNumber(value)) return;
    const parsed = text.trim() ? Number(text) : NaN;
    const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
    if (next !== value) onCommit(next);
  };
  return <input {...props} type="number" min={min} max={max} value={draft ?? formatNumber(value)}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setDraft(null);
      }
    }} />;
}

export default function PolylineTeachingPanel({ open, active, container, getContext, savedPaths, onSave, onDelete, onClose, onBusyChange, sceneRevision, openRequest, onRequestHandled, onSuggestionChange, showRobot }) {
  const [path, setPath] = useState(fresh);
  const [selected, setSelected] = useState(-1);
  const [operation, setOperation] = useState('append');
  const [status, setStatus] = useState('editing');
  const [message, setMessage] = useState(pickingHint);
  const [plan, setPlan] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [travel, setTravel] = useState({ tool: 0, base: 0 });
  const [progress, setProgress] = useState(null);
  const [history, setHistory] = useState([]);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [suggestionVisible, setSuggestionVisible] = useState(true);
  const live = useRef({});
  live.current = { path, plan, status, selected, operation, getContext, open, active };
  const abortRef = useRef(null), runtimeRef = useRef(null), animationRef = useRef(null), snapshotRef = useRef(null);
  const savingRef = useRef(false);
  const autoPlayRef = useRef(false), handledOpenRequestRef = useRef(null);
  const overlayRef = useRef(null), traceRef = useRef(null), traceCountRef = useRef(0), expectedRef = useRef(null);
  const previewRef = useRef(null), executedRef = useRef(null);
  const busy = busyStatuses.includes(status);
  const warnings = plan?.warnings || [];
  const executable = isPolylinePlanExecutable(plan);
  const previewPlan = plan || executedRef.current?.plan;
  const toolZ = path.tcpOffset?.[2] || 0;
  const toolDirection = Math.sign(toolZ) || (path.toolAxisDirection === 1 ? 1 : -1);
  const baseOptions = { ...POLYLINE_BASE_DEFAULTS, ...path.base };
  const baseMoving = baseOptions.sync || baseOptions.search;
  const selectedBasePose = plan?.baseSearch ? polylineBasePose(plan.baseReference, plan.selectedBase) : null;
  const selectedHeading = selectedBasePose ? new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(selectedBasePose.quaternion)) : null;
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  const clearTrace = () => {
    executedRef.current = null;
    previewRef.current?.update();
    traceCountRef.current = 0;
    traceRef.current?.geometry.setDrawRange(0, 0);
    setTravel({ tool: 0, base: 0 });
  };
  const cancel = (text = '已停止，保留当前位置；重新检查后可以再次执行。') => {
    autoPlayRef.current = false;
    abortRef.current?.abort(); abortRef.current = null;
    cancelAnimationFrame(animationRef.current); runtimeRef.current = null;
    setStatus('editing'); setPlan(null); setProgress(null); setMessage(text);
  };
  useEffect(() => {
    if (!open || !active) { cancel(pickingHint); clearTrace(); }
    return () => { abortRef.current?.abort(); cancelAnimationFrame(animationRef.current); };
  }, [open, active]);

  const edit = (next, nextSelected = selected) => {
    if (busyStatuses.includes(live.current.status)) return;
    const previous = structuredClone(live.current.path);
    setHistory((items) => [...items.slice(-49), previous]);
    setPath(next); setSelected(nextSelected); setPlan(null); setStatus('editing'); clearTrace();
    setMessage('路线已更新，请检查后执行。');
  };
  const setToolDistance = (distance, direction = toolDirection) => {
    if (!Number.isFinite(distance) || distance < 0 || distance > 1) return;
    // The simple distance and advanced Z offset edit the same value. Existing
    // paths retain their exact offsets, including transverse mounting offsets.
    edit({ ...path, toolAxisDirection: direction,
      tcpOffset: [path.tcpOffset?.[0] || 0, path.tcpOffset?.[1] || 0, direction * distance] });
  };
  const contextKey = (context) => JSON.stringify([context.robot?.uuid, context.geometry?.uuid,
    context.robot?.parent.uuid, context.lockedJointNames,
    context.configurationKey]);
  const contextMatches = (context, state = expectedRef.current) => snapshotRef.current?.key === contextKey(context)
    && sameJoints(state?.joints, readRobotJointValues(context.robot))
    && state?.matrix?.every((value, i) => Math.abs(value - context.robot.parent.matrixWorld.elements[i]) < 1e-8);

  useEffect(() => {
    onSuggestionChange?.(open && active && suggestionVisible ? plan?.suggestion || null : null);
    return () => onSuggestionChange?.(null);
  }, [open, active, suggestionVisible, plan?.suggestion, onSuggestionChange]);

  useEffect(() => {
    if (!open || !active || !plan?.suggestion) return undefined;
    let frame;
    const validate = () => {
      if (!contextMatches(live.current.getContext())) { cancel('机器人或约束已改变，参考虚影已清除，请重新检查路径。'); return; }
      frame = requestAnimationFrame(validate);
    };
    frame = requestAnimationFrame(validate);
    return () => cancelAnimationFrame(frame);
  }, [open, active, plan?.suggestion]);

  // The selected points describe the virtual TCP path. Tool offsets affect
  // the tool origin, not these world-space points. Closing the editor hides
  // the preview while preserving the points and visibility preference.
  useEffect(() => {
    const { scene, canvas } = getContext();
    if (!scene || !canvas) return undefined;
    let preview;
    if (open && active && previewVisible && path.points.length > 1) {
      const capacity = path.points.length * 3 * 6;
      preview = new LineSegments2(new LineSegmentsGeometry().setPositions(new Float32Array(capacity)).setColors(new Float32Array(capacity)),
        new LineMaterial({ color: 0xffffff, vertexColors: true, linewidth: 3, depthTest: false, depthWrite: false }));
      preview.name = 'polyline-tcp-preview';
      preview.geometry.attributes.instanceStart.data.setUsage(THREE.DynamicDrawUsage);
      preview.geometry.attributes.instanceColorStart.data.setUsage(THREE.DynamicDrawUsage);
      preview.renderOrder = 50; preview.frustumCulled = false;
      scene.add(preview);
    }
    const update = () => {
      const execution = executedRef.current;
      const parts = preview ? polylinePreviewParts(path, plan || execution?.plan, execution?.sample) : [];
      if (preview) writePolylinePreview(preview.geometry, parts);
      canvas.dataset.polylinePreviewVisible = String(parts.length > 0);
      canvas.dataset.polylinePreviewSegments = String(parts.length);
      canvas.dataset.polylineCompletedMm = String(parts.filter((part) => part.completed).reduce((sum, part) => sum + part.length * 1000, 0));
      canvas.dataset.polylineRemainingMm = String(parts.filter((part) => !part.completed).reduce((sum, part) => sum + part.length * 1000, 0));
      canvas.dataset.polylinePreviewColors = JSON.stringify([...new Set(parts.map((part) => part.color.toString(16)))]);
    };
    const current = { update };
    previewRef.current = current; update();
    return () => {
      if (previewRef.current === current) previewRef.current = null;
      disposeLayer(preview);
      delete canvas.dataset.polylinePreviewVisible;
      delete canvas.dataset.polylinePreviewSegments;
      delete canvas.dataset.polylineCompletedMm;
      delete canvas.dataset.polylineRemainingMm;
      delete canvas.dataset.polylinePreviewColors;
    };
  }, [path.points, path.closed, previewVisible, plan, open, active, sceneRevision]);

  // Keep source geometry independent from display LOD. This mesh is never
  // inserted into the scene; picking cannot modify the map's draw range.
  useEffect(() => {
    if (!open || !active) return undefined;
    const context = getContext();
    if (!context.scene || !context.canvas || !context.geometry) return undefined;
    const { canvas, camera, scene, geometry } = context;
    const pickGeometry = new THREE.BufferGeometry();
    pickGeometry.setAttribute('position', geometry.getAttribute('position'));
    pickGeometry.setIndex(geometry.getIndex());
    pickGeometry.boundingSphere = geometry.boundingSphere?.clone() || null;
    const surface = new THREE.Mesh(pickGeometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    surface.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let gesture = null;
    const ray = (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
      camera.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera);
    };
    const hitSurface = (event) => {
      ray(event);
      const hit = raycaster.intersectObject(surface, false)[0];
      return hit ? { id: crypto.randomUUID(), position: hit.point.toArray(), normal: hit.face.normal.toArray() } : null;
    };
    const stopEvent = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const down = (event) => {
      if (event.target !== canvas) return;
      if (live.current.operation === 'view') return;
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (busyStatuses.includes(live.current.status)) return;
      ray(event);
      const marker = raycaster.intersectObjects(overlayRef.current?.children.filter((item) => item.userData.pointIndex !== undefined) || [], false)[0];
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, index: marker?.object.userData.pointIndex ?? -1,
        original: structuredClone(live.current.path), moved: false };
      // Only point dragging owns the pointer. Surface clicks share the normal
      // camera gesture until pointerup distinguishes a click from a rotation.
      if (gesture.index >= 0) {
        stopEvent(event);
        setSelected(gesture.index);
        canvas.setPointerCapture(event.pointerId);
      }
    };
    const move = (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (gesture.index >= 0) stopEvent(event);
      if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= VIEWPORT_DRAG_THRESHOLD) return;
      gesture.moved = true;
      if (gesture.index < 0) return;
      const hit = hitSurface(event);
      if (!hit) return;
      const current = live.current.path;
      setPath({ ...current, points: current.points.map((point, i) => i === gesture.index ? { ...hit, id: point.id } : point) });
      setPlan(null); setStatus('editing'); clearTrace();
      setMessage('点已重新吸附到表面，请重新检查路径。');
    };
    const up = (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const start = gesture; gesture = null;
      if (start.index >= 0) {
        stopEvent(event);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        if (start.moved) setHistory((items) => [...items.slice(-49), start.original]);
        return;
      }
      // Let camera controls receive pointerup and release their own capture.
      if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > VIEWPORT_DRAG_THRESHOLD
        || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const hit = hitSurface(event);
      if (!hit) { setMessage('这里没有命中网格表面，请换一个位置。'); return; }
      const { path: current, selected: index, operation: mode } = live.current;
      const points = [...current.points];
      if (mode === 'replace' && index >= 0) points[index] = { ...hit, id: points[index].id };
      else {
        if (points.length >= POLYLINE_MAX_POINTS) { setMessage(`每条折线最多 ${POLYLINE_MAX_POINTS} 个点，请分开保存。`); return; }
        const insertAt = mode === 'insert' && index >= 0 ? index + 1 : points.length;
        points.splice(insertAt, 0, hit); setSelected(insertAt);
      }
      setHistory((items) => [...items.slice(-49), structuredClone(current)]);
      setPath({ ...current, points }); setPlan(null); setStatus('editing'); clearTrace();
      setOperation('append'); setMessage(`已记录 ${points.length} 个点，可继续点选或检查路径。`);
    };
    const cancelled = (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const start = gesture; gesture = null;
      if (start.index >= 0) {
        setPath(start.original);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      }
    };
    const doubleClick = (event) => { if (event.target === canvas && !event.shiftKey && live.current.operation !== 'view') stopEvent(event); };
    const key = (event) => {
      if (event.key !== 'Escape' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      stopEvent(event);
      if (savingRef.current) return;
      if (['checking', 'playing', 'paused'].includes(live.current.status)) cancel(); else onClose();
    };
    const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancelled], ['lostpointercapture', cancelled], ['dblclick', doubleClick]];
    const eventRoot = canvas.parentElement;
    listeners.forEach(([name, listener]) => eventRoot.addEventListener(name, listener, true));
    window.addEventListener('keydown', key, true);
    canvas.classList.add('is-polyline-picking');
    const trace = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: POLYLINE_EXECUTED_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
    trace.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300000), 3));
    trace.geometry.setDrawRange(0, 0); trace.frustumCulled = false; trace.renderOrder = 52;
    scene.add(trace); traceRef.current = trace; traceCountRef.current = 0;
    return () => {
      listeners.forEach(([name, listener]) => eventRoot.removeEventListener(name, listener, true));
      window.removeEventListener('keydown', key, true); canvas.classList.remove('is-polyline-picking');
      if (gesture?.index >= 0 && canvas.hasPointerCapture(gesture.id)) canvas.releasePointerCapture(gesture.id);
      disposeLayer(trace); traceRef.current = null;
      pickGeometry.dispose(); surface.material.dispose();
    };
  }, [open, active, sceneRevision]);

  useEffect(() => {
    if (!open || !active) return undefined;
    const { scene, camera, canvas } = getContext();
    if (!scene || !canvas) return undefined;
    const group = new THREE.Group(); scene.add(group); overlayRef.current = group;
    if (plan?.complete && plan.baseReference) {
      const trajectory = plan.segments.flatMap((segment) => segment.samples.map((sample) => {
        const position = polylineBasePose(plan.baseReference, sample.base).position;
        return new THREE.Vector3(position[0], position[1], position[2] + 0.015);
      }));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(trajectory),
        new THREE.LineBasicMaterial({ color: 0xc5a1ff, depthTest: false, transparent: true, opacity: 0.85 }));
      line.renderOrder = 49; group.add(line);
      if (plan.baseSearch) {
        const pose = polylineBasePose(plan.baseReference, plan.selectedBase);
        const center = new THREE.Vector3().fromArray(pose.position).add(new THREE.Vector3(0, 0, 0.015));
        const heading = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(pose.quaternion)).setZ(0).normalize();
        const tip = center.clone().addScaledVector(heading, 0.15);
        const side = new THREE.Vector3(-heading.y, heading.x, 0);
        const arrow = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([center, tip,
          tip, tip.clone().addScaledVector(heading, -0.04).addScaledVector(side, 0.025),
          tip, tip.clone().addScaledVector(heading, -0.04).addScaledVector(side, -0.025)]),
        new THREE.LineBasicMaterial({ color: 0xc5a1ff, depthTest: false }));
        arrow.renderOrder = 50; group.add(arrow);
      }
    }
    path.points.forEach((point, index) => {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({ color: index === selected ? 0xffdb7c : 0x50dce6, depthTest: false }));
      marker.position.fromArray(point.position); marker.userData.pointIndex = index; marker.renderOrder = 51; group.add(marker);
      const image = document.createElement('canvas'); image.width = 128; image.height = 64;
      const ctx = image.getContext('2d'); ctx.fillStyle = '#091c26'; ctx.fillRect(0, 0, 128, 64);
      ctx.font = 'bold 32px sans-serif'; ctx.fillStyle = '#effbff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`P${index}`, 64, 32);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(image), depthTest: false }));
      label.position.copy(marker.position); label.renderOrder = 52; label.userData.label = true; label.userData.marker = marker; group.add(label);
    });
    const pen = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xf4c95d, depthTest: false }));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf4c95d, depthTest: false }));
    tip.renderOrder = 51; pen.renderOrder = 50; group.add(pen, tip);
    let frame;
    const resize = () => {
      const currentRobot = live.current.getContext().robot;
      const tcp = readPolylineTcp(currentRobot, live.current.path);
      tip.visible = Boolean(tcp); pen.visible = Boolean(tcp);
      if (tcp) {
        const origin = currentRobot.getObjectByName(`tool_${live.current.path.side}`).getWorldPosition(new THREE.Vector3());
        const attribute = pen.geometry.getAttribute('position');
        attribute.setXYZ(0, origin.x, origin.y, origin.z); attribute.setXYZ(1, tcp.x, tcp.y, tcp.z); attribute.needsUpdate = true; pen.frustumCulled = false;
        tip.position.copy(tcp);
      }
      const projected = new THREE.Vector3();
      group.children.forEach((child) => {
        if (!(child.isMesh || child.isSprite)) return;
        projected.copy(child.position).applyMatrix4(camera.matrixWorldInverse);
        const scale = Math.max(1e-5, -projected.z) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (camera.zoom * canvas.clientHeight);
        if (child.isMesh) child.scale.setScalar(scale * (child.userData.pointIndex === selected ? 7 : 5));
        else {
          child.scale.set(scale * 34, scale * 17, 1);
          child.center.set(0.5, -0.5);
        }
      });
      frame = requestAnimationFrame(resize);
    }; resize();
    return () => { cancelAnimationFrame(frame); disposeLayer(group); if (overlayRef.current === group) overlayRef.current = null; };
  }, [path.points, path.closed, selected, plan, open, active, sceneRevision]);

  const check = async (sourcePath = live.current.path, autoPlay = false) => {
    autoPlayRef.current = false;
    const context = getContext();
    const action = normalizePolyline(sourcePath);
    if (!action) { setMessage('请检查速度、底盘范围与误差设置是否在允许范围内。'); return; }
    if (!context.robot || !context.geometry?.getIndex()) { setMessage('请加载机器人和带三角面的模型。'); return; }
    context.robot.updateWorldMatrix(true, true);
    const controller = getRobotEndEffector(context.robot, action.side);
    if (!controller) { setMessage('模型缺少所选侧的工具末端。'); return; }
    // Every check (including saved-path replay) starts from the live tool frame.
    // The recorded orientation describes the previous check, not a constraint
    // on a new plan after the user has adjusted the robot's posture.
    const withOrientation = { ...action, quaternion: controller.frame.getWorldQuaternion(new THREE.Quaternion()).toArray() };
    setPath(withOrientation); setStatus('checking'); setPlan(null); setSuggestionVisible(true); clearTrace(); setProgress(null); setElapsed(0);
    setMessage(action.base.search ? '正在搜索底盘位置，并检查预定位与完整折线路径。' : '检查到起点的移动、各条线段以及插值中的姿态。');
    snapshotRef.current = { key: contextKey(context) }; expectedRef.current = robotState(context);
    const controllerAbort = new AbortController(); abortRef.current = controllerAbort;
    try {
      const result = await planPolylineInWorker({ robot: context.robot, geometry: context.geometry, path: withOrientation,
        lockedJointNames: context.lockedJointNames, signal: controllerAbort.signal, onProgress: (value) => {
          setProgress(value);
          if (value.phase === 'suggestion') setMessage('到起点的连续逆解失败，正在寻找可行参考姿态…');
        } });
      if (controllerAbort.signal.aborted) return;
      if (!contextMatches(getContext())) { cancel('机器人或约束已改变，请重新检查。'); return; }
      const canExecute = isPolylinePlanExecutable(result);
      autoPlayRef.current = autoPlay && canExecute ? result : false;
      setPlan(result); setStatus(canExecute ? 'ready' : 'failed');
      setMessage(result.partial ? `最大保障：可执行 ${partialSummary(result)}，将在已检查部分的终点停止。`
        : result.complete ? `${result.warnings?.length ? `检查通过 · ${result.warnings.length} 项表面警告，可执行划线` : '检查通过'} · 最大采样误差 ${(result.maximumError * 1000).toFixed(2)} mm · ${result.checks} 次姿态检查`
        : `${checkLocation(result.issue, withOrientation.points.length)}：${result.issue.message}${result.suggestionSearch && !result.suggestion
          ? '。在当前搜索范围内未找到通过完整路线验证的参考姿态。' : ''}`);
    } catch (error) {
      if (error.name !== 'AbortError') { setStatus('failed'); setMessage(error.message); }
    } finally { if (abortRef.current === controllerAbort) abortRef.current = null; }
  };
  const adoptSuggestion = () => {
    const context = getContext(), suggestion = live.current.plan?.suggestion;
    if (!suggestion || busyStatuses.includes(live.current.status)) return;
    if (!contextMatches(context)) { cancel('机器人或约束已改变，请重新检查路径。'); return; }
    // Explicit virtual repositioning, not playback of an unverified transit.
    context.applyState({ joints: suggestion.joints, basePose: suggestion.basePose });
    check();
  };
  const play = () => {
    const current = live.current, context = getContext();
    if (!isPolylinePlanExecutable(current.plan)) return;
    if (!contextMatches(context)) { cancel('机器人、位置或约束已改变，请重新检查路径。'); return; }
    const runtime = runtimeRef.current || { elapsed: 0, last: null, lastUi: 0, plan: current.plan,
      toolTravel: 0, baseTravel: 0, previousTool: readPolylineTcp(context.robot, current.path),
      previousBase: context.robot.parent.getWorldPosition(new THREE.Vector3()) };
    runtime.last = null; runtimeRef.current = runtime; setStatus('playing');
    const frame = (timestamp) => {
      if (runtimeRef.current !== runtime) return;
      const now = live.current.getContext();
      if (!live.current.open || !live.current.active || !contextMatches(now)) { cancel('执行已停止：机器人状态或工作区发生变化，请重新检查。'); return; }
      if (runtime.last !== null) runtime.elapsed += Math.min(60, Math.max(0, timestamp - runtime.last));
      runtime.last = timestamp;
      const sample = samplePolylinePlan(runtime.plan, runtime.elapsed);
      now.applyState(sample); expectedRef.current = robotState(now);
      executedRef.current = { plan: runtime.plan, sample };
      previewRef.current?.update();
      const actual = readPolylineTcp(now.robot, live.current.path);
      const basePosition = now.robot.parent.getWorldPosition(new THREE.Vector3());
      runtime.toolTravel += actual.distanceTo(runtime.previousTool);
      runtime.baseTravel += basePosition.distanceTo(runtime.previousBase);
      runtime.previousTool.copy(actual); runtime.previousBase.copy(basePosition);
      if (sample.drawing && traceRef.current) {
        const attribute = traceRef.current.geometry.getAttribute('position'), count = traceCountRef.current;
        const previous = count ? new THREE.Vector3().fromBufferAttribute(attribute, count - 1) : null;
        if (count < attribute.count && (!previous || previous.distanceTo(actual) > 0.0003 || sample.done)) {
          attribute.setXYZ(count, actual.x, actual.y, actual.z); attribute.needsUpdate = true;
          traceCountRef.current += 1; traceRef.current.geometry.setDrawRange(0, traceCountRef.current);
        }
      }
      if (timestamp - runtime.lastUi > 80 || sample.done) {
        setElapsed(Math.min(runtime.elapsed, runtime.plan.durationMs)); runtime.lastUi = timestamp;
        setTravel({ tool: runtime.toolTravel, base: runtime.baseTravel });
        setMessage(sample.drawing ? `${runtime.plan.partial ? '部分划线' : '划线'} P${sample.segmentIndex} → P${(sample.segmentIndex + 1) % live.current.path.points.length}`
          : sample.phase === 'positioning' ? '底盘与机械臂正在预定位 · 尚未划线' : '正在沿已检查路径移动到起点 · 尚未划线');
      }
      if (sample.done) {
        runtimeRef.current = null; setStatus('completed');
        setMessage(runtime.plan.partial ? `已完成可执行部分 ${partialSummary(runtime.plan)}，已停在可达终点；原折线及未执行部分保留。`
          : '划线完成，已停在终点。可保存折线；再次执行前请重新检查。'); return;
      }
      animationRef.current = requestAnimationFrame(frame);
    };
    animationRef.current = requestAnimationFrame(frame);
  };
  const pause = () => {
    cancelAnimationFrame(animationRef.current);
    const runtime = runtimeRef.current;
    if (runtime) { setElapsed(runtime.elapsed); setTravel({ tool: runtime.toolTravel, base: runtime.baseTravel }); }
    setStatus('paused'); setMessage('已暂停，继续执行将从当前位置开始。');
  };
  const save = async () => {
    if (savingRef.current) return;
    const action = normalizePolyline(path);
    if (!action || action.points.length < 2) { setMessage('请至少选择两个点，并检查速度与笔尖偏移设置。'); return; }
    const frame = getRobotEndEffector(getContext().robot, action.side)?.frame;
    if (!action.quaternion && frame) action.quaternion = frame.getWorldQuaternion(new THREE.Quaternion()).toArray();
    const previousStatus = status;
    savingRef.current = true; setStatus('saving'); setMessage('正在保存折线、工具距离与底盘模式…');
    try {
      const saved = await onSave(action);
      if (saved) { setPath(saved); setMessage('折线已保存至当前示教任务，随工程自动保存。重新打开后需重新检查。'); }
      else setMessage('当前机器人或工程尚未就绪，请稍后再保存。');
    } catch (error) { setMessage(`保存失败：${error.message}`); }
    finally { savingRef.current = false; setStatus(previousStatus); }
  };

  useEffect(() => {
    if (!autoPlayRef.current || !open || !active
      || (openRequest && handledOpenRequestRef.current !== openRequest.id)) return;
    if (status === 'ready' && isPolylinePlanExecutable(plan) && autoPlayRef.current === plan) { autoPlayRef.current = false; play(); }
    else if (status === 'failed') autoPlayRef.current = false;
  }, [status, plan, open, active, openRequest?.id]);

  useEffect(() => {
    if (!openRequest || handledOpenRequestRef.current === openRequest.id || !open || !active) return;
    handledOpenRequestRef.current = openRequest.id;
    onRequestHandled?.(openRequest.id);
    if (busy) return;
    const saved = normalizePolyline(openRequest.path);
    if (!saved || saved.points.length < 2) { setMessage('这条折线数据不完整，无法打开。'); return; }
    autoPlayRef.current = false;
    edit(saved, -1); setOperation('view'); setPreviewVisible(true); setElapsed(0);
    if (openRequest.action === 'play') check(saved, true);
    else setMessage('');
  }, [openRequest, open, active, busy]);

  if (!open || !active || !container) return null;
  const distance = polylineVertices(path).reduce((sum, point, i, points) => i ? sum + point.distanceTo(points[i - 1]) : 0, 0);
  return createPortal(<section className="polyline-teaching" data-layout="sidebar"
    aria-label="表面折线示教" data-path-id={path.id} data-status={status} data-point-count={path.points.length} data-undo-count={history.length} data-warning-count={warnings.length}
    data-plan-partial={Boolean(plan?.partial)} data-plan-executable={executable} data-planned-distance={plan?.distance || 0}
    data-suggestion-found={Boolean(plan?.suggestion)}
    data-planned-end={plan?.stoppedAt ? JSON.stringify(plan.stoppedAt.position) : ''}
    data-elapsed-ms={elapsed} data-duration-ms={plan?.durationMs || 0} data-tool-travel-mm={travel.tool * 1000} data-base-travel-mm={travel.base * 1000}>
    <header>
      <div><span className="polyline-teaching__eyebrow">CARTESIAN PATH</span><strong><MousePointer2 size={16} /> 表面折线示教</strong></div>
      <button type="button" aria-label="关闭折线示教" title="返回图谱控制台" disabled={status === 'saving'} onClick={onClose}><X size={17} /></button></header>
    <div className="polyline-teaching__body">
      <div className="polyline-teaching__status" data-state={status} data-warning={warnings.length > 0 || plan?.partial}><i />{plan?.partial && status === 'ready' ? '可执行部分轨迹'
        : plan?.partial && status === 'completed' ? '部分划线完成'
          : status === 'ready' && warnings.length ? '检查通过 · 有表面警告' : statusLabels[status]}<span>{path.points.length} 点 · {(distance * 1000).toFixed(0)} mm</span></div>
      <div className="polyline-teaching__preview">
        <label><input type="checkbox" checked={previewVisible} onChange={(event) => setPreviewVisible(event.target.checked)} />
          <i aria-hidden="true" />显示笔尖路径预览</label>
        <span>{path.points.length < 2 ? '至少选择 2 点' : previewVisible ? '已显示' : '已隐藏'}</span>
      </div>
      {plan?.suggestion && <div className="polyline-teaching__suggestion" role="note" aria-label="可行起始姿态建议">
        <strong>找到可行起始姿态</strong>
        <span>{plan.suggestion.movedBase
          ? `建议底盘平移 ${Math.hypot(plan.suggestion.baseDelta.x, plan.suggestion.baseDelta.y).toFixed(3)} m · 转向 ${plan.suggestion.baseDelta.yaw.toFixed(1)}°`
          : '底盘位置保持不变'}</span>
        {plan.suggestion.orientationChange > .5 && <span>工具朝向调整 {plan.suggestion.orientationChange.toFixed(1)}°</span>}
        <small>已验证从 P0 起的完整路线；到虚影位置的移动未规划。</small>
        <label><input type="checkbox" checked={suggestionVisible} onChange={(event) => setSuggestionVisible(event.target.checked)} />显示参考虚影</label>
        {!showRobot && <small>请在顶部显示设置中开启机器人模型以查看虚影。</small>}
        <div><button type="button" disabled={!suggestionVisible || !showRobot} onClick={() => getContext().focusSuggestion?.()}>定位虚影</button>
          <button type="button" onClick={adoptSuggestion} title="直接设置虚拟机器人的位置与关节姿态，然后重新检查；不会播放到虚影的移动">采用虚影并重新检查</button></div>
      </div>}
      {warnings.length > 0 && <details className="polyline-teaching__warnings" open><summary>表面警告 · {warnings.length} 项</summary>
        <p>表面警告不阻止虚拟划线，检查通过后可直接执行。</p>
        <ul aria-label="表面警告列表">{warnings.map((warning) => <li key={`${warning.phase}:${warning.segmentIndex}:${warning.code}`}>
          <strong>{checkLocation(warning, path.points.length)}</strong><span>{warning.message}</span>
        </li>)}</ul>
      </details>}
      <label className="polyline-teaching__field">名称<input aria-label="折线名称" value={path.name} disabled={busy} maxLength={80}
        onChange={(event) => setPath({ ...path, name: event.target.value })} /></label>
      <div className="polyline-teaching__columns">
        <label className="polyline-teaching__field">执行机械臂<select aria-label="折线执行机械臂" disabled={busy} value={path.side}
          onChange={(event) => edit({ ...path, side: event.target.value, quaternion: null })}><option value="left">左臂 · tool_left</option><option value="right">右臂 · tool_right</option></select></label>
        <label className="polyline-teaching__field">速度上限 · mm/s<PolylineNumberInput aria-label="折线速度 mm/s" min={1} max={200} step="5" disabled={busy}
          value={path.settings.speed * 1000} onCommit={(value) => edit({ ...path, settings: { ...path.settings, speed: value / 1000 } })} /></label>
      </div>
      <div className="polyline-teaching__columns">
        <label className="polyline-teaching__field">末端距线段 · mm<PolylineNumberInput aria-label="末端距线段 mm" min={0} max={1000} step="5" disabled={busy}
          value={Math.abs(toolZ) * 1000} onCommit={(value) => setToolDistance(value / 1000)} /></label>
        <label className="polyline-teaching__field">从末端指向线段<select aria-label="末端距线段方向" disabled={busy} value={toolDirection}
          onChange={(event) => setToolDistance(Math.abs(toolZ), Number(event.target.value))}>
          <option value={-1}>工具 −Z</option><option value={1}>工具 +Z</option>
        </select></label>
      </div>
      <p className="polyline-teaching__hint">沿工具轴保留 0–1000 mm 的距离，工具朝向保持固定。距离以工具末端原点为准，可按相机或探针的安装位置调整。</p>
      <fieldset className="polyline-teaching__base" disabled={busy}><legend>底盘规划</legend>
        <div className="polyline-teaching__base-modes">
          <div className="polyline-teaching__base-fixed">
            <label><input type="checkbox" checked={!baseMoving} onChange={() => edit({ ...path, base: { ...baseOptions, sync: false, search: false } })} />底盘静止</label>
            <label className={baseMoving ? 'is-disabled' : ''} title="仅底盘静止时生效：完整规划失败时，保留从起点连续通过检查的部分">
              <input type="checkbox" checked={baseOptions.allowPartial} disabled={baseMoving}
                onChange={(event) => edit({ ...path, base: { ...baseOptions, allowPartial: event.target.checked } })} />最大保障</label>
          </div>
          <label><input type="checkbox" checked={baseOptions.sync} onChange={(event) => edit({ ...path, base: { ...baseOptions, sync: event.target.checked } })} />底盘同步</label>
          <label><input type="checkbox" checked={baseOptions.search} onChange={(event) => edit({ ...path, base: { ...baseOptions, search: event.target.checked } })} />底盘自搜索</label>
        </div>
        <p className="polyline-teaching__hint">{baseOptions.search
          ? baseOptions.sync ? '先搜索合适的起始位置，再由底盘与机械臂同步沿线运动。' : '先搜索并预定位，划线期间底盘位置与姿态保持不变。'
          : baseOptions.sync ? '从当前位置开始，底盘平移、转向与机械臂联合规划。'
            : baseOptions.allowPartial ? '底盘保持不动；无法完整划线时，执行从起点连续通过检查的部分，到可达终点停止。'
              : '严格保持当前底盘位置与姿态，仅规划所选机械臂；可勾选最大保障，保留从起点可执行的部分。'}</p>
        {baseMoving && <><div className="polyline-teaching__columns">
          <label className="polyline-teaching__field">水平范围 · m<PolylineNumberInput aria-label="底盘水平范围 m" min={0.05} max={10} step="0.1" value={baseOptions.range}
            onCommit={(value) => edit({ ...path, base: { ...baseOptions, range: value } })} /></label>
          <label className="polyline-teaching__field">转向范围 · ±°<PolylineNumberInput aria-label="底盘转向范围 °" min={0} max={180} step="15" value={baseOptions.yawRange}
            onCommit={(value) => edit({ ...path, base: { ...baseOptions, yawRange: value } })} /></label>
        </div><p className="polyline-teaching__hint">范围以检查时的底盘位置和朝向为中心；保持高度和倾斜。平移上限 100 mm/s，转向上限 15°/s。预定位不划线。</p></>}
      </fieldset>
      {plan?.partial && <div className="polyline-teaching__partial-result" role="note" aria-label="最大保障结果">
        <strong>最大保障 · 部分轨迹可执行</strong>
        <span>可划线 {partialSummary(plan)}</span>
        <span>停止位置：P{plan.stoppedAt.segmentIndex} → P{(plan.stoppedAt.segmentIndex + 1) % path.points.length} 的 {(plan.stoppedAt.progress * 100).toFixed(1)}%</span>
        <small>停止原因：{plan.issue.message}</small>
        <small>绿色为待执行的可达部分，红色为不可执行部分，橘黄色为已执行部分。</small>
      </div>}
      {selectedBasePose && <div className="polyline-teaching__base-result" aria-label="底盘搜索结果">
        <strong>已选底盘起始位置</strong>
        <span>X {selectedBasePose.position[0].toFixed(3)} · Y {selectedBasePose.position[1].toFixed(3)} m · 朝向 {(Math.atan2(selectedHeading.y, selectedHeading.x) * 180 / Math.PI).toFixed(1)}°</span>
        <small>{plan.baseSearch.candidates} 个候选 · {plan.baseSearch.checked} 个完整检查 · {plan.baseSearch.feasible} 个通过；综合关节余量与底盘移动距离择优。</small>
      </div>}
      <details className="polyline-teaching__tcp"><summary>虚拟笔尖偏移（高级）· 工具坐标系 · mm</summary><div className="polyline-teaching__tcp-fields">
        {['X', 'Y', 'Z'].map((axis, index) => <label className="polyline-teaching__field" key={axis}>{axis}<PolylineNumberInput min={-1000} max={1000} step="5"
          aria-label={`笔尖偏移 ${axis} mm`} disabled={busy} value={(path.tcpOffset || [0, 0, 0])[index] * 1000}
          onCommit={(next) => edit({ ...path, toolAxisDirection: index === 2 ? Math.sign(next) || toolDirection : toolDirection,
            tcpOffset: (path.tcpOffset || [0, 0, 0]).map((value, i) => i === index ? next / 1000 : value) })} /></label>)}
      </div><p className="polyline-teaching__hint">Z 与上方距离联动，不额外叠加；X/Y 可补偿安装偏移。金色点是沿线参考点，金色连线表示末端偏移。</p></details>
      <div className="polyline-teaching__edit-actions">
        <button type="button" disabled={busy} aria-pressed={operation === 'append'} onClick={() => setOperation('append')}><Plus size={13} />连续点选</button>
        <button type="button" disabled={busy || selected < 0} aria-pressed={operation === 'insert'} onClick={() => setOperation('insert')}>在选中点后插入</button>
        <button type="button" disabled={busy || selected < 0} aria-pressed={operation === 'replace'} onClick={() => setOperation('replace')}>移动选中点</button>
      </div>
      <button type="button" className="polyline-teaching__view" aria-pressed={operation === 'view'} onClick={() => setOperation(operation === 'view' ? 'append' : 'view')}>
        {operation === 'view' ? '返回表面点选' : '仅调整视角'}</button>
      {path.points.length ? <ol className="polyline-teaching__points" aria-label="折线点列表">{path.points.map((point, index) => <li key={point.id}>
        <button type="button" disabled={busy} aria-pressed={selected === index} onClick={() => setSelected(index)} aria-label={`选择折线点 P${index}`}>
          <b>P{index}</b><span>{point.position.map((value) => value.toFixed(3)).join(' / ')}</span><small>m</small></button>
        <button type="button" disabled={busy} aria-label={`删除折线点 P${index}`} onClick={() => edit({ ...path, closed: path.closed && path.points.length > 3, points: path.points.filter((_, i) => i !== index) }, -1)}><Trash2 size={12} /></button>
      </li>)}</ol> : <div className="polyline-teaching__empty"><MousePointer2 size={24} /><strong>在物体上点出第一条路线</strong><span>单击添加点，拖动已有点重新吸附表面。<br />左键拖动旋转 · 右键平移 · 滚轮缩放</span></div>}
      <div className="polyline-teaching__row"><label><input type="checkbox" checked={path.closed} disabled={busy || path.points.length < 3}
        onChange={(event) => edit({ ...path, closed: event.target.checked })} />闭合折线</label><button type="button" disabled={busy || !history.length} onClick={() => {
          const previous = history.at(-1); setHistory(history.slice(0, -1)); setPath(previous); setSelected(-1); setPlan(null); setStatus('editing'); clearTrace();
        }}><RotateCcw size={12} />撤销</button><button type="button" disabled={busy} onClick={() => { edit(fresh(), -1); setOperation('append'); }}>新建</button></div>
      <p className="polyline-teaching__hint">严格直线连接 · 拐角停顿 · 橘黄色为已执行部分；{previewPlan?.partial ? '绿色为待执行的可达部分，红色为不可执行部分。' : '未执行部分保持原色：青色为目标，橙色为表面警告。'}{baseMoving && '紫色为底盘计划路径，箭头表示搜索选中的起始朝向。'}</p>
      <details className="polyline-teaching__library"><summary>已保存折线 <b>{savedPaths.length}</b></summary>
        {savedPaths.length ? savedPaths.map(({ taskId, taskName, path: saved }) => <div key={`${taskId}:${saved.id}`}>
          <button type="button" disabled={busy} onClick={() => { edit(structuredClone(saved), -1); setOperation('append'); setMessage('已载入折线，请从当前机器人姿态重新检查。'); }}><strong>{saved.name}</strong><small>{taskName} · {saved.points.length} 点</small></button>
          <button type="button" disabled={busy} aria-label={`删除已保存折线 ${saved.name}`} onClick={() => { onDelete(taskId, saved.id); if (path.id === saved.id) setPath({ ...path, id: '' }); }}><Trash2 size={13} /></button>
        </div>) : <p>保存后可在这里重新打开。</p>}
      </details>
    </div>
    <footer className="polyline-teaching__footer">
      {message && <div className="polyline-teaching__message" role="status" data-error={status === 'failed'}>{message}
        {status === 'checking' && progress && <small>{['search', 'suggestion'].includes(progress.phase) ? `${progress.stage} ${progress.candidate}/${progress.candidates}`
          : progress.phase === 'positioning' ? '底盘预定位' : progress.segmentIndex < 0 ? '到起点' : `线段 ${progress.segmentIndex + 1}/${progress.total}`} · {Math.round(progress.fraction * 100)}%</small>}</div>}
      {executable && <div className="polyline-teaching__progress"><progress max={plan.durationMs} value={elapsed} /><span>{(elapsed / 1000).toFixed(1)} / {(plan.durationMs / 1000).toFixed(1)} s</span></div>}
      {executable && <div className="polyline-teaching__motion" aria-label="划线实际移动距离">
        <span>末端已移动 <b>{(travel.tool * 1000).toFixed(1)}</b> mm</span>
        <span>底盘已移动 <b>{(travel.base * 1000).toFixed(1)}</b> mm</span>
      </div>}
      <div className="polyline-teaching__primary">
        <button type="button" disabled={busy || path.points.length < 2} onClick={() => check()}><Check size={14} />检查路径</button>
        {status === 'playing' ? <button type="button" onClick={pause}><Pause size={14} />暂停</button>
          : <button type="button" disabled={!['ready', 'paused'].includes(status)} onClick={play}><Play size={14} />{status === 'paused' ? '继续' : plan?.partial ? '执行可达部分' : '执行划线'}</button>}
        {busy && status !== 'saving' && <button type="button" aria-label="停止折线任务" onClick={() => cancel()}><Square size={12} /></button>}
        <button type="button" disabled={busy || path.points.length < 2} onClick={save}><Save size={14} />保存</button>
      </div>
    </footer>
  </section>, container);
}
