import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createViewportNavigation } from '../../src/features/viewport/model/viewportNavigation.js';
import { createSurfaceZoomAnchor } from '../../src/features/viewport/scene/surfaceZoom.js';

const camera = new THREE.PerspectiveCamera(46, 1, 0.01, 1000);
camera.position.set(0, -20, 0); camera.up.set(0, 0, 1);
const canvas = { clientWidth: 900, clientHeight: 900, dataset: {} };
const controls = { target: new THREE.Vector3(), domElement: canvas,
  update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } };
controls.update();
const navigation = createViewportNavigation(camera, controls, 100);
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const surface = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(Math.PI / 2).translate(0, 5, 0), material);
const behind = new THREE.Mesh(surface.geometry.clone().translate(0, 0.0005, 0), material);
const geometryBefore = Array.from(surface.geometry.attributes.position.array);
const anchor = createSurfaceZoomAnchor(camera, controls, [behind, surface]);
const landmark = new THREE.Vector3(0.1, 5, 0.1);
const projectedBefore = landmark.clone().project(camera);
assert(anchor());
controls.update();
assert(projectedBefore.distanceTo(landmark.clone().project(camera)) < 1e-12, 'retarget without rotating, moving or zooming the view');
assert(controls.target.distanceTo(new THREE.Vector3(0, 5, 0)) < 1e-10, 'use the first visible surface, not the background');
let previousScale = landmark.clone().project(camera).x;
for (let step = 0; step < 40; step += 1) {
  anchor(); navigation.applyWheelDelta(-120); navigation.syncClipping();
  const scale = landmark.clone().project(camera).x;
  assert(scale / previousScale > 1.15, 'each wheel step must still visibly magnify the surface');
  const frontDepth = new THREE.Vector3(0, 5, 0).project(camera).z;
  const backDepth = new THREE.Vector3(0, 5.0005, 0).project(camera).z;
  if (step >= 12) assert((backDepth - frontDepth) * 2 ** 23 > 1, 'near zoom retains distinct 24-bit surface depths');
  assert(frontDepth > -1 && frontDepth < 1, 'do not dolly through or clip the observed surface');
  previousScale = scale;
}
assert(camera.zoom > 1, 'continue smoothly into optical detail');
assert.equal(canvas.dataset.zoomAnchorPickCount, '1', 'do not scan the map on every wheel event');
assert.deepEqual(Array.from(surface.geometry.attributes.position.array), geometryBefore, 'zoom must not rewrite model coordinates');

camera.position.set(1, -3, 0); controls.target.set(1, 0, 0); camera.zoom = 1; camera.updateProjectionMatrix(); controls.update();
assert(anchor());
assert.equal(canvas.dataset.zoomAnchorPickCount, '2', 'pan/rotation invalidates the surface pick');
camera.position.x = controls.target.x = 20; controls.update();
const emptyTarget = controls.target.clone();
assert.equal(anchor(), false);
assert(controls.target.equals(emptyTarget), 'empty space preserves normal target-based zoom');
anchor();
assert.equal(canvas.dataset.zoomAnchorPickCount, '3', 'cache empty-space picks too');

camera.position.set(0, -20, 0); controls.target.set(0, 0, 0); controls.update();
const points = new THREE.Points(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 8, 0),
]), new THREE.PointsMaterial());
const pointAnchor = createSurfaceZoomAnchor(camera, controls, [points]);
assert(pointAnchor());
assert(controls.target.distanceTo(new THREE.Vector3(0, 5, 0)) < 1e-10, 'point clouds use nearby visible samples');
points.visible = false;
assert.equal(pointAnchor(), false, 'hidden layers are not zoom anchors');
for (const object of [surface, behind, points]) object.geometry.dispose();
material.dispose(); points.material.dispose();
console.log('PASS: surface zoom has no dead zone, preserves view/geometry, retains depth precision and caches mesh/point picks.');
