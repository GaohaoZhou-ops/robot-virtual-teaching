import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createViewportNavigation, VIEWPORT_FOV } from '../src/lib/viewportNavigation.js';
import { applyScreenViewportGesture } from '../src/lib/ipadScreenViewport.js';
import { screenJointState, screenViewportCommand, validScreenJointState } from '../src/lib/ipadScreenControl.js';

const rig = (height = 900) => {
  const camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, 1.6, 0.01, 100);
  camera.position.set(0, -6, 8); camera.up.set(0, 0, 1);
  const controls = { target: new THREE.Vector3(), domElement: { clientHeight: height, clientWidth: height * 1.6, dataset: {} },
    update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } };
  controls.update();
  const navigation = createViewportNavigation(camera, controls, 2);
  return { camera, controls, navigation, gesture: (command) => applyScreenViewportGesture(camera, controls, navigation, command) };
};
const view = rig(), original = view.camera.position.clone();
assert(view.gesture({ kind: 'rotate', dx: 0.12, dy: 0, zoom: 0 }));
assert(view.camera.position.x < 0, 'dragging right rotates the scene with the finger');
assert(Math.abs(view.camera.position.length() - original.length()) < 1e-8);
assert(view.controls.target.equals(new THREE.Vector3()), 'rotation keeps the target fixed');
assert(Math.abs(view.camera.up.length() - 1) < 1e-8);
const beforeZoom = view.camera.position.clone();
assert(view.gesture({ kind: 'zoom', dx: 0, dy: 0, zoom: Math.log(2) }));
assert(Math.abs(view.navigation.getPanMetrics().effectiveDistance - beforeZoom.length() / 2) < 1e-8, 'opening fingers zooms in');
assert(view.gesture({ kind: 'zoom', dx: 0, dy: 0, zoom: -Math.log(2) }));
assert(view.camera.position.distanceTo(beforeZoom) < 1e-8, 'pinch round trip restores distance');
const a = rig(), b = rig(400);
const pan = { kind: 'pan', dx: 0.15, dy: -0.08, zoom: 0 };
const direction = a.camera.getWorldDirection(new THREE.Vector3());
assert(a.gesture(pan)); assert(b.gesture(pan));
assert(a.camera.position.distanceTo(b.camera.position) < 1e-8, 'normalized panning is independent of window size');
assert(a.controls.target.distanceTo(b.controls.target) < 1e-8);
assert(a.camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-8, 'two-finger pan does not rotate');
assert(Math.abs(a.camera.position.distanceTo(a.controls.target) - 10) < 1e-8, 'two-finger pan does not zoom');
assert(a.controls.target.x < 0 && a.controls.target.z < 0, 'scene follows the finger direction');
const unchanged = a.camera.position.clone();
assert.equal(a.gesture({ kind: 'pan', dx: Infinity, dy: 0, zoom: 0 }), false);
assert(a.camera.position.equals(unchanged));
for (let index = 0; index < 60; index++) a.gesture({ kind: 'zoom', dx: 0, dy: 0, zoom: 1 });
a.gesture(pan); a.navigation.syncClipping();
assert(a.camera.projectionMatrix.elements.every(Number.isFinite), 'deep optical zoom and pan remain finite');

const state = { ...screenJointState({ id: 'robot' }), editable: false,
  viewportControl: { enabled: true, aspect: 1.6, ack: 0 } };
const command = { robotId: 'robot', sequence: 1, kind: 'pan', dx: 0.1, dy: 0.2, zoom: 0, ageMs: 10, receivedAt: 100 };
assert(validScreenJointState(state));
assert.deepEqual(screenViewportCommand(command, state, 0, 110), command, 'camera navigation is independent of joint editing');
assert.equal(screenViewportCommand(command, state, 1, 110), null, 'replayed relative motion is rejected');
assert.equal(screenViewportCommand(command, state, 0, 3200), null, 'suspended motion expires');
assert.equal(screenViewportCommand(command, { ...state, viewportControl: { ...state.viewportControl, enabled: false } }, 0, 110), null);
for (const invalid of [{ ...command, robotId: 'other' }, { ...command, kind: 'joint' }, { ...command, sequence: -1 },
  { ...command, dx: 5 }, { ...command, ageMs: -1 }, { ...command, zoom: 1 }, { ...command, kind: 'zoom' }]) {
  assert.equal(screenViewportCommand(invalid, state, 0, 110), null);
}
for (const invalid of [{ enabled: true, aspect: 0, ack: 0 }, { enabled: true, aspect: 1.6, ack: -1 }]) {
  assert.equal(validScreenJointState({ ...state, viewportControl: invalid }), false);
}
console.log('Viewport gestures: trackball rotation, pinch directions, normalized pan, precision zoom, capability/sequence/expiry validation passed.');
