import assert from 'node:assert/strict';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';
import { boundTeachingRelation, placeTeachingWorkspace } from "../src/features/teaching/model/teachingTransfer.js";
import { normalizeProject } from "../src/features/workspace/model/io.js";
import { buildProjectArchive, readProjectArchive } from "../src/features/workspace/model/projectArchive.js";
import { linkedWorkspaceRelation, prepareLinkedProjectImport } from "../src/features/workspace/model/linkedProject.js";
import { mapRouteSyncStatus, syncMapRouteToIndependent } from "../src/features/navigation/model/mapRouteSync.js";

const original = teachingTransferFixture('map');
const first = teachingTransferFixture('independent'); // Legacy group without an explicit group ID.
const transformA = { position: { x: 5, y: -3, z: 1 }, rpy: { roll: 0, pitch: 0, yaw: 90 } };
const transformB = { position: { x: -8, y: 6, z: 2 }, rpy: { roll: 0, pitch: 0, yaw: -30 } };
const matrixImports = [{ name: 'a.txt', values: [0, -1, 0, 5, 1, 0, 0, -3, 0, 0, 1, 1, 0, 0, 0, 1] }];
const placedA = transferSnapshot(await placeTeachingWorkspace(first, original, { localToMap: transformA, matrixImports }));

// Same model bytes, different teaching instance: it starts with no binding.
const second = structuredClone(first);
second.map.mapId = second.config.mapId = 'new-independent-map';
second.map.teachingGroupId = second.config.config.project.map.teachingGroupId = 'group-B';
const before = structuredClone(placedA);
assert.equal(boundTeachingRelation(second.map, null, placedA.map, placedA.config.config.project.workspace.transfer), null);
assert.equal(mapRouteSyncStatus(second.map, null, placedA.config).available, false);
const placedB = transferSnapshot(await placeTeachingWorkspace(second, placedA, { localToMap: transformB, matrixImports: [] }));
assert.deepEqual(placedA, before, 'Placement must not change the original map snapshot');
assert.deepEqual(new Float32Array(placedB.map.positionBuffer).slice(0, placedA.map.pointCount * 3),
  new Float32Array(placedA.map.positionBuffer));
assert.deepEqual(normalizeProject(placedB.config.config.project).waypoints.slice(0, before.config.config.project.waypoints.length),
  normalizeProject(before.config.config.project).waypoints);
assert.equal(normalizeProject(placedB.config.config.project).teachingTasks.length, 3);
const relation = (independent) => linkedWorkspaceRelation({ independent, map: placedB });
assert.deepEqual(relation(first).localToMap, transformA);
assert.deepEqual(relation(first).matrixImports, matrixImports);
assert.deepEqual(relation(second).localToMap, transformB);
assert.deepEqual(relation(second).matrixImports, []);
assert.equal(mapRouteSyncStatus(first.map, null, placedB.config).available, true);
assert.equal(syncMapRouteToIndependent(second.map, null, placedB.config).waypoints.length,
  placedB.config.config.project.waypoints.length);
const third = structuredClone(second);
third.map.teachingGroupId = 'group-C';
assert.equal(relation(third), null);
console.log('independent_groups_same_model_isolated_bindings_and_cumulative_map=ok');

// Saving/importing either an older or the latest group keeps its own binding.
for (const independent of [first, second]) {
  const archive = await buildProjectArchive(independent.config.config.project, {
    mapResource: independent.map, existingRobotPackage: independent.map.portableRobotPackage,
    linkedWorkspace: placedB,
  });
  const restored = prepareLinkedProjectImport((await readProjectArchive(archive.bytes)).linkedWorkspaces);
  assert.equal(restored.independent.map.teachingGroupId, independent.map.teachingGroupId);
  assert.deepEqual(linkedWorkspaceRelation(restored).localToMap, relation(independent).localToMap);
  assert.equal(normalizeProject(restored.map.config.config.project).teachingTasks.length, 3);
  assert.equal(restored.map.config.config.project.workspace.transfer.previousPlacements.length, 1);
}
console.log('independent_group_and_prior_bindings_survive_linked_zip_roundtrip=ok');
