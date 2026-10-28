import assert from 'node:assert/strict';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { linkedProjectFixture } from './linked_project_helpers.mjs';
import { linkedWorkspaceRelation, prepareLinkedProjectImport } from '../src/lib/linkedProject.js';
import { buildProjectArchive, readProjectArchive, readProjectDirectoryFiles, saveProjectArchive } from '../src/lib/projectArchive.js';
import { normalizeProject } from '../src/lib/io.js';
import { writeBackTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { expandProjectResources } from '../src/lib/projectResourceStorage.js';

const modes = ['map', 'independent'];
const archiveOptions = (pair, mode) => ({
  mapResource: pair[mode].map,
  existingRobotPackage: pair[mode].map.portableRobotPackage,
  workspaceUI: pair[mode].config.config.ui,
  linkedWorkspace: pair[mode === 'map' ? 'independent' : 'map'],
});
const archiveFor = (pair, mode) => buildProjectArchive(pair[mode].config.config.project, archiveOptions(pair, mode));

for (const kind of ['placement', 'extraction']) {
  const pair = await linkedProjectFixture(kind);
  const original = structuredClone(pair);
  for (const mode of modes) {
    const archive = await archiveFor(pair, mode);
    assert.equal(archive.manifest.format, 'atlas-route-studio-linked-project');
    assert.equal(archive.manifest.statistics.workspaceCount, 2);
    const physicalFiles = unzipSync(archive.bytes);
    const { files } = await expandProjectResources(physicalFiles);
    assert.ok(modes.every((side) => files[`workspaces/${side}/environment/positions.f32le`]));
    assert.ok(modes.every((side) => files[`workspaces/${side}/robot/files/transfer/robot.urdf`]));
    const restored = await readProjectArchive(archive.bytes);
    assert.ok(restored.portable);
    const prepared = prepareLinkedProjectImport(restored.linkedWorkspaces);
    assert.deepEqual(linkedWorkspaceRelation(prepared).localToMap, linkedWorkspaceRelation(pair).localToMap);
    assert.deepEqual(linkedWorkspaceRelation(prepared).matrixImports, linkedWorkspaceRelation(pair).matrixImports);
    for (const side of modes) {
      const actual = prepared[side];
      assert.notEqual(actual.map.mapId, pair[side].map.mapId);
      for (const buffer of ['positionBuffer', 'colorBuffer', 'indexBuffer']) {
        assert.deepEqual(new Uint8Array(actual.map[buffer]), new Uint8Array(pair[side].map[buffer]));
      }
      const before = normalizeProject(JSON.parse(JSON.stringify(pair[side].config.config.project)));
      const after = normalizeProject(actual.config.config.project);
      assert.deepEqual(after.waypoints, before.waypoints);
      assert.deepEqual(after.edges, before.edges);
      assert.deepEqual(after.jointPoses, before.jointPoses);
      assert.deepEqual(after.robot, before.robot);
      assert.deepEqual(after.teachingTasks, before.teachingTasks);
    }
    assert.equal(prepared.independent.config.config.ui.mapRouteSyncEnabled, true);
    assert.equal(prepared.map.config.config.ui.showSlice3D, false);
    if (kind === 'extraction') {
      // The archive/import identity remap must not invalidate extraction baselines.
      await writeBackTeachingWorkspace(prepared.independent, prepared.map);
    }
    // A directory picker can enumerate child manifests before the root.
    const directoryFiles = Object.entries(physicalFiles).reverse().map(([path, bytes]) => ({
      name: path.split('/').at(-1), webkitRelativePath: `pair/${path}`,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    const directory = await readProjectDirectoryFiles(directoryFiles);
    assert.ok(linkedWorkspaceRelation(directory.linkedWorkspaces));
    const rezipped = zipSync({ ...files, 'workspaces/': new Uint8Array(),
      'workspaces/map/': new Uint8Array(), 'workspaces/independent/': new Uint8Array() });
    assert.ok((await readProjectArchive(rezipped)).linkedWorkspaces);

    const missing = { ...files };
    delete missing['workspaces/independent/environment/positions.f32le'];
    await assert.rejects(readProjectArchive(zipSync(missing)), /缺少/);
    const damaged = structuredClone(files);
    damaged['workspaces/map/robot/files/transfer/robot.urdf'][0] ^= 0xff;
    await assert.rejects(readProjectArchive(zipSync(damaged)), /SHA-256/);
    const wrongVersion = { ...files, 'manifest.json': strToU8(JSON.stringify({ ...archive.manifest, archiveVersion: 999 })) };
    await assert.rejects(readProjectArchive(zipSync(wrongVersion)), /版本或结构/);
    console.log(`${kind}_${mode}_save_both_workspaces_assets_binding_and_directory_restore=ok`);
  }
  assert.deepEqual(pair, original, 'Saving must not mutate either workspace');
}

// Older maps may only have cache IDs, without a source hash.
const pair = await linkedProjectFixture();
for (const mode of modes) {
  pair[mode].map.sourceHash = null;
  pair[mode].config.config.project.map.sourceHash = null;
}
const restored = prepareLinkedProjectImport((await readProjectArchive((await archiveFor(pair, 'map')).bytes)).linkedWorkspaces);
assert.ok(linkedWorkspaceRelation(restored));
assert.equal(restored.map.config.config.project.workspace.transfer.sourceMap.mapId, restored.independent.map.mapId);

const invalid = structuredClone(pair);
invalid.independent.map.positionBuffer = null;
let opened = false;
await assert.rejects(saveProjectArchive(invalid.map.config.config.project, {
  async createWritable() { opened = true; throw new Error('must not open'); },
}, archiveOptions(invalid, 'map')), /资源不完整/);
assert.equal(opened, false, 'A missing companion must not truncate an existing saved ZIP');
console.log('identity_only_binding_and_failed_save_preserve_existing_file=ok');
