import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ZividM70Camera, ZIVID_M70_PROFILE as profile } from "../src/features/cameras/model/zividCamera.js";

const camera = new ZividM70Camera();
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const tx = Math.tan(profile.horizontalFov * Math.PI / 360);
const ty = Math.tan(profile.verticalFov * Math.PI / 360);
// Assert physical coverage at focus, not just matching configured numbers.
near(1400 * tx, 754, 1);
near(1400 * ty, 449, 1);
for (const depth of [profile.near, profile.focus, profile.far]) {
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const point = new Vector3(x * depth * tx, y * depth * ty, -depth).project(camera);
    near(point.x, x); near(point.y, y);
    if (depth === profile.near) near(point.z, -1);
    if (depth === profile.far) near(point.z, 1);
    const world = point.unproject(camera);
    near(world.x, x * depth * tx); near(world.y, y * depth * ty); near(world.z, -depth);
  }
}
const native = camera.projectionMatrix.toArray();
for (const aspect of [1944 / 1200, 4 / 3, 3 / 4, 2.4]) {
  camera.aspect = aspect; camera.updateProjectionMatrix();
  assert.deepEqual(camera.projectionMatrix.toArray(), native, 'resizing must not change optical coverage');
}
camera.setViewOffset(1944 * 2, 1200 * 2, 1944 / 2, 1200 / 2, 1944, 1200);
const centered = new Vector3(profile.focus * tx / 2, profile.focus * ty / 2, -profile.focus).project(camera);
near(centered.x, 1); near(centered.y, 1);
camera.setViewOffset(1944 * 2, 1200 * 2, 1944, 0, 1944, 1200);
const panned = new Vector3(profile.focus * tx / 2, profile.focus * ty / 2, -profile.focus).project(camera);
near(panned.x, 0); near(panned.y, 0);
camera.clearViewOffset();
assert.deepEqual(camera.projectionMatrix.toArray(), native, 'reset restores the whole M70 frame');
console.log('M70 footprint, clipping, back-projection, viewport invariance and digital zoom/pan passed.');
