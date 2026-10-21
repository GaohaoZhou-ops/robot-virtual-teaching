import assert from 'node:assert/strict';
import { buildIndependentMapTeachingExport } from '../src/lib/independentTeachingExport.js';
import { buildAbxTeachingArchive } from '../src/lib/abxTeachingExport.js';
import { buildTeachingDataExport } from '../src/lib/teachingData.js';
import { syncMapRouteToIndependent } from '../src/lib/mapRouteSync.js';
import { independentTeachingExportFixture } from './independent_teaching_export_helpers.mjs';

const { map, local, route, robotPackage, task, localToMap } = independentTeachingExportFixture();
const source = local.config.config.project;
const before = JSON.stringify({ source, target: map.config });
const originalJson = buildTeachingDataExport(source);
const mapped = buildIndependentMapTeachingExport(source, local.map, map.config);
assert.equal(mapped.coordinateSystem.frameId, 'map');
assert.equal(mapped.workspace.teachingSpaceMode, 'map');
assert.deepEqual(mapped.virtualTeaching.tasks.map((task) => task.id), ['current-local-task']);
const actual = mapped.virtualTeaching.tasks[0];
for (const [i, parking] of actual.parkingPoints.entries()) {
  assert.equal(parking.mapPose.frameId, 'map');
  for (const key of ['x', 'y', 'z']) {
    assert.ok(Math.abs(parking.mapPose.position[key] - task.parkingPoints[i].mapPose.position[key]) < 1e-10);
    for (const [j, pose] of parking.poses.entries()) {
      assert.ok(Math.abs(pose.mapPose.position[key] - task.parkingPoints[i].poses[j].mapPose.position[key]) < 1e-10);
    }
  }
  assert.deepEqual(parking.poses.map((pose) => pose.fullBodyJoints), task.parkingPoints[i].poses.map((pose) => pose.fullBodyJoints));
}
assert.equal(actual.map.fileName, map.map.name);
assert.equal(actual.map.sourceHash, map.map.sourceHash);
const bundle = await buildAbxTeachingArchive(mapped, { robotPackage });
assert.deepEqual(bundle.navigation.routes, [route]);
assert.deepEqual(bundle.navigation.tasks[0].sequence.filter((step) => step.type === 'route_navigation').map((step) => step.nodeId), ['N31', 'N0']);
assert.equal(bundle.summary.taskCount, 1);
assert.equal(bundle.summary.poseCount, 3);
assert.equal(JSON.stringify({ source, target: map.config }), before, 'export must not modify either workspace');
assert.deepEqual(buildTeachingDataExport(source), originalJson, 'JSON remains in the original independent frame');

// A previously placed group can have its only binding on the map side.
const placedMap = structuredClone(map.config), unboundSource = structuredClone(source);
delete unboundSource.workspace.transfer;
placedMap.config.project.workspace.transfer = { version: 1, kind: 'placement', sourceMap: { sourceHash: 'another-model' },
  localToMap, previousPlacements: [{ version: 1, kind: 'placement', sourceMap: local.map, localToMap }] };
assert.deepEqual(buildIndependentMapTeachingExport(unboundSource, local.map, placedMap).virtualTeaching.tasks,
  mapped.virtualTeaching.tasks);
assert.throws(() => buildIndependentMapTeachingExport(unboundSource, { ...local.map, teachingGroupId: 'another-group' }, placedMap), /建立转换关系/);
const wrongMap = structuredClone(map.config);
wrongMap.config.project.map.sourceHash = 'different-map';
assert.throws(() => buildIndependentMapTeachingExport(source, local.map, wrongMap), /建立转换关系/);
assert.throws(() => buildIndependentMapTeachingExport(source, local.map, null), /加载路径/);
const missingRoute = structuredClone(map.config);
missingRoute.config.project.waypoints = [];
assert.throws(() => buildIndependentMapTeachingExport(source, local.map, missingRoute), /加载路径/);
const legacy = structuredClone(source);
const station = syncMapRouteToIndependent(local.map, source.workspace.transfer, map.config).waypoints[1];
const parking = legacy.virtualTeaching.tasks[0].parkingPoints[0];
parking.name = station.name;
parking.mapPose = { frameId: 'virtual_origin', position: { x: station.pose.x, y: station.pose.y, z: 0.3 },
  rpy: { roll: station.pose.roll, pitch: station.pose.pitch, yaw: station.pose.yaw } };
parking.poses.forEach((pose) => { pose.mapPose = structuredClone(parking.mapPose); });
const legacyBundle = await buildAbxTeachingArchive(buildIndependentMapTeachingExport(legacy, local.map, map.config), { robotPackage });
assert.ok(legacyBundle.summary.warnings.some((warning) => warning.includes('历史示教记录中的高度偏移')));
assert.deepEqual(legacyBundle.navigation.routes, [route]);
// Existing map markers from other placed groups retain their own height context.
const markedMap = structuredClone(map.config);
markedMap.config.project.workspace.transfer = { version: 1, kind: 'placement', sourceMap: { sourceHash: 'other-group' },
  localToMap: { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 20, yaw: 0 } } };
markedMap.config.project.waypoints.push({ id: 'historical-map-marker', source: 'teaching-parking-point', name: 'N0 · 停车点 A',
  pose: { x: 1.25 + Math.sin(Math.PI / 9) * 0.3, y: -2.5, z: Math.cos(Math.PI / 9) * 0.3, roll: 0, pitch: 0, yaw: 90 } });
assert.deepEqual((await buildAbxTeachingArchive(buildIndependentMapTeachingExport(source, local.map, markedMap), { robotPackage })).navigation.routes, [route]);
const moved = structuredClone(source);
moved.virtualTeaching.tasks[0].parkingPoints[0].poses[0].mapPose.position.x += 0.01;
await assert.rejects(buildAbxTeachingArchive(buildIndependentMapTeachingExport(moved, local.map, map.config), { robotPackage }), /未匹配.*不会自动新建/);
console.log('Independent export: tilted coordinates, latest tasks, original route IDs/full graph, binding checks and unchanged JSON/workspaces passed');
