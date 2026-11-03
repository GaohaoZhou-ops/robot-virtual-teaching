import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8 } from 'fflate';
import { abxRouteToProject, buildAbxRouteDocuments } from '../src/features/navigation/model/abxRoute.js';
import { syncMapRouteToIndependent } from '../src/features/navigation/model/mapRouteSync.js';
import { buildAbxTeachingArchive } from '../src/features/teaching/model/abxTeachingExport.js';
import { robotTeachingCoordinates } from '../src/features/teaching/model/mapTeachingCoordinates.js';
import { readMapTeachingMatrix, transformMapTeachingWorkspace } from '../src/features/teaching/model/mapTeachingTransform.js';
import { buildTeachingWaypoints, teachingParkingName, waypointRobotPose } from '../src/features/teaching/model/teachingNavigation.js';
import { buildIndependentMapTeachingExport } from '../src/features/workspace/model/independentTeachingExport.js';
import { buildProjectArchive, readProjectArchive } from '../src/features/workspace/model/projectArchive.js';
import { prepareWorkspaceCollectionImport } from '../src/features/workspace/model/projectWorkspaceCollection.js';
import { independentTeachingExportFixture } from './independent_teaching_export_helpers.mjs';
import { transferSnapshot } from './teaching_transfer_helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const { map, local, robotPackage, route } = independentTeachingExportFixture();
// Repeated labels must still resolve the measured N98 station, never a new ID.
route.nodes[1].id = 98;
route.nodes.forEach((node) => { node.label = '停车点1'; });
route.edges.forEach((edge) => {
  if (edge.start === 31) edge.start = 98;
  if (edge.end === 31) edge.end = 98;
});
const graph = abxRouteToProject(route);
Object.assign(map.config.config.project, graph, { paths: graph.edges });
const matrix = await readMapTeachingMatrix(new File([
  await readFile(new URL('./fixtures/virtual2map.txt', import.meta.url), 'utf8'),
], 'virtual2map.txt'));
const aligned = await transformMapTeachingWorkspace(map, matrix);
const project = aligned.config.project;
const original = route.nodes.find((node) => node.id === 98);
const rawDisplayPoint = project.waypoints.find((point) => point.abx.nodeId === 98);
const points = buildTeachingWaypoints(project.waypoints, [], {
  coordinateFrame: 'map', mapTransform: project.workspace.mapTransform, abxRoutes: project.abxRoutes,
});
const point = points.find((item) => item.abx.nodeId === 98);

function record(payload, pose) {
  const task = structuredClone(payload.virtualTeaching.tasks[0]);
  const parking = { ...task.parkingPoints[0], id: 'captured-N98', name: point.name,
    mapPose: { ...pose, frameId: task.coordinateFrame },
    poses: task.parkingPoints[0].poses.map((value) => ({ ...value, name: point.name,
      mapPose: { ...structuredClone(pose), frameId: task.coordinateFrame } })),
  };
  task.parkingPoints = [parking];
  return { ...payload, virtualTeaching: { ...payload.virtualTeaching, tasks: [task] },
    waypoints: buildTeachingWaypoints(payload.waypoints, [task]) };
}

async function checkExport(payload, legacy) {
  const before = structuredClone(payload);
  const bundle = await buildAbxTeachingArchive(payload, { robotPackage });
  assert.deepEqual(bundle.navigation.routes, [route], 'measured navigation coordinates/IDs must stay exactly unchanged');
  assert.deepEqual((await buildAbxRouteDocuments(payload)).routes, [route], 'parking markers must not create replacement nodes');
  const steps = bundle.navigation.tasks[0].sequence.filter((step) => step.type === 'route_navigation');
  assert.ok(steps.length);
  for (const step of steps) {
    assert.equal(step.nodeId, 'N98');
    assert.deepEqual(step.target, { x_m: original.x_m, y_m: original.y_m, yaw_rad: original.yaw_rad });
  }
  assert.equal(bundle.summary.warnings.some((warning) => warning.includes('历史示教记录中的高度偏移')), legacy);
  assert.deepEqual(payload, before, 'compatibility must not rewrite captured poses, joints or the project');
  for (const [name, bytes] of Object.entries(bundle.files)) {
    assert.ok(!strFromU8(bytes).includes('robot-export-height-directions'), name);
    assert.ok(!strFromU8(bytes).includes('mapTransform'), name);
  }
}

for (const height of [0.3, -0.2, 1.2]) {
  // Reproduce the old map-mode command: retain display XY and replace only Z.
  const legacyPose = waypointRobotPose(rawDisplayPoint, height);
  const legacy = record(project, legacyPose);
  const sourcePose = robotTeachingCoordinates(legacy).virtualTeaching.tasks[0].parkingPoints[0].mapPose;
  assert.ok(Math.hypot(sourcePose.position.x - original.x_m, sourcePose.position.y - original.y_m) > 1e-4);
  await checkExport(legacy, true);

  const moved = structuredClone(legacy);
  moved.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.position.x += .01;
  await assert.rejects(buildAbxTeachingArchive(moved, { robotPackage }), /未匹配/);
  const unnamed = structuredClone(legacy);
  unnamed.virtualTeaching.tasks[0].parkingPoints[0].name = '停车点1';
  await assert.rejects(buildAbxTeachingArchive(unnamed, { robotPackage }), /未匹配/);
  const wrongHeading = structuredClone(legacy);
  wrongHeading.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.rpy.yaw += 1;
  await assert.rejects(buildAbxTeachingArchive(wrongHeading, { robotPackage }), /朝向/);
  // Serialization removes the internal proof; without saved matrices a name
  // alone must never authorize snapping a displaced recording to a station.
  const withoutEvidence = JSON.parse(JSON.stringify(robotTeachingCoordinates(legacy)));
  await assert.rejects(buildAbxTeachingArchive(withoutEvidence, { robotPackage }), /未匹配/);

  // New captures keep the robot-map XY fixed while retaining display height.
  const currentPose = waypointRobotPose(point, height);
  assert.equal(currentPose.position.z, height);
  assert.equal(teachingParkingName(points, currentPose, 'fallback'), point.name);
  const current = record(project, currentPose);
  const robotPose = robotTeachingCoordinates(current).virtualTeaching.tasks[0].parkingPoints[0].mapPose;
  close(robotPose.position.x, original.x_m); close(robotPose.position.y, original.y_m);
  await checkExport(current, false);

  // A fresh device restores only portable project data, not browser state or
  // the transient height-matching context created during an earlier export.
  const archive = await buildProjectArchive(legacy, { mapResource: aligned.map, existingRobotPackage: robotPackage,
    companionWorkspace: local });
  const restored = prepareWorkspaceCollectionImport((await readProjectArchive(archive.bytes)).workspaceCollection);
  await checkExport(restored.workspaces.map.config.config.project, true);
}

// Reported legacy archive: a matrix is saved, but a subsequently imported
// road graph and the captures made at it still contain exact robot readings.
// Applying the inverse a second time used to move N98 by about 15 cm.
const unprojectedSource = { ...map.config.config.project,
  workspace: { ...map.config.config.project.workspace, mapTransform: matrix } };
const rawPoint = graph.waypoints.find((item) => item.abx.nodeId === 98);
for (const height of [0.02103554344176571, .3]) {
  const raw = record(unprojectedSource, waypointRobotPose(rawPoint, height));
  const corrected = robotTeachingCoordinates(raw);
  assert.deepEqual(corrected.waypoints, raw.waypoints);
  assert.deepEqual(corrected.virtualTeaching.tasks, raw.virtualTeaching.tasks,
    'already-robot-frame captures, world camera poses and joints must remain exact');
  await checkExport(raw, false);

  const points = buildTeachingWaypoints(raw.waypoints, raw.virtualTeaching.tasks, {
    coordinateFrame: 'map', mapTransform: raw.workspace.mapTransform, abxRoutes: raw.abxRoutes,
  });
  for (const point of points.filter((point) => point.name === rawPoint.name)) {
    const target = waypointRobotPose(point, height + .2);
    assert.equal(target.position.x, original.x_m);
    assert.equal(target.position.y, original.y_m);
    await checkExport(record(raw, target), false);
  }

  const moved = structuredClone(raw);
  moved.virtualTeaching.tasks[0].parkingPoints[0].mapPose.position.x += .01;
  await assert.rejects(buildAbxTeachingArchive(moved, { robotPackage }), /未匹配/);
  const misnamed = structuredClone(raw);
  misnamed.virtualTeaching.tasks[0].parkingPoints[0].name = 'N1 · 停车点1';
  await assert.rejects(buildAbxTeachingArchive(misnamed, { robotPackage }), /未匹配/);

  const archive = await buildProjectArchive(raw, { mapResource: map.map, existingRobotPackage: robotPackage,
    companionWorkspace: local });
  const restored = prepareWorkspaceCollectionImport((await readProjectArchive(archive.bytes)).workspaceCollection);
  await checkExport(restored.workspaces.map.config.config.project, false);
  const reloaded = await transformMapTeachingWorkspace({ ...map,
    config: { ...map.config, config: { ...map.config.config, project: raw } } }, matrix);
  await checkExport(reloaded.config.project, false);

  const synced = syncMapRouteToIndependent(local.map, local.config.config.project.workspace.transfer,
    { ...map.config, config: { ...map.config.config, project: raw } });
  const station = synced.waypoints.find((item) => item.sourceWaypointId === rawPoint.id);
  const captured = record(local.config.config.project, waypointRobotPose(station, height));
  await checkExport(buildIndependentMapTeachingExport(captured, local.map,
    { ...map.config, config: { ...map.config.config, project: raw } }), false);
}

// The same robot vertical direction must be used by synchronized independent
// navigation, even though its point poses are in a different local frame.
const projected = syncMapRouteToIndependent(local.map, local.config.config.project.workspace.transfer, transferSnapshot(aligned).config);
const localPoint = projected.waypoints.find((item) => item.name === point.name);
const independent = record(local.config.config.project, waypointRobotPose(localPoint, .3));
await checkExport(buildIndependentMapTeachingExport(independent, local.map, transferSnapshot(aligned).config), false);
console.log('N98 display-height alignment: unchanged measured route, old/new captures, portable restore, strict rejection and independent navigation passed');
