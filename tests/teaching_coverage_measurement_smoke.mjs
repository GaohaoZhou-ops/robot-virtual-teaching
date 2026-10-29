import assert from 'node:assert/strict';
import * as THREE from 'three';
import { measureTeachingCoverage, prepareTeachingCoverageSamples, TEACHING_COVERAGE_SAMPLE_LIMIT } from "../src/features/teaching/model/teachingCoverageMeasurement.js";

const frame = (depths, overrides = {}) => ({
  worldToCamera: Float64Array.from(new THREE.Matrix4().elements),
  tangentX: 1, tangentY: 1,
  grid: { columns: 2, rows: 1, near: 0.3, far: 1.3, surfaceDepths: depths },
  ...overrides,
});
const left = frame([1, null]);
const right = frame([null, 1]);
const full = frame([1, 1]);
const rectangle = (x0, x1, y0, y1, z, divisions = 1) => {
  const vertices = [], indices = [];
  for (let cell = 0; cell < divisions; cell += 1) {
    const x = x0 + (x1 - x0) * cell / divisions;
    const nextX = x0 + (x1 - x0) * (cell + 1) / divisions;
    const start = vertices.length / 3;
    vertices.push(x, y0, z, nextX, y0, z, nextX, y1, z, x, y1, z);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  return { vertices, indices };
};
const sampleMesh = ({ vertices, indices }) => prepareTeachingCoverageSamples(
  new THREE.Float32BufferAttribute(vertices, 3), new THREE.Uint32BufferAttribute(indices, 1),
);
const near = (actual, expected, tolerance = 0.004) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} is not near ${expected}`,
);

const square = rectangle(-1, 1, -0.5, 0.5, 1);
const samples = sampleMesh(square);
assert.equal(samples.position.count, TEACHING_COVERAGE_SAMPLE_LIMIT);
assert.equal(samples.kind, 'surface');
assert.equal(samples.totalArea, 2);
assert.deepEqual(samples, sampleMesh(square), 'reopening uses deterministic samples');
const first = await measureTeachingCoverage(samples, [left]);
near(first.fraction, 0.5);
near(first.coveredArea, 1);
assert.deepEqual(await measureTeachingCoverage(samples, [left, left]), first, 'overlapping arms/poses must not double count');
const all = await measureTeachingCoverage(samples, [left, right]);
assert.equal(all.fraction, 1);
assert.deepEqual(await measureTeachingCoverage(samples, [right, left]), all);
assert.deepEqual(await measureTeachingCoverage(samples, [left]), first, 'deleting coverage recomputes the union');
assert.equal((await measureTeachingCoverage(samples, [])).fraction, 0);

// Dense triangulation of one half must not bias the area percentage toward it.
const denseLeft = rectangle(-1, 0, -0.5, 0.5, 1, 1000);
const coarseRight = rectangle(0, 1, -0.5, 0.5, 1);
const uneven = sampleMesh({
  vertices: [...denseLeft.vertices, ...coarseRight.vertices],
  indices: [...denseLeft.indices, ...coarseRight.indices.map((index) => index + denseLeft.vertices.length / 3)],
});
near((await measureTeachingCoverage(uneven, [left])).fraction, 0.5);
assert.equal(uneven.totalArea, samples.totalArea);

// The camera hits triangle interiors even when none of their vertices are in view.
const largeTriangle = sampleMesh({ vertices: [-2, -2, 1, 2, -2, 1, 0, 2, 1], indices: [0, 1, 2] });
const interior = await measureTeachingCoverage(largeTriangle, [frame([1, 1], { tangentX: 0.2, tangentY: 0.2 })]);
near(interior.fraction, 0.16 / 8, 0.0015);
for (const z of [0.2, 1.4]) {
  assert.equal((await measureTeachingCoverage(sampleMesh(rectangle(-0.1, 0.1, -0.1, 0.1, z)), [full])).fraction, 0, 'respect M70 working range');
}
assert.equal((await measureTeachingCoverage(samples, [frame([0.7, 0.7])])).fraction, 0, 'surface behind the first hit is occluded');
assert.equal((await measureTeachingCoverage(samples, [frame([null, null])])).fraction, 0, 'empty depth cells do not cover the object');
const translated = frame([1, 1], { worldToCamera: Float64Array.from(new THREE.Matrix4().makeTranslation(-3, 0, 0).elements) });
assert.equal((await measureTeachingCoverage(samples, [translated])).fraction, 0, 'use camera extrinsics');
const moved = sampleMesh(rectangle(2, 4, -0.5, 0.5, 1));
assert.equal((await measureTeachingCoverage(moved, [translated])).fraction, 1);

const points = prepareTeachingCoverageSamples(new THREE.Float32BufferAttribute([
  -0.5, 0, 1, 0.5, 0, 1, 2, 0, 1, -0.5, 0, 1,
], 3));
const pointResult = await measureTeachingCoverage(points, [left]);
assert.equal(pointResult.kind, 'points');
assert.equal(pointResult.fraction, 0.5);
assert.equal(pointResult.totalArea, null);
assert.equal(pointResult.coveredArea, null);
const empty = await measureTeachingCoverage(prepareTeachingCoverageSamples(null), [full]);
assert.equal(empty.status, 'unavailable');
assert.equal(empty.fraction, null);
const degenerate = await measureTeachingCoverage(sampleMesh({ vertices: [0, 0, 1], indices: [0, 0, 0] }), [full]);
assert.equal(degenerate.status, 'unavailable');
assert.equal(degenerate.kind, 'surface');
assert.throws(() => sampleMesh({ vertices: [0, 0, 1], indices: [0, 1, 2] }), /无效的模型索引/);
assert.throws(() => sampleMesh({ vertices: [NaN, 0, 1], indices: [0, 0, 0] }), /无效的模型坐标/);
assert.equal(await measureTeachingCoverage(samples, [left], { isCancelled: () => true }), null);
let cancelled = false;
setTimeout(() => { cancelled = true; }, 0);
assert.equal(await measureTeachingCoverage(samples, Array(300).fill(translated), {
  isCancelled: () => cancelled,
}), null, 'a superseded worker job yields and never publishes stale coverage');

console.log(`teaching coverage measurement passed: ${(first.fraction * 100).toFixed(3)}% half-surface; ${(interior.fraction * 100).toFixed(3)}% triangle interior; overlap, area weights, range, occlusion, deletion, cancellation`);
