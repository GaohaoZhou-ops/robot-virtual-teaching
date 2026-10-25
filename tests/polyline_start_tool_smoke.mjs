import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues, setRobotJointValue } from '../src/lib/robotLoader.js';
import { serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { createMobileCollisionChecker, prepareMobileCollisionEnvironment } from '../src/lib/mobileTeachingCollision.js';
import { normalizePolyline, samplePolylinePlan, readPolylineTcp } from '../src/lib/polylineTeaching.js';
import { planPolylineWithSuggestion } from '../src/lib/polylineTeachingSuggestion.js';
import { checkPolylineStartTool } from '../src/lib/polylineTeachingToolCheck.js';
import { explainPolylineSearch } from '../src/lib/polylineTeachingExplanation.js';

const fixture = () => {
  const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
  let parent = robot;
  for (let i = 0; i < 3; i += 1) {
    const node = new THREE.Object3D(); node.name = `right_J${i + 1}`;
    node.userData = { jointType: 'prismatic', jointValue: 0,
      jointAxis: [0, 1, 2].map(axis => Number(axis === i)), restPosition: i ? [0, 0, 0] : [.4, 0, .7],
      jointLimit: { lower: -1, upper: 1, velocity: .3 } };
    parent.add(node); setRobotJointValue(node, 0); parent = node;
  }
  const frame = new THREE.Object3D(); frame.name = 'tool_right'; parent.add(frame);
  const camera = new THREE.Object3D(); frame.add(camera);
  camera.userData.mobileCollision = { linkName: 'mounted_tool', chain: ['right_J1', 'right_J2', 'right_J3'],
    center: [0, 0, .08], halfSize: [.03, .06, .06] };
  layer.updateMatrixWorld(true); return { robot, layer, frame, camera };
};
const box = (size, position) => {
  const geometry = new THREE.BoxGeometry(...size).translate(...position);
  const result = { kind: 'mesh', positions: geometry.attributes.position.array, indices: geometry.index.array };
  geometry.dispose(); return result;
};
const path = normalizePolyline({ side: 'right', tcpOffset: [0, 0, -.2],
  base: { waistAssist: true, allowPartial: true }, settings: { deepSearchSeconds: 30 },
  points: [[.8, 0, .7], [.82, 0, .7]].map(position => ({ position })) });
const environment = box([.1, .3, .2], [.8, 0, .98]);
const { robot, layer, frame } = fixture();
const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true }), input = structuredClone(path);
const initial = readRobotJointValues(robot), matrix = layer.matrixWorld.clone(), progress = [];
const options = { snapshot, parentMatrix: matrix.toArray(), path, environment, onProgress: value => progress.push(value) };
const result = await planPolylineWithSuggestion(options);
assert.equal(result.executable, false);
assert.equal(result.issue.code, 'tool-goal-collision');
assert.deepEqual(result.issue.collision.environmentIntersectingLinks, ['mounted_tool']);
assert.equal(result.approachSearch, undefined);
assert.equal(result.suggestionSearch, undefined, 'no random IK ghosts for a fixed-tool collision');
assert.ok(!progress.some(value => value.phase === 'approach-search'));
assert.equal(result.startToolCheck.oppositeDirection.direction, 1);
assert.deepEqual(readRobotJointValues(robot), initial);
assert.ok(layer.matrixWorld.equals(matrix)); assert.deepEqual(path, input);
assert.deepEqual(serializeMobileTeachingRobot(robot, { includeCollision: true }), snapshot);
const report = explainPolylineSearch(result, path, { waistAvailable: true });
assert.match(report.summary, /P0.*固定安装部件/);
assert.match(report.details.join(' '), /1.0 mm.*0.50°/);
assert.match(report.stop, /增加候选数量.*无法消除/);
assert.match(report.suggestions[0].title, /工具 \+Z/);
assert.match(report.suggestions[0].text, /尚未验证整机逆解/);
assert.ok(!report.suggestions.some(value => /开启|自搜索/.test(value.title)));
assert.match(report.original, /原直线/);
const withoutDirection = explainPolylineSearch({ ...result, startToolCheck: { ...result.startToolCheck, oppositeDirection: null } }, path);
assert.ok(!withoutDirection.suggestions.some(value => value.title.includes('+Z')));

// A direction hint is not itself a plan. Recheck and independently validate
// actual FK, collision, unchanged base and fixed tool orientation on playback.
const positive = normalizePolyline({ ...path, tcpOffset: [0, 0, .2] });
const fixed = await planPolylineWithSuggestion({ ...options, path: positive });
assert.equal(fixed.complete, true, JSON.stringify(fixed.issue));
const checker = await createMobileCollisionChecker(robot, environment);
for (let i = 0; i <= 600; i += 1) {
  const sample = samplePolylinePlan(fixed, fixed.durationMs * i / 600);
  applyRobotJointValues(robot, sample.joints); layer.updateMatrixWorld(true);
  assert.ok(checker.check().clear);
  assert.ok(layer.matrixWorld.equals(matrix));
  assert.ok(readPolylineTcp(robot, positive).distanceTo(new THREE.Vector3().fromArray(sample.target)) <= positive.settings.tolerance);
  assert.ok(getRobotEndEffector(robot, 'right').frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion()) < 1e-8);
}
applyRobotJointValues(robot, initial); layer.updateMatrixWorld(true);

// Do not reject a whole tolerance neighbourhood just because its nominal pose
// grazes the 8 mm margin. A substantial overlap remains blocked; a 7.5 mm gap
// is left for normal IK/route checking because allowed residuals can clear it.
const directPath = normalizePolyline({ ...path, tcpOffset: [0, 0, 0] });
for (const [gap, blocked, nominalBlocked] of [[.004, true, true], [.0075, false, true], [.02, false, false]]) {
  const wall = box([.002, .3, .3], [.8 + .03 + gap + .001, 0, .78]);
  const preparedEnvironment = await prepareMobileCollisionEnvironment(wall);
  const args = { robot, frame, path: directPath, environment: wall, preparedEnvironment };
  assert.equal((await checkPolylineStartTool(args)).blocked, blocked);
  assert.equal((await checkPolylineStartTool({ ...args, certifyTolerance: false })).blocked, nominalBlocked);
}

// The angular bound grows with a long probe. Millimetres of angular slack at
// its housing must not be treated like a zero-length TCP offset.
const longPath = normalizePolyline({ ...path, tcpOffset: [0, 0, -.8], settings: { rotationTolerance: 1 } });
const angularWall = box([.002, .3, .3], [.8 + .03 - .003 + .001, 0, 1.58]);
assert.equal((await checkPolylineStartTool({ robot, frame, path: longPath, environment: angularWall })).blocked, false);
assert.equal((await checkPolylineStartTool({ robot, frame, path: longPath, environment: angularWall, certifyTolerance: false })).blocked, true);

// Exact containment and arbitrarily rotated goal frames, including XYZ tool
// offsets, are tested using the same environment semantics as full planning.
const rotatedPath = normalizePolyline({ ...path, tcpOffset: [.03, -.02, -.2],
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, -.8, .7)).toArray() });
const q = new THREE.Quaternion().fromArray(rotatedPath.quaternion), goal = new THREE.Vector3().fromArray(rotatedPath.points[0].position);
const center = new THREE.Vector3(0, 0, .08).sub(new THREE.Vector3().fromArray(rotatedPath.tcpOffset)).applyQuaternion(q).add(goal);
const enclosed = box([.8, .8, .8], center.toArray());
assert.equal((await checkPolylineStartTool({ robot, frame, path: rotatedPath, environment: enclosed })).blocked, true);
const pointEnvironment = { kind: 'points', positions: Float32Array.from(center.toArray()) };
assert.equal((await checkPolylineStartTool({ robot, frame, path: rotatedPath, environment: pointEnvironment })).blocked, true);

// A proximal link can move relative to the tool. Its environment hit must not
// be misdiagnosed as an immutable P0 tool obstruction.
const proximal = robot.getObjectByName('right_J1');
proximal.userData.mobileCollision = { linkName: 'upper_arm', chain: ['right_J1'], center: [0, 0, 0], halfSize: [.03, .03, .03] };
const proximalWall = box([.02, .02, .02], [.8, 0, .7]);
const scope = await checkPolylineStartTool({ robot, frame, path: directPath, environment: proximalWall });
assert.equal(scope.rigidLinkCount, 1); assert.equal(scope.blocked, false);
await assert.rejects(checkPolylineStartTool({ robot, frame, path, environment,
  checkpoint: async () => { throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
assert.deepEqual(readRobotJointValues(robot), initial);
console.log('P0 tool checks: immutable goal collision, explicit direction hint, verified replan, position/angular tolerance guards, long probes, rotated XYZ offsets, containment, scope, cancellation and nonmutation passed.');
