import assert from 'node:assert/strict';
import { buildExport, normalizeProject } from "../src/features/workspace/model/io.js";
import {
  buildTeachingWaypoints,
  navigationEdgesForWaypoints,
  removeTeachingWaypoints,
  TEACHING_WAYPOINT_SOURCE,
  updateTeachingWaypoint,
} from "../src/features/teaching/model/teachingNavigation.js";

const mapData = { name: 'site.ply', sourceHash: 'site-hash' };
const pose = (x) => ({
  frameId: 'map', position: { x, y: 2, z: 0.3 }, rpy: { roll: 1, pitch: 2, yaw: 90 },
});
const tasks = normalizeProject({ virtualTeaching: { tasks: [{
  id: 'task-1', name: '示教任务', coordinateFrame: 'map',
  map: { fileName: mapData.name, sourceHash: mapData.sourceHash },
  parkingPoints: [
    { id: 'stop-1', name: '停车点 P01', mapPose: pose(1), poses: [
      { id: 'pose-1', name: 'A01', mapPose: pose(1), fullBodyJoints: { values: { elbow: 25 } } },
    ] },
    { id: 'stop-2', name: '停车点 P02', mapPose: pose(3), poses: [] },
  ],
}] } }).teachingTasks;
const options = { mapData, coordinateFrame: 'map' };
const manual = { id: 'manual', name: '独立导航点', source: 'imported', pose: { x: 1, y: 2, z: 0.3, roll: 1, pitch: 2, yaw: 90 } };
const original = structuredClone(tasks);
const waypoints = buildTeachingWaypoints([manual], tasks, options);
assert.deepEqual(waypoints.map((point) => point.id), ['manual', 'stop-1', 'stop-2']);
assert.equal(waypoints[1].source, TEACHING_WAYPOINT_SOURCE);
assert.equal(waypoints[1].teachingTaskId, 'task-1');
assert.equal(waypoints[1].teachingPoseCount, 1);
assert.deepEqual(waypoints[1].pose, { x: 1, y: 2, z: 0.3, roll: 1, pitch: 2, yaw: 90 });
assert.deepEqual(navigationEdgesForWaypoints([], waypoints), [], 'parking order must never create paths');
assert.deepEqual(buildTeachingWaypoints(waypoints, tasks, options), waypoints, 'restoring must not duplicate markers');

const changed = updateTeachingWaypoint(tasks, 'stop-1', { name: '装配位', pose: { x: 8, yaw: -45 } });
const parking = changed[0].parkingPoints[0];
assert.equal(parking.name, '装配位');
assert.equal(parking.mapPose.position.x, 8);
assert.equal(parking.mapPose.rpy.yaw, -45);
assert.deepEqual(parking.poses[0].mapPose, parking.mapPose, 'bound recordings follow the parking position');
assert.deepEqual(parking.poses[0].fullBodyJoints, tasks[0].parkingPoints[0].poses[0].fullBodyJoints);
assert.equal(changed[0].parkingPoints[1], tasks[0].parkingPoints[1]);
assert.deepEqual(tasks, original, 'navigation edits must not mutate previous snapshots');

const explicit = [{ id: 'path', from: 'stop-1', to: 'stop-2', limits: { minSpeed: 0.2, maxSpeed: 1 }, motion: { direction: 'reverse' } }];
const linked = buildTeachingWaypoints(waypoints, changed, options);
assert.equal(linked[1].pose.x, 8, 'the saved navigation copy cannot override current teaching coordinates');
assert.deepEqual(navigationEdgesForWaypoints(explicit, linked), explicit);
const exported = buildExport({ mapData, heightRange: [0, 2], waypoints: linked, edges: explicit, teachingTasks: changed });
const restored = normalizeProject(exported);
const restoredPoints = buildTeachingWaypoints(restored.waypoints, restored.teachingTasks, options);
assert.deepEqual(restoredPoints, linked, 'export/import preserves shared IDs, names and poses');
assert.equal(restored.edges.length, 1);
assert.equal(restored.edges[0].motion.direction, 'reverse');
assert.deepEqual([restored.edges[0].from, restored.edges[0].to], ['stop-1', 'stop-2']);

const deleted = removeTeachingWaypoints(changed, new Set(['stop-1']));
const remaining = buildTeachingWaypoints(restoredPoints, deleted, options);
assert.deepEqual(remaining.map((point) => point.id), ['manual', 'stop-2']);
assert.deepEqual(navigationEdgesForWaypoints(explicit, remaining), [], 'deleting a parking point removes incident paths');
assert.equal(deleted[0].parkingPoints[0].sequence, 1);
assert.deepEqual(buildTeachingWaypoints(remaining, [], options), [manual], 'deleting a task removes its saved markers');
assert.deepEqual(buildTeachingWaypoints([], tasks, { mapData: { ...mapData, sourceHash: 'another-map' }, coordinateFrame: 'map' }), []);
assert.deepEqual(buildTeachingWaypoints([], tasks, { mapData, coordinateFrame: 'virtual_origin' }), []);
assert.deepEqual(buildTeachingWaypoints([], [{ ...tasks[0], parkingPoints: [] }], options), []);
console.log('teaching navigation: linked points, no inferred paths, edits, deletion, context and export/import passed');
