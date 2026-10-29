import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { buildExport, normalizeProject } from "../../src/features/workspace/model/io.js";
import { buildProjectArchive, readProjectArchive, saveProjectArchive } from "../../src/features/workspace/model/projectArchive.js";
import { loadRobotTwinProfiles, normalizeRobotTwinProfiles, restoreRobotTwinProfiles, saveRobotTwinProfiles, ROBOT_TWIN_PROFILES_KEY } from "../../src/features/robot-twin/model/robotTwinProfiles.js";
import { loadRobotTwinCredentials, rememberRobotTwinCredential, ROBOT_TWIN_CREDENTIALS_KEY } from "../../src/features/robot-twin/client/robotTwinCredentials.js";
import { teachingTransferFixture } from "../teaching_transfer_helpers.mjs";
import { projectCollectionFixture, projectCollectionOptions } from "../project_collection_helpers.mjs";
import { linkedProjectFixture } from "../linked_project_helpers.mjs";

const secret = 'NEVER_PACK_PASSWORD_OR_TOKEN';
const config = { version: 1, selectedIds: ['beta', 'alpha'], profiles: [
  { id: 'alpha', name: '一号机器人', address: '192.168.0.112:9090', color: '#62c7a0', password: secret },
  { id: 'beta', name: '二号机器人', address: 'https://10.0.0.21:9443', color: '#6baff2', token: secret },
], credentials: [{ password: secret }], session: secret, pose: { x: 100 } };
const expected = normalizeRobotTwinProfiles(config);
assert.ok(!JSON.stringify(expected).includes(secret));
assert.deepEqual(expected.selectedIds, ['beta', 'alpha']);
assert.equal(expected.profiles[0].address, 'http://192.168.0.112:9090');
const exported = buildExport({ mapData: null, heightRange: [0, 1], waypoints: [], edges: [], robotTwin: config });
assert.deepEqual(normalizeProject(exported).robotTwin, expected);

const inspect = (bytes, count) => {
  const files = unzipSync(bytes), configs = Object.entries(files).filter(([path]) => path.endsWith('config/project.json'));
  assert.equal(configs.length, count);
  for (const [, bytes] of configs) assert.deepEqual(JSON.parse(strFromU8(bytes)).robotTwin, expected);
  assert.ok(Object.values(files).every((bytes) => !strFromU8(bytes).includes(secret)), 'no credentials/session/live data in any archive file');
};
for (const mode of ['map', 'independent']) {
  const fixture = teachingTransferFixture(mode), payload = { ...fixture.config.config.project, robotTwin: config };
  const options = { mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage };
  let written;
  await saveProjectArchive(payload, { name: 'robot-config.zip', async createWritable() {
    return { async write(blob) { written = new Uint8Array(await blob.arrayBuffer()); }, async close() {} };
  } }, options);
  inspect(written, 1);
  assert.deepEqual((await readProjectArchive(written)).payload.robotTwin, expected);

  const collection = await projectCollectionFixture();
  collection.workspaces[mode].config.config.project.robotTwin = config;
  const archive = await buildProjectArchive(collection.workspaces[mode].config.config.project, projectCollectionOptions(collection, mode));
  inspect(archive.bytes, 4);
  const restored = (await readProjectArchive(archive.bytes)).workspaceCollection;
  for (const workspace of [...Object.values(restored.workspaces), ...restored.independentHistory]) {
    assert.deepEqual(workspace.config.config.project.robotTwin, expected, 'every workspace/history uses the current exported configuration');
  }
  const pair = await linkedProjectFixture();
  pair[mode].config.config.project.robotTwin = config;
  const linked = await buildProjectArchive(pair[mode].config.config.project, {
    mapResource: pair[mode].map, existingRobotPackage: pair[mode].map.portableRobotPackage,
    linkedWorkspace: pair[mode === 'map' ? 'independent' : 'map'],
  });
  inspect(linked.bytes, 2);
  const workspaces = (await readProjectArchive(linked.bytes)).linkedWorkspaces;
  for (const workspace of Object.values(workspaces)) assert.deepEqual(workspace.config.config.project.robotTwin, expected);
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), stored = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value),
} });
try {
  assert.equal(restoreRobotTwinProfiles(expected), true);
  assert.deepEqual(loadRobotTwinProfiles(), expected, 'fresh browser restores all cards and selection');
  assert.equal(stored.get(ROBOT_TWIN_CREDENTIALS_KEY), undefined, 'import never creates credentials');
  const beforeLegacy = stored.get(ROBOT_TWIN_PROFILES_KEY);
  restoreRobotTwinProfiles(undefined); restoreRobotTwinProfiles({ version: 999, profiles: [] });
  assert.equal(stored.get(ROBOT_TWIN_PROFILES_KEY), beforeLegacy, 'old/unsupported configurations do not erase cards');

  const local = { id: 'alpha', name: '本机另一台', address: 'http://192.168.0.90:9091', color: '#abcdef' };
  const same = { ...expected.profiles[1], id: 'local-beta', name: '本机同地址' };
  saveRobotTwinProfiles({ profiles: [local, same], selectedIds: ['alpha'] });
  rememberRobotTwinCredential(local, 'local-only'); rememberRobotTwinCredential(same, 'same-endpoint-only');
  const credentials = stored.get(ROBOT_TWIN_CREDENTIALS_KEY);
  restoreRobotTwinProfiles(config);
  const merged = loadRobotTwinProfiles();
  assert.equal(merged.profiles.length, 3, 'local cards are preserved; endpoints deduplicated');
  assert.equal(merged.selectedIds[0], same.id, 'same endpoint retains local ID and password');
  assert.notEqual(merged.selectedIds[1], local.id, 'ID collision never changes the old endpoint');
  assert.equal(merged.profiles[0].address, expected.profiles[0].address);
  assert.equal(stored.get(ROBOT_TWIN_CREDENTIALS_KEY), credentials);
  assert.ok(!loadRobotTwinCredentials().some((item) => item.id === merged.selectedIds[1]), 'different target cannot inherit a password');
  restoreRobotTwinProfiles(config);
  assert.deepEqual(loadRobotTwinProfiles(), merged, 'repeated import is idempotent');
  restoreRobotTwinProfiles({ ...expected, selectedIds: [] });
  assert.deepEqual(loadRobotTwinProfiles().selectedIds, [], 'intentional empty selection is restored');

  const malformed = normalizeRobotTwinProfiles({ ...config, selectedIds: ['alpha', 'invalid', 'alpha'], profiles: [
    ...config.profiles, { id: 'duplicate', name: '重复地址', address: expected.profiles[0].address },
    { id: 'invalid', name: '非法', address: 'http://admin:password@192.168.0.3:9090' },
    { id: 'public', name: '公网', address: 'https://example.com' },
  ] });
  assert.deepEqual(malformed.profiles, expected.profiles);
  assert.deepEqual(malformed.selectedIds, ['alpha']);
  globalThis.localStorage.setItem = () => { throw new Error('storage unavailable'); };
  assert.equal(restoreRobotTwinProfiles(expected), false);
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
}
console.log('Robot project configuration: save/export, standalone/linked/collection round trips, allowlist, selection, local merge and credential isolation passed.');
