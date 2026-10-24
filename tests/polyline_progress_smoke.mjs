import assert from 'node:assert/strict';
import { Color, Vector3 } from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { normalizePolyline, polylineVertices, preparePolylineInterpolation, samplePolylinePlan } from '../src/lib/polylineTeaching.js';
import { preparePolylineTiming } from '../src/lib/polylineTeachingTiming.js';
import { POLYLINE_EXECUTED_COLOR, polylinePreviewParts, writePolylinePreview } from '../src/lib/polylineTeachingPreview.js';

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
    assert.ok(Math.abs(sum(completed, true) - .28) < 1e-9);
    assert.ok(Math.abs(sum(completed, false) - .12) < 1e-9);
    assert.ok(completed.filter((part) => !part.completed).every((part) => part.color === 0xff796b), 'unreachable remainder stays red');
  } else assert.equal(sum(completed, false), 0);
}
const plan = makePlan(path);
const sample = samplePolylinePlan(plan, plan.segments[1].startMs + plan.segments[1].durationMs / 2);
const pending = polylinePreviewParts(path, plan, sample).filter((part) => !part.completed);
assert.ok(pending.some((part) => part.color === 0x50dce6), 'pending normal path keeps cyan');
assert.ok(pending.some((part) => part.color === 0xf0a555), 'pending warning path keeps its warning color');
geometry.dispose();
console.log('Polyline progress: timed intra-segment coloring, approach exclusion, preserved pending/warning colors, closed paths, partial endpoints and GPU buffer reuse passed.');
