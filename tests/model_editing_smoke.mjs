import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cropModel, defaultModelEditSettings, editModel, encodeModelPly, modelPreview, modelStats, parseEditablePly, voxelReduceModel } from '../src/lib/modelEditing.js';
import { Quaternion, Vector3 } from 'three';
import { modelMatrixFromOrigin, modelPoseFromOrigin, originFromModelPose, readModelOrigin, ZERO_MODEL_ORIGIN } from '../src/lib/modelOriginTransform.js';

const close = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const bufferOf = (value) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
const fixture = async (name) => parseEditablePly(bufferOf(await readFile(new URL(`fixtures/${name}`, import.meta.url))));
const model = (positions, indices = [], colors = null, normals = null) => ({ positions: new Float32Array(positions), indices: new Uint32Array(indices), colors: colors ? new Float32Array(colors) : null, normals: normals ? new Float32Array(normals) : null });
const bounds = (min, max) => ({ min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } });

const points = await fixture('rotation-map.ply');
const hybrid = await fixture('hybrid-map.ply');
const original = new Float32Array(points.positions);
assert.equal(modelStats(points).pointCount, 24);
assert.equal(modelStats(hybrid).faceCount, 2);

// A new frame with +90° yaw maps old +Y to new +X, after translation.
const poseSource = model([2, 4, 3, 1, 2, 3], [], [1, 0, 0, 0, 1, 0], [0, 1, 0, 1, 0, 0]);
const poseSettings = defaultModelEditSettings(poseSource);
poseSettings.origin = { x: 1, y: 2, z: 3, roll: 0, pitch: 0, yaw: 90 };
const rebased = editModel(poseSource, poseSettings).model;
[2, -1, 0, 0, 0, 0].forEach((v, i) => close(rebased.positions[i], v));
[1, 0, 0, 0, -1, 0].forEach((v, i) => close(rebased.normals[i], v));

// Non-commuting roll/pitch/yaw are checked against the explicit Rz Ry Rx matrix.
const rpy = { roll: 23, pitch: -31, yaw: 47 }, t = { x: 2, y: -5, z: 7 }, local = [0.7, -1.2, 2.5];
const [r, p, y] = [rpy.roll, rpy.pitch, rpy.yaw].map((a) => a * Math.PI / 180);
const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
const matrix = [[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr], [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr], [-sp, cp * sr, cp * cr]];
const world = matrix.map((row, i) => row.reduce((sum, v, a) => sum + v * local[a], 0) + [t.x, t.y, t.z][i]);
const rotated = model(world), rotatedSettings = defaultModelEditSettings(rotated);
rotatedSettings.origin = { ...t, ...rpy };
editModel(rotated, rotatedSettings).model.positions.forEach((v, i) => close(v, local[i]));

// Intersecting surfaces survive even when no original vertex is in the crop.
const triangle = model([-2, -2, 0, 2, -2, 0, 0, 2, 0], [0, 1, 2], [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
const clipped = cropModel(triangle, bounds([-0.25, -0.25, 0], [0.25, 0.25, 0]));
assert.ok(clipped.indices.length >= 6);
let area = 0;
for (let f = 0; f < clipped.indices.length; f += 3) {
  const [a, b, c] = Array.from(clipped.indices.slice(f, f + 3), (i) => Array.from(clipped.positions.slice(i * 3, i * 3 + 3)));
  area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}
close(area, 0.25);
for (let i = 0; i < clipped.positions.length; i += 3) {
  assert.ok(Math.abs(clipped.positions[i]) <= 0.25 && Math.abs(clipped.positions[i + 1]) <= 0.25);
  close(clipped.colors[i] + clipped.colors[i + 1] + clipped.colors[i + 2], 1);
  close(clipped.normals[i + 2], 1);
}

const isolated = cropModel(hybrid, bounds([-0.01, -0.01, 1.1], [0.01, 0.01, 1.3]));
assert.equal(isolated.positions.length / 3, 1); assert.equal(isolated.indices.length, 0);
assert.equal(cropModel(points, bounds([100, 100, 100], [200, 200, 200])).positions.length, 0);

const sampleSettings = defaultModelEditSettings(points);
sampleSettings.reduction = { mode: 'uniform', percentage: 25 };
const sampled = editModel(points, sampleSettings).model;
assert.equal(sampled.positions.length / 3, 6); assert.equal(sampled.colors.length / 3, 6);
assert.deepEqual(points.positions, original);
sampleSettings.crop = { enabled: true, ...bounds([0, -100, -100], [100, 100, 100]) };
sampleSettings.origin.x = 2;
const combined = editModel(points, sampleSettings).model;
assert.ok(combined.positions.every((v, i) => i % 3 !== 0 || v >= 0));

const cluster = voxelReduceModel(model([0, 0, 0, 0.1, 0.1, 0.1, 2, 2, 2], [], [1, 0, 0, 0, 1, 0, 0, 0, 1]), 0.5);
assert.equal(cluster.positions.length / 3, 2); close(cluster.positions[0], 0.05);
close(cluster.colors[0], 0.5); close(cluster.colors[1], 0.5);
const gridPositions = [], gridIndices = [];
for (let yy = 0; yy <= 10; yy += 1) for (let xx = 0; xx <= 10; xx += 1) gridPositions.push(xx / 10, yy / 10, 0);
for (let yy = 0; yy < 10; yy += 1) for (let xx = 0; xx < 10; xx += 1) { const a = yy * 11 + xx; gridIndices.push(a, a + 1, a + 12, a, a + 12, a + 11); }
const grid = model(gridPositions, gridIndices), reduced = voxelReduceModel(grid, 0.25);
assert.ok(reduced.indices.length > 0 && reduced.indices.length < grid.indices.length);
assert.ok(reduced.positions.length < grid.positions.length);
assert.ok(reduced.indices.every((i) => i < reduced.positions.length / 3));
assert.throws(() => voxelReduceModel(grid, 10), /体素尺寸过大/);

for (const originalModel of [points, hybrid, clipped, reduced, rebased]) {
  const exported = encodeModelPly(originalModel), restored = parseEditablePly(exported);
  assert.deepEqual(restored.positions, originalModel.positions);
  assert.deepEqual(restored.indices, originalModel.indices);
  if (originalModel.colors) originalModel.colors.forEach((v, i) => close(restored.colors[i], v, 0.005));
  if (originalModel.normals) assert.deepEqual(restored.normals, originalModel.normals);
}
const preview = modelPreview(grid, 2, 10);
assert.equal(preview.indices.length / 3, 10); assert.equal(preview.limited, true);
assert.equal(parseEditablePly(encodeModelPly(grid)).indices.length / 3, 200);
const pointPreview = modelPreview(points, 6, 10);
assert.equal(pointPreview.pointIndices.length, 6); assert.equal(points.positions.length / 3, 24);

const invalid = defaultModelEditSettings(points);
invalid.origin.x = ''; assert.throws(() => editModel(points, invalid), /XYZ/);
invalid.origin.x = 0; invalid.crop = { enabled: true, ...bounds([1, 0, 0], [0, 1, 1]) };
assert.throws(() => editModel(points, invalid), /下限/);
invalid.crop.enabled = false; invalid.reduction = { mode: 'voxel', voxelSize: 0 };
assert.throws(() => editModel(points, invalid), /体素尺寸/);
assert.throws(() => parseEditablePly(new TextEncoder().encode('not a model').buffer), /有效/);
assert.throws(() => encodeModelPly(model([])), /为空/);

// Gizmo edits move the model, while numeric fields continue to describe the
// inverse frame. Check against explicit world-space movement, not just a round trip.
const pivotCenter = new Vector3(1, 0.5, 0.75);
const sourcePoint = new Vector3(2, -1, 3);
for (const frame of [ZERO_MODEL_ORIGIN, { x: 1, y: 2, z: -3, ...rpy }, { x: -2, y: 1, z: 4, roll: 0, pitch: 0, yaw: 720 }]) {
  const pose = modelPoseFromOrigin(frame, pivotCenter);
  const beforePoint = sourcePoint.clone().applyMatrix4(modelMatrixFromOrigin(frame));
  const delta = new Vector3(0.4, -0.7, 1.1);
  const moved = originFromModelPose(pose.position.clone().add(delta), pose.quaternion, pivotCenter, frame, 'translate');
  const movedPoint = sourcePoint.clone().applyMatrix4(modelMatrixFromOrigin(moved));
  beforePoint.clone().add(delta).toArray().forEach((value, index) => close(movedPoint.toArray()[index], value));
  ['roll', 'pitch', 'yaw'].forEach((field) => close(moved[field], frame[field]));
  for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]) {
    const turn = new Quaternion().setFromAxisAngle(axis, Math.PI / 3);
    const rotatedPose = originFromModelPose(pose.position, turn.clone().multiply(pose.quaternion), pivotCenter, frame, 'rotate');
    const expected = beforePoint.clone().sub(pose.position).applyQuaternion(turn).add(pose.position);
    const options = defaultModelEditSettings(model(sourcePoint.toArray()));
    options.origin = rotatedPose;
    editModel(model(sourcePoint.toArray()), options).model.positions.forEach((value, index) => close(value, expected.toArray()[index]));
  }
}
const wrapBefore = { ...ZERO_MODEL_ORIGIN, yaw: 179 };
const wrapPose = modelPoseFromOrigin({ ...ZERO_MODEL_ORIGIN, yaw: -179 }, pivotCenter);
close(originFromModelPose(wrapPose.position, wrapPose.quaternion, pivotCenter, wrapBefore, 'rotate').yaw, 181);
assert.equal(readModelOrigin({ ...ZERO_MODEL_ORIGIN, x: '' }), null);
assert.equal(modelMatrixFromOrigin({ ...ZERO_MODEL_ORIGIN, pitch: Infinity }), null);
for (const pitch of [89.999, 90, 90.001, -90]) {
  const frame = { x: 1, y: 2, z: 3, roll: 23, pitch, yaw: -42 };
  const pose = modelPoseFromOrigin(frame, pivotCenter);
  const restored = originFromModelPose(pose.position, pose.quaternion, pivotCenter, frame, 'rotate');
  const expected = sourcePoint.clone().applyMatrix4(modelMatrixFromOrigin(frame));
  const actual = sourcePoint.clone().applyMatrix4(modelMatrixFromOrigin(restored));
  expected.toArray().forEach((value, index) => close(actual.toArray()[index], value, 1e-8));
}
console.log('model editing: frame transforms, gizmo-to-origin inversion, triangle clipping, RGB/normals, sampling, mesh reduction, full PLY round trips, and validation passed');
