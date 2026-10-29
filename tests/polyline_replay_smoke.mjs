import assert from 'node:assert/strict';
import * as THREE from 'three';
import { setRobotJointValue } from "../src/features/robot/model/robotLoader.js";
import { planPolyline } from "../src/features/teaching/polyline/model/polylineTeachingSolver.js";
import { normalizePolyline, repeatPolylinePlan, samplePolylinePlan, polylineSegmentStartPoses, polylineVertices } from "../src/features/teaching/polyline/model/polylineTeaching.js";
import { polylinePreviewParts, POLYLINE_EXECUTED_COLOR } from "../src/features/teaching/polyline/model/polylineTeachingPreview.js";

const far = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
function fixture() {
  const robot = new THREE.Group();
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  let parent = robot;
  for (let i = 0; i < 3; i += 1) {
    const joint = new THREE.Group(); joint.name = `left_J${i + 1}`;
    joint.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: [0, 1, 2].map((axis) => Number(axis === i)),
      restPosition: i ? [0, 0, 0] : [.4, .3, .7], jointLimit: { lower: -.12, upper: .12, velocity: .1 } };
    parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
  }
  const tool = new THREE.Object3D(); tool.name = 'tool_left'; parent.add(tool);
  robot.updateMatrixWorld(true); return robot;
}
function samePose(a, b) {
  for (const field of ['joints', 'base']) {
    assert.deepEqual(Object.keys(a[field] || {}), Object.keys(b[field] || {}));
    for (const key of Object.keys(a[field] || {})) assert.ok(Math.abs(a[field][key] - b[field][key]) < 1e-9, `${field}.${key}`);
  }
  assert.ok(new THREE.Vector3().fromArray(a.target).distanceTo(new THREE.Vector3().fromArray(b.target)) < 1e-10);
}
const cases = [
  { base: {} }, { base: { sync: true } }, { base: { search: true } }, { base: { sync: true, search: true } },
  { base: {}, settings: { uniformSpeed: false } }, { base: { allowPartial: true }, partial: true }, { base: {}, closed: true },
];
for (const { partial, ...options } of cases) {
  const path = normalizePolyline({ ...options,
    points: [[.41, .3, .7], [.46, .3, .7], [partial ? .8 : .46, .35, .7]].map((position) => ({ position })) });
  const plan = await planPolyline({ robot: fixture(), parentMatrix: new THREE.Matrix4().toArray(), path, environment: far });
  assert.equal(plan.executable, true, JSON.stringify(plan.issue));
  assert.equal(plan.partial, Boolean(partial));
  const original = JSON.stringify(plan), drawing = plan.segments.filter((segment) => segment.index >= 0);
  const startMs = drawing[0].startMs, drawingMs = plan.durationMs - startMs;
  const replay = repeatPolylinePlan(plan);
  const fixedBase = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  const starts = polylineSegmentStartPoses(plan, fixedBase), repeatedStarts = polylineSegmentStartPoses(replay, fixedBase);
  const vertices = polylineVertices(path);
  assert.deepEqual(starts.map((pose) => pose.segmentIndex), vertices.slice(1).map((_, index) => index));
  assert.deepEqual(repeatedStarts.map((pose) => pose.segmentIndex), starts.map((pose) => pose.segmentIndex));
  starts.forEach((pose, i) => {
    const sample = samplePolylinePlan(plan, pose.startMs);
    assert.deepEqual(pose.joints, sample.joints);
    assert.deepEqual(pose.basePose, sample.basePose || fixedBase);
    assert.ok(new THREE.Vector3().fromArray(pose.target).distanceTo(vertices[pose.segmentIndex]) <= path.settings.tolerance,
      'a rounded edge starts on the checked blend near the authored vertex');
    for (const key of Object.keys(pose.joints)) assert.ok(Math.abs(pose.joints[key] - repeatedStarts[i].joints[key]) < 1e-8);
    assert.notEqual(pose.basePose.position, fixedBase.position, 'snapshots own their base position');
  });
  assert.ok(starts[0].startMs >= startMs, 'approach is not a drawing segment');
  assert.ok(repeatedStarts[0].startMs + 1e-6 >= drawingMs, 'return legs do not produce extra ghosts');
  assert.equal(JSON.stringify(plan), original, 'cached geometry, timing and diagnostics must remain intact');
  assert.equal(replay.segments.length, drawing.length * 2);
  assert.ok(Math.abs(replay.durationMs - drawingMs * 2) < 1e-9);
  samePose(samplePolylinePlan(replay, 0), samplePolylinePlan(plan, plan.durationMs));
  let previousCompleted = 0;
  for (let i = 0; i <= 600; i += 1) {
    const t = drawingMs * i / 600, back = samplePolylinePlan(replay, t);
    samePose(back, samplePolylinePlan(plan, plan.durationMs - t));
    if (i < 600) {
      assert.equal(back.phase, 'returning'); assert.equal(back.drawing, false);
      const parts = polylinePreviewParts(path, plan, back);
      assert.ok(parts.every((part) => !part.completed && part.color !== POLYLINE_EXECUTED_COLOR), 'returning never redraws the old orange stroke');
    }
    const next = samplePolylinePlan(replay, drawingMs + t), forward = samplePolylinePlan(plan, startMs + t);
    samePose(next, forward);
    assert.equal(next.segmentIndex, forward.segmentIndex);
    assert.ok(Math.abs(next.segmentProgress - forward.segmentProgress) < 1e-9);
    const colored = polylinePreviewParts(path, plan, next);
    const completed = colored.filter((part) => part.completed).reduce((sum, part) => sum + part.length, 0);
    assert.ok(completed >= previousCompleted - 1e-9); previousCompleted = completed;
    if (partial) assert.ok(colored.some((part) => part.color === 0xff796b), 'unreachable remainder is preserved');
  }
  assert.equal(samplePolylinePlan(replay, replay.durationMs).done, true);
  for (const returning of replay.segments.filter((segment) => segment.reverse)) {
    const source = drawing.find((segment) => segment.samples === returning.samples);
    assert.ok(source); assert.equal(returning.timing, source.timing); assert.equal(returning.arcMapping, source.arcMapping);
    assert.equal(source.timing[0].v0, 0); assert.equal(source.timing.at(-1).v1, 0, 'reverse/forward join is at rest');
  }
  const again = repeatPolylinePlan(replay);
  assert.equal(again.durationMs, replay.durationMs); assert.equal(again.segments.length, replay.segments.length, 'repeated runs do not accumulate return legs');
}
assert.equal(repeatPolylinePlan(null), null);
assert.equal(repeatPolylinePlan({ complete: false, executable: false }), null);
assert.deepEqual(polylineSegmentStartPoses(null), []);
// A closed stroke with identical final joints/base needs no return movement.
const exactLoop = { complete: true, durationMs: 1000, segments: [{ index: 0, durationMs: 1000,
  samples: [{ u: 0, joints: { slide: 0 }, base: { x: 0, y: 0, yaw: 0 } }, { u: 1, joints: { slide: 0 }, base: { x: 0, y: 0, yaw: 0 } }] }] };
assert.equal(repeatPolylinePlan(exactLoop).segments.length, 1);
console.log('Polyline replay: exact checked reverse/forward poses and timing, no teleport/replanning, all chassis modes, strict/rounded/closed/partial progress, no ink on return and repeated reuse passed.');
