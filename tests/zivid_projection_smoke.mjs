import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ZividM70Camera, ZIVID_M70_PROFILE as profile, zividCalibrationSnapshot } from "../src/features/cameras/model/zividCamera.js";
import { parseHandEyeCalibration } from '../src/shared/robotics/handEyeCalibration.js';
import { handEyeReport } from './fixtures/hand_eye_calibration.mjs';

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
const calibration = parseHandEyeCalibration(JSON.stringify(handEyeReport()));
const calibrated = new ZividM70Camera(calibration);
const { width, height, K } = calibration.intrinsics;
for (const depth of [profile.near, profile.focus, profile.far]) {
  for (const u of [0, K[0][2], width]) for (const v of [0, K[1][2], height]) {
    const world = new Vector3((u - K[0][2]) * depth / K[0][0], -(v - K[1][2]) * depth / K[1][1], -depth);
    const ndc = world.clone().project(calibrated);
    near(ndc.x, 2 * u / width - 1); near(ndc.y, 1 - 2 * v / height);
    assert.ok(ndc.clone().unproject(calibrated).distanceTo(world) < 1e-10);
  }
}
const calibrationMatrix = calibrated.projectionMatrix.toArray();
calibrated.setViewOffset(width * 2, height * 2, width / 2, height / 2, width, height);
const opticalAxis = new Vector3(0, 0, -.7).project(calibrated);
near(opticalAxis.x, 2 * (2 * K[0][2] / width - 1));
near(opticalAxis.y, 2 * (1 - 2 * K[1][2] / height));
calibrated.clearViewOffset();
assert.deepEqual(calibrated.projectionMatrix.toArray(), calibrationMatrix);
const snapshot = zividCalibrationSnapshot(calibration);
assert.deepEqual(new ZividM70Camera(snapshot).projectionMatrix.toArray(), calibrationMatrix);
assert.notEqual(snapshot.intrinsics.K, calibration.intrinsics.K);
assert.deepEqual(new ZividM70Camera({ intrinsics: { K: [] } }).projectionMatrix.toArray(), native);
console.log('Nominal and calibrated M70 projection, off-center pixels, back-projection and digital zoom/pan passed.');
