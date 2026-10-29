import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { strFromU8, unzipSync } from 'fflate';
import { abxRouteToProject, readAbxRoute } from "../src/features/navigation/model/abxRoute.js";
import { buildAbxTeachingArchive } from "../src/features/teaching/model/abxTeachingExport.js";
import { parseAbxTeachingTask, readAbxTeachingFile } from "../src/features/teaching/model/abxTeachingImport.js";
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.parse(strFromU8(value));
const asPayload = (imported) => ({ teachingSpace: { mode: 'map' }, abxRoutes: imported.abxRoutes,
  waypoints: imported.waypoints, paths: imported.edges,
  virtualTeaching: { tasks: imported.tasks, jointPoses: imported.jointPoses } });
const withRoute = (payload, route) => {
  const graph = abxRouteToProject(route);
  return { ...payload, ...graph, paths: graph.edges };
};
const taskIn = async (bundle, index = 0) => {
  const manifest = json(bundle.files['manifest.json']);
  return parseAbxTeachingTask(strFromU8(bundle.files[manifest.tasks[index].file]));
};
const { payload, robotPackage } = abxTeachingFixture();
const route = { schema_version: 1, id: 'original-route', name: '原始路网', scene_name: 'big_map_1',
  nodes: [{ id: 0, label: '停车点1', x_m: 1.25, y_m: -2.5, yaw_rad: Math.PI / 2 },
    { id: 42, label: '停车点1', x_m: 4.5, y_m: 6.75, yaw_rad: -Math.PI },
    { id: 88, label: '中间节点', x_m: 2, y_m: 3, yaw_rad: null }],
  edges: [{ id: 9, start: 0, end: 88 }, { id: 10, start: 88, end: 42 }, { id: 11, start: 42, end: 0 }] };
const current = withRoute(payload, route), before = JSON.stringify(current);
const bundle = await buildAbxTeachingArchive(current, { robotPackage });
assert.equal(JSON.stringify(current), before, 'export must leave the current project untouched');
assert.equal(bundle.summary.routeImportIncluded, true);
assert.equal(bundle.summary.routeCount, 1);
assert.equal(bundle.summary.nodeCount, 3);
assert.equal(bundle.summary.edgeCount, 3);
assert.equal(bundle.navigation.taskVersion, 23);
assert.deepEqual(json(bundle.navigationBytes), bundle.navigation);
assert.ok(!Object.keys(bundle.files).some((name) => name.startsWith('abx/')));
const manifest = json(bundle.files['manifest.json']);
const parsed = await taskIn(bundle);
assert.equal(parsed.header.version, 23);
assert.deepEqual(parsed.navigation.routes, [route]);
assert.deepEqual(json(bundle.files[manifest.tasks[0].navigation.routes[0]]), route);
assert.deepEqual(parsed.points.filter((point) => point.record.type === 'route_navigation')
  .map((point) => [point.record.route_id, point.record.node_id]), [[route.id, 'N0'], [route.id, 'N42']]);
assert.deepEqual((await readAbxTeachingFile(new File([bundle.bytes], 'with-route.zip'))).abxRoutes, [route]);

// A v11 source gains only a navigation context and the required version/count
// metadata. Parking/Pose/capture/action records stay byte-for-byte intact.
const legacy = await buildAbxTeachingArchive(current, { robotPackage, taskVersion: 11 });
const importedLegacy = asPayload(await readAbxTeachingFile(new File([legacy.bytes], 'legacy.zip')));
const legacyTask = await taskIn(legacy);
const upgraded = await buildAbxTeachingArchive(withRoute(importedLegacy, route));
const upgradedTask = await taskIn(upgraded);
assert.equal(upgradedTask.header.version, 23);
assert.equal(upgradedTask.navigation.default_route_id, route.id);
assert.deepEqual(upgradedTask.lines.filter((line) => JSON.parse(line).type !== 'navigation_chunk'), legacyTask.lines);
assert.deepEqual(upgradedTask.navigation.routes, [route]);
const withoutRoute = await buildAbxTeachingArchive(importedLegacy);
assert.deepEqual((await taskIn(withoutRoute)).lines, legacyTask.lines);
assert.deepEqual((await taskIn(withoutRoute)).header, legacyTask.header);
assert.equal(withoutRoute.navigation.routeImportIncluded, false);
assert.equal(withoutRoute.navigation.tasks[0].sequence.filter((step) => step.type === 'route_navigation').length, 2);
assert.match(withoutRoute.summary.warnings.join('\n'), /未导入对应路网/);
const missingNode = structuredClone(route);
missingNode.nodes = missingNode.nodes.filter((node) => node.id !== 42);
missingNode.edges = missingNode.edges.filter((edge) => edge.start !== 42 && edge.end !== 42);
await assert.rejects(buildAbxTeachingArchive(withRoute(importedLegacy, missingNode)), /N42.*不在已导入路网/);
const ambiguous = withRoute(importedLegacy, route);
ambiguous.abxRoutes.push({ ...structuredClone(route), id: 'another-route' });
await assert.rejects(buildAbxTeachingArchive(ambiguous), /多个路网/);

// Newer native actions are preserved by the default export, never reduced to
// the older camera/pose-only exchange format.
const rows = parsed.lines.map(JSON.parse);
rows.find((value) => value.type === 'point' && value.seq === '3').record = { type: 'wait', duration_ms: 120 };
const body = rows.map((row) => JSON.stringify(row) + '\n').join('');
const raw = JSON.stringify(parsed.header) + '\n' + body + JSON.stringify({ type: 'end',
  point_count: parsed.header.point_count, parking_count: parsed.header.parking_count,
  basic_pose_count: parsed.header.basic_pose_count, sha256: hash(body) }) + '\n';
const advanced = await buildAbxTeachingArchive(asPayload(await readAbxTeachingFile(new File([raw], 'advanced.abxteach.ndjson'))));
assert.deepEqual((await taskIn(advanced)).lines, rows.map(JSON.stringify));

const fixtures = [bundle, upgraded, advanced];
const referencePath = process.env.ABX_V11_REFERENCE || '380B平地巡检.zip';
const routePath = process.env.ABX_ROUTE_REFERENCE || '1019平地路网终版测试.json';
if (existsSync(referencePath) && existsSync(routePath)) {
  const referenceBytes = await readFile(referencePath), routeBytes = await readFile(routePath);
  const referenceRoute = readAbxRoute(routeBytes.toString('utf8'));
  const referenceFiles = unzipSync(referenceBytes), referenceManifest = json(referenceFiles['manifest.json']);
  const source = asPayload(await readAbxTeachingFile(new File([referenceBytes], '380B.zip')));
  const referenceBundle = await buildAbxTeachingArchive(source);
  const exported = await taskIn(referenceBundle);
  const original = await parseAbxTeachingTask(strFromU8(referenceFiles[referenceManifest.tasks[0].file]));
  assert.deepEqual(exported.lines, original.lines);
  assert.deepEqual(exported.header, original.header);
  await assert.rejects(buildAbxTeachingArchive(withRoute(source, referenceRoute)), /N10.*不在已导入路网/);
  const routeFixture = withRoute(structuredClone(payload), referenceRoute);
  for (const [index, parking] of routeFixture.virtualTeaching.tasks[0].parkingPoints.entries()) {
    const node = referenceRoute.nodes.find((node) => node.id === [1, 31][index]);
    const pose = { frameId: 'map', position: { x: node.x_m, y: node.y_m, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: node.yaw_rad * 180 / Math.PI } };
    parking.name = `N${node.id}`; parking.mapPose = pose;
    for (const point of parking.poses) point.mapPose = pose;
  }
  const routeBundle = await buildAbxTeachingArchive(routeFixture, { robotPackage });
  assert.deepEqual((await taskIn(routeBundle)).navigation.routes, [referenceRoute]);
  assert.equal(routeBundle.summary.nodeCount, 40);
  assert.equal(routeBundle.summary.edgeCount, 92);
  assert.equal(hash(await readFile(referencePath)), hash(referenceBytes));
  assert.equal(hash(await readFile(routePath)), hash(routeBytes));
  fixtures.push(referenceBundle, routeBundle);
  console.log(`380B: 39 original steps unchanged; mismatched N10/N11 rejected. ${routePath}: all 40 nodes / 92 edges / big_map_1 embedded`);
}

const sourceZip = process.env.ABX_WORKSPACE_ZIP || (existsSync('ABXBrainSystem.zip') ? 'ABXBrainSystem.zip' : null);
if (sourceZip || process.env.ABX_BRAIN_ROOT) {
  const directory = await mkdtemp(path.join(tmpdir(), 'atlas-abx-bundle-'));
  const originalHash = sourceZip && hash(await readFile(sourceZip));
  try {
    const brain = process.env.ABX_BRAIN_ROOT || path.join(directory, 'brain');
    const python = (...args) => {
      const result = spawnSync(process.env.PYTHON || 'python3', ['-B', ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
      process.stdout.write(result.stdout);
    };
    if (!process.env.ABX_BRAIN_ROOT) python('tests/abx_teaching_reference.py', sourceZip, brain);
    const context = { window: {}, TextDecoder, ReadableStream };
    vm.runInNewContext(await readFile(path.join(brain, 'web/teaching-import.js'), 'utf8'), context);
    for (const [index, fixture] of fixtures.entries()) {
      const opened = await context.window.ABXTeachingImport.open(fixture.blob);
      assert.equal(opened.tasks.length, json(fixture.files['manifest.json']).tasks.length);
      for (const entry of opened.tasks) assert.equal(await new Response(entry.file.stream()).text(), strFromU8(fixture.files[entry.file.name]));
      await writeFile(path.join(directory, `${index}.zip`), fixture.bytes);
    }
    python('tests/abx_teaching_bundle_contract.py', directory, brain);
    if (sourceZip) assert.equal(hash(await readFile(sourceZip)), originalHash, 'robot source ZIP is unchanged');
  } finally { await rm(directory, { recursive: true, force: true }); }
} else console.log('Robot source absent; native importer contract skipped (set ABX_WORKSPACE_ZIP or ABX_BRAIN_ROOT)');
console.log('Native task/route bundle, old-task upgrade, lossless actions and ambiguous/missing route rejection passed');
