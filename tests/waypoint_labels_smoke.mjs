import assert from 'node:assert/strict';
import { buildWaypointLabels } from "../src/features/viewport/model/waypointLabels.js";
import { TEACHING_WAYPOINT_SOURCE, TEMPORARY_MAP_ROUTE_SOURCE, waypointRobotPose } from "../src/features/teaching/model/teachingNavigation.js";

const route = (id, node, x, name = `N${node} · 停车点1`) => ({ id, name, source: 'abx-route',
  abx: { routeId: 'route', nodeId: node }, pose: { x, y: 2, z: 0, roll: 0, pitch: 0, yaw: 0 } });
const parking = (id, anchor, dx = 0) => ({ id, name: anchor.name, source: TEACHING_WAYPOINT_SOURCE,
  pose: { ...anchor.pose, x: anchor.pose.x + dx, z: 0.3 }, teachingTaskId: 'task' });
const a = route('a', 1, 1), b = route('b', 31, 3), c = route('c', 2, 5, 'N2 · 停车点2');
const first = parking('first', a, 0.002), second = parking('second', c, -0.004);
const input = [first, a, b, second, c, parking('another-task', a, -0.003)];
const before = structuredClone(input);
const groups = buildWaypointLabels(input);
assert.deepEqual(groups.map((group) => group.point.id), ['a', 'b', 'c']);
assert.deepEqual(groups[0].waypointIds, ['a', 'first', 'another-task']);
assert.deepEqual(groups[2].waypointIds, ['c', 'second']);
assert.deepEqual(input, before, 'grouping labels must not change navigation, task IDs or recorded poses');
assert.equal(groups[0].point, a, 'the label uses the authoritative route position');
assert.equal(buildWaypointLabels([a, { ...first, name: '停车点1' }]).length, 1, 'old names without N prefixes still match');
assert.equal(buildWaypointLabels([a, { ...first, name: 'N0 · 停车点1' }]).length, 2, 'different station numbers never merge');
assert.equal(buildWaypointLabels([a, { ...first, name: '另一个工位' }]).length, 2, 'unrelated names remain visible');
assert.equal(buildWaypointLabels([a, parking('far', a, 0.2)]).length, 2, 'a genuinely moved parking point gets its own label');
assert.equal(buildWaypointLabels([a, route('duplicate-number', 1, 1), first]).length, 3, 'ambiguous stations are not silently hidden');
assert.equal(buildWaypointLabels([a, { ...a, id: 'other-navigation' }]).length, 2, 'standalone navigation points retain individual labels');
assert.equal(buildWaypointLabels([first, second]).length, 2, 'teaching-only workspaces retain their labels');
const zero = route('zero', 0, 10);
assert.equal(buildWaypointLabels([zero, parking('zero-parking', zero)]).length, 1);

// A tilted map projection has a different local X/Y at the robot's height.
const projected = { id: 'projected-a', source: TEMPORARY_MAP_ROUTE_SOURCE, sourceWaypointId: 'a',
  sourceWaypointSource: 'abx-route', name: a.name, pose: a.pose, navigationUp: { x: 0.5, y: 0.2, z: 0.8 } };
const localPose = waypointRobotPose(projected, 0.5);
const localParking = { ...first, pose: { ...localPose.position, ...localPose.rpy } };
const copiedParking = { ...localParking, id: 'projected-parking', source: TEMPORARY_MAP_ROUTE_SOURCE,
  sourceWaypointSource: TEACHING_WAYPOINT_SOURCE, sourceWaypointId: first.id };
const localGroups = buildWaypointLabels([projected, copiedParking, localParking]);
assert.equal(localGroups.length, 1);
assert.deepEqual(localGroups[0].waypointIds, ['projected-a', 'projected-parking', 'first']);
assert.equal(buildWaypointLabels([projected, { ...localParking, pose: { ...localParking.pose, x: localParking.pose.x + 0.02 } }]).length, 1);
const extractedCopy = { ...a, pose: { ...projected.pose } };
assert.equal(buildWaypointLabels([extractedCopy, projected]).length, 1, 'synchronized copies of an extracted waypoint share a label');
const changedCopy = { ...extractedCopy, pose: { ...extractedCopy.pose, x: 20 } };
assert.equal(buildWaypointLabels([changedCopy, projected]).length, 2, 'edited local navigation is not hidden by synchronization');
assert.deepEqual(buildWaypointLabels([]), []);
console.log('Waypoint labels: native identity, slight drift, tilted height, synced parking copies, ambiguity and immutable source data passed');
