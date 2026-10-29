import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BoxGeometry, Group, Object3D, Quaternion, Vector3, Matrix4 } from 'three';
import { normalizePolyline, samplePolylinePlan, readPolylineTcp, repeatPolylinePlan, polylineDrawingProgress,
  polylineSegmentStartPoses, polylinePlanFromSearchPosition, transformPolyline } from "../src/features/teaching/polyline/model/polylineTeaching.js";
import { polylineDrawingEdges, polylineEdgeTarget, samplePolylineOrientation } from "../src/features/teaching/polyline/model/polylineTeachingOrientation.js";
import { planPolyline } from "../src/features/teaching/polyline/model/polylineTeachingSolver.js";
import { checkPolylineStartTool } from "../src/features/teaching/polyline/model/polylineTeachingToolCheck.js";
import { applyRobotJointValues, readRobotJointValues, setRobotJointValue } from "../src/features/robot/model/robotLoader.js";
import { restoreMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";
import { normalizeProject } from "../src/features/workspace/model/io.js";
import { savePolylinePreferences, loadPolylinePreferences } from "../src/features/teaching/polyline/model/polylineTeachingPreferences.js";

const environment = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
const fixture = () => {
  const robot = new Group(), layer = new Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  for (const side of ['left', 'right']) {
    let parent = robot;
    for (let i = 0; i < 6; i += 1) {
      const joint = new Group(); joint.name = `${side}_J${i + 1}`;
      joint.userData = { jointType: i < 3 ? 'prismatic' : 'revolute', jointValue: 0,
        jointAxis: [0, 1, 2].map(axis => Number(axis === i % 3)),
        restPosition: i ? [0, 0, 0] : [.4, side === 'left' ? .3 : -.3, .7],
        jointLimit: { lower: i < 3 ? -.3 : -Math.PI, upper: i < 3 ? .3 : Math.PI, velocity: i < 3 ? .1 : 1 } };
      parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
    }
    const tool = new Object3D(); tool.name = `tool_${side}`; parent.add(tool);
  }
  layer.updateMatrixWorld(true); return { robot, layer };
};
const stroke = (points, extra = {}) => normalizePolyline({ points: points.map(position => ({ position })),
  ...extra, settings: { perpendicularTool: true, ...extra.settings } });
const numericalTangent = (edge, u) => polylineEdgeTarget(edge, Math.min(1, u + 1e-8))
  .sub(polylineEdgeTarget(edge, Math.max(0, u - 1e-8))).normalize();
assert.equal(normalizePolyline({ points: [] }).settings.perpendicularTool, false);

// Independent finite differences check the orientation field, including
// straight tangencies, inflections, coincident points, closed curves and turns.
for (const pathType of ['polyline', 'spline']) for (const uniformSpeed of [false, true]) {
  for (const points of [
    [[0, 0, 0], [.08, 0, .03], [.16, .06, -.02], [.23, -.01, .05]],
    [[0, 0, 0], [0, 0, .1]],
    [[0, 0, 0], [.08, 0, 0], [.02, 0, 0]],
    [[0, 0, 0], [0, 0, 0], [.08, 0, 0], [.08, .08, 0]],
  ]) for (const closed of [false, true]) {
    const path = stroke(points, { pathType, closed, settings: { uniformSpeed } });
    for (const edge of polylineDrawingEdges(path)) {
      let before;
      for (let i = 0; i <= 500; i += 1) {
        const q = samplePolylineOrientation(edge, i / 500), axis = new Vector3(0, 0, 1).applyQuaternion(q);
        assert.ok(Math.abs(axis.dot(numericalTangent(edge, i / 500))) < 2e-4,
          JSON.stringify({ pathType, uniformSpeed, points, closed, edge: edge.index, u: i / 500,
            error: axis.dot(numericalTangent(edge, i / 500)) }));
        assert.ok(q.toArray().every(Number.isFinite));
        if (before) assert.ok(q.angleTo(before) < Math.PI / 2, 'no frame flips at inflections');
        before = q;
      }
      for (let i = 1; i < edge.orientation.samples.length; i += 1) {
        const samples = edge.orientation.samples;
        assert.ok(new Quaternion().fromArray(samples[i].quaternion).angleTo(new Quaternion().fromArray(samples[i - 1].quaternion)) < Math.PI / 85,
          'orientation sampling resolves narrow corners instead of jumping');
      }
    }
  }
}
const checkPlayback = (robot, layer, path, plan) => {
  assert.equal(plan.executable, true, JSON.stringify(plan.issue));
  layer.add(robot);
  const initial = plan.initialJoints, opposite = path.side === 'left' ? 'right' : 'left';
  let coverage = 0, maxTurn = 0;
  const q0 = robot.getObjectByName(`tool_${path.side}`).getWorldQuaternion(new Quaternion());
  for (let i = 0; i <= 800; i += 1) {
    const time = plan.durationMs * i / 800, sample = samplePolylinePlan(plan, time);
    if (sample.basePose) { layer.position.fromArray(sample.basePose.position); layer.quaternion.fromArray(sample.basePose.quaternion); }
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.ok(readPolylineTcp(robot, path).distanceTo(new Vector3().fromArray(sample.target)) <= path.settings.tolerance * 1.01);
    for (const name of Object.keys(initial).filter(name => name.startsWith(opposite))) assert.ok(Math.abs(sample.joints[name] - initial[name]) < 1e-8);
    const q = robot.getObjectByName(`tool_${path.side}`).getWorldQuaternion(new Quaternion());
    maxTurn = Math.max(maxTurn, q.angleTo(q0));
    const segment = plan.segments.find(s => time < s.endMs) || plan.segments.at(-1);
    if (sample.drawing && !segment.rotationOnly) {
      const a = samplePolylinePlan(plan, Math.max(segment.startMs, time - .01));
      const b = samplePolylinePlan(plan, Math.min(segment.endMs, time + .01));
      const tangent = new Vector3().fromArray(b.target).sub(new Vector3().fromArray(a.target));
      if (tangent.lengthSq() > 1e-18) assert.ok(Math.abs(tangent.normalize().dot(new Vector3(0, 0, 1).applyQuaternion(q)))
        <= Math.sin((path.settings.rotationTolerance + .05) * Math.PI / 180), `axis not perpendicular at ${time}`);
    }
    const progress = polylineDrawingProgress(path, sample).fraction;
    assert.ok(progress >= coverage - 1e-8, 'corner turns cannot erase drawing progress'); coverage = progress;
  }
  assert.ok(Math.abs(coverage - plan.coverage) < 1e-8);
  return maxTurn;
};

for (const pathType of ['polyline', 'spline']) for (const uniformSpeed of [true, false]) for (const side of ['left', 'right']) {
  const { robot, layer } = fixture(), tcpOffset = [.01, -.01, side === 'left' ? -.1 : .1];
  const start = readPolylineTcp(robot, { side, tcpOffset });
  const path = stroke([[0, 0, 0], [.05, .01, .025], [.09, .04, -.015]].map(p => start.clone().add(new Vector3(...p)).toArray()),
    { pathType, side, tcpOffset, settings: { uniformSpeed } });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.equal(plan.complete, true, JSON.stringify(plan.issue));
  assert.ok(checkPlayback(robot, layer, path, plan) > .1, 'the tool must actually turn');
  const ghosts = polylineSegmentStartPoses(plan, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  assert.equal(ghosts.length, 2, 'in-place turns do not duplicate segment ghosts');
  if (pathType === 'polyline' && !uniformSpeed) {
    const turn = plan.segments.find(s => s.rotationOnly);
    assert.ok(turn && turn.durationMs > 0, 'strict corner has a checked in-place turn');
    assert.deepEqual(turn.from, turn.to);
    assert.equal(samplePolylinePlan(plan, (turn.startMs + turn.endMs) / 2).segmentProgress, 0);
  }
  const repeat = repeatPolylinePlan(plan);
  assert.equal(samplePolylinePlan(repeat, 0).drawing, false);
  assert.deepEqual(samplePolylinePlan(repeat, 0).joints, plan.segments.at(-1).samples.at(-1).joints);
  assert.equal(polylineDrawingProgress(path, samplePolylinePlan(repeat, repeat.durationMs)).fraction, 1);
}

for (const base of [{ sync: true }, { search: true }, { sync: true, search: true }]) {
  const { robot, layer } = fixture();
  const path = stroke([[.77, .3, .65], [.84, .3, .69]], { tcpOffset: [0, 0, -.1], base: { ...base, yawRange: 0 } });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.equal(plan.complete, true, JSON.stringify(plan.issue));
  checkPlayback(robot, layer, path, plan);
  if (base.search) {
    const positioned = polylinePlanFromSearchPosition(plan);
    assert.ok(positioned);
    const sample = samplePolylinePlan(positioned, 0);
    assert.equal(sample.drawing, true); assert.equal(sample.segmentProgress, 0);
  }
}
{
  const { robot, layer } = fixture();
  const path = stroke([[.4, .3, .7], [.45, .32, .72], [1.2, .35, .72]], { pathType: 'spline', base: { allowPartial: true } });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.equal(plan.partial, true, JSON.stringify(plan.issue));
  assert.ok(plan.coverage > 0 && plan.coverage < 1);
  checkPlayback(robot, layer, path, plan);
}
{
  const { robot, layer } = fixture();
  const path = stroke([[.4, .3, .7], [.45, .3, .72], [.45, .35, .71], [.4, .35, .69]], { pathType: 'spline', closed: true });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.equal(plan.complete, true, JSON.stringify(plan.issue));
  checkPlayback(robot, layer, path, plan);
  assert.equal(polylineSegmentStartPoses(plan, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }).length, 4);
}
{
  const { robot, layer } = fixture();
  const path = stroke([[.4, .3, .7], [.45, .3, .75]]);
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment,
    lockedJointNames: ['left_J4', 'left_J5', 'left_J6'] });
  assert.equal(plan.complete, false); assert.equal(plan.issue.code, 'continuous-ik');
  assert.equal(plan.issue.phase, 'approach', 'locked orientation cannot silently bypass the constraint at P0');
}

// Collision preflight must place the rigid tool at the new P0 orientation.
{
  const { robot, layer } = fixture(), frame = robot.getObjectByName('tool_left');
  frame.userData.mobileCollision = { linkName: 'drawing_tool', chain: ['left_J6'], center: [0, 0, .08], halfSize: [.012, .012, .012] };
  const path = stroke([[.4, .3, .6], [.45, .3, .65]], { tcpOffset: [0, 0, -.1] });
  const center = new Vector3(-1, 0, 1).normalize().multiplyScalar(.18).add(new Vector3(...path.points[0].position));
  const box = new BoxGeometry(.008, .008, .008).translate(...center.toArray());
  const environment = { kind: 'mesh', positions: box.attributes.position.array, indices: box.index.array };
  assert.equal((await checkPolylineStartTool({ robot, frame, path, environment })).blocked, true);
  assert.equal((await checkPolylineStartTool({ robot, frame, path: { ...path, settings: { ...path.settings, perpendicularTool: false } }, environment })).blocked, false);
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.equal(plan.complete, false); assert.ok(plan.issue.collision);
  box.dispose();
}

// Real BOTX kinematics, both arms, signed 200 mm tool offsets and all locked
// torso/idle-arm values. Independently inspect dense FK playback and collision.
const botx = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8')).robot;
for (const side of ['left', 'right']) {
  const robot = restoreMobileTeachingRobot(botx), layer = new Group(); layer.add(robot);
  const values = [0, -80, 10, 70, -10, 5, 0];
  applyRobotJointValues(robot, Object.fromEntries(['left', 'right'].flatMap(s => values.map((v, i) => [`${s}_J${i + 1}`, s === 'left' ? v : -v]))));
  layer.updateMatrixWorld(true);
  const initial = readRobotJointValues(robot), tcpOffset = [0, 0, side === 'left' ? -.2 : .2];
  const start = readPolylineTcp(robot, { side, tcpOffset });
  const q = robot.getObjectByName(`tool_${side}`).getWorldQuaternion(new Quaternion());
  const path = stroke([[0, 0, 0], [.012, 0, 0], [.024, .003, .001]].map(p => new Vector3(...p).applyQuaternion(q).add(start).toArray()),
    { pathType: 'spline', side, tcpOffset });
  const plan = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment });
  assert.equal(plan.complete, true, `${side}: ${JSON.stringify(plan.issue)}`);
  checkPlayback(robot, layer, path, plan);
  const checker = await createMobileCollisionChecker(robot, environment);
  for (let i = 0; i <= 100; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / 100);
    applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
    assert.equal(checker.check().clear, true);
    for (const [name, value] of Object.entries(initial)) if (!name.startsWith(side + '_J')) assert.ok(Math.abs(sample.joints[name] - value) < 1e-8);
  }
}

const saved = stroke([[0, 0, 0], [.1, 0, .05]], { id: 'perpendicular', pathType: 'spline' });
const project = { virtualTeaching: { tasks: [{ id: 'task', parkingPoints: [], polylines: [saved] }] } };
assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(project))).teachingTasks[0].polylines[0], saved);
const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
savePolylinePreferences(saved, storage);
assert.equal(loadPolylinePreferences(storage).settings.perpendicularTool, true);
assert.equal(transformPolyline(saved, new Matrix4().makeRotationX(.4)).settings.perpendicularTool, true);
console.log('Perpendicular tool: finite-difference tangents, 3D curves/lines, both BOTX arms and signed offsets, smooth/stopped turns, base sync/search, partial/closed paths, actual FK, locks/collisions, progress/ghosts/repeat and persistence passed.');
