import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildProjectArchive, readProjectArchive, readProjectDirectoryFiles,
  readProjectDirectoryHandle, readProjectDirectoryMetadata, updateProjectDirectory } from "../src/features/workspace/model/projectArchive.js";
import { expandProjectResources, RESOURCE_PROJECT_FORMAT } from "../src/features/workspace/model/projectResourceStorage.js";
import { buildExport } from "../src/features/workspace/model/io.js";
import { sha256Bytes } from "../src/shared/utils/hash.js";
import { createTeachingAlignment, placeTeachingWorkspace } from "../src/features/teaching/model/teachingTransfer.js";
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';

const parse = (bytes) => JSON.parse(strFromU8(bytes));
const models = [];
for (let kind = 0; kind < 2; kind++) {
  const model = teachingTransferFixture('independent');
  const positions = new Float32Array(9000), colors = new Uint8Array(9000);
  for (let i = 0; i < positions.length; i++) {
    positions[i] = Math.sin(i * 13.31 + kind) * (kind + 1);
    colors[i] = (i * 37 + kind) % 256;
  }
  const rows = Array.from({ length: 3000 }, (_, i) => [...positions.slice(i * 3, i * 3 + 3)].join(' '));
  const source = strToU8(`ply\nformat ascii 1.0\nelement vertex 3000\nproperty float x\nproperty float y\nproperty float z\nend_header\n${rows.join('\n')}\n`);
  Object.assign(model.map, { name: `model-${kind}.ply`, positionBuffer: positions.buffer, colorBuffer: colors.buffer,
    indexBuffer: Uint16Array.from({ length: 3000 }, (_, i) => i).buffer,
    pointCount: 3000, faceCount: 1000, sourceHash: await sha256Bytes(source), sourceBlob: new Blob([source]),
    byteLength: source.byteLength, bounds: { min: { x: -2, y: -2, z: -2 }, max: { x: 2, y: 2, z: 2 } } });
  models.push(model);
}
let map = teachingTransferFixture('map');
const groups = [];
for (let i = 0; i < 30; i++) {
  const group = structuredClone(models[i % 2]);
  group.map.mapId = `group-map-${i}`;
  group.map.teachingGroupId = `group-${i}`;
  const localToMap = { position: { x: i * 9.125, y: -i * 0.237, z: 0.17 },
    rpy: { roll: i * 1.1, pitch: -i * 0.7, yaw: i * 7.3 } };
  const matrixImports = [{ name: `transform-${i}.txt`, values: [1,0,0,i,0,1,0,0,0,0,1,0,0,0,0,1] }];
  const transfer = await createTeachingAlignment(map, { localToMap, matrixImports });
  const project = buildExport({ mapData: group.map, teachingSpaceMode: 'independent',
    independentTeachingName: `组 ${i}`, transfer, heightRange: [-2, 2],
    robot: group.config.config.project.robot, waypoints: [], edges: [], teachingTasks: [], jointPoses: [] });
  group.config = { mapId: group.map.mapId, config: { project, ui: {} } };
  map = transferSnapshot(await placeTeachingWorkspace(group, map, { localToMap, matrixImports }));
  groups.push(group);
}
const original = structuredClone({ map, groups });
const options = { mapResource: map.map, existingRobotPackage: map.map.portableRobotPackage,
  companionWorkspace: groups.at(-1), independentHistory: groups.slice(0, -1).map((group, i) => ({ ...group, archivedAt: i })) };
const packed = await buildProjectArchive(map.config.config.project, options);
const physical = unzipSync(packed.bytes), envelope = parse(physical['manifest.json']);
assert.equal(envelope.format, RESOURCE_PROJECT_FORMAT);
assert.equal(packed.manifest.statistics.independentWorkspaceCount, 30);
const geometries = envelope.files.filter((file) => /environment\/positions.f32le$/.test(file.path));
assert.equal(geometries.length, 2, 'Thirty groups store only the two unique local geometries');
assert.equal(envelope.files.filter((file) => file.path.endsWith('/environment/original.ply')).length, 2);
assert.equal(envelope.files.filter((file) => file.path.endsWith('/robot/files/transfer/robot.urdf')).length, 1);
const mapParts = envelope.references['workspaces/map/environment/positions.f32le'].parts;
assert.equal(mapParts.filter((part) => part.kind === 'positions').length, 30);
assert.equal(new Set(mapParts.filter((part) => part.kind === 'positions').map((part) => part.resource)).size, 2);
const expanded = await expandProjectResources(physical);
const legacy = zipSync(expanded.files, { level: 1 });
assert.ok(packed.byteLength < legacy.byteLength * 0.3, 'Repeated realistic models materially reduce ZIP size');

const restored = await readProjectArchive(packed.bytes);
const actualGroups = [restored.workspaceCollection.workspaces.independent, ...restored.workspaceCollection.independentHistory];
for (const snapshot of [restored.workspaceCollection.workspaces.map, ...actualGroups]) {
  const before = snapshot.mode === 'map' ? map : groups.find((group) => group.map.mapId === snapshot.map.mapId);
  for (const field of ['positionBuffer', 'colorBuffer', 'indexBuffer']) {
    assert.deepEqual(new Uint8Array(snapshot.map[field]), new Uint8Array(before.map[field]), field);
  }
  assert.deepEqual(snapshot.config.config.project.workspace.transfer, JSON.parse(JSON.stringify(before.config.config.project.workspace.transfer)));
  if (before.map.sourceBlob) assert.deepEqual(await snapshot.map.sourceBlob.arrayBuffer(), await before.map.sourceBlob.arrayBuffer());
}
new Float32Array(actualGroups[0].map.positionBuffer)[0] = 12345;
assert.notEqual(new Float32Array(actualGroups[2].map.positionBuffer)[0], 12345, 'Restored groups remain independently editable');
assert.deepEqual({ map, groups }, original, 'Packing must not mutate the live workspaces');
assert.equal((await readProjectArchive(legacy)).workspaceCollection.independentHistory.length, 29);
const directory = await readProjectDirectoryFiles(Object.entries(physical).map(([name, bytes]) => ({ name,
  webkitRelativePath: `project/${name}`, arrayBuffer: async () => bytes.slice().buffer })));
assert.equal(directory.workspaceCollection.independentHistory.length, 29);

// Sync keeps its existing active-workspace scope and stripped transfer config,
// while the storage layer can still reconstruct the complete merged map.
const syncPayload = structuredClone(map.config.config.project);
syncPayload.workspace.transfer = null;
let loads = 0;
const syncOptions = { mapResource: map.map, existingRobotPackage: map.map.portableRobotPackage,
  geometryTransfer: map.config.config.project.workspace.transfer,
  loadGeometrySource: async (identity) => { loads++; return groups.find((group) => group.map.mapId === identity.mapId).map; } };
const sync = await buildProjectArchive(syncPayload, syncOptions);
assert.equal(loads, 2, 'Load each distinct source model only once');
const syncPhysical = unzipSync(sync.bytes), syncEnvelope = parse(syncPhysical['manifest.json']);
assert.equal(new Set(syncEnvelope.references['environment/positions.f32le'].parts
  .filter((part) => part.kind === 'positions').map((part) => part.resource)).size, 2);
const received = await readProjectArchive(sync.bytes);
assert.equal(received.payload.workspace.transfer, null);
assert.equal(received.workspaceCollection, undefined);
assert.deepEqual(new Uint8Array(received.resources.map.positionBuffer), new Uint8Array(map.map.positionBuffer));
assert.deepEqual(new Uint8Array(received.resources.map.indexBuffer), new Uint8Array(map.map.indexBuffer));

// Missing or edited source geometry falls back losslessly, without blocking a
// valid export or silently replacing the user's modified scene.
const missing = await buildProjectArchive(syncPayload, { ...syncOptions, loadGeometrySource: async () => null });
assert.deepEqual(new Uint8Array((await readProjectArchive(missing.bytes)).resources.map.positionBuffer), new Uint8Array(map.map.positionBuffer));
const edited = structuredClone(map.map);
new Float32Array(edited.positionBuffer)[edited.pointCount * 3 - 1] += 0.001;
const fallback = await buildProjectArchive(syncPayload, { ...syncOptions, mapResource: edited });
assert.deepEqual(new Uint8Array((await readProjectArchive(fallback.bytes)).resources.map.positionBuffer), new Uint8Array(edited.positionBuffer));

const corrupt = async (change, pattern) => {
  const files = structuredClone(physical), root = parse(files['manifest.json']);
  change(files, root);
  files['manifest.json'] = strToU8(JSON.stringify(root));
  await assert.rejects(readProjectArchive(zipSync(files)), pattern);
};
await corrupt((files, root) => { delete files[root.references['workspaces/map/environment/positions.f32le'].parts[1].resource]; }, /缺少/);
await corrupt((files) => { files[geometries[0].path][0] ^= 1; }, /SHA-256/);
await corrupt((files, root) => { root.references['workspaces/map/environment/positions.f32le'].parts[1].matrix[12] += 1; }, /SHA-256/);
await corrupt((files, root) => { root.references['workspaces/map/environment/positions.f32le'].parts[1].resource = '../bad'; }, /路径/);
await corrupt((files, root) => { root.archiveVersion = 99; }, /版本/);

// Writable extracted directories retain shared geometry across incremental
// saves, including after metadata-only reopen on the next page load.
const makeDirectory = (files) => {
  const data = new Map(Object.entries(files)), writes = [];
  const directory = (prefix = '') => ({ kind: 'directory', name: 'shared-project',
    queryPermission: async () => 'granted', getDirectoryHandle: async (name) => directory(`${prefix}${name}/`),
    getFileHandle: async (name, { create } = {}) => {
      const path = prefix + name;
      if (!data.has(path) && !create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return { getFile: async () => new File([data.get(path)], name), createWritable: async () => ({
        write: async (bytes) => { writes.push(path); data.set(path, bytes.slice()); }, close: async () => {},
      }) };
    } });
  return { root: directory(), data, writes };
};
const memory = makeDirectory(syncPhysical);
const opened = await readProjectDirectoryHandle(memory.root);
assert.equal(opened.directory.writable, true);
const next = structuredClone(opened.payload);
next.workspace.independentTeachingName = 'incremental storage check';
const saved = await updateProjectDirectory(memory.root, next, { manifest: opened.manifest, rawPayload: opened.rawPayload });
assert.ok(memory.writes.every((path) => !path.startsWith('resources/') && !path.startsWith('environment/')));
const reopened = await readProjectDirectoryHandle(memory.root);
assert.deepEqual(new Uint8Array(reopened.resources.map.positionBuffer), new Uint8Array(map.map.positionBuffer));
assert.equal(reopened.payload.workspace.independentTeachingName, next.workspace.independentTeachingName);
const metadata = await readProjectDirectoryMetadata(memory.root);
assert.ok(metadata.manifest.archiveStorage);
await updateProjectDirectory(memory.root, next, metadata);
assert.ok((await readProjectDirectoryHandle(memory.root)).portable);
assert.ok(saved.manifest.archiveStorage);
const photoProject = structuredClone(reopened.payload);
const firstPhoto = photoProject.virtualTeaching.tasks[0].parkingPoints[0].poses[0].cameraCapture;
firstPhoto.capturedAt = '2026-10-28T12:00:00.000Z';
firstPhoto.frames.left.rgb.dataUrl = 'data:image/png;base64,d29ybGQ=';
await updateProjectDirectory(memory.root, photoProject, { manifest: reopened.manifest, rawPayload: reopened.rawPayload });
const photoRestored = await readProjectDirectoryHandle(memory.root);
const restoredPhotos = photoRestored.payload.virtualTeaching.tasks[0].parkingPoints;
assert.equal(restoredPhotos[0].poses[0].cameraCapture.frames.left.rgb.dataUrl, 'data:image/png;base64,d29ybGQ=');
assert.equal(restoredPhotos[1].poses[0].cameraCapture.frames.left.rgb.dataUrl, 'data:image/png;base64,aGVsbG8=',
  'Editing the canonical shared photo must preserve other poses by copying on write');
console.log(JSON.stringify({ models: 2, groups: 30, physicalModels: geometries.length,
  legacyZipBytes: legacy.byteLength, sharedZipBytes: packed.byteLength,
  reductionPercent: Math.round((1 - packed.byteLength / legacy.byteLength) * 100),
  syncZipBytes: sync.byteLength, originalMapSyncZipBytes: missing.byteLength }));
console.log('Shared resources: exact geometry, transforms, isolated edits, original PLYs, old archives, sync scope, corruption rejection, directory updates and safe fallback passed.');
