import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from "../src/features/robot/model/robotLoader.js";
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { planPolylineWithSuggestion } from "../src/features/teaching/polyline/model/polylineTeachingSuggestion.js";
import { planPolyline } from "../src/features/teaching/polyline/model/polylineTeachingSolver.js";
import { normalizePolyline, readPolylineTcp, samplePolylinePlan } from "../src/features/teaching/polyline/model/polylineTeaching.js";
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";

const far = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
function fixture(rotary = false) {
  const robot = new THREE.Group();
  robot.userData.mobileCollision = { linkName: 'base', chain: [], center: [0, 0, .05], halfSize: [.05, .05, .05] };
  for (const side of ['left', 'right']) {
    let parent = robot;
    for (let i = 0; i < 3; i += 1) {
      const joint = new THREE.Group(); joint.name = `${side}_J${i + 1}`;
      joint.userData = { jointType: rotary ? 'revolute' : 'prismatic', jointValue: 0,
        jointAxis: rotary ? [0, 0, 1] : [0, 1, 2].map((axis) => Number(axis === i)),
        restPosition: rotary ? i ? [.3, 0, 0] : [0, side === 'left' ? 0 : -1, .7]
          : i ? [0, 0, 0] : [.4, side === 'left' ? .3 : -.3, .7],
        jointLimit: { lower: rotary ? -Math.PI : -.12, upper: rotary ? Math.PI : .12, velocity: rotary ? 1 : .1 } };
      parent.add(joint); parent = joint; setRobotJointValue(joint, 0);
    }
    const tool = new THREE.Object3D(); tool.name = `tool_${side}`; parent.add(tool);
    if (side === 'left') tool.userData.mobileCollision = { linkName: 'wrist', chain: ['left_J1', 'left_J2', 'left_J3'],
      center: [0, 0, 0], halfSize: [.01, .01, .01] };
  }
  robot.updateMatrixWorld(true);
  return serializeMobileTeachingRobot(robot, { includeCollision: true });
}
const action = (points, base = {}) => normalizePolyline({ points: points.map((position) => ({ position })), base });
const check = (snapshot, path, extra = {}) => planPolylineWithSuggestion({ snapshot, path,
  parentMatrix: new THREE.Matrix4().toArray(), environment: far, ...extra });

async function verifySuggestion(snapshot, path, result, environment = far, lockedJointNames = []) {
  assert.equal(result.complete, false, 'the original approach failure must remain a failure');
  assert.equal(result.issue.code, 'continuous-ik');
  assert.equal(result.issue.phase, 'approach');
  const suggestion = result.suggestion;
  assert.ok(suggestion, JSON.stringify(result));
  assert.equal(suggestion.transitChecked, false, 'a static ghost is not a verified transit');
  assert.equal(result.suggestionSearch.found, true);
  const robot = restoreMobileTeachingRobot(snapshot), layer = new THREE.Group(); layer.add(robot);
  layer.position.fromArray(suggestion.basePose.position); layer.quaternion.fromArray(suggestion.basePose.quaternion);
  applyRobotJointValues(robot, suggestion.joints); layer.updateMatrixWorld(true);
  const initial = readRobotJointValues(restoreMobileTeachingRobot(snapshot));
  const opposite = path.side === 'left' ? 'right' : 'left';
  for (const name of Object.keys(initial).filter((name) => name.startsWith(opposite) || lockedJointNames.includes(name))) assert.equal(suggestion.joints[name], initial[name]);
  assert.ok(readPolylineTcp(robot, path).distanceTo(new THREE.Vector3().fromArray(path.points[0].position)) <= path.settings.tolerance);
  const freshPath = { ...path, quaternion: getRobotEndEffector(robot, path.side).frame.getWorldQuaternion(new THREE.Quaternion()).toArray(),
    base: { ...path.base, search: false, allowPartial: false } };
  const verified = await planPolyline({ robot, parentMatrix: layer.matrixWorld.toArray(), path: freshPath, environment, lockedJointNames });
  assert.equal(verified.complete, true, JSON.stringify(verified.issue));
  const checker = await createMobileCollisionChecker(robot, environment);
  for (let i = 0; i <= 600; i += 1) {
    const sample = samplePolylinePlan(verified, verified.durationMs * i / 600);
    applyRobotJointValues(robot, sample.joints);
    assert.ok(checker.check().clear, `suggested route collision at ${i}`);
    assert.ok(readPolylineTcp(robot, path).distanceTo(new THREE.Vector3().fromArray(sample.target)) <= path.settings.tolerance * 1.01);
    const quaternion = getRobotEndEffector(robot, path.side).frame.getWorldQuaternion(new THREE.Quaternion());
    assert.ok(THREE.MathUtils.radToDeg(quaternion.angleTo(new THREE.Quaternion().fromArray(freshPath.quaternion))) <= path.settings.rotationTolerance);
  }
}

// A locked wrist and limited slide cannot reach P0 at the original direction.
// Free-direction seeding can find an alternate tool direction at the SAME
// base; the full stroke must subsequently maintain that direction and lock.
{
  const robot = restoreMobileTeachingRobot(fixture(true));
  const slide = new THREE.Group(); slide.name = 'left_slide';
  slide.userData = { jointType: 'prismatic', jointAxis: [1, 0, 0], jointValue: 0,
    jointLimit: { lower: -.12, upper: .12, velocity: .1 }, restPosition: [0, 0, 0] };
  slide.add(robot.getObjectByName('left_J1')); robot.add(slide); setRobotJointValue(slide, 0); robot.updateMatrixWorld(true);
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true });
  const path = action([[.42, .15, .7], [.44, .15, .7]]), locks = ['left_J3'];
  const result = await check(snapshot, path, { lockedJointNames: locks });
  await verifySuggestion(snapshot, path, result, far, locks);
  assert.equal(result.suggestion.movedBase, false);
  assert.ok(result.suggestion.orientationChange > .5, 'report the newly proposed tool direction');
}

// A straight, singular planar arm cannot retract along X from its current
// pose. Another elbow branch at P0 supports the complete stroke at this base.
{
  const snapshot = fixture(true), original = structuredClone(snapshot);
  const path = action([[.48, 0, .7], [.45, .03, .7]]);
  const phases = [];
  const result = await check(snapshot, path, { onProgress: (progress) => phases.push(progress.stage) });
  await verifySuggestion(snapshot, path, result);
  assert.equal(result.suggestion.movedBase, false, 'always try posture changes before moving the base');
  assert.deepEqual(result.suggestion.basePose, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  assert.ok(!phases.includes('搜索参考底盘位置'));
  assert.deepEqual(snapshot, original, 'search must not mutate the live input snapshot');
}

// A short Cartesian arm needs a different parking position. The stationary
// mode remains stationary during the proposed stroke, with a bounded offset.
{
  const snapshot = fixture(), path = action([[.7, .3, .7], [.76, .35, .7]], { range: .6, yawRange: 0 });
  const result = await check(snapshot, path);
  await verifySuggestion(snapshot, path, result);
  assert.equal(result.suggestion.movedBase, true);
  assert.ok(Math.hypot(result.suggestion.baseDelta.x, result.suggestion.baseDelta.y) <= path.base.range);
  assert.equal(result.suggestion.basePose.position[2], 0);
  assert.deepEqual(result.suggestion.basePose.quaternion, [0, 0, 0, 1]);
  assert.equal(path.base.sync, false); assert.equal(path.base.search, false);
}

// Never advertise P0-only IK, a partial stroke, or a colliding target as a
// full solution. An unsuccessful bounded search must say no suggestion.
{
  const snapshot = fixture(), path = { ...action([[.7, -.3, .7], [.76, -.25, .7]], { range: .6, yawRange: 0 }), side: 'right' };
  await verifySuggestion(snapshot, path, await check(snapshot, path));
}
{
  const snapshot = fixture();
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.12, -.08, .3));
  const origin = new THREE.Vector3(1, 2, .1), matrix = new THREE.Matrix4().compose(origin, rotation, new THREE.Vector3(1, 1, 1));
  const start = new THREE.Vector3(.4, .3, .7).applyMatrix4(matrix).add(new THREE.Vector3(.3, .04, 0));
  const path = action([start.toArray(), start.clone().add(new THREE.Vector3(.04, .02, 0)).toArray()], { range: .6, yawRange: 0 });
  const result = await check(snapshot, path, { parentMatrix: matrix.toArray() });
  await verifySuggestion(snapshot, path, result);
  assert.equal(result.suggestion.movedBase, true);
  assert.equal(result.suggestion.basePose.position[2], origin.z);
  assert.ok(rotation.angleTo(new THREE.Quaternion().fromArray(result.suggestion.basePose.quaternion)) < 1e-7, 'preserve base height, roll and pitch');
}
for (const path of [
  action([[.7, .3, .7], [1.5, .3, .7]], { allowPartial: true, range: .6, yawRange: 0 }),
  action([[2, .3, .7], [2.1, .3, .7]], { range: .05, yawRange: 0 }),
]) {
  const result = await check(fixture(), path);
  assert.equal(result.suggestion, null);
  assert.equal(result.suggestionSearch.found, false);
}
{
  const wall = new THREE.BoxGeometry(.08, .08, .08); wall.translate(.7, .3, .7);
  const result = await check(fixture(), action([[.7, .3, .7], [.76, .35, .7]], { range: .6, yawRange: 0 }),
    { environment: { kind: 'mesh', positions: wall.attributes.position.array, indices: wall.index.array } });
  assert.equal(result.suggestion, null); wall.dispose();
}

// Existing successful paths and drawing-phase failures do not invoke search.
for (const path of [action([[.4, .3, .7], [.45, .3, .7]]), action([[.4, .3, .7], [.8, .3, .7]])]) {
  const result = await check(fixture(), path);
  assert.equal(result.suggestionSearch, undefined);
}
{
  let searching = false;
  await assert.rejects(check(fixture(true), action([[.48, 0, .7], [.45, .03, .7]]), {
    onProgress: (progress) => { searching ||= progress.phase === 'suggestion'; },
    checkpoint: async () => { if (searching) throw new DOMException('cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
}
console.log('Polyline suggestions: fixed-base branch recovery, bounded base relocation, full-route FK/collision/orientation validation, no partial/P0-only false positives, snapshot isolation and cancellation passed.');
