import { useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, Color, PerspectiveCamera, Points, PointsMaterial, Scene, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RotateCcw } from 'lucide-react';
import { colorRobotTwinPointCloud } from '../lib/robotTwinPointCloud.js';

export default function RobotTwinPointCloud({ cloud, inspection, label }) {
  const host = useRef(null), reset = useRef(null), viewer = useRef(null);
  const [error, setError] = useState('');
  const annotationKey = JSON.stringify({ state: inspection?.state, abnormal: inspection?.abnormal, boxes: inspection?.boxes,
    pixelMapping: inspection?.pixelMapping, imageWidth: inspection?.imageWidth, imageHeight: inspection?.imageHeight });
  const annotation = useMemo(() => colorRobotTwinPointCloud(cloud, JSON.parse(annotationKey)), [cloud, annotationKey]);
  useEffect(() => {
    const element = host.current;
    let renderer, geometry, material, controls, observer;
    setError('');
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.setAttribute('role', 'img'); renderer.domElement.setAttribute('aria-label', `${label}点云`);
      renderer.domElement.dataset.pointCount = String(cloud.count);
      element.append(renderer.domElement);
      const scene = new Scene(); scene.background = new Color('#081714');
      const camera = new PerspectiveCamera(42, 1, 0.001, 1000);
      geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(cloud.positions, 3));
      geometry.setAttribute('color', new BufferAttribute(new Uint8Array(cloud.colors), 3, true));
      geometry.computeBoundingSphere();
      material = new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true });
      scene.add(new Points(geometry, material));
      const center = geometry.boundingSphere.center.clone(), radius = Math.max(geometry.boundingSphere.radius, 0.01);
      controls = new OrbitControls(camera, renderer.domElement); controls.minDistance = radius * 0.05; controls.maxDistance = radius * 30;
      const render = () => renderer.render(scene, camera);
      viewer.current = { colors: geometry.getAttribute('color'), canvas: renderer.domElement, render };
      const fit = () => {
        const angle = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.min(camera.aspect, 1));
        const distance = radius / Math.sin(angle) * 1.15;
        camera.near = Math.max(radius / 10000, 0.00001); camera.far = radius * 1000; camera.updateProjectionMatrix();
        camera.up.set(0, 1, 0); camera.position.copy(center).add(new Vector3(0, 0, distance));
        controls.target.copy(center); controls.update(); render();
      };
      reset.current = fit;
      const resize = () => {
        const { width, height } = element.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); fit();
      };
      controls.addEventListener('change', render);
      observer = new ResizeObserver(resize); observer.observe(element); resize();
    } catch { setError('当前浏览器无法显示三维点云'); }
    return () => {
      reset.current = null; viewer.current = null; observer?.disconnect(); controls?.dispose(); geometry?.dispose(); material?.dispose();
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
  }, [cloud, label]);
  useEffect(() => {
    const current = viewer.current;
    if (!current) return;
    // Late algorithm results update only colors, preserving the loaded cloud
    // and the user's orbit/zoom. Clearing annotations restores the base colors.
    current.colors.array.set(annotation.colors); current.colors.needsUpdate = true;
    current.canvas.dataset.highlightedPointCount = String(annotation.highlighted);
    current.canvas.dataset.confirmedPointCount = String(annotation.confirmedPoints);
    current.canvas.dataset.suspectedPointCount = String(annotation.suspectedPoints);
    current.render();
  }, [cloud, label, annotation]);
  return <div className="robot-twin-cloud">
    <div ref={host} className="robot-twin-cloud__canvas" />
    {error ? <p className="robot-twin-capture__empty" role="status">{error}</p> : <>
      <button type="button" className="robot-twin-capture__icon robot-twin-cloud__reset" onClick={() => reset.current?.()} aria-label={`重置${label}点云视角`} title="重置视角"><RotateCcw size={14} /></button>
      {annotation.warning ? <span className="robot-twin-cloud__annotation is-warning" role="status">{annotation.warning}</span>
        : annotation.highlighted > 0 && <span className="robot-twin-cloud__annotation">
          {annotation.confirmedPoints > 0 && <span><i />红色为异常区域</span>}
          {annotation.suspectedPoints > 0 && <span className="is-suspected"><i />黄色为疑似区域</span>}
        </span>}
      <span className="robot-twin-cloud__hint">拖动旋转 · 滚轮缩放</span>
      <span className="robot-twin-cloud__count">{cloud.count.toLocaleString()} / {cloud.valid.toLocaleString()} 点</span>
    </>}
  </div>;
}
