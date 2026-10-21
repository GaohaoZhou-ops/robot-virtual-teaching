import assert from 'node:assert/strict';
import { connectivityCopy, inspectConnectivity } from '../src/lib/graph.js';

const points = (...ids) => ids.map((id) => ({ id }));
const path = (from, to, directed = true) => ({ id: `${from}-${to}`, from, to, directed });
const inspect = (ids, edges) => {
  const waypoints = points(...ids);
  const original = JSON.stringify({ waypoints, edges });
  const result = inspectConnectivity(waypoints, edges);
  assert.equal(JSON.stringify({ waypoints, edges }), original, 'Checking must not mutate coordinates or paths');
  return result;
};

// An isolated teaching/navigation point must not be described as a yellow path.
const isolated = inspect(['A', 'B', 'parking'], [path('A', 'B'), path('B', 'A')]);
assert.equal(isolated.stronglyConnected, false);
assert.deepEqual([...isolated.edgeStatus.values()], ['connected', 'connected']);
assert.deepEqual(isolated.validation.isolatedWaypointIds, ['parking']);
assert.equal(isolated.validation.unreachableCount, 0);
assert.equal(connectivityCopy(isolated.validation).detail, '1 个孤立导航点未接入路网');

// Every existing edge can be green while two complete road networks are separate.
const disjoint = inspect(['A', 'B', 'C', 'D'], [path('A', 'B'), path('B', 'A'), path('C', 'D'), path('D', 'C')]);
assert.equal(disjoint.validation.status, 'partial');
assert.deepEqual(disjoint.validation.components, [['A', 'B'], ['C', 'D']]);
assert.equal(disjoint.validation.unreachableCount, 0);
assert.equal(connectivityCopy(disjoint.validation).detail, '2 组路网互不相连');

const oneWay = inspect(['A', 'B', 'C'], [path('A', 'B'), path('B', 'A'), path('B', 'C')]);
assert.deepEqual(oneWay.validation.unreachableEdgeIds, ['B-C']);
assert.equal(oneWay.edgeStatus.get('B-C'), 'unreachable');
assert.deepEqual(oneWay.validation.isolatedWaypointIds, []);
assert.equal(connectivityCopy(oneWay.validation).detail, '1 条路径无法往返（黄色）');

// A return trip may use other directed edges, or an explicitly bidirectional path.
for (const result of [
  inspect(['A', 'B', 'C'], [path('A', 'B'), path('B', 'C'), path('C', 'A')]),
  inspect(['A', 'B'], [path('A', 'B', false)]),
]) {
  assert.equal(result.validation.status, 'connected');
  assert.equal(result.validation.unreachableCount, 0);
  assert.ok([...result.edgeStatus.values()].every((status) => status === 'connected'));
}

const invalid = inspect(['A', 'B'], [path('A', 'B', false), path('B', 'missing'), path('missing', 'missing')]);
assert.equal(invalid.validation.status, 'partial');
assert.deepEqual(invalid.validation.invalidEdgeIds, ['B-missing', 'missing-missing']);
assert.equal(invalid.edgeStatus.get('missing-missing'), 'unreachable');
assert.equal(connectivityCopy(invalid.validation).detail, '2 条路径端点缺失，无法显示');
assert.equal(inspect(['A'], []).validation.status, 'connected');
assert.equal(inspect([], []).stronglyConnected, false);
assert.equal(connectivityCopy({ status: 'idle' }).title, '等待连通性检测');
console.log('Connectivity diagnostics passed: isolated points, disconnected networks, directed/bidirectional routes, invalid endpoints.');
