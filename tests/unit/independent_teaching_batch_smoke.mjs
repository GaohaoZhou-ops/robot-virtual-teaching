import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchingBatchMatrix, prepareIndependentTeachingBatch, readIndependentBatchMatrix } from '../../src/features/workspace/model/independentTeachingBatch.js';
import { boundTeachingTransform } from '../../src/features/teaching/model/teachingTransfer.js';
import { teachingTransferFixture } from '../teaching_transfer_helpers.mjs';
import { buildProjectArchive, readProjectArchive } from '../../src/features/workspace/model/projectArchive.js';
import { prepareWorkspaceCollectionImport } from '../../src/features/workspace/model/projectWorkspaceCollection.js';

const candidates = [{ id: 'a', name: 'part_a.txt' }, { id: 'b', name: 'position_12.txt' }];
assert.equal(matchingBatchMatrix('PART_A.PLY', candidates), 'a');
assert.equal(matchingBatchMatrix('model_12.ply', candidates), 'b');
assert.equal(matchingBatchMatrix('unknown.ply', candidates), '');
assert.equal(matchingBatchMatrix('part_a.ply', [...candidates, { id: 'duplicate', name: 'part_a.txt' }]), '');
const first = await readIndependentBatchMatrix(new File(['1 0 0 5\n0 1 0 0\n0 0 1 1\n0 0 0 1'], 'a.txt'));
const second = await readIndependentBatchMatrix(new File(['0 -1 0 -8\n1 0 0 6\n0 0 1 2\n0 0 0 1'], 'b.txt'));
await assert.rejects(readIndependentBatchMatrix(new File(['1 0 0 1'], 'invalid.txt')), /4 行/);
const file = new File([await readFile(new URL('../fixtures/rotation-map.ply', import.meta.url))], 'shared.ply');
let reads = 0;
const originalRead = file.arrayBuffer.bind(file);
file.arrayBuffer = () => { reads += 1; return originalRead(); };
const map = teachingTransferFixture('map');
const before = structuredClone(map);
const settings = { selectedRobot: map.config.config.project.robot, meshRenderQuality: 'performance' };
const entries = [
  { file, name: '工位 A · 左侧', matrix: first, syncRoute: true, placeInMap: true },
  { file, name: '工位 B · 右侧', matrix: second, syncRoute: true, placeInMap: true },
  { file, name: '稍后示教', matrix: null, syncRoute: false, placeInMap: false },
];
const { replacements, mapPlacement } = await prepareIndependentTeachingBatch(entries, {
  targetMap: map, settings, robotPackage: map.map.portableRobotPackage,
});
assert.equal(reads, 1, 'The same file is parsed only once');
assert.deepEqual(map, before, 'Preparation must not mutate the target');
assert.equal(new Set(replacements.map((item) => item.map.teachingGroupId)).size, 3);
assert.equal(new Set(replacements.map((item) => item.map.mapId)).size, 3);
assert.deepEqual(replacements.map((item) => item.config.project.workspace.independentTeachingName), entries.map((item) => item.name));
assert.equal(replacements[2].config.project.workspace.transfer, undefined);
assert.deepEqual(replacements[0].map.positionBuffer, replacements[1].map.positionBuffer);
const count = replacements[0].map.pointCount;
assert.equal(mapPlacement.map.pointCount, map.map.pointCount + count * 2);
const positions = new Float32Array(mapPlacement.map.positionBuffer);
assert.deepEqual(positions.slice(0, map.map.pointCount * 3), new Float32Array(map.map.positionBuffer));
const local = new Float32Array(replacements[0].map.positionBuffer);
for (let i = 0; i < local.length; i += 3) {
  assert.deepEqual([...positions.slice(map.map.pointCount * 3 + i, map.map.pointCount * 3 + i + 3)],
    [Math.fround(local[i] + 5), local[i + 1], Math.fround(local[i + 2] + 1)]);
  const actual = positions.slice((map.map.pointCount + count) * 3 + i, (map.map.pointCount + count) * 3 + i + 3);
  const expected = [-local[i + 1] - 8, local[i] + 6, local[i + 2] + 2];
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 2e-5));
}
for (const [index, replacement] of replacements.slice(0, 2).entries()) {
  assert.deepEqual(boundTeachingTransform(replacement.map, replacement.config.project.workspace.transfer,
    mapPlacement.map, mapPlacement.config.project.workspace.transfer), entries[index].matrix.localToMap);
}
assert.equal(mapPlacement.config.project.virtualTeaching.tasks.length, before.config.config.project.virtualTeaching.tasks.length);
assert.deepEqual(mapPlacement.config.project.waypoints, before.config.config.project.waypoints);

const snapshot = (item) => ({ mode: 'independent', map: item.map,
  config: { mapId: item.map.mapId, config: item.config }, archivedAt: Date.now() });
const archive = await buildProjectArchive(mapPlacement.config.project, {
  mapResource: mapPlacement.map, existingRobotPackage: mapPlacement.map.portableRobotPackage,
  companionWorkspace: snapshot(replacements[0]), independentHistory: replacements.slice(1).map(snapshot),
});
const restored = prepareWorkspaceCollectionImport((await readProjectArchive(archive.bytes)).workspaceCollection);
const restoredRows = [restored.workspaces.independent, ...restored.independentHistory];
assert.deepEqual(restoredRows.map((item) => item.config.config.project.workspace.independentTeachingName), entries.map((item) => item.name));
assert.equal(new Set(restoredRows.map((item) => item.map.teachingGroupId)).size, 3);
await assert.rejects(prepareIndependentTeachingBatch([{ ...entries[0], name: ' ' }], { settings }), /第 1 组.*名称/);
await assert.rejects(prepareIndependentTeachingBatch([{ ...entries[0], matrix: null }], { settings }), /需要转换矩阵/);
await assert.rejects(prepareIndependentTeachingBatch([{ ...entries[0], file: new File(['ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n'], 'empty.ply') }], { settings }), /第 1 组.*顶点/);
console.log('Batch pairing, distinct groups, independent transforms, original data preservation, name/archive roundtrip and invalid input passed.');
