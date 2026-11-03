import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix4, Vector3 } from 'three';
import { buildExport, normalizeProject } from '../src/features/workspace/model/io.js';
import { buildProjectArchive, readProjectArchive } from '../src/features/workspace/model/projectArchive.js';
import { readMapTeachingMatrix, transformMapTeachingWorkspace } from '../src/features/teaching/model/mapTeachingTransform.js';
import { mapTeachingMatrixDefinition } from '../src/features/teaching/model/mapTeachingCoordinates.js';
import { boundTeachingTransform, createTeachingAlignment, identityTransferPose, placeTeachingWorkspace,
  transferMatrix, transformTeachingPose, mapTeachingCalibrationMatrix } from '../src/features/teaching/model/teachingTransfer.js';
import { placedObjectLayers } from '../src/features/viewport/model/placedObjectRendering.js';
import { syncMapRouteToIndependent } from '../src/features/navigation/model/mapRouteSync.js';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';

const close = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const vector = (actual, expected, epsilon) => ['x', 'y', 'z'].forEach((axis, index) => close(actual[axis], expected[index], epsilon));
const file = (text, name = 'matrix.txt') => new File([text], name, { type: 'text/plain' });
const identity = await readMapTeachingMatrix(file('1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1'));
const quarter = await readMapTeachingMatrix(file('0 -1 0 4\n1 0 0 -2\n0 0 1 .5\n0 0 0 1'));
const tilt = await readMapTeachingMatrix(file('1 0 0 -3\n0 0 -1 5\n0 1 0 2\n0 0 0 1'));
const local = teachingTransferFixture('independent');
local.map.teachingGroupId = 'first-group';
const secondLocal = teachingTransferFixture('independent');
secondLocal.map.teachingGroupId = 'second-group';
const background = teachingTransferFixture('map');
let original = transferSnapshot(await placeTeachingWorkspace(local, background, { localToMap: identityTransferPose() }));
original = transferSnapshot(await placeTeachingWorkspace(secondLocal, original, { localToMap: identityTransferPose() }));
const untouched = structuredClone(original);
const first = await transformMapTeachingWorkspace(original, quarter);
assert.deepEqual(original, untouched, 'conversion must not mutate its source snapshot');
assert.deepEqual(first.map.indexBuffer, original.map.indexBuffer);
assert.deepEqual(first.map.colorBuffer, original.map.colorBuffer);
assert.equal(first.map.pointCount, original.map.pointCount);
assert.notEqual(first.map.sourceHash, original.map.sourceHash);
assert.equal(first.map.sourceBlob, null);
assert.equal(placedObjectLayers(first.map, first.config.project.workspace.transfer).objectRanges.length, 2);
const positions = new Float32Array(first.map.positionBuffer);
assert.deepEqual(positions.slice(0, background.map.pointCount * 3), new Float32Array(background.map.positionBuffer));
assert.deepEqual([...positions.slice(18, 21)], [-16, 8, 1.5]);
assert.deepEqual([...positions.slice(36, 39)], [-16, 8, 1.5]);
vector(first.config.project.waypoints[0].pose, [-16, 8, 1.5]);
close(Math.abs(first.config.project.waypoints[0].pose.yaw), 180);
vector(first.config.project.robot.origin.position, [-16, 8, 1.5]);
for (const task of first.config.project.virtualTeaching.tasks) {
  const parking = task.parkingPoints[0], pose = parking.poses[0];
  vector(parking.mapPose.position, [-16, 8, 1.5]);
  vector(pose.mapPose.position, [-16, 8, 1.5]);
  vector(pose.opticalTargets.left.position, [-16.2, 8.5, 2.3]);
  assert.equal(pose.cameraCapture.frames.left.pointCloud.positionData, 'AAABAAIA');
  assert.deepEqual(pose.fullBodyJoints.values, { shoulder: 12, lift: 0.4 });
  assert.equal(task.map.sourceHash, first.map.sourceHash);
}
assert.ok(first.config.project.paths.every((edge) => edge.connectivity === 'unchecked'));
for (const independent of [local, secondLocal]) {
  const binding = boundTeachingTransform(independent.map, null, first.map, first.config.project.workspace.transfer);
  vector(binding.position, [4, -2, 0.5]);
  const synced = syncMapRouteToIndependent(independent.map, null, transferSnapshot(first).config);
  vector(synced.waypoints[0].pose, [10, 20, 1]);
}

// Reloading identical numeric values must not move anything or accumulate rounding.
let repeat = first;
for (let index = 0; index < 4; index += 1) {
  repeat = await transformMapTeachingWorkspace(transferSnapshot(repeat), { ...quarter, name: 'renamed.txt' });
}
assert.deepEqual(repeat.map.positionBuffer, first.map.positionBuffer);
assert.deepEqual(repeat.config.project.waypoints, first.config.project.waypoints);
assert.deepEqual(repeat.config.project.virtualTeaching, first.config.project.virtualTeaching);
const replaced = await transformMapTeachingWorkspace(transferSnapshot(first), tilt);
vector(replaced.config.project.waypoints[0].pose, [7, 4, 22]);
assert.deepEqual([...new Float32Array(replaced.map.positionBuffer).slice(18, 21)], [7, 4, 22]);
const direct = await transformMapTeachingWorkspace(original, tilt);
assert.deepEqual(replaced.map.positionBuffer, direct.map.positionBuffer);
const reset = await transformMapTeachingWorkspace(transferSnapshot(replaced), identity);
assert.deepEqual(reset.map.positionBuffer, original.map.positionBuffer);
vector(reset.config.project.waypoints[0].pose, [10, 20, 1]);
transferMatrix(reset.config.project.robot.origin).elements.forEach((v, i) => close(v, transferMatrix(original.config.config.project.robot.origin).elements[i]));

// Preserve edits performed after calibration; never restore a stale graph/task snapshot.
const edited = transferSnapshot(structuredClone(first));
edited.config.config.project.waypoints[0].name = 'edited waypoint';
edited.config.config.project.waypoints[0].pose.x += 1;
edited.config.config.project.paths.pop();
const editedResult = await transformMapTeachingWorkspace(edited, identity);
assert.equal(editedResult.config.project.waypoints[0].name, 'edited waypoint');
vector(editedResult.config.project.waypoints[0].pose, [10, 19, 1]);
assert.equal(editedResult.config.project.paths.length, first.config.project.paths.length - 1);

// The user's six-decimal sample, with CRLF and BOM, follows row-major T * p.
const sampleText = await readFile(new URL('./fixtures/virtual2map.txt', import.meta.url), 'utf8');
const sample = await readMapTeachingMatrix(file('\uFEFF' + sampleText.replaceAll('\n', '\r\n'), 'virtual2map.txt'));
const rounded = await transformMapTeachingWorkspace(original, sample);
const raw = new Matrix4().set(...sample.values);
vector(rounded.config.project.waypoints[0].pose, new Vector3(10, 20, 1).applyMatrix4(raw).toArray(), 3e-5);
const sampleTwice = await transformMapTeachingWorkspace(transferSnapshot(rounded), sample);
assert.deepEqual(sampleTwice.map.positionBuffer, rounded.map.positionBuffer);
assert.deepEqual(sampleTwice.config.project.waypoints, rounded.config.project.waypoints);

// Matrix metadata must survive normal exports, ZIPs, and independent placement.
const archive = await buildProjectArchive(rounded.config.project, {
  mapResource: rounded.map, existingRobotPackage: rounded.map.portableRobotPackage,
});
const restored = await readProjectArchive(archive.bytes);
assert.deepEqual(mapTeachingMatrixDefinition(restored.payload.workspace.mapTransform), sample);
assert.equal(JSON.stringify(restored.payload.workspace.mapTransform.sourceCoordinates), JSON.stringify(rounded.config.project.workspace.mapTransform.sourceCoordinates));
const restoredMap = { ...restored.resources.map, mapId: rounded.map.mapId };
const restoredSnapshot = { mode: 'map', map: restoredMap,
  config: { mapId: restoredMap.mapId, config: { project: restored.payload } } };
const afterArchive = await transformMapTeachingWorkspace(restoredSnapshot, sample);
assert.deepEqual(afterArchive.map.positionBuffer, rounded.map.positionBuffer);
assert.deepEqual(afterArchive.config.project.waypoints, rounded.config.project.waypoints);
const replacedAfterArchive = await transformMapTeachingWorkspace(transferSnapshot(afterArchive), tilt);
new Float32Array(replacedAfterArchive.map.positionBuffer).forEach((v, i) => close(v, new Float32Array(direct.map.positionBuffer)[i], 5e-6));
const appended = await placeTeachingWorkspace(local, transferSnapshot(first), {
  localToMap: boundTeachingTransform(local.map, null, first.map, first.config.project.workspace.transfer),
});
assert.deepEqual(appended.config.project.workspace.mapTransform, first.config.project.workspace.mapTransform);
assert.equal(buildExport({ ...normalizeProject(first.config.project), ...normalizeProject(first.config.project).workspace,
  mapData: first.map, heightRange: [0, 2], teachingSpaceMode: 'independent' }).workspace.mapTransform, undefined);

const noObjects = await transformMapTeachingWorkspace(background, quarter);
assert.deepEqual(noObjects.map.positionBuffer, background.map.positionBuffer);
vector(noObjects.config.project.waypoints[0].pose, [-16, 8, 1.5]);
const alignment = await createTeachingAlignment(background, { localToMap: identityTransferPose() });
const alignedSync = syncMapRouteToIndependent(local.map, alignment, transferSnapshot(noObjects).config);
vector(alignedSync.waypoints[0].pose, [10, 20, 1]);
// Alignments created after calibration must not apply the same matrix twice.
const calibratedAlignment = await createTeachingAlignment(transferSnapshot(noObjects), {
  localToMap: transformTeachingPose(identityTransferPose(), mapTeachingCalibrationMatrix(quarter)),
});
vector(syncMapRouteToIndependent(local.map, calibratedAlignment, transferSnapshot(noObjects).config).waypoints[0].pose, [10, 20, 1]);
const replacedAlignmentMap = await transformMapTeachingWorkspace(transferSnapshot(noObjects), tilt);
vector(syncMapRouteToIndependent(local.map, calibratedAlignment, transferSnapshot(replacedAlignmentMap).config).waypoints[0].pose, [10, 20, 1]);
const legacy = structuredClone(original);
delete legacy.config.config.project.workspace.transfer.geometryLayers;
await assert.rejects(transformMapTeachingWorkspace(legacy, quarter), /独立对象/);
const recovered = await transformMapTeachingWorkspace(legacy, quarter, {
  loadSource: async (identity) => identity.teachingGroupId === 'first-group' ? local.map : secondLocal.map,
});
assert.deepEqual(recovered.map.positionBuffer, first.map.positionBuffer);
await assert.rejects(transformMapTeachingWorkspace(local, quarter), /地图示教/);
for (const invalid of ['', '1 2 3', '1 0 0 0\n0 2 0 0\n0 0 1 0\n0 0 0 1', 'NaN 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1']) {
  await assert.rejects(readMapTeachingMatrix(file(invalid)), /转换矩阵/);
}
await assert.rejects(readMapTeachingMatrix(file(sampleText, 'matrix.csv')), /TXT/);
await assert.rejects(readMapTeachingMatrix({ name: 'huge.txt', size: 1024 * 1024 + 1 }), /1 MB/);
assert.deepEqual(original, untouched);
console.log('map matrix: route/object/task transforms, replacement, persistence, legacy recovery and validation passed');
