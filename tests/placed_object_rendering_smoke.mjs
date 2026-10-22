import assert from 'node:assert/strict';
import { placedObjectLayers, placedObjectMask, recoverPlacedObjectLayers } from '../src/lib/placedObjectRendering.js';
import { identityTransferPose, placeTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { normalizeProject } from '../src/lib/io.js';
import { teachingTransferFixture, transferSnapshot, transferFixtureFiles } from './teaching_transfer_helpers.mjs';

const background = teachingTransferFixture('map');
const local = teachingTransferFixture('independent');
local.map.teachingGroupId = 'object-a';
const original = structuredClone(background.map);
const pose = identityTransferPose();
pose.position = { x: -2.1, y: 0.3, z: 1.2 };
pose.rpy = { roll: 5, pitch: 10, yaw: 17 };
const first = await placeTeachingWorkspace(local, background, { localToMap: pose });
const firstTransfer = first.config.project.workspace.transfer;
assert.deepEqual(placedObjectLayers(first.map, firstTransfer).objectRanges, [{ start: 6, count: 6 }]);
assert(placedObjectLayers(first.map, firstTransfer).complete);
assert.deepEqual(Array.from(placedObjectMask(12, firstTransfer.geometryLayers.objectRanges)), [...Array(6).fill(0), ...Array(6).fill(1)]);
assert.deepEqual(background.map, original, 'Rendering metadata must not change source geometry');

// Repeated placements of the same source keep all object ranges, even though
// the teaching-binding history deduplicates that source group.
const second = await placeTeachingWorkspace(local, transferSnapshot(first), { localToMap: identityTransferPose() });
assert.deepEqual(placedObjectLayers(second.map, second.config.project.workspace.transfer).objectRanges,
  [{ start: 6, count: 6 }, { start: 12, count: 6 }]);
assert.equal(normalizeProject(second.config.project).workspace.transfer.geometryLayers.pointCount, 18);
const files = await transferFixtureFiles(transferSnapshot(second));
const archived = JSON.parse(new TextDecoder().decode(files['config/project.json']));
assert.deepEqual(archived.workspace.transfer.geometryLayers, second.config.project.workspace.transfer.geometryLayers);

const legacy = structuredClone(firstTransfer);
delete legacy.geometryLayers;
const recovered = await recoverPlacedObjectLayers(first.map, legacy, async () => local.map);
assert.deepEqual(recovered, firstTransfer.geometryLayers, 'Recover transformed Float32 blocks exactly');
const unavailable = await recoverPlacedObjectLayers(first.map, legacy, async () => null);
assert.deepEqual(unavailable.objectRanges, []);
assert.equal(unavailable.complete, false);
const changed = structuredClone(local.map);
new Float32Array(changed.positionBuffer)[4] += 0.01;
assert.deepEqual((await recoverPlacedObjectLayers(first.map, legacy, async () => changed)).objectRanges, [],
  'Nearby or overlapping geometry is not enough to classify a block');
const invalid = structuredClone(firstTransfer);
invalid.geometryLayers.objectRanges[0].count = 1000;
assert.equal(placedObjectLayers(first.map, invalid), null);
assert.equal(placedObjectLayers({ ...first.map, sourceHash: 'replacement-map' }, firstTransfer), null);

// Old single-color projects retain their initial appearance until a layer's
// control is changed explicitly.
for (const color of ['height', 'source', 'white']) {
  const old = structuredClone(background.config.config.project);
  old.workspace.pointColorMode = color;
  delete old.workspace.placedObjectColorMode;
  assert.equal(normalizeProject(old).workspace.placedObjectColorMode, color);
}
console.log('PASS: appended/multiple object ranges, immutable geometry, ZIP metadata, exact legacy recovery and old color defaults');
