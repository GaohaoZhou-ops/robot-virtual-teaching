import assert from 'node:assert/strict';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';
import { boundTeachingRelation, createTeachingAlignment, hasLoadedMapWorkspace, identityTransferPose,
  parseTransferMatrixFile, placeTeachingWorkspace, transformTeachingPose, writeBackTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { mapRouteSyncStatus } from '../src/lib/mapRouteSync.js';
import { normalizeProject } from '../src/lib/io.js';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';
import { prepareLinkedProjectImport } from '../src/lib/linkedProject.js';
import { prepareWorkspaceCollectionImport } from '../src/lib/projectWorkspaceCollection.js';

const independent = teachingTransferFixture('independent');
const map = teachingTransferFixture('map');
const originalMap = structuredClone(map);
const originalLocal = structuredClone(independent);
const imported = parseTransferMatrixFile('0 -1 0 5\n1 0 0 -3\n0 0 1 2\n0 0 0 1');
const options = { localToMap: transformTeachingPose(identityTransferPose(), imported.matrix),
  matrixImports: [{ name: 'alignment.txt', values: imported.values }] };
assert.ok(hasLoadedMapWorkspace(map));
for (const missing of [null, { mode: 'map' }, independent,
  { ...map, map: { ...map.map, positionBuffer: new ArrayBuffer(0) } },
  { ...map, map: { ...map.map, positionBuffer: null } },
  { ...map, config: { ...map.config, mapId: 'wrong-id' } }]) {
  assert.equal(hasLoadedMapWorkspace(missing), false);
  await assert.rejects(createTeachingAlignment(missing, options), /先加载完整/);
}
const transfer = await createTeachingAlignment(map, options);
assert.equal(transfer.kind, 'alignment');
assert.deepEqual(map, originalMap);
assert.deepEqual(independent, originalLocal);
independent.config.config.project.workspace.transfer = transfer;
assert.deepEqual(normalizeProject(independent.config.config.project).workspace.transfer, transfer);
assert.deepEqual(boundTeachingRelation(independent.map, transfer, map.map, null), transfer);
assert.ok(mapRouteSyncStatus(independent.map, transfer, map.config).available);
assert.equal(boundTeachingRelation(independent.map, transfer, { ...map.map, mapId: 'different', sourceHash: 'different' }, null), null);
await assert.rejects(writeBackTeachingWorkspace(independent, map), /没有可回写/);

// Other groups add geometry without changing the map coordinate system. A
// model with only an alignment must keep its relation across these additions.
const other = teachingTransferFixture('independent');
other.map.mapId = other.config.mapId = 'other-independent-group';
other.map.teachingGroupId = 'other-independent-group';
const firstAddition = transferSnapshot(await placeTeachingWorkspace(other, map, { localToMap: identityTransferPose() }));
assert.deepEqual(boundTeachingRelation(independent.map, transfer, firstAddition.map,
  firstAddition.config.config.project.workspace.transfer), transfer);
const intermediateAlignment = await createTeachingAlignment(firstAddition, options);
const enlargedMap = transferSnapshot(await placeTeachingWorkspace(other, firstAddition, { localToMap: options.localToMap }));
for (const relation of [transfer, intermediateAlignment]) {
  assert.deepEqual(boundTeachingRelation(independent.map, relation, enlargedMap.map,
    enlargedMap.config.config.project.workspace.transfer), relation);
  assert.ok(mapRouteSyncStatus(independent.map, relation, enlargedMap.config).available);
}

// The pending relationship survives both archive formats, without applying it
// to either geometry until an explicit placement is requested.
for (const target of [map, enlargedMap]) for (const withHistory of [false, true]) {
  const history = structuredClone(originalLocal);
  history.map.mapId = history.config.mapId = 'history-unbound';
  history.archivedAt = 1800000000000;
  const archive = await buildProjectArchive(independent.config.config.project, {
    mapResource: independent.map, existingRobotPackage: independent.map.portableRobotPackage,
    linkedWorkspace: target, independentHistory: withHistory ? [history] : [],
  });
  const restored = await readProjectArchive(archive.bytes);
  const workspaces = withHistory
    ? prepareWorkspaceCollectionImport(restored.workspaceCollection).workspaces
    : prepareLinkedProjectImport(restored.linkedWorkspaces);
  const relation = normalizeProject(workspaces.independent.config.config.project).workspace.transfer;
  assert.equal(relation.kind, 'alignment');
  assert.equal(relation.sourceMap.mapId, workspaces.map.map.mapId);
  assert.deepEqual(relation.localToMap, JSON.parse(JSON.stringify(transfer.localToMap)));
  assert.deepEqual(relation.matrixImports, transfer.matrixImports);
  assert.deepEqual(new Float32Array(workspaces.map.map.positionBuffer), new Float32Array(target.map.positionBuffer));
  assert.deepEqual(new Float32Array(workspaces.independent.map.positionBuffer), new Float32Array(independent.map.positionBuffer));
  assert.ok(mapRouteSyncStatus(workspaces.independent.map, relation, workspaces.map.config).available);
}
const changed = { position: { x: 14, y: -8, z: 2 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
const placed = transferSnapshot(await placeTeachingWorkspace(independent, map, { localToMap: changed }));
assert.deepEqual(boundTeachingRelation(independent.map, transfer, placed.map,
  placed.config.config.project.workspace.transfer).localToMap, changed, 'A later placement overrides the initial alignment');
assert.deepEqual(map, originalMap);
console.log('optional_alignment_requires_loaded_map_preserves_geometry_and_survives_archives=ok');
console.log('alignment_route_sync_and_later_placement_override_without_false_writeback=ok');
console.log('pending_alignment_survives_other_groups_repeated_placement_and_archive=ok');
