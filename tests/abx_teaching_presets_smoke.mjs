import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { strFromU8, unzipSync } from 'fflate';
import { abxTeachingNeedsRobot, buildAbxTeachingArchive, buildAbxTeachingExport } from "../src/features/teaching/model/abxTeachingExport.js";
import { parseAbxTeachingTask, readAbxTeachingFile } from "../src/features/teaching/model/abxTeachingImport.js";
import { buildIndependentMapTeachingExport } from "../src/features/workspace/model/independentTeachingExport.js";
import { abxTeachingPresetFixture } from './abx_teaching_helpers.mjs';
import { independentTeachingExportFixture } from './independent_teaching_export_helpers.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (data) => JSON.parse(strFromU8(data));
const { payload, robotPackage, model, stamp, values } = abxTeachingPresetFixture();
const before = JSON.stringify(payload);
const bundle = await buildAbxTeachingArchive(payload, { robotPackage });
const manifest = json(bundle.files['manifest.json']);
const tasks = await Promise.all(manifest.tasks.map((entry) => parseAbxTeachingTask(strFromU8(bundle.files[entry.file]))));
const basics = tasks[0].basics;
assert.equal(bundle.summary.basicPoseCount, 2, 'the shared library is counted once, even when repeated in each task');
assert.equal(bundle.summary.poseCount, 3, 'presets must not become executable task steps');
assert.equal(tasks[0].points.length, 5);
assert.equal(tasks[1].points.length, 0);
assert.deepEqual(basics.map((basic) => basic.name), ['准备姿态', '未插入任务的预设']);
assert.deepEqual(tasks[1].basics, basics, 'an empty task also carries its robot presets');
assert.equal(abxTeachingNeedsRobot(payload), true);
assert.equal(JSON.stringify(payload), before);
assert.deepEqual((await buildAbxTeachingArchive(payload, { robotPackage })).files, bundle.files, 'IDs and bytes are stable');
const consolePayload = structuredClone(payload);
consolePayload.virtualTeaching.jointPoses.forEach((pose) => {
  if (pose.joints.source === 'robot-preset') pose.joints.source = 'joint-console';
});
assert.deepEqual((await buildAbxTeachingArchive(consolePayload, { robotPackage })).files, bundle.files,
  'legacy console recordings export the same basic poses, units and robot bindings');
const reordered = structuredClone(payload);
reordered.virtualTeaching.jointPoses.reverse().forEach((preset, index) => { preset.sequence = index + 1; });
const reorderedBundle = await buildAbxTeachingArchive(reordered, { robotPackage });
const reorderedBasics = (await parseAbxTeachingTask(strFromU8(reorderedBundle.files[manifest.tasks[0].file]))).basics;
assert.deepEqual(reorderedBasics.map((basic) => basic.id), basics.map((basic) => basic.id).reverse());
for (const basic of reorderedBasics) {
  assert.deepEqual(basic.record, basics.find((original) => original.id === basic.id).record,
    'library order changes must not create different template content on the robot');
}

// Field sets and library ordering from the supplied teaching-tasks.zip. Its
// v25 library records also fit the existing v23 exchange format (basic_pose
// has been supported since v14), so older deployments remain compatible.
const keys = (value) => Object.keys(value).sort();
const basicFields = 'type id name created_ns updated_ns record seq'.split(' ').sort();
const recordFields = 'captured_ns robot_model robot_sequence robot_received_ns joints_rad'.split(' ').sort();
for (const basic of basics) {
  assert.deepEqual(keys(basic), basicFields);
  assert.deepEqual(keys(basic.record), recordFields);
  assert.match(basic.id, /^[0-9a-f]{32}$/);
  assert.equal(basic.created_ns, String(BigInt(Date.parse(stamp)) * 1000000n));
  assert.equal(basic.record.robot_model, model);
  assert.deepEqual(Object.values(basic.record.joints_rad).map((group) => group.length), [2, 4, 7, 7]);
  assert.equal(basic.record.joints_rad.head[0], values.head_yaw_J * Math.PI / 180);
  assert.ok(Math.abs(basic.record.joints_rad.torso[1] - values.knee_pitch_J * Math.PI / 180) < 1e-14);
  assert.ok(Math.abs(basic.record.joints_rad.left_arm[6] - values.left_J7 * Math.PI / 180) < 1e-14);
  assert.ok(Math.abs(basic.record.joints_rad.right_arm[0] - values.right_J1 * Math.PI / 180) < 1e-14);
}
assert.deepEqual(basics.map((basic) => basic.seq), ['1', '2']);
for (const entry of manifest.tasks) {
  const lines = strFromU8(bundle.files[entry.file]).trimEnd().split('\n');
  const records = lines.map(JSON.parse);
  assert.equal(entry.basic_pose_count, '2');
  assert.equal(records[0].basic_pose_count, '2');
  assert.equal(records.at(-1).basic_pose_count, '2');
  assert.equal(records.at(-1).sha256, hash(lines.slice(1, -1).map((line) => line + '\n').join('')));
  const lastBasic = records.findLastIndex((record) => record.type === 'basic_pose');
  const navigationIndex = records.findIndex((record) => record.type === 'navigation_chunk');
  assert.ok(navigationIndex === -1 || lastBasic < navigationIndex);
}

// Inspect customer reference data only when present; never require it in CI
// or add the supplied ZIP to version control.
let reference;
try { reference = await readFile('teaching-tasks.zip'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (reference) {
  const files = unzipSync(reference), entries = json(files['manifest.json']).tasks;
  const original = entries.flatMap((entry) => strFromU8(files[entry.file]).trim().split('\n').map(JSON.parse))
    .find((record) => record.type === 'basic_pose');
  assert.ok(original, 'reference must include a basic_pose example');
  assert.deepEqual(keys(original), keys(basics[0]));
  assert.deepEqual(keys(original.record), keys(basics[0].record));
  assert.deepEqual(keys(original.record.joints_rad), keys(basics[0].record.joints_rad));
  assert.equal(hash(await readFile('teaching-tasks.zip')), hash(reference));
  console.log('Supplied teaching-tasks.zip basic_pose fields verified; reference ZIP unchanged');
}

// A native task keeps its original library and all actions. Re-exporting a
// local preset already carried by that task reuses the same library ID.
const imported = await readAbxTeachingFile(new File([bundle.bytes], 'with-presets.zip'),
  { robot: payload.robot, robotModel: model });
const native = { ...payload, abxRoutes: imported.abxRoutes, waypoints: imported.waypoints, paths: imported.edges,
  virtualTeaching: { tasks: imported.tasks.slice(0, 1), jointPoses: imported.jointPoses } };
assert.equal(abxTeachingNeedsRobot(native), false);
const nativeBundle = await buildAbxTeachingArchive(native);
const nativeEntry = json(nativeBundle.files['manifest.json']).tasks[0];
assert.deepEqual(nativeBundle.files[nativeEntry.file], bundle.files[manifest.tasks[0].file]);
native.virtualTeaching.jointPoses.push(...structuredClone(payload.virtualTeaching.jointPoses));
const localPreset = native.virtualTeaching.jointPoses.find((preset) => preset.id === 'preset-ready');
localPreset.name = '准备姿态 · 已编辑';
localPreset.joints.values.head_yaw_J = 35;
localPreset.updatedAt = '2026-10-22T01:02:03.456Z';
const changed = await buildAbxTeachingArchive(native);
const changedEntry = json(changed.files['manifest.json']).tasks[0];
const changedTask = await parseAbxTeachingTask(strFromU8(changed.files[changedEntry.file]));
assert.equal(changedTask.basics.length, 2, 'do not duplicate an already embedded preset');
assert.equal(changedTask.basics[0].id, basics[0].id);
assert.equal(changedTask.basics[0].name, localPreset.name);
assert.ok(Math.abs(changedTask.basics[0].record.joints_rad.head[0] - 35 * Math.PI / 180) < 1e-14);
assert.notEqual(changedTask.basics[0].updated_ns, basics[0].updated_ns);
const actions = (task) => task.lines.filter((line) => JSON.parse(line).type !== 'basic_pose');
assert.deepEqual(actions(changedTask), actions(tasks[0]), 'all task actions and navigation stay untouched');
const mixedLibrary = structuredClone(native);
const otherBasic = { ...structuredClone(basics[0]), id: 'c'.repeat(32), name: '原生库中的其他机器人', seq: '3' };
otherBasic.record.robot_model = 'another_robot';
const source = mixedLibrary.virtualTeaching.tasks[0].abx;
source.lines.splice(source.lines.findIndex((raw) => JSON.parse(raw).type === 'navigation_chunk'), 0, JSON.stringify(otherBasic));
source.header.basic_pose_count = '3';
const mixedBundle = await buildAbxTeachingArchive(mixedLibrary);
const mixedEntry = json(mixedBundle.files['manifest.json']).tasks[0];
const mixedBasics = (await parseAbxTeachingTask(strFromU8(mixedBundle.files[mixedEntry.file]))).basics;
assert.equal(mixedBasics.length, 3);
assert.deepEqual(mixedBasics[2], otherBasic, 'an unrelated native library template stays intact');

// Legacy tasks gain library support without changing parking/action records.
const noPresets = structuredClone(payload);
noPresets.virtualTeaching.jointPoses = [];
const legacy = await buildAbxTeachingArchive(noPresets, { robotPackage, taskVersion: 11 });
const importedLegacy = await readAbxTeachingFile(new File([legacy.bytes], 'legacy.zip'), { robot: payload.robot, robotModel: model });
const legacyPayload = { ...payload, waypoints: [], paths: [], virtualTeaching: {
  tasks: importedLegacy.tasks.slice(0, 1), jointPoses: payload.virtualTeaching.jointPoses } };
const withLibrary = await buildAbxTeachingArchive(legacyPayload);
const upgradedEntry = json(withLibrary.files['manifest.json']).tasks[0];
const upgraded = await parseAbxTeachingTask(strFromU8(withLibrary.files[upgradedEntry.file]));
assert.equal(upgraded.header.version, 23);
assert.equal(upgraded.header.navigation, null);
assert.deepEqual(upgraded.lines.filter((line) => JSON.parse(line).type !== 'basic_pose'), importedLegacy.tasks[0].abx.lines);
await assert.rejects(buildAbxTeachingArchive(payload, { robotPackage, taskVersion: 11 }), /basic_pose/);

// Presets also travel through the independent -> map ZIP path. They keep
// local joint targets and do not pick up the map workspace's other presets.
const independent = independentTeachingExportFixture();
independent.local.config.config.project.virtualTeaching.jointPoses = structuredClone(payload.virtualTeaching.jointPoses);
independent.map.config.config.project.virtualTeaching.jointPoses = [{ ...payload.virtualTeaching.jointPoses[0], id: 'map-only', name: '地图预设' }];
const mapped = buildIndependentMapTeachingExport(independent.local.config.config.project, independent.local.map, independent.map.config);
const mappedBundle = await buildAbxTeachingArchive(mapped, { robotPackage });
const mappedEntry = json(mappedBundle.files['manifest.json']).tasks[0];
assert.deepEqual((await parseAbxTeachingTask(strFromU8(mappedBundle.files[mappedEntry.file]))).basics, basics);

const empty = structuredClone(payload);
empty.virtualTeaching.tasks = [empty.virtualTeaching.tasks[1]];
assert.equal(abxTeachingNeedsRobot(empty), true);
assert.equal((await buildAbxTeachingArchive(empty, { robotPackage })).summary.basicPoseCount, 2);
await assert.rejects(buildAbxTeachingArchive(empty), /预设姿态.*URDF/);
assert.equal((await buildAbxTeachingArchive(noPresets, { robotPackage })).summary.basicPoseCount, 0);
for (const [mutate, pattern] of [
  [(preset) => { delete preset.joints.values.head_yaw_J; }, /准备姿态.*head_yaw_J/],
  [(preset) => { preset.joints.angularUnit = 'unknown'; }, /角度单位/],
  [(preset) => { preset.joints.values.left_J1 = Infinity; }, /left_J1.*有限数值/],
  [(preset) => { preset.joints.values.gripper = 1; }, /无法表达.*gripper/],
  [(preset) => { preset.createdAt = 'invalid'; }, /预设姿态.*时间无效/],
]) {
  const invalid = structuredClone(payload);
  mutate(invalid.virtualTeaching.jointPoses[0]);
  const blocked = await buildAbxTeachingExport(invalid, { robotPackage });
  assert.equal(blocked.summary.status, 'blocked');
  assert.match(blocked.summary.message, pattern);
  assert.ok(Object.keys(blocked.files).every((name) => !name.endsWith('.ndjson')), 'invalid presets block the whole export');
}
console.log('Preset library export: matching robots, unused presets, units, IDs/counts/hash, native/legacy tasks and independent export passed');

if (process.env.ABX_BRAIN_ROOT) {
  const folder = await mkdtemp(path.join(tmpdir(), 'atlas-abx-presets-'));
  try {
    await writeFile(path.join(folder, 'presets.zip'), bundle.bytes);
    const result = spawnSync(process.env.PYTHON || 'python3', ['-B', 'tests/abx_teaching_presets_contract.py',
      folder, process.env.ABX_BRAIN_ROOT], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    process.stdout.write(result.stdout);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
