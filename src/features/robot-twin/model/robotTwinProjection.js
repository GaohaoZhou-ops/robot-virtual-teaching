import * as THREE from 'three';
import { createRobotMeasuredJointUpdater } from '../../robot/model/robotLoader.js';
import { zividCalibrationSnapshot } from '../../cameras/model/zividCamera.js';
import { buildVisionCoverageDepthGrid, markTeachingSurfaceCoverageRange, prepareTeachingVisionCoverageFrames } from '../../cameras/model/visionCoverage.js';

export const ROBOT_TWIN_COVERAGE_ATTRIBUTE = 'atlasTwinCoverage';

// Copy just the two optical-frame ancestor chains. Applying a saved capture
// must never move the displayed robot or copy its large visual meshes.
export function createRobotTwinProjectionKinematics(base) {
  const wanted = new Set();
  const names = ['left', 'right'].map((side) => `zivid_${side}_optical_frame`);
  for (const name of names) for (let node = base.getObjectByName(name); node; node = node === base ? null : node.parent) wanted.add(node);
  const copy = (node) => {
    const result = new THREE.Object3D();
    result.name = node.name; result.position.copy(node.position); result.quaternion.copy(node.quaternion); result.scale.copy(node.scale);
    for (const key of ['jointType', 'jointAxis', 'restPosition', 'restQuaternion', 'jointValue', 'cameraCalibration']) {
      if (node.userData[key] !== undefined) result.userData[key] = structuredClone(node.userData[key]);
    }
    for (const child of node.children) if (wanted.has(child)) result.add(copy(child));
    return result;
  };
  const model = copy(base), root = new THREE.Group(); root.add(model);
  const updater = createRobotMeasuredJointUpdater(model);
  return (capture, height) => {
    const frame = model.getObjectByName(`zivid_${capture.side}_optical_frame`);
    if (!frame) return null;
    root.position.set(capture.pose.x, capture.pose.y, height);
    root.rotation.set(0, 0, THREE.MathUtils.degToRad(capture.pose.yaw));
    updater.apply(capture.joints); root.updateMatrixWorld(true);
    const position = frame.getWorldPosition(new THREE.Vector3()), quaternion = frame.getWorldQuaternion(new THREE.Quaternion());
    return { key: capture.key, side: capture.side, calibration: zividCalibrationSnapshot(frame.userData.cameraCalibration),
      frame: { opticalPose: { position: { x: position.x, y: position.y, z: position.z },
        quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w } } } };
  };
}

// Use the model surface, as in offline teaching. No extra camera exposure or
// XYZ transfer is needed, including captures that saved only an RGB image.
export function prepareRobotTwinProjection(record, positions, indices) {
  const [prepared] = prepareTeachingVisionCoverageFrames([record]);
  if (!prepared) return null;
  const matrix = new THREE.Matrix4().fromArray(prepared.worldToCamera), local = new Float32Array(positions.length);
  const point = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) point.fromArray(positions, i).applyMatrix4(matrix).toArray(local, i);
  const grid = buildVisionCoverageDepthGrid(null, record.calibration, { positions: local });
  // Large mesh faces can cover the image without any vertex inside the field
  // of view. Rasterize their first hit at each optical grid-cell center too.
  if (indices?.length) {
    const depths = new Float64Array(grid.columns * grid.rows).fill(Infinity);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
    for (let i = 0; i < indices.length; i += 3) {
      a.fromArray(local, indices[i] * 3); b.fromArray(local, indices[i + 1] * 3); c.fromArray(local, indices[i + 2] * 3);
      if (Math.max(a.z, b.z, c.z) < grid.near || Math.min(a.z, b.z, c.z) > grid.far) continue;
      const vertices = [a, b, c];
      let x0 = 0, x1 = grid.columns - 1, y0 = 0, y1 = grid.rows - 1;
      if (vertices.every((v) => v.z > 0)) {
        const xs = vertices.map((v) => (v.x / v.z / grid.tangentX + grid.offsetX + 1) * grid.columns / 2 - .5);
        const ys = vertices.map((v) => (v.y / v.z / grid.tangentY + grid.offsetY + 1) * grid.rows / 2 - .5);
        x0 = Math.max(0, Math.ceil(Math.min(...xs))); x1 = Math.min(x1, Math.floor(Math.max(...xs)));
        y0 = Math.max(0, Math.ceil(Math.min(...ys))); y1 = Math.min(y1, Math.floor(Math.max(...ys)));
      }
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        ray.direction.set(((x + .5) * 2 / grid.columns - 1 - grid.offsetX) * grid.tangentX,
          ((y + .5) * 2 / grid.rows - 1 - grid.offsetY) * grid.tangentY, 1);
        if (ray.intersectTriangle(a, b, c, false, hit) && hit.z >= grid.near && hit.z <= grid.far) {
          const cell = y * grid.columns + x; depths[cell] = Math.min(depths[cell], hit.z);
        }
      }
    }
    grid.surfaceDepths = grid.surfaceDepths.map((depth, i) => Number.isFinite(depths[i])
      ? Math.min(depth ?? Infinity, depths[i]) : depth);
    grid.surfaceCellCount = grid.surfaceDepths.filter(Number.isFinite).length;
  }
  return { ...prepared, grid, tangentX: grid.tangentX, tangentY: grid.tangentY, offsetX: grid.offsetX, offsetY: grid.offsetY };
}

export class RobotTwinProjectionCoverage {
  constructor(positions, indices) {
    this.positions = positions; this.indices = indices; this.frames = new Map();
    this.left = new Float32Array(positions.length / 3); this.right = new Float32Array(this.left.length);
    this.attribute = new THREE.BufferAttribute(positions, 3);
  }

  sync(records) {
    const { frames, left, right } = this;
    const wanted = new Set(records.map((record) => record.key));
    let removed = false;
    const added = [];
    for (const key of frames.keys()) if (!wanted.has(key)) { frames.delete(key); removed = true; }
    for (const record of records) if (!frames.has(record.key)) {
      const frame = prepareRobotTwinProjection(record, this.positions, this.indices);
      if (frame) { frames.set(record.key, frame); added.push(frame); }
    }
    const prepared = [...frames.values()], changed = removed ? prepared : added;
    if (removed) { left.fill(0); right.fill(0); }
    // Append only new captures. Rebuild the union when a robot disconnects.
    markTeachingSurfaceCoverageRange(this.attribute, changed.filter((frame) => frame.record.side === 'left'), left);
    markTeachingSurfaceCoverageRange(this.attribute, changed.filter((frame) => frame.record.side === 'right'), right);
    const mask = new Float32Array(left.length), counts = [0, 0, 0, 0];
    for (let i = 0; i < mask.length; i++) { mask[i] = left[i] + right[i] * 2; counts[mask[i]]++; }
    return { frames: prepared, mask, counts };
  }
}
