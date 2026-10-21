import assert from 'node:assert/strict';
import { buildExport, normalizeProject } from '../src/lib/io.js';
import { mapRouteSyncStatus, syncMapRouteToIndependent } from '../src/lib/mapRouteSync.js';
import { TEMPORARY_MAP_ROUTE_SOURCE, withoutTemporaryMapNavigation } from '../src/lib/teachingNavigation.js';
import { extractTeachingWorkspace, identityTransferPose, placeTeachingWorkspace, transferMatrix } from '../src/lib/teachingTransfer.js';
import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';

const local = teachingTransferFixture('independent');
const map = teachingTransferFixture('map');
const localToMap = { position: { x: 12, y: -7, z: 3 }, rpy: { roll: 22, pitch: -31, yaw: 127 } };
const placed = transferSnapshot(await placeTeachingWorkspace(local, map, { localToMap }));
const before = structuredClone(placed.config);
const synced = syncMapRouteToIndependent(local.map, null, placed.config);
const original = normalizeProject(placed.config.config.project);
assert.equal(synced.waypoints.length, original.waypoints.length);
assert.equal(synced.edges.length, original.edges.length);
assert.equal(mapRouteSyncStatus(local.map, null, placed.config).available, true);

// The displayed map origin is a full coordinate frame. Transforming it back
// to the absolute map must produce the identity, including roll/pitch/yaw.
const restoredOrigin = transferMatrix(localToMap).multiply(transferMatrix(synced.mapOrigin)).elements;
assert.ok(transferMatrix(identityTransferPose()).elements.every((value, index) =>
  Math.abs(value - restoredOrigin[index]) < 1e-10));
assert.notDeepEqual(synced.mapOrigin.position, { x: -12, y: 7, z: -3 },
  'a rotated frame cannot use just the negated translation');

const pointMatrix = (point) => transferMatrix({ position: point.pose,
  rpy: { roll: point.pose.roll, pitch: point.pose.pitch, yaw: point.pose.yaw } });
for (const [index, point] of synced.waypoints.entries()) {
  // Reconstruct the original full rigid pose, including roll/pitch, rather
  // than comparing Euler components across their equivalent representations.
  const reconstructed = transferMatrix(localToMap).multiply(pointMatrix(point)).elements;
  const absolute = pointMatrix(original.waypoints[index]).elements;
  assert.ok(absolute.every((value, offset) => Math.abs(value - reconstructed[offset]) < 1e-10));
  assert.equal(point.source, TEMPORARY_MAP_ROUTE_SOURCE);
  assert.notEqual(point.id, original.waypoints[index].id);
}
const ids = new Set(synced.waypoints.map((point) => point.id));
for (const [index, edge] of synced.edges.entries()) {
  assert.ok(ids.has(edge.from) && ids.has(edge.to));
  assert.deepEqual(edge.limits, original.edges[index].limits);
  assert.deepEqual(edge.motion, original.edges[index].motion);
  assert.equal(edge.status, 'unchecked');
}
assert.deepEqual(placed.config, before, 'synchronization must never mutate the absolute map route');

// Edits are confined to the projection, including nested edge metadata.
synced.waypoints[0].pose.x = 999;
synced.edges[0].limits.maxSpeed = 99;
synced.edges[0].motion.direction = 'reverse';
synced.mapOrigin.position.x = 999;
assert.deepEqual(placed.config, before);
const repeated = syncMapRouteToIndependent(local.map, null, placed.config);
assert.notEqual(repeated.mapOrigin.position.x, 999);
assert.notEqual(repeated.waypoints[0].pose.x, 999);
assert.equal(repeated.edges[0].limits.maxSpeed, original.edges[0].limits.maxSpeed);
for (const [index, point] of repeated.waypoints.entries()) {
  assert.deepEqual(point.pose, syncMapRouteToIndependent(local.map, null, placed.config).waypoints[index].pose);
}

// Preserve local navigation but omit all temporary points and incident paths
// from every save/export/transfer payload, even if a new edge joins the two.
const localProject = normalizeProject(local.config.config.project);
const mixedPoints = [...localProject.waypoints, ...synced.waypoints];
const mixedEdges = [...localProject.edges, ...synced.edges, {
  id: 'mixed-edge', from: localProject.waypoints[0].id, to: synced.waypoints[0].id,
}];
const retained = withoutTemporaryMapNavigation(mixedPoints, mixedEdges);
assert.deepEqual(retained, { waypoints: localProject.waypoints, edges: localProject.edges });
const payload = buildExport({ mapData: local.map, heightRange: [0, 2], waypoints: mixedPoints, edges: mixedEdges });
assert.deepEqual(payload.waypoints, buildExport({
  mapData: local.map, heightRange: [0, 2], waypoints: localProject.waypoints, edges: localProject.edges,
}).waypoints);
assert.equal(payload.paths.length, localProject.edges.length);
assert.ok(!JSON.stringify(payload).includes(TEMPORARY_MAP_ROUTE_SOURCE));

// Cached extraction relations also work and require the correct source map.
const extracted = transferSnapshot(await extractTeachingWorkspace(map, {
  bounds: { min: { x: 9, y: 19, z: 0 }, max: { x: 12, y: 22, z: 2 } },
  localToMap,
}));
const extraction = extracted.config.config.project.workspace.transfer;
const extractedSync = syncMapRouteToIndependent(extracted.map, extraction, map.config);
assert.equal(extractedSync.waypoints.length, map.config.config.project.waypoints.length,
  'sync includes the full map route beyond the crop');
assert.deepEqual(extractedSync.mapOrigin, repeated.mapOrigin);

for (const pose of [identityTransferPose(), {
  position: { x: 10000, y: -20000, z: 50 }, rpy: { roll: 0, pitch: 0, yaw: 0 },
}]) {
  const config = structuredClone(placed.config);
  config.config.project.workspace.transfer.localToMap = pose;
  const origin = syncMapRouteToIndependent(local.map, null, config).mapOrigin;
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(origin.position[axis] + pose.position[axis]) < 1e-10);
  for (const axis of ['roll', 'pitch', 'yaw']) assert.ok(Math.abs(origin.rpy[axis]) < 1e-10);
}
assert.equal(mapRouteSyncStatus(local.map, null, map.config).available, false, 'unrelated cached projects are not sufficient');
assert.equal(mapRouteSyncStatus({ ...local.map, sourceHash: 'different' }, null, placed.config).available, false);
assert.equal(mapRouteSyncStatus(local.map, null, null).available, false);
assert.equal(mapRouteSyncStatus(map.map, null, placed.config).available, false);
const empty = structuredClone(placed.config);
empty.config.project.waypoints = [];
empty.config.project.paths = [];
assert.equal(mapRouteSyncStatus(local.map, null, empty).available, false);
assert.throws(() => syncMapRouteToIndependent(local.map, null, empty), /加载路径/);
const wrongTarget = structuredClone(map.config);
wrongTarget.config.project.map.sourceHash = 'another-map';
assert.equal(mapRouteSyncStatus(extracted.map, extraction, wrongTarget).available, false);

// Native ABX route IDs and teaching associations are not editable links back
// to the source workspace, and must not survive in a local projection.
const linked = structuredClone(placed.config);
linked.config.project.waypoints[0].abx = { routeId: 'absolute-route', nodeId: 1 };
linked.config.project.waypoints[0].source = 'teaching-parking-point';
linked.config.project.waypoints[0].teachingTaskId = 'original-task';
linked.config.project.paths[0].abx = { routeId: 'absolute-route', edgeId: 2 };
const linkedSync = syncMapRouteToIndependent(local.map, null, linked);
assert.equal(linkedSync.waypoints[0].abx, undefined);
assert.equal(linkedSync.waypoints[0].teachingTaskId, undefined);
assert.equal(linkedSync.waypoints[0].sourceWaypointSource, 'teaching-parking-point',
  'temporary copies retain only the source kind needed to group duplicate labels');
assert.equal(linkedSync.edges[0].abx, undefined);
console.log('map route sync: inverse XYZ/RPY, map origin frame, graph, repeat sync, isolation, transient exports and both relations passed');
