import assert from 'node:assert/strict';
import { syncDocument, validateSyncDocument, diffSyncDocument, applySyncOperations, rebaseSyncDocument } from "../../src/shared/protocols/workSyncDocument.js";
import { placedObjectLayers, appendPlacedObjectLayers } from "../../src/features/viewport/model/placedObjectRendering.js";
import { buildProjectArchive, readProjectArchive } from "../../src/features/workspace/model/projectArchive.js";
import { normalizeProject } from "../../src/features/workspace/model/io.js";
import { identityTransferPose, placeTeachingWorkspace } from "../../src/features/teaching/model/teachingTransfer.js";
import { teachingTransferFixture } from "../teaching_transfer_helpers.mjs";

const background = teachingTransferFixture('map'), source = teachingTransferFixture('independent');
const combined = await placeTeachingWorkspace(source, background, { localToMap: identityTransferPose() });
const payload = structuredClone(combined.config.project);
payload.workspace.pointColorMode = 'height'; payload.workspace.placedObjectColorMode = 'source';
payload.workspace.showHeightLegend3D = false; payload.workspace.showPathNames3D = true;
payload.rendering.meshQuality = 'balanced';
const layers = placedObjectLayers(combined.map, payload.workspace.transfer);
assert.ok(layers?.complete);
const resource = { ...combined.map, geometryLayers: layers };
payload.workspace.transfer = null;
const pack = (project, mapResource, existingRobotPackage) => buildProjectArchive(project, { mapResource, existingRobotPackage });
const first = await pack(payload, resource, combined.map.portableRobotPackage);
const imported = await readProjectArchive(first.bytes);
assert.equal(imported.payload.workspace.transfer, null, 'no dependency on the other device\'s independent workspace');
assert.deepEqual(placedObjectLayers(imported.resources.map, null), layers, 'portable geometry carries verified display groups');
assert.equal(imported.payload.workspace.pointColorMode, 'height');
assert.equal(imported.payload.workspace.placedObjectColorMode, 'source');
// Cache restoration retains the groups on BufferGeometry; later exports can reuse them.
const restored = { pointCount: resource.pointCount, sourceHash: resource.sourceHash,
  geometry: { userData: { geometryLayers: imported.resources.map.geometryLayers } } };
assert.deepEqual(placedObjectLayers(restored, null), layers);
const second = await pack(imported.payload, imported.resources.map, imported.resources.robot);
assert.deepEqual((await readProjectArchive(second.bytes)).resources.map.geometryLayers, layers);
assert.equal(placedObjectLayers({ ...resource, sourceHash: 'different-map' }, null), null);
assert.equal(placedObjectLayers({ ...resource, pointCount: 1 }, null), null);
assert.equal(placedObjectLayers({ ...resource, geometryLayers: { ...layers, objectRanges: [{ start: 0, count: 999 }] } }, null), null);
const incomplete = { ...resource, geometryLayers: { ...layers, complete: false } };
const appended = appendPlacedObjectLayers({ pointCount: resource.pointCount + 6, sourceHash: 'next' }, incomplete, null, 6);
assert.equal(appended.complete, false, 'adding an object cannot make an incomplete legacy grouping complete');
assert.equal(appended.objectRanges.length, layers.objectRanges.length + 1);

const initial = syncDocument(normalizeProject(payload));
assert.equal(initial.displaySettings.pointColorMode, 'height');
assert.equal(initial.displaySettings.placedObjectColorMode, 'source');
assert.equal(initial.displaySettings.showHeightLegend3D, false);
assert.equal(initial.displaySettings.showPathNames3D, true);
assert.equal(initial.displaySettings.meshRenderQuality, 'balanced');
assert.ok(!('transfer' in initial) && !('view3d' in initial.displaySettings) && !('collapsedPanel' in initial.displaySettings));
const local = structuredClone(initial), remote = structuredClone(initial);
local.displaySettings.pointColorMode = 'white';
remote.displaySettings.placedObjectColorMode = 'height';
remote.displaySettings.showPathNames3D = false;
const merged = applySyncOperations(local, diffSyncDocument(initial, remote));
assert.equal(merged.displaySettings.pointColorMode, 'white');
assert.equal(merged.displaySettings.placedObjectColorMode, 'height');
assert.equal(merged.displaySettings.showPathNames3D, false);
assert.deepEqual(rebaseSyncDocument(remote, initial, local), merged, 'in-flight changes merge per setting');
const old = structuredClone(initial); delete old.displaySettings;
assert.doesNotThrow(() => validateSyncDocument(old));
assert.deepEqual(applySyncOperations(old, diffSyncDocument(old, initial)), initial);
assert.equal(syncDocument({ workspace: { pointColorMode: 'source' } }).displaySettings.placedObjectColorMode, 'source');
for (const [field, value] of [['pointColorMode', 'unknown'], ['showPaths3D', 'false'], ['view3d', {}], ['meshRenderQuality', 'unsafe']]) {
  assert.throws(() => applySyncOperations(initial, [{ type: 'set', path: ['displaySettings', field], value }]));
}
console.log('Work sync display: portable object groups, color/settings export, safe validation and per-setting merges passed.');
