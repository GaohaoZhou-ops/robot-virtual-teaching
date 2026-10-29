import assert from 'node:assert/strict';
import { Color, Vector3 } from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { normalizePolyline, polylineVertices, polylineDrawingProgress, preparePolylineInterpolation, samplePolylinePlan } from "../src/features/teaching/polyline/model/polylineTeaching.js";
import { preparePolylineTiming } from "../src/features/teaching/polyline/model/polylineTeachingTiming.js";
import { POLYLINE_EXECUTED_COLOR, polylinePreviewParts, writePolylinePreview } from "../src/features/teaching/polyline/model/polylineTeachingPreview.js";

const path = normalizePolyline({ points: [[0, 0, .5], [.2, 0, .5], [.2, .2, .5]].map((position) => ({ position })) });
function makePlan(source, stop = null) {
  const vertices = polylineVertices(source), segments = [];
  const edges = [{ index: -1, from: vertices[0].clone().add(new Vector3(0, 0, .1)), to: vertices[0] },
    ...vertices.slice(1).map((to, index) => ({ index, from: vertices[index], to }))];
  let durationMs = 0;
  for (const edge of edges) {
    if (stop && edge.index > stop.index) break;
    const endFraction = stop?.index === edge.index ? stop.fraction : 1;
    const to = edge.from.clone().lerp(edge.to, endFraction), distance = edge.from.distanceTo(to);
    const samples = preparePolylineInterpolation([{ u: 0, joints: { arm: 0 } }, { u: 1, joints: { arm: distance } }]);
    const timing = preparePolylineTiming(samples, distance, source.settings, { arm: { type: 'prismatic', velocity: .1 } });
    segments.push({ index: edge.index, from: edge.from.toArray(), to: to.toArray(), endFraction, samples,
      ...timing, startMs: durationMs, endMs: durationMs + timing.durationMs });
    durationMs += timing.durationMs;
  }
  return { complete: !stop, partial: Boolean(stop), executable: true, segments, durationMs,
    ...(stop ? { stoppedAt: { segmentIndex: stop.index, progress: stop.fraction, position: segments.at(-1).to } } : {}),
    warnings: [{ segmentIndex: 1 }] };
}
const sum = (parts, completed) => parts.filter((part) => part.completed === completed).reduce((total, part) => total + part.length, 0);
const geometry = new LineSegmentsGeometry().setPositions(new Float32Array(54)).setColors(new Float32Array(54));
const positions = geometry.attributes.instanceStart.data.array, colors = geometry.attributes.instanceColorStart.data.array;
for (const [source, stop] of [[path, null], [path, { index: 1, fraction: .4 }], [{ ...path, closed: true }, null]]) {
  const plan = makePlan(source, stop);
  const total = polylineVertices(source).slice(1).reduce((length, point, i) => length + point.distanceTo(polylineVertices(source)[i]), 0);
  let previous = 0;
  for (let i = 0; i <= 100; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / 100);
    const parts = polylinePreviewParts(source, plan, sample);
    const completed = sum(parts, true);
    const progress = polylineDrawingProgress(source, sample);
    assert.equal(progress.total, total);
    assert.ok(Math.abs(progress.completed - completed) < 1e-6, 'percentage follows the orange boundary independently of preview visibility');
    // The preview omits pieces shorter than 1 µm. Convert that absolute
    // render tolerance to a fraction, including faster boundary samples.
    assert.ok(Math.abs(progress.fraction - completed / total) < 1e-6 / total);
    assert.ok(completed >= previous - 1e-10, 'orange progress must be monotonic along the authored order'); previous = completed;
    assert.ok(Math.abs(completed + sum(parts, false) - total) < 1e-6,
      `splitting must conserve the line within the render tolerance: ${completed + sum(parts, false)} / ${total}`);
    if (!sample.drawing) assert.equal(completed, 0, 'approach motion does not mark the stroke');
    const tail = parts.find((part) => part.completed && part.segmentIndex === sample.segmentIndex);
    if (tail) assert.ok(tail.to.distanceTo(new Vector3().fromArray(sample.target)) < 1e-9, 'the color boundary follows the real timed target');
    assert.ok(parts.filter((part) => part.completed).every((part) => part.color === POLYLINE_EXECUTED_COLOR));
    writePolylinePreview(geometry, parts);
    assert.equal(geometry.instanceCount, parts.length);
    assert.equal(geometry.attributes.instanceStart.data.array, positions);
    assert.equal(geometry.attributes.instanceColorStart.data.array, colors);
    parts.forEach((part, index) => assert.equal(new Color().fromBufferAttribute(geometry.attributes.instanceColorStart, index).getHex(), part.color));
  }
  const completed = polylinePreviewParts(source, plan, samplePolylinePlan(plan, plan.durationMs));
  if (stop) {
    assert.ok(Math.abs(polylineDrawingProgress(source, samplePolylinePlan(plan, plan.durationMs)).fraction - .7) < 1e-9,
      'completing a partial plan must not report the entire requested line as 100%');
    assert.ok(Math.abs(sum(completed, true) - .28) < 1e-9);
    assert.ok(Math.abs(sum(completed, false) - .12) < 1e-9);
    assert.ok(completed.filter((part) => !part.completed).every((part) => part.color === 0xff796b), 'unreachable remainder stays red');
  } else {
    assert.equal(sum(completed, false), 0);
    assert.equal(polylineDrawingProgress(source, samplePolylinePlan(plan, plan.durationMs)).fraction, 1);
  }
}
const unequal = normalizePolyline({ points: [[0, 0, 0], [.1, 0, 0], [.1, .3, 0]].map((position) => ({ position })) });
assert.equal(polylineDrawingProgress(unequal).fraction, 0);
assert.equal(polylineDrawingProgress(unequal, { drawing: false, segmentIndex: 1, segmentProgress: .5 }).fraction, 0,
  'returning along the drawing curve does not count as drawing');
assert.equal(polylineDrawingProgress(unequal, { drawing: true, segmentIndex: 0, segmentProgress: 1 }).fraction, .25);
assert.equal(polylineDrawingProgress(unequal, { drawing: true, segmentIndex: 1, segmentProgress: .5 }).fraction, .625);
assert.equal(polylineDrawingProgress({ points: [] }).fraction, 0);
assert.equal(polylineDrawingProgress({ points: [unequal.points[0], unequal.points[0]] }).fraction, 0);
const plan = makePlan(path);
const sample = samplePolylinePlan(plan, plan.segments[1].startMs + plan.segments[1].durationMs / 2);
const pending = polylinePreviewParts(path, plan, sample).filter((part) => !part.completed);
assert.ok(pending.every((part) => part.color === 0x50dce6), 'all untraveled sections stay cyan, including surface warnings');
for (const progress of [0, .01, .25, .5, .99, 1]) {
  const parts = polylinePreviewParts(path, plan, { drawing: true, segmentIndex: 1, segmentProgress: progress });
  const edge = parts.filter((part) => part.segmentIndex === 1);
  assert.ok(Math.abs(sum(edge, true) - .2 * progress) < 1e-9, 'only the traversed fraction of a warning edge becomes orange');
  assert.ok(Math.abs(sum(edge, false) - .2 * (1 - progress)) < 1e-9);
  assert.ok(edge.filter((part) => !part.completed).every((part) => part.color === 0x50dce6));
}
assert.deepEqual(plan.warnings, [{ segmentIndex: 1 }], 'progress colors must not discard warning diagnostics');
geometry.dispose();
console.log('Polyline progress: length-weighted percentages, approach/return exclusion, closed/partial paths, zero length, timed orange/cyan boundary, warning colors and GPU buffer reuse passed.');
