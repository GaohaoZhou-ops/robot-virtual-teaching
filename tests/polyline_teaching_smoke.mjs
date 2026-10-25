import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues } from '../src/lib/robotLoader.js';
import { planPolyline } from '../src/lib/polylineTeachingSolver.js';
import { normalizePolyline, readPolylineTcp, samplePolylinePlan, transformPolyline } from '../src/lib/polylineTeaching.js';
import { normalizeTeachingTasks, normalizeProject } from '../src/lib/io.js';
import { buildTeachingDataExport } from '../src/lib/teachingData.js';
import { transformTeachingTasks, extractTeachingWorkspace, writeBackTeachingWorkspace, placeTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { buildAbxTeachingExport } from '../src/lib/abxTeachingExport.js';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
function setup(side = 'left', offset = [0, 0, 0]) {
  const robot = restoreMobileTeachingRobot(fixture.robot), layer = new THREE.Group(); layer.add(robot); layer.updateMatrixWorld(true);
  const controller = getRobotEndEffector(robot, side), p = readPolylineTcp(robot, { side, tcpOffset: offset });
  return { robot, layer, controller, p };
}
const far = { kind: 'mesh', positions: new Float32Array([100, 100, 100, 101, 100, 100, 100, 101, 100]), indices: new Uint32Array([0, 1, 2]) };
const points = (vertices) => vertices.map((point, index) => ({ id: `p${index}`, position: point.toArray() }));
const parentMatrix = new THREE.Matrix4().toArray();

// A crouched BOTX produced a false initial collision between its knee and
// waist boxes. Use the actual URDF meshes, through the worker snapshot path.
{
  const { robot, layer } = setup();
  applyRobotJointValues(robot, { ankle_pitch_J: 30, knee_pitch_J: -60, waist_pitch_J: 30 });
  const coarse = await createMobileCollisionChecker(robot, far);
  assert.ok(coarse.check().selfPairs.some((pair) => pair.includes('knee_pitch_L') && pair.includes('waist_yaw_L')));
  const meshes = [];
  for (const name of ['knee_pitch_L', 'waist_yaw_L']) {
    const bytes = await readFile(new URL(`../robots/botx_abx_zivid_m70/meshes/${name}.STL`, import.meta.url));
    const geometry = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let proxy;
    robot.traverse((node) => { if (node.userData.mobileCollision?.linkName === name) proxy = node; });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    proxy.add(mesh); delete proxy.userData.mobileCollision; meshes.push(mesh);
  }
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true, includeCollisionHulls: true });
  const precise = restoreMobileTeachingRobot(structuredClone(snapshot)); layer.add(precise);
  const checker = await createMobileCollisionChecker(precise, far);
  assert.equal(checker.check().clear, true, 'convex separation rejects the knee/waist box false positive');
  const p = readPolylineTcp(precise, { side: 'left', tcpOffset: [0, 0, -.2] });
  const plan = await planPolyline({ robot: precise, parentMatrix, environment: far,
    path: { side: 'left', tcpOffset: [0, 0, -.2], points: points([p, p.clone().add(new THREE.Vector3(-.015, 0, 0))]) } });
  assert.ok(plan.complete, JSON.stringify(plan.issue));
  // A deeper crouch really brings other detection bodies together. Refining
  // one pair must not exempt the torso or bypass other self-collision checks.
  const blocked = restoreMobileTeachingRobot(structuredClone(snapshot)); layer.add(blocked);
  applyRobotJointValues(blocked, { ankle_pitch_J: 60, knee_pitch_J: -120, waist_pitch_J: 60 });
  const start = readPolylineTcp(blocked, { side: 'left', tcpOffset: [0, 0, -.2] });
  const failure = await planPolyline({ robot: blocked, parentMatrix, environment: far,
    path: { side: 'left', tcpOffset: [0, 0, -.2], points: points([start, start.clone().add(new THREE.Vector3(-.015, 0, 0))]) } });
  assert.equal(failure.complete, false);
  assert.equal(failure.issue.phase, 'initial');
  assert.match(failure.issue.message, /机器人自身碰撞/);
  assert.ok(failure.issue.collision.selfPairs.length);
  assert.ok(failure.issue.collision.selfPairs.every((pair) => !(pair.includes('knee_pitch_L') && pair.includes('waist_yaw_L'))));
  meshes.forEach((mesh) => { mesh.geometry.dispose(); mesh.material.dispose(); });
}

for (const side of ['left', 'right']) {
  const { robot, p, controller } = setup(side);
  const source = readRobotJointValues(robot);
  const path = normalizePolyline({ id: 'line', side, settings: { uniformSpeed: false }, points: points([p.clone().add(new THREE.Vector3(-0.01, 0, 0)),
    p.clone().add(new THREE.Vector3(-0.025, 0, 0)), p.clone().add(new THREE.Vector3(-0.025, side === 'left' ? 0.015 : -0.015, 0))]) });
  const plan = await planPolyline({ robot, parentMatrix, path, environment: far });
  assert.ok(plan.complete, JSON.stringify(plan.issue));
  assert.deepEqual(plan.segments.map((segment) => segment.index), [-1, 0, 1]);
  const orientation = new THREE.Quaternion().fromArray(plan.quaternion);
  for (let i = 0; i <= 600; i += 1) {
    const sample = samplePolylinePlan(plan, plan.durationMs * i / 600);
    applyRobotJointValues(robot, sample.joints); robot.updateMatrixWorld(true);
    const actual = readPolylineTcp(robot, path);
    assert.ok(actual.distanceTo(new THREE.Vector3().fromArray(sample.target)) <= path.settings.tolerance * 1.02, 'playback must follow each straight edge');
    assert.ok(THREE.MathUtils.radToDeg(controller.frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation)) < path.settings.rotationTolerance);
    for (const [name, value] of Object.entries(source)) if (!name.startsWith(`${side}_J`)) assert.equal(sample.joints[name], value, `${name} must remain fixed`);
  }
  for (const segment of plan.segments.slice(0, -1)) {
    const a = samplePolylinePlan(plan, segment.endMs - 0.1), b = samplePolylinePlan(plan, segment.endMs + 0.1);
    for (const name of Object.keys(source)) assert.ok(Math.abs(a.joints[name] - b.joints[name]) < 1e-7, 'real corners stop without a jump');
  }
  assert.equal(samplePolylinePlan(plan, plan.durationMs + 1000).done, true);
  assert.deepEqual(samplePolylinePlan(plan, plan.durationMs + 1000).joints, plan.segments.at(-1).samples.at(-1).joints, 'no loop or teleport to the start');
}

// A virtual pen permits contact without putting the wrist inside the workpiece.
{
  const offset = [0, 0, -0.2], { robot, p } = setup('left', offset);
  const positions = new Float32Array([p.x - .07, p.y - .07, p.z, p.x + .07, p.y - .07, p.z,
    p.x + .07, p.y + .07, p.z, p.x - .07, p.y + .07, p.z]);
  const path = normalizePolyline({ tcpOffset: offset, points: points([p, p.clone().add(new THREE.Vector3(-.025, 0, 0)), p.clone().add(new THREE.Vector3(-.025, .025, 0))]) });
  const result = await planPolyline({ robot, parentMatrix, path, environment: { positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), kind: 'mesh' } });
  assert.ok(result.complete, JSON.stringify(result.issue));
}

// Surface crossings, an enclosed tip and a virtual pen crossing the surface
// are advisory, both on approach and while drawing. IK still completes.
for (const approach of [false, true]) {
  const { robot, p } = setup('left', [0, 0, -.2]);
  const solid = new THREE.BoxGeometry(.006, .015, .015); solid.translate(p.x - .012, p.y, p.z);
  const first = approach ? p.clone().add(new THREE.Vector3(-.02, 0, 0)) : p;
  const result = await planPolyline({ robot, parentMatrix, path: { tcpOffset: [0, 0, -.2], points: points([first, p.clone().add(new THREE.Vector3(-.03, 0, 0))]) },
    environment: { kind: 'mesh', positions: solid.attributes.position.array, indices: solid.index.array } });
  assert.ok(result.complete, JSON.stringify(result.issue));
  for (const code of ['path-crosses-surface', 'tip-inside-surface', 'pen-crosses-surface']) {
    assert.ok(result.warnings.some((warning) => warning.code === code && warning.segmentIndex === (approach ? -1 : 0)
      && warning.phase === (approach ? 'approach' : 'drawing')), `${code}: ${JSON.stringify(result.warnings)}`);
  }
  assert.equal(new Set(result.warnings.map((warning) => `${warning.phase}:${warning.segmentIndex}:${warning.code}`)).size,
    result.warnings.length, 'interpolation must not flood the panel with duplicate surface warnings');
  assert.equal(samplePolylinePlan(result, result.durationMs).done, true);
  solid.dispose();
}
{
  const { robot, p } = setup('left', [0, 0, -.2]);
  const solid = new THREE.BoxGeometry(.012, .025, .025); solid.translate(p.x, p.y, p.z);
  const result = await planPolyline({ robot, parentMatrix, path: { tcpOffset: [0, 0, -.2], points: points([p, p.clone().add(new THREE.Vector3(-.03, 0, 0))]) },
    environment: { kind: 'mesh', positions: solid.attributes.position.array, indices: solid.index.array } });
  assert.ok(result.complete, JSON.stringify(result.issue));
  assert.ok(result.warnings.some((warning) => warning.phase === 'initial' && warning.code === 'tip-inside-surface'));
  solid.dispose();
}
// Physical robot/model collisions remain blocking, including the initial pose.
{
  const { robot, p } = setup('left', [0, 0, -.2]);
  let knee;
  robot.traverse((node) => { if (node.userData.mobileCollision?.linkName === 'knee_pitch_L') knee = node; });
  const center = new THREE.Vector3().fromArray(knee.userData.mobileCollision.center).applyMatrix4(knee.matrixWorld);
  const solid = new THREE.BoxGeometry(.025, .025, .025); solid.translate(center.x, center.y, center.z);
  const result = await planPolyline({ robot, parentMatrix, path: { tcpOffset: [0, 0, -.2], points: points([p, p.clone().add(new THREE.Vector3(-.03, 0, 0))]) },
    environment: { kind: 'mesh', positions: solid.attributes.position.array, indices: solid.index.array } });
  assert.equal(result.complete, false);
  assert.equal(result.issue.phase, 'initial');
  assert.match(result.issue.message, /机器人与模型碰撞/);
  assert.ok(result.issue.collision.environmentLinks.includes('knee_pitch_L'));
  solid.dispose();
}
{
  const { robot, p, controller } = setup();
  await assert.rejects(planPolyline({ robot, parentMatrix, path: { points: points([p, p.clone().addScalar(.01)]) }, environment: far,
    lockedJointNames: controller.joints.map((joint) => joint.name) }), /均被锁定/);
}
{
  const { robot, p } = setup();
  const result = await planPolyline({ robot, parentMatrix, path: { points: points([p, p.clone().add(new THREE.Vector3(-2, 0, 0))]) }, environment: far });
  assert.equal(result.complete, false); assert.ok(result.issue); assert.notEqual(result.durationMs, 0);
}
{
  const { robot, p } = setup();
  await assert.rejects(planPolyline({ robot, parentMatrix, path: { points: points([p, p.clone().addScalar(.01)]) }, environment: far,
    checkpoint: async () => { throw new DOMException('cancel', 'AbortError'); } }), { name: 'AbortError' });
}

// Source data survives project and lightweight exports. Only world quantities
// rotate/translate during workspace conversion; local tool offsets stay local.
const path = normalizePolyline({ id: 'saved', name: '试验折线', side: 'right', tcpOffset: [0, 0, .15],
  base: { allowPartial: true },
  points: points([new THREE.Vector3(1, 2, 3), new THREE.Vector3(2, 2, 3)]), quaternion: [0, 0, 0, 1] });
const project = teachingTransferFixture('map').config.config.project;
project.virtualTeaching.tasks[0].polylines = [path];
assert.deepEqual(normalizeProject(project).teachingTasks[0].polylines, [path]);
assert.deepEqual(buildTeachingDataExport(project).tasks[0].polylines, [path]);
const transform = new THREE.Matrix4().makeRotationZ(Math.PI / 2); transform.setPosition(3, 4, 5);
const transformed = transformPolyline(path, transform), restored = transformPolyline(transformed, transform.clone().invert());
restored.points.forEach((point, index) => assert.ok(new THREE.Vector3().fromArray(point.position).distanceTo(new THREE.Vector3().fromArray(path.points[index].position)) < 1e-10));
assert.deepEqual(transformed.tcpOffset, path.tcpOffset);
assert.deepEqual(transformTeachingTasks(normalizeTeachingTasks(project), transform, 'independent', {})[0].polylines[0], transformed);
assert.equal((await buildAbxTeachingExport(project)).summary.status, 'blocked');
assert.equal(normalizePolyline({ points: [{ position: [Infinity, 0, 0] }] }), null);
assert.equal(normalizePolyline({ ...path, settings: { speed: 0 } }), null);
assert.equal(normalizePolyline({ ...path, tcpOffset: [0, 0, 10] }), null);
assert.equal(normalizePolyline({ ...path, tcpOffset: [0, 0, -.2], toolAxisDirection: 1 }).toolAxisDirection, -1,
  'legacy Z offsets remain authoritative');
assert.equal(normalizePolyline({ ...path, tcpOffset: [0, 0, 0], toolAxisDirection: 1 }).toolAxisDirection, 1);

const source = teachingTransferFixture('map');
const inside = normalizePolyline({ ...path, id: 'inside-line', tcpOffset: [0, 0, 0], toolAxisDirection: 1,
  points: points([new THREE.Vector3(10, 20, 1), new THREE.Vector3(10.5, 20, 1)]) });
const outside = normalizePolyline({ ...path, id: 'outside-line', points: points([new THREE.Vector3(30, 20, 1), new THREE.Vector3(30.5, 20, 1)]) });
source.config.config.project.virtualTeaching.tasks[0].polylines = [inside, outside];
const extracted = await extractTeachingWorkspace(source, { bounds: { min: { x: 9, y: 19, z: 0 }, max: { x: 12, y: 22, z: 2 } },
  localToMap: { position: { x: 10, y: 20, z: 1 }, rpy: { roll: 0, pitch: 0, yaw: 90 } } });
assert.equal(extracted.config.project.virtualTeaching.tasks[0].polylines.length, 1);
const local = transferSnapshot(extracted);
local.config.config.project.virtualTeaching.tasks[0].polylines[0].name = '局部修改';
const returned = await writeBackTeachingWorkspace(local, source);
const returnedPaths = returned.config.project.virtualTeaching.tasks[0].polylines;
assert.equal(returnedPaths.find((path) => path.id === inside.id).name, '局部修改');
assert.deepEqual(returnedPaths.find((path) => path.id === outside.id), outside);
const conflicting = structuredClone(source);
conflicting.config.config.project.virtualTeaching.tasks[0].polylines[0].name = '地图修改';
await assert.rejects(writeBackTeachingWorkspace(local, conflicting), /对应内容已修改/);
const placed = await placeTeachingWorkspace(local, source, { localToMap: { position: { x: 1, y: 2, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 45 } } });
assert.notEqual(placed.config.project.virtualTeaching.tasks.at(-1).polylines[0].id, inside.id);
const archive = await buildProjectArchive(source.config.config.project, { mapResource: source.map, existingRobotPackage: source.map.portableRobotPackage });
const roundtrip = await readProjectArchive(archive.bytes);
assert.deepEqual(roundtrip.payload.virtualTeaching.tasks[0].polylines, [inside, outside]);
console.log('Polyline teaching: real dual-arm FK, fixed body/orientation, continuous playback, corner stops, pen offset, collision, failed IK, cancellation and persistence passed.');
