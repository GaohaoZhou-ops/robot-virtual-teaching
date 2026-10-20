import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createIndependentGround, viewportDistanceScale } from '../src/lib/viewportReference.js';

for (const bounds of [
  new THREE.Box3(new THREE.Vector3(-0.3, -1.7, -4), new THREE.Vector3(2.4, 3.8, 8)),
  new THREE.Box3(new THREE.Vector3(-34.7, 20.2, 1), new THREE.Vector3(-10, 29.8, 2)),
]) {
  const before = bounds.clone();
  const ground = createIndependentGround(bounds);
  ground.updateMatrixWorld(true);
  const surface = ground.getObjectByName('virtual-ground-surface');
  const grid = ground.getObjectByName('virtual-ground-meter-grid');
  const surfaceBounds = new THREE.Box3().setFromObject(surface);
  assert.equal(surfaceBounds.min.z, 0);
  assert.equal(surfaceBounds.max.z, 0);
  assert(surfaceBounds.min.x <= -20 && surfaceBounds.max.x >= 20);
  assert(surfaceBounds.min.y <= -20 && surfaceBounds.max.y >= 20);
  for (const point of [bounds.min, bounds.max, new THREE.Vector3()]) {
    assert(surfaceBounds.containsPoint(new THREE.Vector3(point.x, point.y, 0)));
  }
  const positions = grid.geometry.getAttribute('position');
  const coordinate = new THREE.Vector3();
  const xLines = new Set();
  const yLines = new Set();
  for (let i = 0; i < positions.count; i += 1) {
    coordinate.fromBufferAttribute(positions, i).applyMatrix4(grid.matrixWorld);
    assert(Math.abs(coordinate.z) < 1e-10, 'All grid lines lie on Z=0');
    xLines.add(Math.round(coordinate.x * 1e8) / 1e8);
    yLines.add(Math.round(coordinate.y * 1e8) / 1e8);
  }
  for (const axis of [xLines, yLines]) {
    assert(axis.has(0), 'Grid must intersect the model origin');
    const sorted = [...axis].sort((a, b) => a - b);
    sorted.slice(1).forEach((value, index) => assert.equal(value - sorted[index], 1));
  }
  assert(bounds.equals(before), 'A visual reference cannot change model bounds');
  ground.traverse((child) => {
    child.geometry?.dispose();
    child.material?.dispose();
  });
}

for (const [resolution, label] of [
  [10, '1 km'], [0.01, '1 m'], [0.001, '10 cm'],
  [1e-5, '1 mm'], [1e-8, '1 µm'], [1e-35, '1e-33 m'],
]) {
  const scale = viewportDistanceScale(resolution);
  assert.equal(scale.label, label);
  assert(Math.abs(scale.pixels - 100) < 1e-8);
}
for (let power = -35; power <= 6; power += 0.07) {
  const resolution = 10 ** power;
  const scale = viewportDistanceScale(resolution);
  assert(scale.pixels > 47.99 && scale.pixels <= 120.00001);
  assert(Math.abs(scale.meters / scale.pixels / resolution - 1) < 1e-12);
}
for (const invalid of [0, -1, NaN, Infinity]) {
  assert.equal(viewportDistanceScale(invalid), null);
  assert.equal(viewportDistanceScale(0.01, invalid), null);
}
console.log('PASS: Z=0 floor, origin-aligned 1 m grid, metric scale across dolly/optical zoom ranges');
