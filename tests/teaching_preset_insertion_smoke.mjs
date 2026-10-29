import assert from 'node:assert/strict';
import { strFromU8 } from 'fflate';
import { buildAbxTeachingArchive } from "../src/features/teaching/model/abxTeachingExport.js";
import { parseAbxTeachingTask, readAbxTeachingFile } from "../src/features/teaching/model/abxTeachingImport.js";
import { normalizeProject } from "../src/features/workspace/model/io.js";
import { buildTeachingDataExport } from "../src/features/teaching/model/teachingData.js";
import { insertTeachingPreset, teachingActionPresets } from "../src/features/teaching/model/teachingPresetInsertion.js";
import { moveTeachingPose, teachingPoseMoveReason } from "../src/features/teaching/model/teachingPoseOrder.js";
import { sha256Bytes } from "../src/shared/utils/hash.js";
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';

const { payload, robotPackage, model, values, stamp } = abxTeachingFixture();
const project = normalizeProject(payload);
const task = project.teachingTasks[0];
const parking = task.parkingPoints[1];
const anchor = parking.poses[0];
const preset = {
  id: 'prepare', name: '巡检准备姿态', robot: task.robot,
  joints: { source: 'robot-preset', angularUnit: 'degree', linearUnit: 'meter',
    values: Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith('wheel_'))
      .map(([name, value]) => [name, value + 5])) },
};
const request = { parkingPointId: parking.id, poseId: anchor.id, preset, capturedAt: stamp };
const snapshot = JSON.stringify({ task, preset });
const before = insertTeachingPreset(task, { ...request, id: 'before', position: 'before' });
const after = insertTeachingPreset(task, { ...request, id: 'after', position: 'after' });
assert.deepEqual(before.parkingPoints[1].poses.map((pose) => pose.id), ['before', anchor.id, parking.poses[1].id]);
assert.deepEqual(after.parkingPoints[1].poses.map((pose) => pose.id), [anchor.id, 'after', parking.poses[1].id]);
for (const result of [before, after]) {
  assert.deepEqual(result.parkingPoints[1].poses.map((pose) => pose.sequence), [1, 2, 3]);
  assert.equal(result.parkingPoints[0], task.parkingPoints[0]);
  const inserted = result.parkingPoints[1].poses.find((pose) => ['before', 'after'].includes(pose.id));
  assert.deepEqual(inserted.mapPose, anchor.mapPose);
  assert.notEqual(inserted.mapPose, anchor.mapPose);
  assert.deepEqual(inserted.fullBodyJoints.values, preset.joints.values);
  assert.notEqual(inserted.fullBodyJoints.values, preset.joints.values);
  assert.equal(inserted.fullBodyJoints.count, 20);
  assert.equal(inserted.cameraCapture, null);
  assert.equal(inserted.opticalTargets, undefined);
}
assert.equal(JSON.stringify({ task, preset }), snapshot);
const consolePreset = { ...preset, id: 'console', joints: { ...preset.joints, source: 'joint-console' } };
assert.deepEqual(teachingActionPresets([preset, { ...preset, id: 'other', robot: { id: 'different' } },
  consolePreset, { ...preset, id: 'ordinary', joints: { ...preset.joints, source: 'urdf-movable-joints' } }], task.robot),
[preset, consolePreset]);
const consoleInsertion = insertTeachingPreset(task, { ...request, preset: consolePreset, id: 'console-insert', position: 'after' });
assert.deepEqual(consoleInsertion.parkingPoints[1].poses[1].fullBodyJoints.values, consolePreset.joints.values);
for (const changes of [
  { preset: undefined }, { preset: { ...preset, robot: { id: 'other' } } }, { poseId: 'gone' },
  { parkingPointId: 'gone' }, { position: 'invalid' }, { id: anchor.id },
  { preset: { ...preset, joints: { ...preset.joints, values: { bad: NaN } } } },
]) assert.throws(() => insertTeachingPreset(task, { ...request, id: 'bad', position: 'after', ...changes }));

for (const mode of ['map', 'independent']) {
  const saved = structuredClone(before);
  saved.coordinateFrame = mode === 'map' ? 'map' : 'virtual_origin';
  const restored = normalizeProject({ teachingSpace: { mode }, virtualTeaching: { tasks: [saved], jointPoses: [preset] } });
  assert.deepEqual(restored.teachingTasks[0].parkingPoints[1].poses.map((pose) => pose.id),
    before.parkingPoints[1].poses.map((pose) => pose.id));
  const lightweight = buildTeachingDataExport({ teachingSpace: { mode },
    virtualTeaching: { tasks: restored.teachingTasks, jointPoses: restored.jointPoses } });
  assert.deepEqual(lightweight.tasks[0].parkingPoints[1].poses.find((pose) => pose.id === 'before').fullBodyJoints.values,
    preset.joints.values);
}
const virtualPayload = { ...payload, virtualTeaching: { tasks: [before], jointPoses: [preset] } };
const virtualZip = await buildAbxTeachingArchive(virtualPayload, { robotPackage });
const virtualManifest = JSON.parse(strFromU8(virtualZip.files['manifest.json']));
const exported = await parseAbxTeachingTask(strFromU8(virtualZip.files[virtualManifest.tasks[0].file]));
assert.equal(exported.points.filter((point) => point.record.type === 'route_navigation').length, 2);
assert.deepEqual(exported.points.filter((point) => point.record.joints_rad).map((point) => point.label),
  ['姿态 b1', preset.name, anchor.name, parking.poses[1].name]);
const inserted = exported.points.find((point) => point.label === preset.name);
assert.ok(Math.abs(inserted.record.joints_rad.head[0] - preset.joints.values.head_yaw_J * Math.PI / 180) < 1e-12);

// Add a native camera step between poses. Insertion must preserve that record
// and all navigation records, even though only joint poses appear in the tree.
const original = await buildAbxTeachingArchive(payload, { robotPackage });
const manifest = JSON.parse(strFromU8(original.files['manifest.json']));
const source = await parseAbxTeachingTask(strFromU8(original.files[manifest.tasks[0].file]));
const rows = source.lines.map(JSON.parse);
const camera = rows.find((row) => row.type === 'point' && row.seq === '3');
camera.record = { type: 'zivid_capture', sides: ['left', 'right'], formats: ['png', 'exr'], wait_ms: 100, count: 1, interval_ms: 0 };
const body = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
const nativeText = `${JSON.stringify(source.header)}\n${body}${JSON.stringify({ type: 'end',
  point_count: source.header.point_count, parking_count: source.header.parking_count,
  basic_pose_count: source.header.basic_pose_count,
  sha256: await sha256Bytes(new TextEncoder().encode(body)) })}\n`;
const imported = await readAbxTeachingFile(new File([nativeText], 'native.abxteach.ndjson'),
  { robot: payload.robot, robotModel: model });
const importedGraph = { abxRoutes: imported.abxRoutes, waypoints: imported.waypoints, paths: imported.edges };
let nativeTask = imported.tasks[0];
const nativeSnapshot = JSON.stringify(nativeTask);
const nativeParking = nativeTask.parkingPoints[0], nativeAnchor = nativeParking.poses[0];
const nativePreset = { ...preset, robot: nativeTask.robot };
nativeTask = insertTeachingPreset(nativeTask, { parkingPointId: nativeParking.id, poseId: nativeAnchor.id,
  preset: nativePreset, position: 'before', id: 'native-before', capturedAt: stamp });
nativeTask = insertTeachingPreset(nativeTask, { parkingPointId: nativeParking.id, poseId: nativeAnchor.id,
  preset: { ...nativePreset, name: '巡检结束姿态' }, position: 'after', id: 'native-after', capturedAt: stamp });
assert.equal(JSON.stringify(imported.tasks[0]), nativeSnapshot);
const nativeZip = await buildAbxTeachingArchive({ ...importedGraph, virtualTeaching: {
  tasks: normalizeProject({ virtualTeaching: { tasks: [nativeTask] } }).teachingTasks,
} });
const nativeManifest = JSON.parse(strFromU8(nativeZip.files['manifest.json']));
const nativeExported = await parseAbxTeachingTask(strFromU8(nativeZip.files[nativeManifest.tasks[0].file]));
assert.equal(nativeExported.header.point_count, '7');
assert.equal(nativeExported.parkings[0].point_count, '5');
assert.deepEqual(nativeExported.points.map((point) => point.record.type || point.label),
  ['route_navigation', preset.name, nativeAnchor.name, '巡检结束姿态', 'zivid_capture', 'route_navigation', '姿态 b1']);
const sourceNonPoses = rows.filter((row) => row.type === 'point' && !row.record.joints_rad);
assert.deepEqual(nativeExported.points.filter((point) => !point.record.joints_rad).map((point) => point.record),
  sourceNonPoses.map((point) => point.record));
assert.deepEqual(nativeExported.points.filter((point) => !point.record.joints_rad).map((point) => point.action),
  sourceNonPoses.map((point) => point.action));

const beforeSnapshot = JSON.stringify(before);
const moveRequest = { parkingPointId: parking.id, poseId: 'before', direction: 'down', updatedAt: stamp };
const moved = moveTeachingPose(before, moveRequest);
assert.deepEqual(moved.parkingPoints[1].poses.map((pose) => pose.id), [anchor.id, 'before', parking.poses[1].id]);
assert.deepEqual(moved.parkingPoints[1].poses.map((pose) => pose.sequence), [1, 2, 3]);
assert.equal(moved.parkingPoints[0], before.parkingPoints[0], 'movement stays within the same parking');
assert.equal(JSON.stringify(before), beforeSnapshot);
assert.deepEqual(moved.parkingPoints[1].poses[1].fullBodyJoints, before.parkingPoints[1].poses[0].fullBodyJoints);
assert.deepEqual(moved.parkingPoints[1].poses[1].mapPose, before.parkingPoints[1].poses[0].mapPose);
const movedBack = moveTeachingPose(moved, { ...moveRequest, direction: 'up' });
assert.deepEqual(movedBack.parkingPoints[1].poses, before.parkingPoints[1].poses);
assert.equal(moveTeachingPose(movedBack, { ...moveRequest, direction: 'up' }), movedBack);
assert.match(teachingPoseMoveReason(movedBack, parking.id, 'before', 'up'), /第一个/);
assert.match(teachingPoseMoveReason(movedBack, parking.id, parking.poses[1].id, 'down'), /最后一个/);
assert.throws(() => moveTeachingPose(before, { ...moveRequest, poseId: 'missing' }), /不存在/);
assert.throws(() => moveTeachingPose(before, { ...moveRequest, direction: 'sideways' }), /上移或下移/);
const restoredMoved = normalizeProject({ virtualTeaching: { tasks: [moved] } }).teachingTasks[0];
const movedZip = await buildAbxTeachingArchive({ ...payload, virtualTeaching: { tasks: [restoredMoved] } }, { robotPackage });
const movedManifest = JSON.parse(strFromU8(movedZip.files['manifest.json']));
const movedExported = await parseAbxTeachingTask(strFromU8(movedZip.files[movedManifest.tasks[0].file]));
assert.deepEqual(movedExported.points.filter((point) => point.record.joints_rad).map((point) => point.label),
  ['姿态 b1', anchor.name, preset.name, parking.poses[1].name]);
assert.deepEqual(movedExported.points.filter((point) => !point.record.joints_rad),
  exported.points.filter((point) => !point.record.joints_rad));

const nativeBeforeMove = JSON.stringify(nativeTask);
const reorderedNative = moveTeachingPose(nativeTask, { parkingPointId: nativeParking.id,
  poseId: 'native-before', direction: 'down', updatedAt: stamp });
assert.equal(JSON.stringify(nativeTask), nativeBeforeMove);
const reorderedZip = await buildAbxTeachingArchive({ ...importedGraph, virtualTeaching: { tasks: [reorderedNative] } });
const reorderedManifest = JSON.parse(strFromU8(reorderedZip.files['manifest.json']));
const reorderedExported = await parseAbxTeachingTask(strFromU8(reorderedZip.files[reorderedManifest.tasks[0].file]));
assert.deepEqual(reorderedExported.points.map((point) => point.record.type || point.label),
  ['route_navigation', nativeAnchor.name, preset.name, '巡检结束姿态', 'zivid_capture', 'route_navigation', '姿态 b1']);
assert.deepEqual(reorderedExported.points.filter((point) => !point.record.joints_rad),
  nativeExported.points.filter((point) => !point.record.joints_rad));
assert.deepEqual(reorderedExported.parkings, nativeExported.parkings);
assert.deepEqual(moveTeachingPose(reorderedNative, { parkingPointId: nativeParking.id,
  poseId: 'native-before', direction: 'up', updatedAt: stamp }).abx.lines, nativeTask.abx.lines);

// A native task can navigate again within one parking group. Such navigation
// remains a boundary: moving a joint pose across it changes its physical stop.
const mergedRows = rows.filter((row) => row.type !== 'parking' || row.id === source.parkings[0].id)
  .map((row) => row.type === 'point' ? { ...row, parking_id: source.parkings[0].id, parking_seq: row.seq } : {
    ...row, point_count: source.header.point_count,
  });
const mergedBody = mergedRows.map((row) => `${JSON.stringify(row)}\n`).join('');
const mergedText = `${JSON.stringify({ ...source.header, parking_count: '1' })}\n${mergedBody}${JSON.stringify({
  type: 'end', point_count: source.header.point_count, parking_count: '1',
  basic_pose_count: source.header.basic_pose_count,
  sha256: await sha256Bytes(new TextEncoder().encode(mergedBody)),
})}\n`;
const crossing = (await readAbxTeachingFile(new File([mergedText], 'navigation-boundary.abxteach.ndjson'))).tasks[0];
const crossingParking = crossing.parkingPoints[0];
const crossingPose = crossingParking.poses.at(-1);
assert.match(teachingPoseMoveReason(crossing, crossingParking.id, crossingPose.id, 'up'), /不能跨导航/);
assert.throws(() => moveTeachingPose(crossing, { parkingPointId: crossingParking.id,
  poseId: crossingPose.id, direction: 'up' }), /不能跨导航/);
console.log('Teaching preset insertion: before/after, copy isolation, model binding, persistence and ZIP order passed');
console.log('Native insertion: navigation/capture preservation, sequence mapping, counts and checksum passed');
console.log('Pose ordering: up/down, parking boundaries, persistence, ZIP order and native navigation protection passed');
