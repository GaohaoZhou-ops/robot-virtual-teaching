import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { composeModels, inverseModelPose, joinEditableModels } from "../src/features/model-editor/model/modelComposition.js";
import { encodeModelPly, modelBounds, parseEditablePly } from "../src/features/model-editor/model/modelEditing.js";
import { modelMatrixFromOrigin, ZERO_MODEL_ORIGIN } from "../src/features/model-editor/model/modelOriginTransform.js";

const model = (positions, indices = [], colors = null, normals = null) => ({ positions: new Float32Array(positions), indices: new Uint32Array(indices),
  colors: colors && new Float32Array(colors), normals: normals && new Float32Array(normals) });
const pose = (values = {}) => ({ ...ZERO_MODEL_ORIGIN, ...values });
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const area = (mesh) => {
  let total = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (id) => new Vector3().fromArray(mesh.positions, id * 3));
    total += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return total;
};

// Inversion adapts the shared origin gizmo to conventional B-in-A coordinates.
for (const input of [pose(), pose({ x: 2, y: -4, z: 0.2, roll: 17, pitch: 35, yaw: 78 }), pose({ pitch: 90, yaw: 41 }), pose({ roll: 270, pitch: -89.99999, yaw: -223 })]) {
  const gizmoOrigin = inverseModelPose(input), recovered = inverseModelPose(gizmoOrigin, input);
  const expected = modelMatrixFromOrigin(input).invert(), actual = modelMatrixFromOrigin(gizmoOrigin);
  expected.elements.forEach((value, i) => close(value, actual.elements[i]));
  Object.keys(input).forEach((field) => close(input[field], recovered[field], 1e-5));
}

const a = model([0, 0, 0, 0.7, 0.7, 0, 0.7, -0.7, 0, 2, 0, 0]);
const b = model([-1, -0.25, -0.5, 1, -0.25, -0.5, 1, 0.25, 0.5, -1, 0.25, 0.5], [0, 1, 2, 0, 2, 3]);
const aCopy = clone(a), bCopy = clone(b);
function clone(value) { return structuredClone(value); }
const rotated = pose({ yaw: 45 });
const replace = composeModels(a, b, { pose: rotated, mode: 'replace' });
assert.deepEqual(Array.from(replace.retainedA.positions), Array.from(a.positions.subarray(6)));
// (0.7, -0.7) lies in the world AABB, but outside B's rotated narrow box.
assert.equal(replace.model.positions.length / 3, 6);
const merged = composeModels(a, b, { pose: rotated, mode: 'merge' });
assert.deepEqual(merged.retainedA, a);
assert.equal(merged.model.positions.length / 3, 8);
assert.deepEqual(Array.from(merged.model.indices), [4, 5, 6, 4, 6, 7]);
assert.deepEqual(a, aCopy); assert.deepEqual(b, bCopy);

const translated = composeModels(a, b, { pose: pose({ x: 10, y: -3, z: 2 }), mode: 'replace' });
assert.deepEqual(translated.retainedA.positions, a.positions);
assert.deepEqual(Array.from(translated.model.positions.subarray(a.positions.length, a.positions.length + 3)), [9, -3.25, 1.5]);

// Cutting triangles in a rotated frame preserves surface area, source vertices,
// boundary RGB and normals. B's local footprint is 2 by 0.5 = 1 square unit.
const plane = model([-3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0], [0, 1, 2, 0, 2, 3],
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
for (const yaw of [0, 15, 45, 90, 137, 179, 270]) {
  const settings = { pose: pose({ x: 0.2, y: -0.3, yaw }), mode: 'replace' };
  const clipped = composeModels(plane, b, settings);
  close(area(clipped.retainedA), 35, 1e-5);
  assert.deepEqual(clipped.retainedA.positions.subarray(0, 12), plane.positions);
  const frame = modelMatrixFromOrigin(settings.pose), box = modelBounds(b);
  for (let i = 0; i < clipped.retainedA.indices.length; i += 3) {
    const center = new Vector3();
    for (const id of clipped.retainedA.indices.subarray(i, i + 3)) center.add(new Vector3().fromArray(clipped.retainedA.positions, id * 3));
    center.divideScalar(3).applyMatrix4(frame);
    assert.ok(['x', 'y', 'z'].some((axis) => center[axis] <= box.min[axis] + 1e-6 || center[axis] >= box.max[axis] - 1e-6));
  }
  for (let i = 0; i < clipped.retainedA.positions.length; i += 3) {
    close(clipped.retainedA.colors[i] + clipped.retainedA.colors[i + 1] + clipped.retainedA.colors[i + 2], 1);
    close(clipped.retainedA.normals[i + 2], 1);
  }
  const restored = parseEditablePly(encodeModelPly(clipped.model));
  assert.deepEqual(restored.positions, clipped.model.positions); assert.deepEqual(restored.indices, clipped.model.indices);
  assert.ok(restored.normals.every(Number.isFinite));
}

const mixed = joinEditableModels(plane, b);
assert.deepEqual(Array.from(mixed.colors.subarray(plane.positions.length)), Array(b.positions.length).fill(1));
assert.ok(mixed.normals.every(Number.isFinite));
for (let i = plane.positions.length; i < mixed.normals.length; i += 3) close(Math.hypot(...mixed.normals.subarray(i, i + 3)), 1);
const boundary = model([-1, 0, 0, 1, 0, 0, 1.0001, 0, 0]);
assert.equal(composeModels(boundary, b, { pose: pose(), mode: 'replace' }).retainedA.positions.length, 3);
assert.throws(() => composeModels(a, b, { pose: pose({ x: '' }), mode: 'replace' }), /XYZ/);
assert.throws(() => composeModels(a, b, { pose: pose(), mode: 'invalid' }), /替换或合并/);
console.log('model composition: pose/gizmo inversion, oriented-box replacement, exact retained vertices, mesh clipping, merge indices, mixed attributes, PLY exports and validation passed');
