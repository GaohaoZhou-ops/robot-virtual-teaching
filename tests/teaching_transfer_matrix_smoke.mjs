import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';
import { normalizeProject } from '../src/lib/io.js';
import {
  boundTeachingTransform, extractTeachingWorkspace, identityTransferPose, parseTransferMatrix, placeTeachingWorkspace,
  transferMatrix, transformTeachingPose, writeBackTeachingWorkspace,
} from '../src/lib/teachingTransfer.js';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';

const close = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
const vector = (actual, expected, epsilon) => ['x', 'y', 'z'].forEach((axis, index) => close(actual[axis], expected[index], epsilon));
const sampleText = readFileSync(new URL('./fixtures/position_0.txt', import.meta.url), 'utf8');
const sample = parseTransferMatrix(sampleText);
const samplePose = transformTeachingPose(identityTransferPose(), sample);
vector(samplePose.position, [4.116670, -1.306052, 0.130329]);
// Independent row-by-column calculation catches transposed matrices and wrong translation units.
vector(new Vector3(1, 2, 3).applyMatrix4(sample), [3.101295, -3.317191, 3.117691], 3e-6);
close(samplePose.rpy.yaw, 179.583867, 2e-5);
close(sample.determinant(), 1, 1e-12);
sample.elements.forEach((value, index) => close(transferMatrix(samplePose).elements[index], value, 1e-12));
assert.deepEqual(parseTransferMatrix(`\uFEFF\n ${sampleText.replaceAll(' ', '\t').replaceAll('\n', '\r\n')} \n`).elements, sample.elements);

const identity = '1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1';
assert.deepEqual(parseTransferMatrix(identity).elements, new Matrix4().elements);
const quarterTurn = '0 -1 0 4e0\n1 0 0 -2\n0 0 1 +.5\n0 0 0 1';
vector(new Vector3(10, 20, 1).applyMatrix4(parseTransferMatrix(quarterTurn)), [-16, 8, 1.5]);
for (const text of [
  '', '1 0 0 0', `${identity}\n0 0 0 1`, identity.replace('1 0 0 0', '1 0 0'),
  identity.replace('1 0 0 0', '1 0 0 0 0'),
]) assert.throws(() => parseTransferMatrix(text), /4 行/);
for (const invalid of ['NaN', 'Infinity', '1e999', '0x10', '1,0', 'abc']) {
  assert.throws(() => parseTransferMatrix(identity.replace('1 0 0 0', `1 0 0 ${invalid}`)), /第 1 行第 4 列/);
}
assert.throws(() => parseTransferMatrix(identity.replace('0 0 0 1', '0.1 0 0 1')), /最后一行/);
assert.throws(() => parseTransferMatrix(identity.replace('0 0 0 1', '0 0 0 0')), /最后一行/);
for (const row of ['2 0 0 0', '1 .1 0 0', '-1 0 0 0', '0 0 0 0']) {
  assert.throws(() => parseTransferMatrix(identity.replace('1 0 0 0', row)), /正交旋转矩阵/);
}
// Full 3D rotation, including the Euler singularity, must survive conversion to the saved pose format.
for (const text of ['0 0 1 3\n0 1 0 -4\n-1 0 0 2\n0 0 0 1', '0 0 -1 3\n0 1 0 -4\n1 0 0 2\n0 0 0 1']) {
  const matrix = parseTransferMatrix(text);
  const roundTrip = transferMatrix(transformTeachingPose(identityTransferPose(), matrix));
  matrix.elements.forEach((value, index) => close(roundTrip.elements[index], value, 1e-12));
}

const source = teachingTransferFixture('independent'), target = teachingTransferFixture('map');
const originals = structuredClone({ source, target });
const localToMap = transformTeachingPose(identityTransferPose(), parseTransferMatrix(quarterTurn));
const placed = await placeTeachingWorkspace(source, target, { localToMap });
const project = normalizeProject(placed.config.project);
const parking = project.teachingTasks[1].parkingPoints[0];
vector(project.robot.origin.position, [-16, 8, 1.5]);
vector(parking.mapPose.position, [-16, 8, 1.5]);
vector(parking.poses[0].mapPose.position, [-16, 8, 1.5]);
close(parking.mapPose.rpy.roll, 15);
close(parking.mapPose.rpy.pitch, -12);
close(Math.abs(parking.mapPose.rpy.yaw), 180);
vector(project.waypoints[3].pose, [-16, 8, 1.5]);
vector(parking.poses[0].opticalTargets.left.position, [-16.2, 8.5, 2.3]);
vector(parking.poses[0].cameraCapture.frames.left.opticalPose.position, [-16.2, 8.5, 2.3]);
assert.deepEqual(parking.poses[0].fullBodyJoints.values, { shoulder: 12, lift: 0.4 });
assert.equal(parking.poses[0].cameraCapture.frames.left.pointCloud.positionData, 'AAABAAIA');
const mergedPositions = new Float32Array(placed.map.positionBuffer);
assert.deepEqual([...mergedPositions.slice(0, 18)], [...new Float32Array(target.map.positionBuffer)]);
assert.deepEqual([...mergedPositions.slice(18, 21)], [-16, 8, 1.5]);
assert.deepEqual({ source, target }, originals);

// Return to an already-bound independent workspace: the same transform must
// apply once to the original local data, regardless of the map robot's pose.
const bound = boundTeachingTransform(source.map, null, placed.map, project.workspace.transfer);
assert.deepEqual(bound, localToMap);
const placedAgain = await placeTeachingWorkspace(source, transferSnapshot(placed), { localToMap: bound });
vector(placedAgain.config.project.robot.origin.position, [-16, 8, 1.5]);
assert.deepEqual(source, originals.source);
bound.position.x = 100;
assert.deepEqual(project.workspace.transfer.localToMap, localToMap, 'preview edits must not mutate the binding');
assert.equal(boundTeachingTransform({ ...source.map, sourceHash: 'different-model' },
  null, placed.map, project.workspace.transfer), null, 'a different model must not inherit the old alignment');
assert.deepEqual(boundTeachingTransform({ ...source.map, mapId: 'reopened-model' },
  null, placed.map, project.workspace.transfer), localToMap, 'the same model can have a new cache ID');

// The rounded sample remains a rigid transform throughout placement, extraction and archive reload.
const samplePlaced = await placeTeachingWorkspace(source, target, { localToMap: samplePose });
const raw = new Matrix4().set(...sampleText.trim().split(/\s+/).map(Number));
const expected = new Vector3(10, 20, 1).applyMatrix4(raw);
vector(samplePlaced.config.project.robot.origin.position, expected.toArray(), 3e-5);
const archive = await buildProjectArchive(samplePlaced.config.project, {
  mapResource: samplePlaced.map, existingRobotPackage: samplePlaced.map.portableRobotPackage,
});
const restored = await readProjectArchive(archive.bytes);
assert.deepEqual(normalizeProject(restored.payload).workspace.transfer.localToMap, samplePose);
const extracted = await extractTeachingWorkspace(target, { bounds: target.map.bounds, localToMap: samplePose });
const local = normalizeProject(extracted.config.project);
assert.deepEqual(boundTeachingTransform(extracted.map, local.workspace.transfer, target.map, null), samplePose);
assert.equal(boundTeachingTransform(extracted.map, local.workspace.transfer,
  { ...target.map, sourceHash: 'different-target' }, null), null);
vector(new Vector3(...Object.values(local.robot.origin.position)).applyMatrix4(sample), [10, 20, 1]);
const returned = await writeBackTeachingWorkspace(transferSnapshot(extracted), target);
vector(returned.config.project.robot.origin.position, [10, 20, 1]);
assert.deepEqual(returned.map.positionBuffer, target.map.positionBuffer);
assert.deepEqual({ source, target }, originals);
console.log('transfer_matrix_sample_validation_and_coordinate_convention=ok');
console.log('transfer_matrix_geometry_robot_teaching_camera_and_archive=ok');
console.log('transfer_matrix_inverse_extraction_and_writeback=ok');
