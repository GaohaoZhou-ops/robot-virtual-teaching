import * as THREE from 'three';
import { createTeachingSurfaceProjectionOverlay, disposeTeachingSurfaceProjectionOverlay } from '../../cameras/model/visionCoverage.js';
import { createRobotTwinProjectionKinematics, ROBOT_TWIN_COVERAGE_ATTRIBUTE } from './robotTwinProjection.js';

export class RobotTwinProjectionLayer {
  constructor({ scene, model, geometry, displayGeometry, surfaceGeometry, material, canvas, onStatus }) {
    Object.assign(this, { scene, displayGeometry, surfaceGeometry, material, canvas, onStatus });
    this.records = new Map(); this.frames = []; this.overlays = []; this.visible = { left: true, right: true }; this.counts = [0, 0, 0, 0];
    this.kinematics = createRobotTwinProjectionKinematics(model);
    this.revision = 0; this.pending = false; this.dirty = false;
    this.attribute = displayGeometry.getAttribute(ROBOT_TWIN_COVERAGE_ATTRIBUTE)
      || new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1);
    displayGeometry.setAttribute(ROBOT_TWIN_COVERAGE_ATTRIBUTE, this.attribute);
    this.worker = new Worker(new URL('../workers/robotTwinProjection.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      this.pending = false;
      if (data.revision === this.revision) {
        if (data.error) { onStatus('投影计算失败，请重新连接后重试'); canvas.dataset.twinProjectionState = 'error'; }
        else {
          this.frames = data.frames; this.counts = data.counts; this.attribute.array.set(data.mask); this.attribute.needsUpdate = true;
          this.rebuild(); onStatus('');
          canvas.dataset.twinProjectionState = this.frames.length ? 'ready' : 'empty';
          canvas.dataset.twinProjectionFrameCount = String(this.frames.length);
          canvas.dataset.twinProjectionPoses = JSON.stringify(this.frames.map(({ record }) => ({ key: record.key, side: record.side, ...record.frame.opticalPose })));
        }
      }
      if (this.dirty) this.submit();
    };
    this.worker.onerror = () => { this.pending = false; onStatus('投影计算失败，请重新连接后重试'); canvas.dataset.twinProjectionState = 'error'; };
    const position = geometry.getAttribute('position');
    const packed = position.itemSize === 3 && !position.isInterleavedBufferAttribute && !position.normalized;
    const positions = packed ? new Float32Array(position.array) : new Float32Array(position.count * 3);
    if (!packed) for (let i = 0; i < position.count; i++) {
      positions[i * 3] = position.getX(i); positions[i * 3 + 1] = position.getY(i); positions[i * 3 + 2] = position.getZ(i);
    }
    const indices = geometry.getIndex()?.array.slice() || null;
    this.worker.postMessage({ type: 'init', positions, indices }, [positions.buffer, ...(indices ? [indices.buffer] : [])]);
    canvas.dataset.twinProjectionFrameCount = '0'; canvas.dataset.twinProjectionState = 'empty';
  }

  sync(robots, height, heightOffsets) {
    const wanted = new Set(); let changed = false;
    for (const robot of robots) for (const capture of robot.captureProjections || []) {
      const key = `${robot.id}/${capture.key}`; wanted.add(key);
      if (this.records.has(key)) continue;
      const record = this.kinematics({ ...capture, key }, height + (heightOffsets?.get(robot.id) || 0));
      if (record) { this.records.set(key, record); changed = true; }
    }
    for (const key of this.records.keys()) if (!wanted.has(key)) { this.records.delete(key); changed = true; }
    if (!changed) return;
    ++this.revision; this.dirty = true;
    if (!this.pending) this.submit();
  }

  submit() {
    this.pending = true; this.dirty = false;
    this.canvas.dataset.twinProjectionState = 'computing';
    this.worker.postMessage({ type: 'project', revision: this.revision, records: [...this.records.values()] });
  }

  setVisible(visible) {
    this.visible = visible;
    const values = [visible.left ? 1 : 0, visible.right ? 1 : 0];
    this.material.userData.twinProjectionVisibility = values;
    const uniform = this.material.userData.mapColorShader?.uniforms.atlasTwinProjectionVisibility;
    if (uniform) uniform.value = values;
    this.rebuild();
  }

  rebuild() {
    this.overlays.forEach(disposeTeachingSurfaceProjectionOverlay); this.overlays = [];
    const frames = this.frames.filter((frame) => this.visible[frame.record.side]);
    // Bound shader loops and texture dimensions for long-running sessions.
    for (let i = 0; i < frames.length; i += 128) {
      const overlay = createTeachingSurfaceProjectionOverlay(this.surfaceGeometry, frames.slice(i, i + 128), { opacity: .28 });
      if (overlay) { overlay.mesh.name = 'robot-twin-capture-projection'; this.scene.add(overlay.mesh); this.overlays.push(overlay); }
    }
    this.canvas.dataset.twinProjectionLeftVisible = String(this.visible.left);
    this.canvas.dataset.twinProjectionRightVisible = String(this.visible.right);
    this.canvas.dataset.twinProjectionVisibleFrameCount = String(frames.length);
    const count = (this.visible.left ? this.counts[1] : 0) + (this.visible.right ? this.counts[2] : 0)
      + (this.visible.left || this.visible.right ? this.counts[3] : 0);
    this.canvas.dataset.twinProjectionCoveredPointCount = String(count);
    this.canvas.dataset.twinProjectionMeshCount = String(this.overlays.length);
  }

  dispose() {
    this.worker.terminate(); this.overlays.forEach(disposeTeachingSurfaceProjectionOverlay);
    this.attribute.array.fill(0); this.attribute.needsUpdate = true;
    // Keep the cleared attribute owned by the display geometry: reuse it on
    // reconnect and let geometry.dispose() release its WebGL buffer.
    this.records.clear(); this.frames = []; this.overlays = [];
    for (const key of ['twinProjectionFrameCount', 'twinProjectionVisibleFrameCount', 'twinProjectionCoveredPointCount', 'twinProjectionMeshCount']) this.canvas.dataset[key] = '0';
    this.canvas.dataset.twinProjectionPoses = '[]'; this.canvas.dataset.twinProjectionState = 'inactive';
  }
}
