import assert from 'node:assert/strict';
import { createWorkspaceSyncAdapter, mergeWorkspaceSyncDocument, workspaceSyncIdentity } from '../../src/features/workspace/client/workspaceSyncAdapter.js';
import { TEMPORARY_MAP_ROUTE_SOURCE } from '../../src/features/teaching/model/teachingNavigation.js';

const retained = { id: 'kept', name: '停车点' };
const temporary = { id: 'temporary', source: TEMPORARY_MAP_ROUTE_SOURCE };
const localEdge = { id: 'local-edge', from: 'temporary', to: 'kept' };
const current = { teachingSpaceMode: 'map', mapData: { mapId: 'map-a', sourceHash: 'hash-a', name: '地图 A', geometry: {} },
  selectedRobot: { relativePath: 'robot.urdf' }, waypoints: [retained, temporary], edges: [localEdge],
  teachingTasks: [], jointPoses: [], abxRoutes: [], independentTeachingName: '' };
const document = { waypoints: [{ ...retained }], edges: [], teachingTasks: [], jointPoses: [], abxRoutes: [],
  independentTeachingName: '', displaySettings: { pointColorMode: 'source' } };
const merged = mergeWorkspaceSyncDocument(current, document);
assert.equal(merged.next.waypoints[0], retained, 'unchanged entity references survive synchronization');
assert.equal(merged.next.waypoints[1], temporary, 'local temporary navigation survives remote edits');
assert.equal(merged.next.edges[0], localEdge);
assert.equal(merged.displaySettings, document.displaySettings);
const removed = mergeWorkspaceSyncDocument(current, { ...document, waypoints: [] });
assert.deepEqual(removed.next.edges, [], 'temporary edges cannot retain deleted endpoints');
assert.equal(current.waypoints.length, 2, 'merging does not mutate the local snapshot');

let snapshot = current, applied, available = true, blocked = false;
const persist = () => {}, load = () => {}, save = () => {};
const adapter = createWorkspaceSyncAdapter({ deviceName: 'fixture', checkpoints: { load, save }, workspace: {
  read: () => snapshot, views: () => ({}), ready: () => available && !blocked, available: () => available,
  transferBlocked: () => blocked, apply: (next, displaySettings) => { applied = { next, displaySettings }; },
  persist, robotPackage: () => null,
} });
assert.equal(adapter.identity(), workspaceSyncIdentity(current));
assert.equal(adapter.project().name, '地图 A');
snapshot = { ...current, mapData: { ...current.mapData, mapId: 'map-b', sourceHash: 'hash-b', name: '地图 B' } };
assert.equal(adapter.project().name, '地图 B', 'adapter reads current workspace after switching');
assert.notEqual(adapter.identity(), workspaceSyncIdentity(current));
available = false;
assert.equal(adapter.ready(), false);
assert.equal(adapter.project(), null);
available = true; blocked = true;
await assert.rejects(adapter.buildInitial(), /完成当前工程加载/);
adapter.applyDocument(document);
assert.equal(applied.next.waypoints[0], retained);
assert.equal(adapter.persist, persist);
assert.equal(adapter.loadCheckpoint, load);
assert.equal(adapter.saveCheckpoint, save);
console.log('Workspace sync adapter: live snapshots, reference retention, temporary navigation, readiness and persistence ports passed.');
