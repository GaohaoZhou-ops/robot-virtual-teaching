import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from "../src/features/robot/model/robotLoader.js";
import { restoreMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { normalizePolyline, polylineBasePose, samplePolylinePlan, readPolylineTcp, transformPolyline, polylinePlanFromSearchPosition, repeatPolylinePlan } from "../src/features/teaching/polyline/model/polylineTeaching.js";
import { planPolyline } from "../src/features/teaching/polyline/model/polylineTeachingSolver.js";
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";

const far = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
function fixture() {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, 0.05], halfSize: [0.05, 0.05, 0.05] };
  for (const side of ['left', 'right']) {
    let parent = robot;
    for (let i = 0; i < 4; i += 1) {
      const joint = new THREE.Group(); joint.name = `${side}_J${i + 1}`;
      joint.userData = { jointType: i === 3 ? 'revolute' : 'prismatic', jointValue: 0,
        jointAxis: i === 3 ? [0, 0, 1] : [0, 1, 2].map((axis) => Number(axis === i)),
        restPosition: i ? [0, 0, 0] : [0.4, side === 'left' ? 0.3 : -0.3, 0.7],
        jointLimit: { lower: i === 3 ? -Math.PI : -0.12, upper: i === 3 ? Math.PI : 0.12, velocity: i === 3 ? 1 : 0.1 } };
      parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
    }
    const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool);
  }
  layer.updateMatrixWorld(true);
  return { robot, layer };
}
const points = (vertices) => vertices.map((position, i) => ({ id: `p${i}`, position }));
const makePath = (base, vertices = [[0.8, 0.3, 0.7], [0.86, 0.36, 0.7]]) => normalizePolyline({ base, points: points(vertices) });
async function plan(path, environment = far, options = {}) {
  const { robot, layer } = fixture();
  return planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), environment, path, ...options });
}

// Old paths are fixed by default; bad ranges cannot reach the worker.
assert.deepEqual(makePath().base, { sync: false, search: false, allowPartial: false, waistAssist: false, range: 2, yawRange: 180 });
assert.equal(makePath({ range: NaN }), null);
assert.equal(makePath({ yawRange: 181 }), null);
assert.equal((await plan(makePath())).complete, false, 'a fixed short arm cannot reach the distant line');
assert.equal(polylinePlanFromSearchPosition(null), null);
assert.equal(polylinePlanFromSearchPosition({ complete: false }), null);

for (const [sync, search] of [[false, false], [true, false], [false, true], [true, true]]) {
  const path = makePath({ sync, search }, !sync && !search ? [[0.4, 0.3, 0.7], [0.46, 0.36, 0.7]] : undefined);
  const result = await plan(path);
  assert.ok(result.complete, JSON.stringify({ sync, search, issue: result.issue }));
  const { robot, layer } = fixture(), initial = readRobotJointValues(robot);
  const initialMatrix = layer.matrixWorld.clone();
  const checker = await createMobileCollisionChecker(robot, far);
  const orientation = new THREE.Quaternion().fromArray(result.quaternion);
  let last = null, lastVelocity = null, maxTravel = 0, maxTurn = 0;
  const dt = result.durationMs / 1200 / 1000;
  for (let i = 0; i <= 1200; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 1200);
    if (sample.basePose) {
      layer.position.fromArray(sample.basePose.position); layer.quaternion.fromArray(sample.basePose.quaternion);
    }
    layer.updateMatrixWorld(true); applyRobotJointValues(robot, sample.joints);
    assert.ok(checker.check().clear);
    if (!sync && !search) assert.ok(layer.matrixWorld.equals(initialMatrix), 'fixed means exactly the original base transform');
    {
      assert.ok(readPolylineTcp(robot, path).distanceTo(new THREE.Vector3().fromArray(sample.target)) <= path.settings.tolerance * 1.02);
      assert.ok(getRobotEndEffector(robot, 'left').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) < path.settings.rotationTolerance * Math.PI / 180);
    }
    for (const name of Object.keys(initial).filter((name) => name.startsWith('right'))) assert.equal(sample.joints[name], initial[name]);
    if (sample.base) {
      maxTravel = Math.max(maxTravel, Math.hypot(sample.base.x, sample.base.y)); maxTurn = Math.max(maxTurn, Math.abs(sample.base.yaw));
      if (search && !sync && sample.drawing) for (const axis of ['x', 'y', 'yaw']) assert.ok(Math.abs(sample.base[axis] - result.selectedBase[axis]) < 1e-12);
      if (last) {
        assert.ok(Math.hypot(sample.base.x - last.base.x, sample.base.y - last.base.y) / dt <= 0.10001, 'vector base speed is limited');
        assert.ok(Math.abs(sample.base.yaw - last.base.yaw) / dt <= 15.001, 'yaw speed is limited');
        const velocity = ['x', 'y', 'yaw'].map((axis) => (sample.base[axis] - last.base[axis]) / dt);
        if (lastVelocity) {
          assert.ok(Math.hypot(velocity[0] - lastVelocity[0], velocity[1] - lastVelocity[1]) / dt <= 0.2501, 'vector base acceleration is limited');
          assert.ok(Math.abs(velocity[2] - lastVelocity[2]) / dt <= 30.01, 'yaw acceleration is limited');
        }
        lastVelocity = velocity;
      }
    }
    last = sample;
  }
  if (sync || search) assert.ok(maxTravel > 0.2, 'the base really moves, including when arm-only IK fails');
  if (sync && !search) assert.ok(maxTurn > 0.1, 'yaw participates in the combined IK');
  if (search) {
    assert.ok(result.baseSearch.feasible >= 1);
    assert.equal(result.segments[0].phase, 'positioning');
    const first = samplePolylinePlan(result, 0);
    assert.deepEqual(first.joints, initial); assert.deepEqual(first.base, { x: 0, y: 0, yaw: 0 });
    assert.equal(first.drawing, false, 'preposition is continuous from the actual pose, without ink');
    assert.deepEqual(result.selectedBase, result.segments.find((segment) => segment.index >= 0).samples[0].base, 'reported parking pose is the actual pose at the start of drawing');
    const original = JSON.stringify(result), drawing = result.segments.filter(segment => segment.index >= 0);
    const positioned = polylinePlanFromSearchPosition(result), startMs = drawing[0].startMs;
    assert.ok(positioned.durationMs < result.durationMs, 'adopting the search result removes the preposition/approach time');
    assert.equal(positioned.baseReference, result.baseReference, 'offsets retain the original world reference');
    assert.deepEqual(positioned.initialJoints, drawing[0].samples[0].joints);
    positioned.segments.forEach((segment, i) => {
      assert.equal(segment.samples, drawing[i].samples);
      assert.equal(segment.timing, drawing[i].timing);
      assert.equal(segment.arcMapping, drawing[i].arcMapping);
    });
    for (let i = 0; i <= 200; i += 1) {
      const elapsed = positioned.durationMs * i / 200;
      const expected = samplePolylinePlan(result, startMs + elapsed), actual = samplePolylinePlan(positioned, elapsed);
      assert.equal(actual.drawing, true);
      for (const field of ['joints', 'base']) for (const key of Object.keys(expected[field])) {
        assert.ok(Math.abs(actual[field][key] - expected[field][key]) < 1e-9, `${field}.${key} retains the checked trajectory`);
      }
      for (const field of ['position', 'quaternion']) actual.basePose[field].forEach((value, j) => {
        assert.ok(Math.abs(value - expected.basePose[field][j]) < 1e-9, 'placement must not translate or rotate the checked stroke again');
      });
    }
    const replay = repeatPolylinePlan(positioned);
    assert.deepEqual(samplePolylinePlan(replay, 0).joints, samplePolylinePlan(positioned, positioned.durationMs).joints);
    assert.ok(replay.segments.every(segment => segment.phase !== 'positioning'), 'replay never returns to the old base position');
    assert.deepEqual(polylinePlanFromSearchPosition(positioned), positioned, 'repeated placement does not accumulate time or offsets');
    assert.equal(JSON.stringify(result), original, 'the original checked plan stays intact');
    assert.equal(polylinePlanFromSearchPosition({ ...result, complete: false, executable: false }), null);
    assert.equal(polylinePlanFromSearchPosition({ ...result, baseSearch: null }), null);
    const tilted = { ...result, baseReference: { position: [2, -3, .4], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, -.12, .4)).toArray() } };
    assert.deepEqual(samplePolylinePlan(polylinePlanFromSearchPosition(tilted), 0).basePose,
      samplePolylinePlan(tilted, startMs).basePose, 'nonzero, tilted world references are preserved');
  } else {
    assert.equal(polylinePlanFromSearchPosition(result), null, 'a non-search plan offers no search placement');
  }
  for (const segment of result.segments.slice(0, -1)) {
    const before = samplePolylinePlan(result, segment.endMs - 0.001), after = samplePolylinePlan(result, segment.endMs + 0.001);
    for (const name of Object.keys(initial)) assert.ok(Math.abs(before.joints[name] - after.joints[name]) < 1e-8);
    if (before.base) for (const axis of ['x', 'y', 'yaw']) assert.ok(Math.abs(before.base[axis] - after.base[axis]) < 1e-8);
  }
}

// Search considers the entire line. A stroke longer than the static arm's
// workspace fails in search-only, but succeeds with synchronized motion.
const long = [[0.8, 0.3, 0.7], [1.3, 0.3, 0.7]];
assert.equal((await plan(makePath({ search: true, yawRange: 0 }, long))).complete, false);
assert.equal((await plan(makePath({ search: true, sync: true, yawRange: 0 }, long))).complete, true);
assert.equal((await plan(makePath({ sync: true, range: 0.05, yawRange: 0 }))).complete, false, 'the movement envelope is enforced');
assert.equal((await plan(makePath({ search: true, range: 0.05, yawRange: 0 }))).complete, false);
{
  const result = await plan(makePath({ search: true, yawRange: 0 }, [[.4, .3, .7], [.6, .3, .7]]));
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  assert.equal(result.segments[0].phase, 'positioning', 'the base can reposition while the TCP is already at P0');
  assert.deepEqual(result.segments[0].from, result.segments[0].to);
  assert.ok(result.selectedBase.x > 0.05);
}
{
  const locked = ['left_J1', 'left_J2', 'left_J3', 'left_J4'];
  const result = await plan(makePath({ sync: true }), far, { lockedJointNames: locked });
  assert.equal(result.complete, true, JSON.stringify(result.issue));
  for (const segment of result.segments) for (const sample of segment.samples) {
    for (const name of locked) assert.equal(sample.joints[name], 0, 'base-only travel respects every arm lock');
  }
}

// A wall between the original and searched bases blocks transit even if both
// endpoints and the arm's final target are clear. Surface warnings cannot
// downgrade a chassis collision.
const wall = new THREE.BoxGeometry(0.03, 4, 0.4); wall.translate(0.2, 0, 0.2);
const obstruction = { kind: 'mesh', positions: wall.attributes.position.array, indices: wall.index.array };
for (const base of [{ sync: true, yawRange: 0 }, { search: true, yawRange: 0 }, { sync: true, search: true, yawRange: 0 }]) {
  const result = await plan(makePath(base), obstruction);
  assert.equal(result.complete, false);
  assert.match(result.issue.message, /8 mm 预留区/);
  assert.ok(result.issue.collision.environmentLinks.includes('base'));
  assert.ok(result.issue.collision.environmentClearanceLinks.includes('base'));
  assert.ok(!result.issue.collision.environmentIntersectingLinks.includes('base'));
  if (base.search) assert.equal(result.issue.phase, 'positioning');
}
wall.dispose();

// Cancellation must interrupt the candidate loop, not just path interpolation.
let cancelled = false;
await assert.rejects(plan(makePath({ search: true }), far, {
  onProgress: (progress) => { if (progress.phase === 'search') cancelled = true; },
  checkpoint: async () => { if (cancelled) throw new DOMException('cancelled', 'AbortError'); },
}), { name: 'AbortError' });

// Preserve support height and tilt under a world-Z turn (XYZ Euler.z alone
// would rotate about the wrong axis on a tilted chassis).
{
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.12, 0.4, 'XYZ'));
  const reference = { position: [1, 2, 0.4], quaternion: q.toArray() };
  const pose = polylineBasePose(reference, { x: 0.2, y: -0.1, yaw: 60 });
  assert.deepEqual(pose.position, [1.2, 1.9, 0.4]);
  const beforeUp = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const afterUp = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(pose.quaternion));
  assert.ok(Math.abs(beforeUp.z - afterUp.z) < 1e-12);
  const path = makePath({ sync: true, search: true, range: 1.2, yawRange: 60 });
  assert.deepEqual(normalizePolyline(JSON.parse(JSON.stringify(path))).base, path.base);
  assert.deepEqual(normalizePolyline(transformPolyline(path, new THREE.Matrix4().makeTranslation(1, 2, 3))).base, path.base);
}

// Actual BOTX: combine base with arm while retaining the torso, other arm,
// tool-axis standoff and world orientation in independently sampled playback.
for (const [sync, search] of [[true, false], [false, true], [true, true]]) {
  const source = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
  const robot = restoreMobileTeachingRobot(source.robot), layer = new THREE.Group(); layer.add(robot); layer.updateMatrixWorld(true);
  const p = readPolylineTcp(robot, { side: 'left', tcpOffset: [0, 0, -0.2] });
  // The fixture starts fully extended downward: a long horizontal line at
  // its lowest reach needs continuous base travel. For search-only, relocate
  // to a distant short stroke that fits within one fixed arm workspace.
  if (search) p.x += 0.25;
  const path = normalizePolyline({ base: { sync, search }, tcpOffset: [0, 0, -0.2],
    points: points([p.toArray(), p.clone().add(new THREE.Vector3(...(search ? [0, 0.02, 0] : [-0.02, 0.2, 0]))).toArray()]) });
  const result = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path, environment: far });
  assert.ok(result.complete, JSON.stringify({ sync, search, issue: result.issue }));
  if (search && !sync) assert.ok(result.selectedBase.x > 0.2);
  const live = restoreMobileTeachingRobot(source.robot); layer.add(live);
  const initial = readRobotJointValues(live), checker = await createMobileCollisionChecker(live, far);
  for (let i = 0; i <= 500; i += 1) {
    const sample = samplePolylinePlan(result, result.durationMs * i / 500);
    layer.position.fromArray(sample.basePose.position); layer.quaternion.fromArray(sample.basePose.quaternion); layer.updateMatrixWorld(true);
    applyRobotJointValues(live, sample.joints);
    assert.ok(readPolylineTcp(live, path).distanceTo(new THREE.Vector3().fromArray(sample.target)) < path.settings.tolerance * 1.02);
    assert.ok(getRobotEndEffector(live, 'left').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion().fromArray(result.quaternion)) < 0.5 * Math.PI / 180);
    assert.ok(checker.check().clear);
    for (const name of Object.keys(initial).filter((name) => !name.startsWith('left_J'))) assert.equal(sample.joints[name], initial[name]);
  }
}
console.log('Polyline chassis: four modes, world FK, fixed parking, XY/yaw limits and speeds, transit collisions, cancellation, persistence and BOTX passed.');
