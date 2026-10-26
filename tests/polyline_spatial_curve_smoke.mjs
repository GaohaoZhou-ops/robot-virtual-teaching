import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BoxGeometry, CatmullRomCurve3, Group, Object3D, Vector3, Matrix4, Quaternion } from 'three';
import { normalizePolyline, polylineDrawingProgress, polylineSegmentStartPoses, samplePolylinePlan,
  readPolylineTcp, repeatPolylinePlan, transformPolyline, polylineBoundsPoints } from '../src/lib/polylineTeaching.js';
import { spatialCurveGeometry, spatialPartPoint, sampleSpatialCurve, spatialCurveDrawingEdges } from '../src/lib/polylineTeachingSpatialCurve.js';
import { polylinePreviewParts, polylinePreviewCapacity, POLYLINE_EXECUTED_COLOR } from '../src/lib/polylineTeachingPreview.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { setRobotJointValue, applyRobotJointValues, readRobotJointValues } from '../src/lib/robotLoader.js';
import { normalizeProject } from '../src/lib/io.js';
import { buildTeachingDataExport } from '../src/lib/teachingData.js';
import { loadPolylinePreferences, savePolylinePreferences } from '../src/lib/polylineTeachingPreferences.js';
import { restoreMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';

const path = (points, extra = {}) => normalizePolyline({ pathType: 'spline', points: points.map(position => ({ position })), ...extra });
const points = [[.4, .3, .7], [.435, .3, .72], [.49, .36, .68], [.505, .31, .71]];
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
assert.equal(normalizePolyline({ points: [] }).pathType, 'polyline', 'legacy geometry never changes');
assert.equal(normalizePolyline({ pathType: 'unknown', points: [] }), null);

for (const closed of [false, true]) {
  const stroke = path(points, { closed }), before = structuredClone(stroke), geometry = spatialCurveGeometry(stroke);
  const oracle = new CatmullRomCurve3(points.map(p => new Vector3().fromArray(p)), closed, 'centripetal');
  let measured = 0, previous = oracle.getPoint(0);
  for (let i = 1; i <= 20000; i += 1) {
    const next = oracle.getPoint(i / 20000); measured += next.distanceTo(previous); previous = next;
  }
  near(geometry.length, measured, .00005);
  for (const part of geometry.parts) {
    assert.deepEqual(spatialPartPoint(part, 0).toArray(), points[part.index]);
    for (let i = 0; i <= 100; i += 1) {
      assert.ok(spatialPartPoint(part, i / 100).distanceTo(oracle.getPoint((part.index + i / 100) / geometry.parts.length)) < 1e-12);
    }
  }
  const transformed = transformPolyline(stroke, new Matrix4().makeRotationX(.6).setPosition(1, -2, 3));
  near(polylineDrawingProgress(transformed).total, geometry.length);
  assert.equal(transformed.pathType, 'spline');
  const bounds = polylineBoundsPoints(stroke);
  for (let axis = 0; axis < 3; axis += 1) {
    const min = Math.min(...bounds.map(p => p.getComponent(axis))), max = Math.max(...bounds.map(p => p.getComponent(axis)));
    for (let i = 0; i <= 300; i += 1) {
      const value = oracle.getPoint(i / 300).getComponent(axis);
      assert.ok(value >= min - 1e-10 && value <= max + 1e-10);
    }
  }
  if (closed) {
    assert.deepEqual(geometry.parts.at(-1).to, geometry.parts[0].from);
    const first = geometry.parts[0], last = geometry.parts.at(-1);
    const incoming = new Vector3().fromArray(last.to).sub(new Vector3().fromArray(last.controls[1])).normalize();
    const outgoing = new Vector3().fromArray(first.controls[0]).sub(new Vector3().fromArray(first.from)).normalize();
    assert.ok(incoming.dot(outgoing) > 1 - 1e-10, 'closed seam has a continuous tangent');
  }
  const total = polylineDrawingProgress(stroke).total;
  for (let i = 0; i <= 100; i += 1) {
    const sample = { ...sampleSpatialCurve(geometry, i / 100), drawing: true };
    const progress = polylineDrawingProgress(stroke, sample), preview = polylinePreviewParts(stroke, null, sample);
    near(progress.fraction, i / 100);
    near(preview.reduce((s, part) => s + part.length, 0), total, 1e-6);
    near(preview.filter(part => part.completed).reduce((s, part) => s + part.length, 0), progress.completed, 1e-6);
    assert.ok(preview.length <= polylinePreviewCapacity(stroke));
    const boundary = preview.filter(part => part.completed).at(-1);
    if (boundary && i > 0) assert.ok(boundary.to.distanceTo(sample.target) < 1e-8);
  }
  assert.deepEqual(stroke, before);
}
const two = path(points.slice(0, 2));
near(spatialCurveGeometry(two).length, new Vector3(...points[0]).distanceTo(new Vector3(...points[1])));
for (const duplicate of [path([points[0], points[0], points[1], points[1], points[2]]),
  path([...points, points[0], points[0]], { closed: true }), path([points[0], points[0]])]) {
  const geometry = spatialCurveGeometry(duplicate);
  assert.ok(Number.isFinite(geometry.length));
  assert.ok(polylinePreviewParts(duplicate).every(part => part.length > 0));
  if (geometry.length) near(polylineDrawingProgress(duplicate, { ...sampleSpatialCurve(geometry, 1), drawing: true }).fraction, 1);
}
assert.equal(spatialCurveDrawingEdges(path([[0, 0, .7], [.04, 0, .7], [.015, 0, .7]])).length, 2, 'real reversals stop');

const fixture = () => {
  const robot = new Group(), layer = new Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  for (const side of ['left', 'right']) {
    let parent = robot;
    for (let i = 0; i < 3; i += 1) {
      const joint = new Group(); joint.name = `${side}_J${i + 1}`;
      joint.userData = { jointType: 'prismatic', jointValue: 0, jointAxis: [0, 1, 2].map(axis => Number(axis === i)),
        restPosition: i ? [0, 0, 0] : [.4, side === 'left' ? .3 : -.3, .7], jointLimit: { lower: -.12, upper: .12, velocity: .1 } };
      parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
    }
    const tool = new Object3D(); tool.name = `tool_${side}`; parent.add(tool);
  }
  layer.updateMatrixWorld(true); return { robot, layer };
};
const environment = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
for (const uniformSpeed of [true, false]) for (const partial of [false, true]) {
  const stroke = path(partial ? [...points, [.62, .32, .71]] : points,
    { settings: { uniformSpeed }, base: { allowPartial: partial } });
  const { robot, layer } = fixture(), initial = readRobotJointValues(robot);
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: stroke, environment });
  assert.equal(plan.executable, true, JSON.stringify(plan.issue));
  assert.equal(plan.partial, partial);
  assert.equal(Boolean(plan.speedProfile), uniformSpeed);
  layer.add(robot);
  let previous = 0, cruises = 0;
  for (let i = 0; i <= 2000; i += 1) {
    const time = plan.durationMs * i / 2000, sample = samplePolylinePlan(plan, time);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    const actual = readPolylineTcp(robot, stroke);
    assert.ok(actual.distanceTo(new Vector3().fromArray(sample.target)) <= stroke.settings.tolerance * 1.001);
    near(robot.getObjectByName('tool_left').getWorldQuaternion(new Quaternion()).angleTo(new Quaternion().fromArray(plan.quaternion)), 0);
    for (const name of Object.keys(initial).filter(name => name.startsWith('right'))) near(sample.joints[name], initial[name]);
    const progress = polylineDrawingProgress(stroke, sample);
    assert.ok(progress.completed >= previous - 1e-9); previous = progress.completed;
    const parts = polylinePreviewParts(stroke, plan, sample);
    near(parts.filter(p => p.completed).reduce((s, p) => s + p.length, 0), progress.completed, 1e-6);
    const segment = plan.segments.find(s => time < s.endMs) || plan.segments.at(-1);
    const cruise = segment.uniformSpeed && segment.timing.find(p => p.v0 > 0 && p.v0 === p.v1);
    if (cruise && time - segment.startMs > cruise.startMs + .1 && time - segment.startMs < cruise.endMs) {
      const nearby = samplePolylinePlan(plan, time - .01);
      applyRobotJointValues(robot, nearby.joints); layer.updateMatrixWorld(true);
      const speed = actual.distanceTo(readPolylineTcp(robot, stroke)) / .00001;
      assert.ok(Math.abs(speed / segment.cruiseSpeed - 1) < .025); cruises += 1;
    }
  }
  if (uniformSpeed) assert.ok(cruises > 0);
  near(previous, plan.distance, 1e-8);
  near(plan.requestedDistance, polylineDrawingProgress(stroke).total);
  assert.ok(partial ? plan.coverage > 0 && plan.coverage < 1 : Math.abs(plan.coverage - 1) < 1e-10);
  const ghosts = polylineSegmentStartPoses(plan, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  assert.ok(ghosts.length >= 3);
  for (const ghost of ghosts) assert.ok(new Vector3().fromArray(ghost.target).distanceTo(new Vector3().fromArray(stroke.points[ghost.segmentIndex].position)) < 1e-8);
  const repeat = repeatPolylinePlan(plan);
  assert.ok(polylinePreviewParts(stroke, plan, samplePolylinePlan(repeat, 0)).every(p => p.color !== POLYLINE_EXECUTED_COLOR));
}

for (const stroke of [path(points, { closed: true }), path([points[0], [.45, .3, .7], points[0]]),
  path([points[0], points[0], points[1]])]) {
  const { robot, layer } = fixture();
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: stroke, environment });
  assert.equal(plan.complete, true, JSON.stringify(plan.issue));
  assert.ok(Number.isFinite(plan.durationMs) && plan.durationMs < 120000);
  layer.add(robot);
  for (let i = 0; i <= 500; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / 500);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(readPolylineTcp(robot, stroke).distanceTo(new Vector3().fromArray(sample.target)) < stroke.settings.tolerance * 1.01);
  }
  near(polylineDrawingProgress(stroke, samplePolylinePlan(plan, plan.durationMs)).fraction, 1);
}
const saved = path(points, { id: 'spatial', name: '空间曲线' });
// A physical tool can hit a curve's bow while all the straight chords are
// clear. Surface-contact warnings must not bypass robot collision checking.
{
  const stroke = path([[.3, .3, .7], [.5, .3, .7], [.5, .5, .7], [.3, .5, .7]]);
  const center = spatialPartPoint(spatialCurveGeometry(stroke).parts[0], .5);
  const obstacle = new BoxGeometry(.002, .002, .002).translate(center.x, center.y, center.z);
  const environment = { kind: 'mesh', positions: obstacle.attributes.position.array, indices: obstacle.index.array };
  for (const [pathType, allowPartial] of [['polyline', false], ['spline', false], ['spline', true]]) {
    const { robot, layer } = fixture();
    robot.traverse(node => { if (node.userData.jointLimit) node.userData.jointLimit = { lower: -.5, upper: .5, velocity: .1 }; });
    robot.getObjectByName('tool_left').userData.mobileCollision = { linkName: 'drawing_tool',
      chain: ['left_J1', 'left_J2', 'left_J3'], center: [0, 0, 0], halfSize: [.001, .001, .001] };
    const source = { ...stroke, pathType, base: { ...stroke.base, allowPartial } };
    const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: source, environment });
    assert.equal(plan.complete, pathType === 'polyline', JSON.stringify(plan.issue));
    if (pathType === 'spline') {
      assert.ok(plan.issue.collision);
      assert.equal(plan.partial, allowPartial);
      if (allowPartial) {
        assert.ok(plan.coverage > 0 && plan.coverage < .3);
        const checker = await createMobileCollisionChecker(robot, environment);
        for (let i = 0; i <= 500; i += 1) {
          applyRobotJointValues(robot, samplePolylinePlan(plan, plan.durationMs * i / 500).joints);
          assert.equal(checker.check().clear, true);
        }
      }
    }
  }
  obstacle.dispose();
}
for (const base of [{ sync: true }, { search: true }, { sync: true, search: true }]) {
  const { robot, layer } = fixture();
  const stroke = path([[.61, .3, .7], [.65, .33, .71], [.69, .3, .7]], { base: { ...base, yawRange: 0 } });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: stroke, environment });
  assert.equal(plan.complete, true, JSON.stringify(plan.issue));
  layer.add(robot);
  for (let i = 0; i <= 400; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / 400);
    layer.position.fromArray(sample.basePose.position); layer.quaternion.fromArray(sample.basePose.quaternion);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(readPolylineTcp(robot, stroke).distanceTo(new Vector3().fromArray(sample.target)) < stroke.settings.tolerance * 1.01);
  }
}
// Real articulated robot, both arms: retain tool offsets and locked joints,
// and compare replay to actual FK along a genuinely nonplanar spline.
const botx = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8')).robot;
for (const side of ['left', 'right']) {
  const robot = restoreMobileTeachingRobot(botx), layer = new Group(); layer.add(robot);
  const values = [0, -80, 10, 70, -10, 5, 0];
  applyRobotJointValues(robot, Object.fromEntries(['left', 'right'].flatMap(s => values.map((v, i) => [`${s}_J${i + 1}`, s === 'left' ? v : -v]))));
  layer.updateMatrixWorld(true);
  const initial = readRobotJointValues(robot), tcpOffset = [0, 0, side === 'left' ? -.2 : .2];
  const start = readPolylineTcp(robot, { side, tcpOffset });
  const stroke = path([[0, 0, 0], [-.015, 0, .002], [-.015, side === 'left' ? .015 : -.015, 0]]
    .map(delta => start.clone().add(new Vector3(...delta)).toArray()), { side, tcpOffset });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: stroke, environment });
  assert.equal(plan.complete, true, JSON.stringify(plan.issue));
  layer.add(robot);
  for (let i = 0; i <= 1000; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / 1000);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(readPolylineTcp(robot, stroke).distanceTo(new Vector3().fromArray(sample.target)) < stroke.settings.tolerance * 1.01);
    assert.ok(robot.getObjectByName(`tool_${side}`).getWorldQuaternion(new Quaternion()).angleTo(new Quaternion().fromArray(plan.quaternion)) < stroke.settings.rotationTolerance * Math.PI / 180);
    for (const [name, value] of Object.entries(initial)) if (!name.startsWith(side + '_J')) near(sample.joints[name], value);
  }
}
const project = { virtualTeaching: { tasks: [{ id: 'task', parkingPoints: [], polylines: [saved] }] } };
assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(project))).teachingTasks[0].polylines[0], saved);
assert.deepEqual(buildTeachingDataExport(project).tasks[0].polylines[0], saved);
const entries = new Map(), storage = { setItem: (k, v) => entries.set(k, v), getItem: k => entries.get(k) };
assert.equal(savePolylinePreferences(saved, storage), true);
assert.equal(loadPolylinePreferences(storage).pathType, 'spline');
assert.equal(loadPolylinePreferences(storage).points, undefined);
console.log('Spatial curves: interpolation, closed/duplicate/reversal playback, bounds/transforms, both BOTX arms, base sync/search, actual curve collisions, partial coverage, speed, progressive colors, ghosts, repeat and persistence passed.');
