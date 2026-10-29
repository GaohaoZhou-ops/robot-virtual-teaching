import assert from 'node:assert/strict';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { buildProjectArchive, readProjectArchive, readProjectDirectoryFiles, saveProjectArchive } from "../src/features/workspace/model/projectArchive.js";
import { prepareWorkspaceCollectionImport } from "../src/features/workspace/model/projectWorkspaceCollection.js";
import { linkedWorkspaceRelation } from "../src/features/workspace/model/linkedProject.js";
import { normalizeProject } from "../src/features/workspace/model/io.js";
import { projectCollectionFixture, projectCollectionOptions } from './project_collection_helpers.mjs';
import { linkedProjectFixture } from './linked_project_helpers.mjs';
import { writeBackTeachingWorkspace } from "../src/features/teaching/model/teachingTransfer.js";
import { expandProjectResources } from "../src/features/workspace/model/projectResourceStorage.js";

const collection = await projectCollectionFixture();
const original = structuredClone(collection);
const all = (value) => [...Object.values(value.workspaces), ...value.independentHistory];
for (const mode of ['map', 'independent']) {
  const payload = collection.workspaces[mode].config.config.project;
  const options = projectCollectionOptions(collection, mode);
  const archive = await buildProjectArchive(payload, options);
  assert.equal(archive.manifest.format, 'atlas-route-studio-workspace-project');
  assert.equal(archive.manifest.statistics.workspaceCount, 4);
  assert.equal(archive.manifest.statistics.independentWorkspaceCount, 3);
  assert.equal(archive.manifest.statistics.independentHistoryCount, 2);
  const importProgress = [];
  const restored = await readProjectArchive(archive.bytes, { onProgress: ({ progress }) => importProgress.push(progress) });
  assert.equal(importProgress.at(-1), 1);
  assert.ok(importProgress.every((value, index) => value >= 0 && value <= 1
    && (!index || value >= importProgress[index - 1])), 'Historical groups must share one forward-only progress range');
  const prepared = prepareWorkspaceCollectionImport(restored.workspaceCollection);
  assert.equal(prepared.activeMode, mode);
  assert.equal(linkedWorkspaceRelation(prepared.workspaces), null, 'Same file does not make group C bound');
  const before = all(collection);
  for (const snapshot of all(prepared)) {
    const source = before.find((item) => item.map.mapId === snapshot.map.portableOriginalMapId);
    assert.ok(source);
    assert.notEqual(snapshot.map.mapId, source.map.mapId);
    for (const field of ['positionBuffer', 'colorBuffer', 'indexBuffer']) {
      assert.deepEqual(new Uint8Array(snapshot.map[field]), new Uint8Array(source.map[field]));
    }
    const actual = normalizeProject(snapshot.config.config.project);
    const expected = normalizeProject(JSON.parse(JSON.stringify(source.config.config.project)));
    for (const field of ['teachingTasks', 'jointPoses', 'robot', 'waypoints', 'edges', 'abxRoutes', 'view2d', 'view3d', 'slice']) {
      assert.deepEqual(actual[field], expected[field], field);
    }
    assert.ok(actual.jointPoses.some((pose) => pose.joints.source === 'robot-preset'));
    assert.deepEqual(snapshot.map.portableRobotPackage.files.map((file) => [file.path, new Uint8Array(file.bytes)]),
      source.map.portableRobotPackage.files.map((file) => [file.path, new Uint8Array(file.bytes)]));
    if (snapshot.archivedAt) {
      assert.equal(snapshot.archivedAt, source.archivedAt);
      const relation = linkedWorkspaceRelation({ map: prepared.workspaces.map, independent: snapshot });
      assert.equal(relation.sourceMap.mapId, snapshot.map.mapId);
      const prior = linkedWorkspaceRelation({ map: collection.workspaces.map, independent: source });
      assert.deepEqual(relation.localToMap, prior.localToMap);
      assert.deepEqual(relation.matrixImports, prior.matrixImports);
    }
  }
  const physicalFiles = unzipSync(archive.bytes);
  const { files } = await expandProjectResources(physicalFiles);
  for (const prefix of ['workspaces/map/', 'workspaces/independent/', 'independent-history/1/', 'independent-history/2/']) {
    assert.ok(files[prefix + 'robot/files/transfer/meshes/body.stl']);
    assert.ok(Object.keys(files).some((path) => path.startsWith(prefix + 'teaching-data/') && path.endsWith('.png')));
  }
  const directory = await readProjectDirectoryFiles(Object.entries(physicalFiles).reverse().map(([path, bytes]) => ({
    name: path.split('/').at(-1), webkitRelativePath: `collection/${path}`,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })));
  assert.equal(directory.workspaceCollection.independentHistory.length, 2);
  const missing = { ...files };
  delete missing['independent-history/2/robot/files/transfer/meshes/body.stl'];
  await assert.rejects(readProjectArchive(zipSync(missing)), /缺少/);
  const damaged = structuredClone(files);
  damaged['independent-history/1/environment/positions.f32le'][0] ^= 0xff;
  await assert.rejects(readProjectArchive(zipSync(damaged)), /SHA-256/);
  const invalid = { ...files, 'manifest.json': strToU8(JSON.stringify({ ...archive.manifest, archiveVersion: 999 })) };
  await assert.rejects(readProjectArchive(zipSync(invalid)), /版本或结构/);

  const reexport = await buildProjectArchive(prepared.workspaces[mode].config.config.project, projectCollectionOptions(prepared, mode));
  assert.equal((await readProjectArchive(reexport.bytes)).workspaceCollection.independentHistory.length, 2);
  console.log(`${mode}_all_groups_presets_media_meshes_routes_transforms_directory_and_reexport=ok`);
}
assert.deepEqual(collection, original);

// Standalone independent collections do not require a map workspace.
const standalone = structuredClone(collection);
delete standalone.workspaces.map;
const standaloneArchive = await buildProjectArchive(standalone.workspaces.independent.config.config.project,
  projectCollectionOptions(standalone, 'independent'));
const standaloneRestored = prepareWorkspaceCollectionImport((await readProjectArchive(standaloneArchive.bytes)).workspaceCollection);
assert.deepEqual(Object.keys(standaloneRestored.workspaces), ['independent']);
assert.equal(standaloneRestored.independentHistory.length, 2);

// Bad historical resources must fail before opening/truncating the saved ZIP.
const broken = structuredClone(collection);
broken.independentHistory[0].map.positionBuffer = null;
let opened = false;
await assert.rejects(saveProjectArchive(broken.workspaces.map.config.config.project, {
  async createWritable() { opened = true; throw new Error('must not open'); },
}, projectCollectionOptions(broken, 'map')), /资源不完整/);
assert.equal(opened, false);
console.log('standalone_history_and_failed_save_preserve_existing_file=ok');

// An extracted group in history must still support write-back after its map's
// local identity changes on a different device.
const extraction = await linkedProjectFixture('extraction');
const extractedCollection = { activeMode: 'map',
  workspaces: { map: extraction.map, independent: collection.workspaces.independent },
  independentHistory: [{ ...extraction.independent, archivedAt: 1800000001000 }] };
const extractedArchive = await buildProjectArchive(extraction.map.config.config.project,
  projectCollectionOptions(extractedCollection, 'map'));
const extracted = prepareWorkspaceCollectionImport((await readProjectArchive(extractedArchive.bytes)).workspaceCollection);
assert.equal(extracted.independentHistory[0].config.config.project.workspace.transfer.sourceMap.mapId,
  extracted.workspaces.map.map.mapId);
await writeBackTeachingWorkspace(extracted.independentHistory[0], extracted.workspaces.map);
console.log('historical_extraction_identity_baseline_and_writeback=ok');
