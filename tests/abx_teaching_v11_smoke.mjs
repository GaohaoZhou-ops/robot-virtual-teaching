import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { buildAbxTeachingArchive, buildAbxTeachingExport } from '../src/lib/abxTeachingExport.js';
import { parseAbxTeachingTask, readAbxTeachingFile } from '../src/lib/abxTeachingImport.js';
import { abxRouteToProject } from '../src/lib/abxRoute.js';
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';

// Exact field sets observed in 380B平地巡检.zip; independent of the serializer.
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort());
const hash = (data) => createHash('sha256').update(data).digest('hex');
const parse = (data) => JSON.parse(strFromU8(data));
function verifyBundle(bundle) {
  const files = unzipSync(bundle.bytes), manifest = parse(files['manifest.json']);
  keys(manifest, 'schema version exported_utc include_images tasks images pending_captures');
  assert.equal(manifest.schema, 'abx-teaching-export');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.include_images, false);
  assert.deepEqual(manifest.images, []);
  assert.equal(manifest.pending_captures, 0);
  assert.deepEqual(Object.keys(files).sort(), ['manifest.json', 'README.txt', ...manifest.tasks.map((task) => task.file)].sort());
  assert.match(strFromU8(files['README.txt']), /拍照步骤是配置/);
  for (const entry of manifest.tasks) {
    keys(entry, 'id name created_ns updated_ns point_count parking_count file image_count');
    assert.match(entry.id, /^[0-9a-f]{32}$/);
    assert.equal(entry.file, `tasks/${entry.id}.abxteach.ndjson`);
    assert.equal(entry.image_count, 0);
    for (const key of ['created_ns', 'updated_ns', 'point_count', 'parking_count']) assert.match(entry[key], /^\d+$/);
    const raw = strFromU8(files[entry.file]);
    assert.ok(raw.endsWith('\n'));
    const lines = raw.trimEnd().split('\n'), records = lines.map(JSON.parse);
    const header = records[0], footer = records.at(-1);
    keys(header, 'type version name created_ns point_count joint_order units parking_count');
    keys(footer, 'type point_count parking_count sha256');
    assert.equal(header.type, 'abx-teaching-task');
    assert.equal(header.version, 11);
    assert.equal(header.name, entry.name);
    assert.equal(header.created_ns, entry.created_ns);
    assert.deepEqual(header.units, { joints: 'rad', position: 'm' });
    assert.deepEqual(header.joint_order, { head: ['yaw', 'pitch'],
      torso: ['ankle_pitch', 'knee_pitch', 'waist_pitch', 'waist_yaw'],
      left_arm: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7'],
      right_arm: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7'] });
    assert.equal(footer.type, 'end');
    const parkings = records.filter((record) => record.type === 'parking');
    const points = records.filter((record) => record.type === 'point');
    assert.equal(records.length, parkings.length + points.length + 2);
    assert.deepEqual(records.slice(1, -1), [...parkings, ...points]);
    for (const [name, count] of [['parking_count', parkings.length], ['point_count', points.length]]) {
      assert.equal(header[name], String(count));
      assert.equal(footer[name], String(count));
      assert.equal(entry[name], String(count));
    }
    assert.equal(footer.sha256, hash(lines.slice(1, -1).map((line) => line + '\n').join('')));
    parkings.forEach((parking, i) => {
      keys(parking, 'type id seq name created_ns point_count location');
      assert.match(parking.id, /^[0-9a-f]{32}$/);
      assert.equal(parking.seq, String(i + 1));
      const group = points.filter((point) => point.parking_id === parking.id);
      assert.equal(parking.point_count, String(group.length));
      assert.deepEqual(group.map((point) => point.parking_seq), group.map((_, j) => String(j + 1)));
    });
    points.forEach((point, i) => {
      keys(point, 'type seq label record parking_id parking_seq action');
      assert.equal(point.seq, String(i + 1));
      keys(point.action, 'id name');
      assert.match(point.action.id, /^[0-9a-f]{32}$/);
      assert.ok(point.action.name);
      const record = point.record;
      if (record.joints_rad) {
        keys(record, 'captured_ns robot_model robot_sequence robot_received_ns joints_rad');
        assert.deepEqual(Object.values(record.joints_rad).map((values) => values.length), [2, 4, 7, 7]);
        assert.ok(Object.values(record.joints_rad).flat().every(Number.isFinite));
      } else if (record.type === 'route_navigation') {
        keys(record, 'type node_id');
        assert.match(record.node_id, /^N\d+$/);
      } else {
        assert.equal(record.type, 'zivid_capture');
        keys(record, 'type sides formats wait_ms count interval_ms');
      }
    });
  }
  return { files, manifest };
}
const asPayload = (imported) => ({ teachingSpace: { mode: 'map' }, abxRoutes: imported.abxRoutes,
  waypoints: imported.waypoints, paths: imported.edges,
  virtualTeaching: { tasks: imported.tasks, jointPoses: imported.jointPoses } });
const { payload, robotPackage } = abxTeachingFixture();
const before = JSON.stringify(payload);
const bundle = await buildAbxTeachingArchive(payload, { robotPackage });
const { files, manifest } = verifyBundle(bundle);
assert.equal(JSON.stringify(payload), before, 'export must not modify map coordinates or teaching data');
const parsed = await parseAbxTeachingTask(strFromU8(files[manifest.tasks[0].file]));
assert.deepEqual(parsed.points.map((point) => point.record.type || 'pose'),
  ['route_navigation', 'pose', 'pose', 'route_navigation', 'pose']);
assert.deepEqual(parsed.points.filter((point) => point.record.joints_rad).map((point) => point.label),
  ['姿态 a1', '姿态 a2', '姿态 b1']);
assert.ok(Math.abs(parsed.points[1].record.joints_rad.head[0] - 20 * Math.PI / 180) < 1e-14);
assert.equal(parsed.points[0].action.id, parsed.points[3].action.id, 'navigation shares an action definition');
assert.equal(bundle.navigation.routeImportIncluded, false);
assert.equal(bundle.navigation.taskVersion, 11);
assert.deepEqual(parse(bundle.navigationBytes), bundle.navigation);
assert.deepEqual((await buildAbxTeachingArchive(payload, { robotPackage })).files, files);
const again = await readAbxTeachingFile(new File([bundle.bytes], 'virtual.zip'));
verifyBundle(await buildAbxTeachingArchive(asPayload(again)));

// Sparse native station IDs, including N0, must survive without renumbering.
const sparse = structuredClone(payload);
const route = { schema_version: 1, id: '380B-route', name: '原机器人路网', scene_name: '现场',
  nodes: [{ id: 0, label: '起点', x_m: 1.25, y_m: -2.5, yaw_rad: Math.PI / 2 },
    { id: 42, label: '终点', x_m: 4.5, y_m: 6.75, yaw_rad: -Math.PI }],
  edges: [{ id: 9, start: 0, end: 42 }] };
const graph = abxRouteToProject(route);
Object.assign(sparse, graph, { paths: graph.edges });
const sparseBefore = JSON.stringify(sparse);
const sparseBundle = await buildAbxTeachingArchive(sparse, { robotPackage });
verifyBundle(sparseBundle);
assert.deepEqual(sparseBundle.navigation.tasks[0].sequence.filter((step) => step.type === 'route_navigation')
  .map((step) => step.nodeId), ['N0', 'N42']);
assert.equal(JSON.stringify(sparse), sparseBefore);

// Build a tiny, non-customer native fixture with navigation, Pose and capture.
const source = await buildAbxTeachingExport(payload, { robotPackage });
const sourceManifest = parse(source.files['abx/manifest.json']);
const sourceTask = await parseAbxTeachingTask(strFromU8(source.files[`abx/${sourceManifest.tasks[0].file}`]));
const cameraRows = sourceTask.lines.map((line) => {
  const value = JSON.parse(line);
  if (value.type === 'point' && value.seq === '3') value.record = {
    type: 'zivid_capture', sides: ['left', 'right'], formats: ['png', 'exr'], wait_ms: 0, count: 1, interval_ms: 0 };
  return value;
});
const nativeFile = (header, rows) => {
  const body = rows.map((row) => JSON.stringify(row) + '\n').join('');
  const counts = Object.fromEntries(['point_count', 'parking_count', 'basic_pose_count']
    .filter((key) => header[key] !== undefined).map((key) => [key, header[key]]));
  return new File([JSON.stringify(header) + '\n' + body
    + JSON.stringify({ type: 'end', ...counts, sha256: hash(body) }) + '\n'], 'native.abxteach.ndjson');
};
const withCamera = await readAbxTeachingFile(nativeFile(sourceTask.header, cameraRows));
const cameraBundle = await buildAbxTeachingArchive(asPayload(withCamera));
const cameraVerified = verifyBundle(cameraBundle);
const cameraTask = await parseAbxTeachingTask(strFromU8(cameraVerified.files[cameraVerified.manifest.tasks[0].file]));
assert.deepEqual(cameraTask.points[2].record, cameraRows.find((row) => row.type === 'point' && row.seq === '3').record);
assert.equal(cameraTask.points[2].action.name, 'Zivid 拍照');
assert.equal(cameraTask.points.length, 5, 'preserve capture order and total step count');
for (const record of [
  { ...sourceTask.points[1].record, component: 'left_arm' },
  { type: 'wait', duration_ms: 100 },
  { type: 'parallel', actions: [] },
  { type: 'zivid_capture', sides: ['left'], formats: ['ply'], wait_ms: 0, count: 1, interval_ms: 0 },
]) {
  const rows = structuredClone(cameraRows);
  rows.find((row) => row.type === 'point' && row.seq === '2').record = record;
  const imported = await readAbxTeachingFile(nativeFile(sourceTask.header, rows));
  await assert.rejects(buildAbxTeachingArchive(asPayload(imported)), /v11/);
}
const withBasic = structuredClone(cameraRows);
withBasic.splice(withBasic.findIndex((row) => row.type === 'navigation_chunk'), 0, {
  type: 'basic_pose', id: 'a'.repeat(32), seq: '1', name: '模板',
  created_ns: sourceTask.header.created_ns, updated_ns: sourceTask.header.created_ns, record: sourceTask.points[1].record });
const importedBasic = await readAbxTeachingFile(nativeFile({ ...sourceTask.header, basic_pose_count: '1' }, withBasic));
await assert.rejects(buildAbxTeachingArchive(asPayload(importedBasic)), /basic_pose/);
await assert.rejects(buildAbxTeachingArchive({ ...payload, teachingSpace: { mode: 'independent' } }, { robotPackage }), /转换到地图/);
await assert.rejects(buildAbxTeachingArchive({ ...payload, virtualTeaching: { tasks: [] } }), /1–100/);
const incomplete = structuredClone(payload);
delete incomplete.virtualTeaching.tasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.head_yaw_J;
await assert.rejects(buildAbxTeachingArchive(incomplete, { robotPackage }), /head_yaw_J/);

// Use the supplied robot file when available, without adding customer data to
// source control. All 39 steps (including capture settings) must round-trip.
const referencePath = process.env.ABX_V11_REFERENCE || '380B平地巡检.zip';
let reference;
try { reference = await readFile(referencePath); } catch (error) {
  if (error.code !== 'ENOENT' || process.env.ABX_V11_REFERENCE) throw error;
}
if (reference) {
  const referenceFiles = unzipSync(reference), referenceManifest = parse(referenceFiles['manifest.json']);
  const imported = await readAbxTeachingFile(new File([reference], 'reference.zip'));
  const referencePayload = asPayload(imported), referenceBefore = JSON.stringify(referencePayload);
  const output = await buildAbxTeachingArchive(referencePayload);
  const checked = verifyBundle(output);
  for (const [index, task] of referenceManifest.tasks.entries()) {
    assert.deepEqual(checked.files[checked.manifest.tasks[index].file], referenceFiles[task.file],
      'actual robot NDJSON, action IDs, camera settings, nanoseconds and SHA-256 must remain byte-for-byte identical');
  }
  assert.equal(JSON.stringify(referencePayload), referenceBefore);
  assert.equal(hash(await readFile(referencePath)), hash(reference), 'reference ZIP remains unchanged');
  assert.equal(output.navigation.tasks[0].sequence.filter((step) => step.type === 'route_navigation').length, 8);
  console.log('380B reference: all 39 steps, 8 parkings, 19 poses, 12 captures and 8 navigation actions preserved byte-for-byte');
} else console.log('380B reference ZIP absent; synthetic v11 contract checks completed');
console.log('ABX v11 ZIP fields, checksums, route IDs, action metadata, unit conversion, native round-trip and incompatible-record rejection passed');
