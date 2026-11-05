import * as THREE from 'three';
import { ROBOT_PEDESTRIANS_MAX_BOXES } from '../../../shared/protocols/robotTwinPedestrians.js';
import { RobotTwinPedestrianTracks } from './robotTwinPedestrianTracks.js';
import { loadRobotPedestrianGeometry } from './robotTwinPedestrianGeometry.js';

function installPedestrianOpacity(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float pedestrianOpacity;\nvarying float vPedestrianOpacity;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPedestrianOpacity = pedestrianOpacity;');
    shader.fragmentShader = `varying float vPedestrianOpacity;\n${shader.fragmentShader}`
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vPedestrianOpacity;');
  };
  material.customProgramCacheKey = () => 'twin-pedestrian-opacity-v1';
}

// Shared static human mesh, with translucent white for briefly retained tracks. This
// overlay never enters the saved project, collision model, or teaching paths.
export class RobotTwinPedestriansLayer {
  constructor(scene, { loadGeometry = loadRobotPedestrianGeometry } = {}) {
    this.loadGeometry = loadGeometry; this.geometryReady = false; this.loading = null; this.retryAfter = 0;
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .8, metalness: 0,
        emissive: '#ffffff', emissiveIntensity: .08 }), ROBOT_PEDESTRIANS_MAX_BOXES);
    this.mesh.name = 'twin-pedestrians'; this.mesh.count = 0; this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.heldMesh = new THREE.InstancedMesh(this.mesh.geometry,
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .8, metalness: 0,
        emissive: '#ffffff', emissiveIntensity: .08, transparent: true, depthWrite: false }),
      ROBOT_PEDESTRIANS_MAX_BOXES);
    this.heldMesh.name = 'twin-pedestrians-held'; this.heldMesh.count = 0; this.heldMesh.visible = false;
    this.heldMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.heldMesh.frustumCulled = false;
    // Draw the map/robot background first (render orders 1–3), then keep only
    // the nearest human surface before blending it once. Otherwise clothing,
    // skin and rear-facing limbs all accumulate through a translucent person.
    // Both passes use the same shader/transforms for identical surface depth.
    const heldDepthMaterial = this.heldMesh.material.clone();
    heldDepthMaterial.colorWrite = false; heldDepthMaterial.depthWrite = true;
    installPedestrianOpacity(this.heldMesh.material); installPedestrianOpacity(heldDepthMaterial);
    this.heldOpacity = new THREE.InstancedBufferAttribute(new Float32Array(ROBOT_PEDESTRIANS_MAX_BOXES), 1);
    this.heldOpacity.setUsage(THREE.DynamicDrawUsage);
    this.heldDepthMesh = new THREE.InstancedMesh(this.mesh.geometry, heldDepthMaterial,
      ROBOT_PEDESTRIANS_MAX_BOXES);
    this.heldDepthMesh.name = 'twin-pedestrians-held-depth';
    this.heldDepthMesh.count = 0; this.heldDepthMesh.visible = false;
    this.heldDepthMesh.instanceMatrix = this.heldMesh.instanceMatrix;
    this.heldDepthMesh.frustumCulled = false;
    this.heldDepthMesh.renderOrder = 4; this.heldMesh.renderOrder = 5;
    scene.add(this.heldDepthMesh);
    scene.add(this.heldMesh);
    this.transform = new THREE.Object3D(); this.positions = []; this.trackers = new Map();
  }

  prepareGeometry(now) {
    if (this.disposed || this.geometryReady || this.loading || now < this.retryAfter) return;
    this.loading = Promise.resolve().then(() => this.loadGeometry()).then((geometry) => {
      if (this.disposed) { geometry.dispose(); return; }
      this.mesh.geometry.dispose();
      geometry.setAttribute('pedestrianOpacity', this.heldOpacity);
      this.mesh.geometry = geometry; this.heldMesh.geometry = geometry; this.heldDepthMesh.geometry = geometry;
      this.geometryReady = true; this.dirty = true;
    }).catch((error) => {
      if (this.disposed) return;
      this.retryAfter = performance.now() + 5000;
      console.warn('行人模型加载失败，稍后重试', error);
    }).finally(() => { this.loading = null; });
  }

  clear() {
    this.mesh.count = 0; this.heldMesh.count = 0; this.heldDepthMesh.count = 0;
    this.positions = []; this.trackers.clear();
    this.mesh.visible = false; this.heldMesh.visible = false; this.heldDepthMesh.visible = false;
  }

  update(robots, visible, heightOffsets, now = performance.now(), followId = '') {
    if (this.disposed) return;
    if (visible && robots.some((robot) => robot.pedestrians?.enabled)) this.prepareGeometry(now);
    const wanted = new Set(robots.map((robot) => robot.id));
    for (const id of this.trackers.keys()) if (!wanted.has(id)) this.trackers.delete(id);
    const positions = [];
    let freshCount = 0, heldCount = 0;
    for (const robot of robots) {
      if (!this.trackers.has(robot.id)) this.trackers.set(robot.id, new RobotTwinPedestrianTracks());
      const tracker = this.trackers.get(robot.id);
      tracker.observe(robot, now);
      const people = tracker.read(now, robot.id === followId);
      if (!visible || !this.geometryReady) continue;
      for (const person of people) {
        if (positions.length >= ROBOT_PEDESTRIANS_MAX_BOXES) break;
        const z = person.z + (heightOffsets.get(robot.id) || 0), yaw = THREE.MathUtils.degToRad(person.yaw);
        this.transform.position.set(person.x, person.y, z);
        this.transform.rotation.set(0, 0, yaw);
        // Detection XY extents vary with occlusion and pose. Use height alone so
        // the head, shoulders, arms and legs keep the downloaded human's proportions.
        this.transform.scale.setScalar(person.size[2]);
        this.transform.updateMatrix();
        if (person.held) {
          this.heldMesh.setMatrixAt(heldCount, this.transform.matrix);
          this.heldOpacity.setX(heldCount++, person.opacity);
        }
        else this.mesh.setMatrixAt(freshCount++, this.transform.matrix);
        positions.push({ robotId: robot.id, trackId: person.id, x: person.x, y: person.y, z, yaw,
          width: person.size[0], depth: person.size[1], height: person.size[2], held: person.held, opacity: person.opacity });
      }
    }
    // Avoid GPU uploads and diagnostic DOM writes while a person is stationary.
    const changed = this.dirty || positions.length !== this.positions.length || positions.some((p, i) =>
      Object.keys(p).some((key) => p[key] !== this.positions[i]?.[key]));
    this.dirty = false;
    this.mesh.count = freshCount; this.heldMesh.count = heldCount; this.heldDepthMesh.count = heldCount;
    this.mesh.visible = visible && freshCount > 0; this.heldMesh.visible = visible && heldCount > 0;
    this.heldDepthMesh.visible = this.heldMesh.visible;
    if (changed) {
      this.positions = positions;
      if (freshCount) this.mesh.instanceMatrix.needsUpdate = true;
      if (heldCount) { this.heldMesh.instanceMatrix.needsUpdate = true; this.heldOpacity.needsUpdate = true; }
    }
  }

  dispose() {
    this.disposed = true;
    this.clear(); this.mesh.removeFromParent(); this.mesh.dispose();
    this.heldMesh.removeFromParent(); this.heldMesh.dispose(); this.heldMesh.material.dispose();
    this.heldDepthMesh.removeFromParent(); this.heldDepthMesh.dispose(); this.heldDepthMesh.material.dispose();
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}
