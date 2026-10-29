import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createViewportNavigation, VIEWPORT_FOV } from "../src/features/viewport/model/viewportNavigation.js";

const camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, 1, 0.01, 100);
camera.position.set(0, -6, 8);
camera.up.set(0, 0, 1);
const controls = {
  target: new THREE.Vector3(),
  domElement: { clientWidth: 900, clientHeight: 900, dataset: {} },
  update() {
    camera.lookAt(this.target);
    camera.updateMatrixWorld(true);
  },
};
controls.update();
const navigation = createViewportNavigation(camera, controls, 2);
const initial = camera.position.clone();
assert.equal(controls.maxDistance, Infinity);
for (let i = 0; i < 30; i += 1) assert(navigation.applyWheelDelta(160));
const distant = camera.position.distanceTo(controls.target);
assert(distant > initial.length() * 1000, 'Zoom out must continue beyond six model radii');
assert(navigation.applyWheelDelta(160));
assert(camera.position.distanceTo(controls.target) > distant);
for (let i = 0; i < 31; i += 1) assert(navigation.applyWheelDelta(-160));
assert(camera.position.distanceTo(initial) < 1e-8, 'Zooming back must recover the original view');

navigation.setRadius(1);
assert.equal(controls.maxDistance, Infinity, 'Refitting a model must not reinstate a zoom-out cap');
navigation.applyZoomFactor(1e-12);
assert(camera.zoom > 1);
assert(Math.abs(navigation.getPanMetrics().effectiveDistance / 1e-11 - 1) < 1e-9);
navigation.applyZoomFactor(1e12);
assert.equal(camera.zoom, 1);
assert(camera.position.distanceTo(initial) < 1e-8);

// Ground references may extend well past a small model. Keep their far edge
// inside the clip range without including them in model fit/zoom sensitivity.
const reference = new THREE.Sphere(new THREE.Vector3(4, 6, 0), Math.SQRT2 * 20);
navigation.setReferenceSphere(reference);
navigation.syncClipping();
assert(camera.far >= camera.position.distanceTo(reference.center) + reference.radius);
assert(Math.abs(navigation.getPanMetrics().effectiveDistance - 10) < 1e-8);
navigation.applyZoomFactor(1e6);
navigation.syncClipping();
const distance = camera.position.distanceTo(controls.target);
assert(camera.far > distance && camera.near < distance);
assert(camera.far / camera.near < 20000, 'Far-away views should retain depth precision');
controls.update();
const projectedTarget = controls.target.clone().project(camera);
assert(projectedTarget.z > -1 && projectedTarget.z < 1);
assert(camera.projectionMatrix.elements.every(Number.isFinite));
const beforeInvalid = camera.position.clone();
for (const factor of [NaN, Infinity, 0, -1, 1e308]) {
  assert.equal(navigation.applyZoomFactor(factor), false);
  assert(camera.position.equals(beforeInvalid));
}
console.log('PASS: uncapped zoom-out, zoom round trips, optical detail and extended ground clipping');
