import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { Crosshair, LoaderCircle, Pause, Play, TriangleAlert } from 'lucide-react';
import { applyRobotJointValues, configureRobotArmSoftLimits, disposeRobotModel,
  loadRobotModel, setRobotJointValue, setRobotVisualBounds } from '../lib/robotLoader.js';
import { getRobotSoftLimitRange } from '../lib/robotJointLimits.js';

const CYCLE_SECONDS = 8;

// Each preview owns its model resources. Endpoint clones share geometry only
// inside this bundle, which is disposed once as a whole when the page closes.
function endpointGhost(model, name, color) {
  const ghost = model.clone(true);
  ghost.name = name;
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.27,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  ghost.traverse((node) => { if (node.isMesh) node.material = material; });
  return ghost;
}

export default function RobotJointLimitPreview({ robot, joint, values, ratio, overrides }) {
  const viewportRef = useRef(null), canvasRef = useRef(null), readoutRef = useRef(null);
  const contextRef = useRef(null), modelsRef = useRef(null), animationRef = useRef({ elapsed: 0 });
  const configRef = useRef({ joint, values, ratio, overrides });
  configRef.current = { joint, values, ratio, overrides };
  const [playing, setPlaying] = useState(true);
  const playingRef = useRef(playing); playingRef.current = playing;
  const [load, setLoad] = useState({ status: 'loading', detail: '正在装配预览模型' });
  const [revision, setRevision] = useState(0);
  const fittedJointRef = useRef('');

  const fitView = useCallback(() => {
    const context = contextRef.current, models = modelsRef.current;
    const selected = configRef.current.joint;
    if (!context || !models || !selected) return;
    const { solid } = models, node = solid.getObjectByName(selected.name);
    if (!node) return;
    const previous = node.userData.jointValue;
    const bounds = new THREE.Box3(), sample = new THREE.Box3();
    // Fit the full hard sweep once per selected joint, so dragging the soft
    // endpoints does not zoom the camera or clip a newly expanded range.
    const priorRatio = node.userData.armSoftLimitRatio, priorRange = node.userData.armSoftLimitRange;
    node.userData.armSoftLimitRatio = 1; delete node.userData.armSoftLimitRange;
    for (let i = 0; i <= 24; i += 1) {
      setRobotJointValue(node, THREE.MathUtils.degToRad(selected.hardLower + (selected.hardUpper - selected.hardLower) * i / 24));
      solid.updateMatrixWorld(true); bounds.union(setRobotVisualBounds(sample, solid));
    }
    node.userData.armSoftLimitRatio = priorRatio;
    if (priorRange) node.userData.armSoftLimitRange = priorRange;
    setRobotJointValue(node, previous); solid.updateMatrixWorld(true);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.35);
    const halfFov = THREE.MathUtils.degToRad(context.camera.fov / 2);
    const angle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * context.camera.aspect));
    const distance = radius / Math.sin(angle) * 1.08;
    context.controls.reset();
    context.camera.up.set(0, 0, 1);
    context.camera.position.copy(center).addScaledVector(new THREE.Vector3(1, -0.3, 0.12).normalize(), distance);
    context.camera.near = Math.max(0.002, radius / 150);
    context.camera.far = Math.max(180, distance * 12);
    context.controls.target.copy(center);
    context.controls.minDistance = radius * 0.25;
    context.controls.maxDistance = distance * 6;
    context.camera.updateProjectionMatrix(); context.controls.update();
    context.grid.scale.setScalar(Math.max(2, Math.ceil(size.length() * 2)) / 10);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current, viewport = viewportRef.current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
    catch (error) { setLoad({ status: 'error', detail: error.message || '无法创建 3D 预览' }); return undefined; }
    renderer.setClearColor(0x061116); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, 0.002, 180);
    camera.up.set(0, 0, 1); camera.position.set(4, -1, 2);
    const controls = new TrackballControls(camera, canvas);
    controls.rotateSpeed = 3.1; controls.zoomSpeed = 1.1; controls.panSpeed = 0.72;
    controls.dynamicDampingFactor = 0.16; controls.keys = [];
    const grid = new THREE.GridHelper(10, 20, 0x285d62, 0x15363a);
    grid.rotation.x = Math.PI / 2; grid.position.z = -0.003;
    grid.material.transparent = true; grid.material.opacity = 0.45;
    scene.add(grid, new THREE.HemisphereLight(0xd8f7ff, 0x172024, 2.2));
    for (const [color, intensity, position] of [[0xffffff, 2.8, [4, -5, 8]], [0x8cddf2, 1.5, [-5, 2, 3]]]) {
      const light = new THREE.DirectionalLight(color, intensity); light.position.fromArray(position); scene.add(light);
    }
    contextRef.current = { scene, camera, renderer, controls, grid };
    const resize = () => {
      const { width, height } = viewport.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(Math.max(2, width), Math.max(2, height), false);
      camera.aspect = Math.max(2, width) / Math.max(2, height); camera.updateProjectionMatrix(); controls.handleResize();
    };
    const observer = new ResizeObserver(resize); observer.observe(viewport); resize();
    let frame = 0, previousTime = 0, lastReadout = 0;
    const render = (now) => {
      frame = requestAnimationFrame(render);
      const animation = animationRef.current;
      if (playingRef.current && !document.hidden && animation.node) animation.elapsed += Math.min((now - previousTime) / 1000 || 0, 0.08);
      previousTime = now;
      if (animation.node) {
        const progress = (1 - Math.cos(animation.elapsed * Math.PI * 2 / CYCLE_SECONDS)) / 2;
        const angle = animation.lower + (animation.upper - animation.lower) * progress;
        setRobotJointValue(animation.node, THREE.MathUtils.degToRad(angle));
        if (now - lastReadout > 80) {
          canvas.dataset.angle = String(angle); canvas.dataset.phase = String(progress);
          canvas.dataset.playing = String(playingRef.current);
          if (readoutRef.current) readoutRef.current.textContent = `${angle.toFixed(1)}°`;
          lastReadout = now;
        }
      }
      controls.update(); renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    const preventContextMenu = (event) => event.preventDefault(); canvas.addEventListener('contextmenu', preventContextMenu);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      canvas.removeEventListener('contextmenu', preventContextMenu);
      if (modelsRef.current) disposeRobotModel(modelsRef.current.bundle);
      modelsRef.current = null; contextRef.current = null;
      grid.geometry.dispose(); grid.material.dispose(); renderer.dispose(); scene.clear();
      // StrictMode reuses the same canvas for its effect probe; lose the GL
      // context only after a real unmount, never during that remount.
      queueMicrotask(() => { if (!canvas.isConnected) renderer.forceContextLoss(); });
    };
  }, []);

  useEffect(() => {
    const context = contextRef.current;
    if (!context || !robot) return undefined;
    const controller = new AbortController();
    let bundle;
    setLoad({ status: 'loading', detail: '正在装配预览模型' });
    loadRobotModel(robot, { signal: controller.signal }).then((solid) => {
      if (controller.signal.aborted || contextRef.current !== context) { disposeRobotModel(solid); return; }
      bundle = new THREE.Group();
      const start = endpointGhost(solid, 'soft-limit-start', 0xff6464);
      const end = endpointGhost(solid, 'soft-limit-end', 0x439fff);
      bundle.add(solid, start, end); context.scene.add(bundle);
      modelsRef.current = { bundle, solid, start, end }; fittedJointRef.current = '';
      setLoad({ status: 'ready', detail: '' }); setRevision((value) => value + 1);
    }).catch((error) => {
      if (!controller.signal.aborted) setLoad({ status: 'error', detail: error.message || '预览加载失败' });
    });
    return () => {
      controller.abort();
      animationRef.current = { elapsed: 0 };
      if (bundle) disposeRobotModel(bundle);
      if (modelsRef.current?.bundle === bundle) modelsRef.current = null;
    };
  }, [robot]);

  useEffect(() => {
    const models = modelsRef.current, canvas = canvasRef.current;
    if (!models || !joint) return;
    const range = getRobotSoftLimitRange(joint.name, ratio, overrides[joint.name]);
    const lower = joint.hardLower + (joint.hardUpper - joint.hardLower) * range.lower;
    const upper = joint.hardLower + (joint.hardUpper - joint.hardLower) * range.upper;
    for (const model of [models.solid, models.start, models.end]) {
      configureRobotArmSoftLimits(model, ratio, overrides); applyRobotJointValues(model, values);
    }
    const node = models.solid.getObjectByName(joint.name);
    setRobotJointValue(models.start.getObjectByName(joint.name), THREE.MathUtils.degToRad(lower));
    setRobotJointValue(models.end.getObjectByName(joint.name), THREE.MathUtils.degToRad(upper));
    setRobotJointValue(node, THREE.MathUtils.degToRad(lower));
    animationRef.current = { node, lower, upper, elapsed: 0 };
    Object.assign(canvas.dataset, { joint: joint.name, lower: String(lower), upper: String(upper), ghostCount: '2', angle: String(lower) });
    if (fittedJointRef.current !== joint.name) { fitView(); fittedJointRef.current = joint.name; }
  }, [joint, values, ratio, overrides, revision, fitView]);

  return <section className="joint-limit-preview" aria-label="关节软限位动画预览" data-status={load.status}>
    <header><span><i />单关节循环预览</span><button type="button" onClick={fitView} disabled={load.status !== 'ready'}><Crosshair size={13} />复位视角</button></header>
    <div className="joint-limit-preview__viewport" ref={viewportRef}>
      <canvas ref={canvasRef} className="joint-limit-preview__canvas" tabIndex={0} aria-label="软限位机器人 3D 预览" />
      {load.status !== 'ready' && <div className="joint-limit-preview__state" role={load.status === 'error' ? 'alert' : 'status'}>
        {load.status === 'loading' ? <LoaderCircle className="is-spinning" size={24} /> : <TriangleAlert size={24} />}<span>{load.detail}</span>
      </div>}
      <div className="joint-limit-preview__legend">
        <span><i className="is-start" />红色虚影 · 起点 / 下限</span>
        <span><i className="is-end" />蓝色虚影 · 终点 / 上限</span>
        <span><i />实体模型 · 当前角度</span>
      </div>
    </div>
    <div className="joint-limit-preview__transport">
      <button type="button" disabled={load.status !== 'ready'} onClick={() => setPlaying((value) => !value)}
        aria-label={playing ? '暂停软限位预览' : '播放软限位预览'}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? '暂停' : '播放'}</button>
      <span>{joint?.name}<strong ref={readoutRef}>—</strong></span><small>起点 ⇄ 终点 · 8 s / 循环</small>
    </div>
    <p>拖动旋转 · 滚轮缩放。仅展示单关节范围，不包含碰撞和关节耦合检查。</p>
  </section>;
}
