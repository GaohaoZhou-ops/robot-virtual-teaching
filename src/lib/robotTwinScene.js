import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createRobotMeasuredJointUpdater, setRobotVisualBounds } from './robotLoader.js';
import { tintRobotTwinBody } from './robotTwinAppearance.js';
import { applyRobotModelOpacity } from './robotDisplay.js';
import { RobotTwinMotion } from './robotTwinMotion.js';

function isVisibleRobotMesh(object) {
  if (!object.isMesh || object.userData.robotChassisDragTarget) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  if (materials.some((material) => material?.colorWrite === false)) return false;
  for (let node = object; node; node = node.parent) {
    if (!node.visible || node.userData.urdfType === 'collision') return false;
  }
  return true;
}

// Clones share immutable geometry/materials with the loaded project model.
// Their transforms, skeletons and URDF joint metadata remain independent.
export class RobotTwinScene {
  constructor(scene, mount, onSelect) {
    this.scene = scene; this.mount = mount; this.onSelect = onSelect;
    this.entries = new Map(); this.motion = new Map();
    this.labels = document.createElement('div');
    this.labels.className = 'robot-twin-scene-labels'; mount.append(this.labels);
    this.projected = new THREE.Vector3(); this.cameraPoint = new THREE.Vector3();
  }

  remove(entry) {
    entry.tint.dispose();
    if (entry.selected) applyRobotModelOpacity(this.base, this.base?.userData.robotDisplayOpacity ?? 1);
    entry.group.removeFromParent(); entry.label.remove();
    entry.ring.geometry.dispose(); entry.ring.material.dispose();
    entry.model?.traverse((node) => { if (node.isSkinnedMesh) node.skeleton?.dispose(); });
    // Never dispose the base model's shared geometry, textures or materials.
    entry.group.clear();
  }

  clear() {
    for (const entry of this.entries.values()) this.remove(entry);
    this.entries.clear(); this.motion.clear(); this.followId = ''; this.base = null; this.robots = null;
  }

  sync(base, baseLayer, robots, selectedId, visible) {
    const opacity = base?.userData.robotDisplayOpacity ?? 1;
    if (this.base === base && this.robots === robots && this.selectedId === selectedId && this.visible === visible && this.opacity === opacity) return;
    if (this.base !== base) this.clear();
    this.base = base; this.baseLayer = baseLayer; this.robots = robots; this.selectedId = selectedId; this.visible = visible; this.opacity = opacity;
    const wanted = new Set(base ? robots.map((robot) => robot.id) : []);
    for (const id of this.motion.keys()) if (!wanted.has(id)) this.motion.delete(id);
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id) || entry.selected !== (id === selectedId)) { this.remove(entry); this.entries.delete(id); }
    }
    for (const robot of base ? robots : []) {
      const selected = robot.id === selectedId;
      let entry = this.entries.get(robot.id);
      if (!entry) {
        const group = new THREE.Group(); group.name = `twin-robot:${robot.id}`;
        const model = selected ? null : cloneSkeleton(base);
        if (model) {
          model.traverse((node) => {
            if (node.isMesh && !isVisibleRobotMesh(node)) node.visible = false;
            if (node.isLine || node.isSprite) node.visible = false;
          });
          group.add(model);
        }
        const tint = tintRobotTwinBody(model || base, robot.color);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.46, 48),
          new THREE.MeshBasicMaterial({ color: robot.color, transparent: true,
            opacity: selected ? 0.9 : 0.45, depthWrite: false, side: THREE.DoubleSide }));
        ring.position.z = 0.015; group.add(ring); this.scene.add(group);
        const label = document.createElement('button'); label.type = 'button';
        label.addEventListener('click', (event) => { event.stopPropagation(); this.onSelect(robot.id); });
        this.labels.append(label);
        entry = { group, model, ring, label, selected, tint,
          joints: createRobotMeasuredJointUpdater(model || base) }; this.entries.set(robot.id, entry);
      }
      entry.robot = robot; entry.group.visible = visible;
      if (entry.model && entry.opacity !== opacity) {
        applyRobotModelOpacity(entry.model, opacity);
        entry.opacity = opacity;
      }
      entry.label.textContent = robot.name;
      entry.label.style.setProperty('--twin-color', robot.color);
      entry.label.title = `${robot.name} · ${robot.phase === 'live' ? '实时同步' : '数据暂不可用'} · 点击查看任务`;
      entry.label.className = `robot-twin-scene-label ${selected ? 'is-selected' : ''} ${robot.phase !== 'live' ? 'is-stale' : ''}`;
      entry.label.setAttribute('aria-label', `查看机器人 ${robot.name}`);
      entry.label.setAttribute('aria-pressed', String(selected));
    }
  }

  update(now, followId = '') {
    if (this.followId !== followId) {
      this.motion.clear(); this.followId = followId;
    }
    let selected = null;
    for (const [id, entry] of this.entries) {
      const following = id === followId;
      const sample = entry.robot.motionSample || entry.robot;
      if (!following && !entry.following && entry.sample === sample) {
        if (entry.selected) selected = entry.presentation;
        continue;
      }
      let frame = entry.robot;
      if (following) {
        if (!this.motion.has(id)) this.motion.set(id, new RobotTwinMotion());
        const motion = this.motion.get(id);
        motion.push(entry.robot); frame = motion.read(now) || frame;
      }
      entry.sample = sample; entry.following = following;
      const { position, rpy } = frame.pose;
      entry.rendered = frame;
      entry.group.position.set(position.x, position.y, position.z);
      entry.group.rotation.set(...[rpy.roll, rpy.pitch, rpy.yaw].map(THREE.MathUtils.degToRad), 'XYZ');
      entry.joints.apply(frame.joints);
      entry.presentation = { pose: frame.pose, joints: entry.joints };
      if (entry.selected) {
        this.baseLayer.position.copy(entry.group.position);
        this.baseLayer.quaternion.copy(entry.group.quaternion);
        selected = entry.presentation;
      }
    }
    return selected;
  }

  pick(raycaster) {
    if (!this.visible) return null;
    let closest = null;
    for (const [id, entry] of this.entries) {
      const model = entry.selected ? this.base : entry.model;
      const hit = raycaster.intersectObject(model, true).find((item) => isVisibleRobotMesh(item.object));
      if (hit && (!closest || hit.distance < closest.distance)) closest = { id, distance: hit.distance };
    }
    return closest?.id || null;
  }

  bounds() {
    const bounds = new THREE.Box3();
    for (const entry of this.entries.values()) {
      const model = entry.selected ? this.base : entry.model;
      bounds.union(setRobotVisualBounds(new THREE.Box3(), model));
    }
    return bounds;
  }

  project(camera, canvas) {
    const height = Math.max(0.8, this.base?.userData.robot?.bounds?.max?.[2] || 1.8);
    const width = canvas.clientWidth, viewHeight = canvas.clientHeight;
    const positions = [];
    for (const [id, entry] of this.entries) {
      const p = (entry.rendered || entry.robot).pose.position;
      this.projected.set(p.x, p.y, p.z + height + 0.16);
      this.cameraPoint.copy(this.projected).applyMatrix4(camera.matrixWorldInverse);
      this.projected.project(camera);
      const onScreen = this.visible && this.cameraPoint.z < 0 && Math.abs(this.projected.x) <= 1
        && Math.abs(this.projected.y) <= 1 && Math.abs(this.projected.z) <= 1;
      entry.label.style.visibility = onScreen ? 'visible' : 'hidden';
      const x = (this.projected.x + 1) * width / 2, y = (1 - this.projected.y) * viewHeight / 2;
      entry.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      // Expose model centers for viewport diagnostics and real pointer tests.
      this.projected.set(p.x, p.y, p.z + height * 0.45).project(camera);
      positions.push({ id, x: p.x, y: p.y, selected: entry.selected, color: entry.robot.color,
        bodyMeshes: entry.tint.bodyMeshes, preservedMeshes: entry.tint.preservedMeshes,
        screenX: (this.projected.x + 1) * width / 2, screenY: (1 - this.projected.y) * viewHeight / 2 });
    }
    canvas.dataset.twinRobots = JSON.stringify(positions);
    canvas.dataset.selectedTwinRobot = this.selectedId || '';
    canvas.dataset.smoothedTwinRobot = this.followId || '';
  }

  dispose() { this.clear(); this.labels.remove(); }
}
