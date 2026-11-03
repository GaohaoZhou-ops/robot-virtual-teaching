import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { buildAbxRouteDocuments } from '../src/features/navigation/model/abxRoute.js';
import { buildAbxTeachingArchive } from '../src/features/teaching/model/abxTeachingExport.js';
import { mergeAbxImport, parseAbxTeachingTask, readAbxTeachingFile } from '../src/features/teaching/model/abxTeachingImport.js';
import { normalizeProject, normalizeTeachingTasks } from '../src/features/workspace/model/io.js';
import { readMapTeachingMatrix, transformMapTeachingWorkspace } from '../src/features/teaching/model/mapTeachingTransform.js';
import { buildTeachingDataExport, buildTeachingParkingPointCopy } from '../src/features/teaching/model/teachingData.js';
import { mapTeachingMatrixDefinition, robotTeachingCoordinates } from '../src/features/teaching/model/mapTeachingCoordinates.js';
import { buildIndependentMapTeachingExport } from '../src/features/workspace/model/independentTeachingExport.js';
import { buildProjectArchive, readProjectArchive } from '../src/features/workspace/model/projectArchive.js';
import { prepareWorkspaceCollectionImport } from '../src/features/workspace/model/projectWorkspaceCollection.js';
import { independentTeachingExportFixture } from './independent_teaching_export_helpers.mjs';
import { transferSnapshot } from './teaching_transfer_helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const calibration = await readMapTeachingMatrix(new File([
  '0 -1 0 4\n1 0 0 -2\n0 0 1 .5\n0 0 0 1',
], 'project-only-calibration.txt'));
const projectOnly = new Set(['workspace', 'mapTransform', 'transfer', 'localToMap', 'matrixImports',
  'previousPlacements', 'geometryLayers', 'mapFrameSources', 'sourceCoordinates']);
function assertExchange(value, path = 'export') {
  if (typeof value === 'string') assert.ok(!value.includes(calibration.name), `${path}: matrix filename must stay in the project`);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!projectOnly.has(key), `${path}.${key} must stay in the project`);
    assertExchange(item, `${path}.${key}`);
  }
}
async function assertRobotArchive(bundle) {
  const files = unzipSync(bundle.bytes);
  assert.ok(!files['config/project.json'], 'robot ZIP must not contain a project backup');
  assertExchange(JSON.parse(strFromU8(bundle.navigationBytes)), 'navigation download');
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.json')) assertExchange(JSON.parse(strFromU8(data)), name);
    if (name.endsWith('.ndjson')) {
      const parsed = await parseAbxTeachingTask(strFromU8(data));
      assertExchange(parsed.header, name);
      parsed.lines.forEach((line) => assertExchange(JSON.parse(line), name));
      // Navigation chunks are encoded; inspect the decoded content as well.
      assertExchange(parsed.navigation, `${name}.navigation`);
    }
    if (/\.(json|ndjson|txt)$/.test(name)) assert.ok(!strFromU8(data).includes(calibration.name), name);
  }
}

const { map, local, route, robotPackage } = independentTeachingExportFixture();
const source = structuredClone({ map, local });
const originals = [map.config.config.project, buildIndependentMapTeachingExport(local.config.config.project, local.map, map.config)];
const calibrated = await transformMapTeachingWorkspace(map, calibration);
const project = calibrated.config.project;
assert.deepEqual(mapTeachingMatrixDefinition(project.workspace.mapTransform), calibration);
assert.deepEqual(project.workspace.mapTransform.sourceCoordinates.waypoints,
  originals[0].waypoints.map(({ id, pose }) => ({ id, pose })));
const mapped = buildIndependentMapTeachingExport(local.config.config.project, local.map, transferSnapshot(calibrated).config);
assert.deepEqual(mapped.workspace.mapTransform, project.workspace.mapTransform);
assert.ok(mapped.workspace.transfer.localToMap, 'independent export keeps its binding while compiling');
const beforeExports = structuredClone({ calibrated, mapped, local });

// Scene alignment changes the displayed graph, but robot outputs must retain
// the pre-alignment graph and joint readings in both export entry points.
for (const [index, payload] of [project, mapped].entries()) {
  const { routes } = await buildAbxRouteDocuments(payload);
  assertExchange(routes, 'route download');
  assert.deepEqual(routes, [route], 'all robot route coordinates, headings and IDs stay unchanged');
  const data = buildTeachingDataExport(payload);
  const originalData = buildTeachingDataExport(originals[index]);
  assertExchange(data, 'teaching JSON');
  assert.deepEqual(data.navigation.waypoints, originalData.navigation.waypoints);
  for (const [taskIndex, task] of data.tasks.entries()) {
    for (const [parkingIndex, parking] of task.parkingPoints.entries()) {
      const before = originalData.tasks[taskIndex].parkingPoints[parkingIndex];
      for (const axis of ['x', 'y', 'z']) close(parking.mapPose.position[axis], before.mapPose.position[axis]);
      assert.deepEqual(parking.poses.map((point) => point.fullBodyJoints), before.poses.map((point) => point.fullBodyJoints));
      assert.ok(parking.poses.every((point) => Object.keys(point.opticalTargets).length === 0), 'joint readings do not synthesize end-effector poses');
    }
  }
  for (const taskVersion of [23, 11]) {
    const bundle = await buildAbxTeachingArchive(payload, { robotPackage, taskVersion });
    const originalBundle = await buildAbxTeachingArchive(originals[index], { robotPackage, taskVersion });
    await assertRobotArchive(bundle);
    assert.deepEqual(bundle.navigation.routes, routes);
    for (const [name, bytes] of Object.entries(bundle.files).filter(([name]) => name.endsWith('.ndjson'))) {
      assert.equal(strFromU8(bytes), strFromU8(originalBundle.files[name]), 'robot task bytes are unchanged by scene alignment');
    }
    for (const step of bundle.navigation.tasks.flatMap((task) => task.sequence).filter((step) => step.type === 'route_navigation')) {
      const node = routes[0].nodes.find((item) => `N${item.id}` === step.nodeId);
      close(step.target.x_m, node.x_m);
      close(step.target.y_m, node.y_m);
      close(step.target.yaw_rad, node.yaw_rad);
    }
  }
}
const independent = buildTeachingDataExport(local.config.config.project);
assertExchange(independent, 'independent JSON');
assert.equal(independent.coordinateSystem.frameId, 'virtual_origin');
assert.deepEqual(independent.tasks[0].parkingPoints.map((point) => point.mapPose),
  local.config.config.project.virtualTeaching.tasks[0].parkingPoints.map((point) => point.mapPose));
assert.deepEqual({ calibrated, mapped, local }, beforeExports, 'robot exports must not alter the editable project');
assert.deepEqual({ map, local }, source);

// Project saves retain the relationship, even after robot files were generated.
const full = await buildProjectArchive(project, { mapResource: calibrated.map, existingRobotPackage: robotPackage });
const restored = await readProjectArchive(full.bytes);
assert.equal(JSON.stringify(restored.payload.workspace.mapTransform), JSON.stringify(project.workspace.mapTransform));
// JSON normalizes -0 to 0; compare the serialized coordinate contract.
assert.equal(JSON.stringify(restored.payload.waypoints), JSON.stringify(project.waypoints));
const restoredMap = { ...restored.resources.map, mapId: calibrated.map.mapId };
const reloaded = await transformMapTeachingWorkspace({ mode: 'map', map: restoredMap,
  config: { mapId: restoredMap.mapId, config: { project: restored.payload } } }, calibration);
assert.deepEqual(reloaded.config.project.waypoints, restored.payload.waypoints, 'saved calibration must prevent a second transform');
assert.deepEqual(reloaded.map.positionBuffer, calibrated.map.positionBuffer);
// Saving both workspaces also retains calibration and the independent binding.
const complete = await buildProjectArchive(project, { mapResource: calibrated.map,
  existingRobotPackage: robotPackage, companionWorkspace: local });
const collection = prepareWorkspaceCollectionImport((await readProjectArchive(complete.bytes)).workspaceCollection);
const restoredLocal = collection.workspaces.independent;
assert.equal(JSON.stringify(collection.workspaces.map.config.config.project.workspace.mapTransform), JSON.stringify(project.workspace.mapTransform));
assert.deepEqual(restoredLocal.config.config.project.workspace.transfer.localToMap,
  local.config.config.project.workspace.transfer.localToMap);
const restoredMapped = buildIndependentMapTeachingExport(restoredLocal.config.config.project,
  restoredLocal.map, collection.workspaces.map.config);
assert.deepEqual(restoredMapped.virtualTeaching.tasks.map((task) => task.parkingPoints),
  JSON.parse(JSON.stringify(mapped.virtualTeaching.tasks.map((task) => task.parkingPoints))));
assert.deepEqual(calibrated, beforeExports.calibrated);
assert.deepEqual((await buildAbxRouteDocuments(restored.payload)).routes, [route]);

// Real robot records keep their exact captured poses and native joint records,
// whether imported before or after the display alignment was loaded.
const robotBundle = await buildAbxTeachingArchive(originals[0], { robotPackage });
const native = await readAbxTeachingFile(new File([robotBundle.bytes], 'real-robot.zip'), {
  robot: originals[0].robot, map: map.map,
});
native.tasks = normalizeTeachingTasks(native.tasks);
const nativeMap = structuredClone(map);
nativeMap.config.config.project.virtualTeaching.tasks = native.tasks;
const nativeBefore = await buildAbxTeachingArchive(nativeMap.config.config.project, { robotPackage });
const nativeAligned = await transformMapTeachingWorkspace(nativeMap, calibration);
const importedLater = mergeAbxImport(normalizeProject(project), native);
const later = { ...project, workspace: { ...project.workspace, mapTransform: importedLater.mapTransform },
  waypoints: importedLater.waypoints, virtualTeaching: { ...project.virtualTeaching, tasks: importedLater.tasks.filter((task) => task.abx) } };
const legacy = structuredClone(nativeAligned.config.project);
delete legacy.workspace.mapTransform.sourceCoordinates;
const legacyLate = structuredClone(legacy);
legacyLate.virtualTeaching.tasks = native.tasks;
const partialLegacy = structuredClone(legacyLate);
partialLegacy.workspace.mapTransform.sourceCoordinates = { version: 1, waypoints: [], tasks: [] };
const sample = await readMapTeachingMatrix(new File([
  await readFile(new URL('./fixtures/virtual2map.txt', import.meta.url), 'utf8'),
], 'virtual2map.txt'));
const asSnapshot = (payload) => ({ mode: 'map', map: nativeAligned.map,
  config: { mapId: nativeAligned.map.mapId, config: { project: payload } } });
const repaired = await transformMapTeachingWorkspace(asSnapshot(partialLegacy), calibration);
const replaced = await transformMapTeachingWorkspace(asSnapshot(legacyLate), sample);
for (const payload of [nativeAligned.config.project, later, legacy, legacyLate, repaired.config.project, replaced.config.project]) {
  const exported = await buildAbxTeachingArchive(payload, { robotPackage });
  assert.deepEqual(exported.navigation.routes, [route]);
  for (const [name, bytes] of Object.entries(exported.files).filter(([name]) => name.endsWith('.ndjson'))) {
    assert.equal(strFromU8(bytes), strFromU8(nativeBefore.files[name]), 'native task, parking and joints remain byte-for-byte intact');
  }
}
const alignedTask = nativeAligned.config.project.virtualTeaching.tasks[0];
const copied = buildTeachingParkingPointCopy(alignedTask, alignedTask.parkingPoints[0], nativeAligned.config.project.workspace.mapTransform);
assert.deepEqual(copied.parkingPoint.mapPose, native.tasks[0].parkingPoints[0].mapPose);
assertExchange(copied, 'parking clipboard');
const exact = robotTeachingCoordinates(nativeAligned.config.project);
assert.deepEqual(exact.virtualTeaching.tasks.map((task) => task.parkingPoints.map((parking) => parking.mapPose)),
  native.tasks.map((task) => task.parkingPoints.map((parking) => parking.mapPose)));
const edited = structuredClone(project);
edited.waypoints[0].pose.x += 1;
const editedRoute = (await buildAbxRouteDocuments(edited)).routes[0];
close(editedRoute.nodes[0].x_m, route.nodes[0].x_m);
close(editedRoute.nodes[0].y_m, route.nodes[0].y_m - 1);
const changedNative = structuredClone(nativeAligned.config.project);
changedNative.virtualTeaching.tasks[0].parkingPoints[0].mapPose.position.x += .01;
await assert.rejects(buildAbxTeachingArchive(changedNative, { robotPackage }), /停车定位已改变/);
const updatedJoints = structuredClone(nativeAligned.config.project);
const jointPose = updatedJoints.virtualTeaching.tasks[0].parkingPoints[0].poses[0];
jointPose.fullBodyJoints.values.head_yaw_J += 7;
const jointExport = await buildAbxTeachingArchive(updatedJoints, { robotPackage });
const jointTask = await parseAbxTeachingTask(strFromU8(Object.entries(jointExport.files).find(([name]) => name.endsWith('.ndjson'))[1]));
close(jointTask.points.find((point) => point.record.joints_rad).record.joints_rad.head[0], jointPose.fullBodyJoints.values.head_yaw_J * Math.PI / 180);
console.log('Display alignment: original robot routes/parking/joints, native import ordering, legacy recovery, edits and full project persistence passed');
