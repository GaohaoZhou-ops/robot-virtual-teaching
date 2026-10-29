import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { abxNodeName, abxRouteToProject, buildAbxRouteDocuments } from "../src/features/navigation/model/abxRoute.js";
import { buildAbxTeachingArchive } from "../src/features/teaching/model/abxTeachingExport.js";
import { normalizeProject } from "../src/features/workspace/model/io.js";
import { syncMapRouteToIndependent } from "../src/features/navigation/model/mapRouteSync.js";
import { teachingParkingName, waypointRobotPose } from "../src/features/teaching/model/teachingNavigation.js";
import { transferMatrix, transformTeachingPose } from "../src/features/teaching/model/teachingTransfer.js";
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';

const decoder = new TextDecoder();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const taskRecords = (bundle) => {
  const manifest = JSON.parse(decoder.decode(bundle.files['manifest.json']));
  return decoder.decode(bundle.files[manifest.tasks[0].file]).trimEnd().split('\n').map(JSON.parse);
};
const { payload: fixture, robotPackage } = abxTeachingFixture();
const poseOf = (node, yawDrift = 0) => ({ frameId: 'map',
  position: { x: node.x_m, y: node.y_m, z: 0.3 },
  rpy: { roll: 0, pitch: 0, yaw: (node.yaw_rad ?? 0) * 180 / Math.PI + yawDrift } });
const payloadFor = (route, ids) => {
  const payload = structuredClone(fixture), graph = abxRouteToProject(route);
  Object.assign(payload, graph, { paths: graph.edges });
  const task = payload.virtualTeaching.tasks[0], template = task.parkingPoints[0];
  payload.virtualTeaching.tasks = [task];
  task.parkingPoints = ids.map((id, i) => {
    const pose = poseOf(route.nodes.find((node) => node.id === id), 0.001);
    return { ...template, id: `parking-${id}`, name: `停车点 P${i + 1}`, sequence: i + 1, mapPose: pose,
      poses: [{ ...template.poses[0], id: `pose-${id}`, sequence: 1, mapPose: structuredClone(pose) }] };
  });
  // Reproduce cached teaching markers preceding the actual route nodes. The
  // old exporter used these synthesized nodes and emitted N132 instead of N31.
  payload.waypoints.unshift(...task.parkingPoints.map((parking) => ({ id: parking.id, name: parking.name,
    source: 'teaching-parking-point', pose: { ...parking.mapPose.position, ...parking.mapPose.rpy } })));
  return payload;
};

const synthetic = { schema_version: 1, id: 'repeat-labels', name: '分组路网', scene_name: 'map',
  nodes: [0, 1, 31, 62, 98].map((id, i) => ({ id, label: id ? '停车点1' : '起点',
    x_m: 10 + i * 3, y_m: -4, yaw_rad: id === 98 ? null : 0.2 })),
  edges: [{ id: 10, start: 0, end: 1 }, { id: 40, start: 1, end: 31 },
    { id: 71, start: 31, end: 62 }, { id: 107, start: 62, end: 98 }] };

async function checkRoute(route) {
  const original = structuredClone(route), graph = abxRouteToProject(route);
  const wanted = [1, 31, 62, 98];
  assert.deepEqual(wanted.map((id) => graph.waypoints.find((point) => point.abx.nodeId === id).name),
    wanted.map((id) => `N${id} · 停车点1`));
  const legacy = structuredClone(graph);
  legacy.waypoints.forEach((point) => { point.name = route.nodes.find((node) => node.id === point.abx.nodeId).label; });
  const restored = normalizeProject({ ...legacy, paths: legacy.edges });
  assert.deepEqual(restored.waypoints.map((point) => point.name), graph.waypoints.map((point) => point.name),
    'cached labels gain stable IDs on load');
  assert.deepEqual((await buildAbxRouteDocuments({ ...restored, paths: restored.edges })).routes, [route],
    'display names must not change native labels, node/edge IDs, coordinates or scene bindings');
  const payload = payloadFor(route, wanted), before = JSON.stringify(payload);
  assert.deepEqual((await buildAbxRouteDocuments(payload)).routes, [route],
    'teaching markers at native stations must not create additional route nodes');
  const bundle = await buildAbxTeachingArchive(payload, { robotPackage }), records = taskRecords(bundle);
  assert.deepEqual(records.filter((record) => record.type === 'parking').map((record) => record.name),
    wanted.map((id) => `N${id} · 停车点1`));
  assert.deepEqual(records.filter((record) => record.record?.type === 'route_navigation').map((record) => record.record.node_id),
    wanted.map((id) => `N${id}`), 'repeat labels and heading drift must never renumber stations');
  for (const step of bundle.navigation.tasks[0].sequence.filter((step) => step.type === 'route_navigation')) {
    const node = route.nodes.find((node) => `N${node.id}` === step.nodeId);
    assert.deepEqual(step.target, { x_m: node.x_m, y_m: node.y_m, yaw_rad: node.yaw_rad },
      'preview must show the actual robot route heading, including unspecified headings');
  }
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(route, original);
  const reordered = structuredClone(payload);
  reordered.waypoints.reverse();
  assert.deepEqual(taskRecords(await buildAbxTeachingArchive(reordered, { robotPackage }))
    .filter((record) => record.type === 'point'), records.filter((record) => record.type === 'point'),
  'node identity must not depend on waypoint list order');

  const node = route.nodes.find((node) => node.id === 31);
  assert.equal(teachingParkingName(graph.waypoints, poseOf(node), 'fallback'), 'N31 · 停车点1');
  assert.equal(teachingParkingName(graph.waypoints, poseOf(node), 'fallback', graph.waypoints[0].id), 'N31 · 停车点1',
    'a distant selected waypoint must not rename the current stop');
  assert.equal(teachingParkingName(graph.waypoints, { x: 900, y: 900, yaw: 0 }, 'fallback'), 'fallback');
  const offRoute = structuredClone(payload);
  offRoute.virtualTeaching.tasks[0].parkingPoints[0].mapPose.position.x += 0.01;
  await assert.rejects(buildAbxTeachingArchive(offRoute, { robotPackage }), /未匹配.*不会自动新建/);
  const offRoutePose = structuredClone(payload);
  offRoutePose.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.position.x += 0.01;
  await assert.rejects(buildAbxTeachingArchive(offRoutePose, { robotPackage }), /未匹配.*不会自动新建/);
  const wrongHeading = structuredClone(payload);
  wrongHeading.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.rpy.yaw += 20;
  await assert.rejects(buildAbxTeachingArchive(wrongHeading, { robotPackage }), /底盘朝向.*0.1°/);
  const lostRoute = structuredClone(payload);
  lostRoute.abxRoutes = [];
  await assert.rejects(buildAbxTeachingArchive(lostRoute, { robotPackage }), /关联路网缺失/);

  // Only a local copy is transformed. The N-number/name survives independent
  // teaching and the inverse transform, while the absolute route is unchanged.
  const localToMap = { position: { x: 11, y: -4, z: 2 }, rpy: { roll: 0, pitch: 0, yaw: 137 } };
  const mapConfig = { mapId: 'map', config: { project: payload } };
  const relation = { kind: 'extraction', sourceMap: { sourceHash: payload.map.sourceHash }, localToMap };
  const projected = syncMapRouteToIndependent({ teachingSpaceMode: 'independent' }, relation, mapConfig);
  const local = projected.waypoints.find((point) => point.name === 'N31 · 停车点1');
  assert.equal(local.abx, undefined, 'temporary points must not carry editable absolute-coordinate metadata');
  const localPose = { position: { x: local.pose.x, y: local.pose.y, z: local.pose.z },
    rpy: { roll: local.pose.roll, pitch: local.pose.pitch, yaw: local.pose.yaw } };
  assert.equal(teachingParkingName(projected.waypoints, localPose, 'fallback', local.id), local.name);
  const returned = transformTeachingPose(localPose, transferMatrix(localToMap), 'map');
  const roundtrip = payloadFor(route, [31]);
  Object.assign(roundtrip.virtualTeaching.tasks[0].parkingPoints[0], { name: local.name, mapPose: returned });
  roundtrip.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose = structuredClone(returned);
  assert.equal(taskRecords(await buildAbxTeachingArchive(roundtrip, { robotPackage }))
    .find((record) => record.record?.type === 'route_navigation').record.node_id, 'N31');
  assert.equal(JSON.stringify(payload), before, 'independent sync/return must not modify map route data');
}

await checkRoute(synthetic);

// Recorded local Z is a calibrated robot height, not the route's plane. Use
// the real tilted alignment that exposed the failure, plus a larger rotation.
for (const localToMap of [
  { position: { x: 4.087704, y: -7.297507, z: 0.100661 },
    rpy: { roll: -0.27501951721487344, pitch: -0.0019406646615915792, yaw: 179.27496036793707 } },
  { position: { x: 11, y: -4, z: 2 }, rpy: { roll: 12, pitch: -8, yaw: 137 } },
]) {
  const source = payloadFor(synthetic, [31]), matrix = transferMatrix(localToMap);
  const projected = syncMapRouteToIndependent({ teachingSpaceMode: 'independent' },
    { kind: 'extraction', sourceMap: { sourceHash: source.map.sourceHash }, localToMap },
    { mapId: 'map', config: { project: source } });
  const station = projected.waypoints.find((point) => point.name === 'N31 · 停车点1');
  const calibratedHeight = 0.3;
  const localPose = waypointRobotPose(station, calibratedHeight);
  assert.equal(localPose.position.z, calibratedHeight, 'retain the calibrated independent robot height');
  assert.equal(teachingParkingName(projected.waypoints, localPose, 'fallback'), station.name);
  const returned = transformTeachingPose(localPose, matrix, 'map');
  const original = synthetic.nodes.find((node) => node.id === 31);
  assert(Math.hypot(returned.position.x - original.x_m, returned.position.y - original.y_m) < 1e-10,
    'moving to a projected waypoint must reach the same map XY even with a tilted matrix');
  const payload = payloadFor(synthetic, [31]), parking = payload.virtualTeaching.tasks[0].parkingPoints[0];
  Object.assign(parking, { name: station.name, mapPose: returned });
  parking.poses[0].mapPose = structuredClone(returned);
  assert.equal(taskRecords(await buildAbxTeachingArchive(payload, { robotPackage }))
    .find((record) => record.record?.type === 'route_navigation').record.node_id, 'N31',
  'new captures export using strict map coordinates, with no legacy context');

  // Reproduce already-saved records from the old move-to-waypoint behavior.
  const legacyPose = transformTeachingPose({
    position: { x: station.pose.x, y: station.pose.y, z: calibratedHeight },
    rpy: { roll: station.pose.roll, pitch: station.pose.pitch, yaw: station.pose.yaw },
  }, matrix, 'map');
  assert(Math.hypot(legacyPose.position.x - original.x_m, legacyPose.position.y - original.y_m) > 1e-4);
  parking.mapPose = legacyPose;
  parking.poses[0].mapPose = structuredClone(legacyPose);
  Object.assign(payload.waypoints.find((point) => point.id === parking.id),
    { name: parking.name, pose: { ...legacyPose.position, ...legacyPose.rpy } });
  await assert.rejects(buildAbxTeachingArchive(payload, { robotPackage }), /未匹配/,
    'without saved frame evidence an off-station recording must still fail');
  const placement = { version: 1, kind: 'placement', localToMap };
  payload.workspace.transfer = { version: 1, kind: 'placement',
    localToMap: { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } },
    previousPlacements: [placement] };
  const before = JSON.stringify(payload);
  assert.deepEqual((await buildAbxRouteDocuments(payload)).routes, [synthetic],
    'legacy teaching markers must reuse the original stations, never create duplicate graph nodes');
  const recovered = await buildAbxTeachingArchive(payload, { robotPackage });
  assert.equal(taskRecords(recovered).find((record) => record.record?.type === 'route_navigation').record.node_id, 'N31');
  assert.deepEqual(recovered.navigation.tasks[0].sequence.find((step) => step.type === 'route_navigation').target,
    { x_m: original.x_m, y_m: original.y_m, yaw_rad: original.yaw_rad });
  assert.equal(JSON.stringify(payload), before, 'legacy export must preserve original cache, poses and joints');
  const noName = structuredClone(payload);
  noName.virtualTeaching.tasks[0].parkingPoints[0].name = '停车点1';
  await assert.rejects(buildAbxTeachingArchive(noName, { robotPackage }), /未匹配/,
    'repeated display labels alone are insufficient evidence for height recovery');
  const moved = structuredClone(payload);
  moved.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.position.x += 0.01;
  await assert.rejects(buildAbxTeachingArchive(moved, { robotPackage }), /未匹配/,
    'moving a recorded base away must not be hidden by legacy height recovery');
  const wrongHeading = structuredClone(payload);
  wrongHeading.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.rpy.yaw += 20;
  await assert.rejects(buildAbxTeachingArchive(wrongHeading, { robotPackage }), /底盘朝向.*0.1°/);
}

const coincident = structuredClone(synthetic);
Object.assign(coincident.nodes.find((node) => node.id === 62), coincident.nodes.find((node) => node.id === 31), { id: 62 });
const ambiguous = payloadFor(coincident, [31]);
await assert.rejects(buildAbxTeachingArchive(ambiguous, { robotPackage }), /多个同坐标站点/);
ambiguous.virtualTeaching.tasks[0].parkingPoints[0].name = abxNodeName(62, '停车点1');
assert.equal(taskRecords(await buildAbxTeachingArchive(ambiguous, { robotPackage }))
  .find((record) => record.record?.type === 'route_navigation').record.node_id, 'N62');

const referencePath = process.env.ABX_ROUTE_REFERENCE || '1019平地路网终版测试.json';
let reference;
try { reference = await readFile(referencePath); } catch (error) {
  if (error.code !== 'ENOENT' || process.env.ABX_ROUTE_REFERENCE) throw error;
}
if (reference) {
  const route = JSON.parse(reference);
  await checkRoute(route);
  assert.equal(sha(await readFile(referencePath)), sha(reference));
  console.log(`${referencePath}: ${route.nodes.length} nodes / ${route.edges.length} edges unchanged; N1/N31/N62/N98 map to the correct work areas`);
}
console.log('Route identity, naming, cache migration, no renumbering, independent projection and unmatched/ambiguous target rejection passed');
