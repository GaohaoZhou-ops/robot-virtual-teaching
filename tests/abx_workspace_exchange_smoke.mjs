import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, zipSync } from 'fflate';
import { abxRouteToProject, buildAbxRouteDocuments, readAbxRoute, validateAbxRoute } from "../src/features/navigation/model/abxRoute.js";
import { readAbxTeachingFile, parseAbxTeachingTask, mergeAbxImport } from "../src/features/teaching/model/abxTeachingImport.js";
import { buildAbxTeachingExport } from "../src/features/teaching/model/abxTeachingExport.js";
import { buildExport, normalizeProject } from "../src/features/workspace/model/io.js";
import { buildTeachingWaypoints } from "../src/features/teaching/model/teachingNavigation.js";
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';

const workspace = path.resolve(process.env.ABX_WORKSPACE_ZIP || 'workspace.zip');
const hashFile = async (file) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const originalHash = await hashFile(workspace);
const folder = await mkdtemp(path.join(tmpdir(), 'atlas-abx-exchange-'));
const brain = path.join(folder, 'brain');
const python = process.env.PYTHON || 'python3';
const run = (...args) => {
  const result = spawnSync(python, ['-B', ...args], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  process.stdout.write(result.stdout);
};
const file = (bytes, name) => new File([bytes], name);
const rawTask = (header, lines) => {
  const body = lines.map((line) => JSON.stringify(line) + '\n').join('');
  const counts = Object.fromEntries(['point_count', 'parking_count', 'basic_pose_count'].map((key) => [key, header[key]]));
  return JSON.stringify(header) + '\n' + body + JSON.stringify({ type: 'end', ...counts,
    sha256: createHash('sha256').update(body).digest('hex') }) + '\n';
};
const nativePayload = (imported) => ({
  coordinateSystem: { frameId: 'map', angleUnit: 'degree', distanceUnit: 'meter' },
  teachingSpace: { mode: 'map' }, abxRoutes: imported.abxRoutes, waypoints: imported.waypoints, paths: imported.edges,
  virtualTeaching: { tasks: imported.tasks, jointPoses: imported.jointPoses },
});
// This v23 reader regression covers extended records preserved in project
// backups. The user-facing robot ZIP now targets v11 (test:abx-v11).
const buildExtendedArchive = async (payload, options) => {
  const result = await buildAbxTeachingExport(payload, options);
  if (result.summary.status !== 'ready') throw new Error(result.summary.message);
  const files = Object.fromEntries(Object.entries(result.files).map(([name, bytes]) => [name.slice(4), bytes]));
  return { ...result, files, bytes: zipSync(files, { level: 0 }) };
};
try {
  run('tests/abx_teaching_reference.py', workspace, brain);
  run('tests/abx_workspace_exchange_contract.py', 'fixtures', folder, brain, workspace);
  const deployed = await readFile(path.join(folder, 'deployed-teaching.zip'));
  const imported = await readAbxTeachingFile(file(deployed, 'robot.zip'));
  assert.ok(imported.tasks.length >= 1);
  assert.ok(imported.tasks.some((task) => task.abx.preservedStepCount > 0));
  assert.deepEqual(buildTeachingWaypoints([], imported.tasks), [], 'native stops must not invent graph nodes');
  const restored = normalizeProject(nativePayload(imported));
  const saved = buildExport({ mapData: null, heightRange: [0, 1], ...restored });
  const reloaded = normalizeProject(saved);
  assert.deepEqual(reloaded.abxRoutes, imported.abxRoutes, 'route identities survive save/restore');
  assert.deepEqual(reloaded.teachingTasks.map((task) => task.abx), imported.tasks.map((task) => task.abx));
  const roundtrip = await buildExtendedArchive(saved);
  await writeFile(path.join(folder, 'roundtrip.zip'), roundtrip.bytes);
  const again = await readAbxTeachingFile(file(roundtrip.bytes, 'again.zip'));
  for (let i = 0; i < imported.tasks.length; i += 1) {
    assert.deepEqual(again.tasks[i].abx.lines, imported.tasks[i].abx.lines, 'unmodified native body remains byte-for-byte identical');
    assert.deepEqual(again.tasks[i].abx.header, imported.tasks[i].abx.header);
  }
  const edited = structuredClone(saved);
  edited.virtualTeaching.tasks[0].name = '修改后的机器人任务';
  const pose = edited.virtualTeaching.tasks.flatMap((task) => task.parkingPoints).flatMap((p) => p.poses)[0];
  pose.name = '修改后的关节姿态';
  pose.fullBodyJoints.values.head_yaw_J += 1;
  if (edited.waypoints.length) edited.waypoints[0].pose.x += 0.05;
  const editedBundle = await buildExtendedArchive(edited);
  await writeFile(path.join(folder, 'edited.zip'), editedBundle.bytes);
  const changed = await readAbxTeachingFile(file(editedBundle.bytes, 'edited.zip'));
  assert.equal(changed.tasks[0].name, '修改后的机器人任务');
  const changedPose = changed.tasks.flatMap((task) => task.parkingPoints).flatMap((p) => p.poses).find((p) => p.name === pose.name);
  assert.ok(Math.abs(changedPose.fullBodyJoints.values.head_yaw_J - pose.fullBodyJoints.values.head_yaw_J) < 1e-10);
  const removed = structuredClone(saved);
  removed.virtualTeaching.tasks.find((task) => task.parkingPoints.some((p) => p.poses.length))
    .parkingPoints.find((p) => p.poses.length).poses.pop();
  await assert.rejects(buildExtendedArchive(removed), /步骤结构已改变/);
  const corrupt = unzipSync(deployed);
  const taskName = JSON.parse(new TextDecoder().decode(corrupt['manifest.json'])).tasks[0].file;
  const source = new TextDecoder().decode(corrupt[taskName]);
  await assert.rejects(parseAbxTeachingTask(source.replace(/"label"\s*:\s*"[^"]*"/, '"label":"tampered"')), /SHA-256/);
  await assert.rejects(parseAbxTeachingTask(source.split('\n').slice(0, -2).join('\n')), /结束标记/);
  await assert.rejects(parseAbxTeachingTask(source.replace('"version":23', '"version":24')), /版本/);
  const missing = { ...corrupt }; delete missing[taskName];
  await assert.rejects(readAbxTeachingFile(file(zipSync(missing), 'missing.zip')), /缺失/);
  await assert.rejects(parseAbxTeachingTask(source.replace('"type":', '"type":"duplicate","type":')), /重复字段/);

  const deployedRoute = readAbxRoute(await readFile(path.join(folder, 'deployed.route.json'), 'utf8'));
  const route = structuredClone(deployedRoute);
  // Explicitly test uint32 zero, empty labels, nullable yaw and IDs shared by
  // nodes and edges; these are all accepted by the deployed robot.
  route.nodes = [{ id: 0, label: '', x_m: 1, y_m: -2, yaw_rad: null },
    { id: 0xffffffff, label: '终点', x_m: 3, y_m: 4, yaw_rad: Math.PI }];
  route.edges = [{ id: 9, start: 0, end: 0xffffffff }, { id: 7, start: 0xffffffff, end: 0 }];
  const graph = abxRouteToProject(route);
  const routeProject = normalizeProject({ ...graph, paths: graph.edges });
  const routeSaved = buildExport({ ...routeProject, heightRange: [0, 1], teachingTasks: [] });
  const exportedRoutes = await buildAbxRouteDocuments(routeSaved);
  assert.deepEqual(exportedRoutes.routes, [route]);
  const duplicateKey = JSON.stringify(route).replace('"schema_version":1', '"schema_version":1,"schema_version":1');
  assert.throws(() => readAbxRoute(duplicateKey), /重复字段/);
  assert.throws(() => validateAbxRoute({ ...route, edges: [{ id: 0, start: 0, end: 0xffffffff }] }), /唯一/);
  assert.throws(() => validateAbxRoute({ ...route, edges: [{ id: 2, start: 0, end: 123 }] }), /不存在/);
  assert.throws(() => validateAbxRoute({ ...route, nodes: [{ ...route.nodes[0], yaw_rad: Math.PI + 0.1 }] }), /Yaw/);
  assert.throws(() => normalizeProject(route), /路径\/导航 → 导入路径/);
  assert.throws(() => mergeAbxImport({ abxRoutes: [route] }, { abxRoutes: [{ ...route, name: 'conflict' }] }), /冲突/);
  await mkdir(path.join(folder, 'route-exports'));
  await writeFile(path.join(folder, 'route-exports/nullable.route.json'), JSON.stringify(route));
  await writeFile(path.join(folder, 'route-exports/deployed.route.json'), JSON.stringify(deployedRoute));
  const { payload, robotPackage } = abxTeachingFixture();
  const bundle = await buildExtendedArchive(payload, { robotPackage });
  const manifest = JSON.parse(new TextDecoder().decode(bundle.files['manifest.json']));
  const values = new TextDecoder().decode(bundle.files[manifest.tasks[0].file]).trim().split('\n').map(JSON.parse);
  const poseLine = values.find((v) => v.record?.joints_rad);
  const parking = values.find((v) => v.type === 'parking');
  const header = { ...values[0], point_count: '6', parking_count: '1', basic_pose_count: '1', navigation: null };
  const frames = [[0, ...Array(20).fill(0.25)], [100, ...Array(20).fill(0.5)]];
  const trajectory = { type: 'recorded_trajectory', trajectory_id: 'b'.repeat(32), robot_model: poseLine.record.robot_model,
    frame_count: 2, duration_ms: 100, optimize: false, remove_stationary: false, raw_frames: true, agile: false,
    sha256: createHash('sha256').update(JSON.stringify(frames)).digest('hex') };
  const nativeLines = [{ ...parking, point_count: '6' },
    { ...poseLine, seq: '1', parking_seq: '1', record: { ...poseLine.record, component: 'left_arm' } },
    { ...poseLine, seq: '2', parking_seq: '2', label: '等待', record: { type: 'wait', duration_ms: 1200 } },
    { ...poseLine, seq: '3', parking_seq: '3', label: '定时', record: { type: 'wait_until', target_time: '2026-10-20T12:00:00' } },
    { ...poseLine, seq: '4', parking_seq: '4', label: '拍照', record: {
      type: 'zivid_capture', sides: ['left'], formats: ['ply'], wait_ms: 10, count: 2, interval_ms: 100 } },
    { ...poseLine, seq: '5', parking_seq: '5', label: '并行', record: {
      type: 'parallel', completion: 'all', result: 'success', designated_action_id: null, actions: [
        { id: 'c'.repeat(32), label: '左臂', component: 'left_arm', record: { ...poseLine.record, component: 'left_arm' } },
        { id: 'd'.repeat(32), label: '等待', component: 'auto', record: { type: 'wait', duration_ms: 200 } },
      ] } },
    { ...poseLine, seq: '6', parking_seq: '6', label: '录制轨迹', record: trajectory },
    { type: 'basic_pose', id: 'a'.repeat(32), seq: '1', name: '基础姿态', created_ns: header.created_ns,
      updated_ns: header.created_ns, record: poseLine.record },
    { type: 'trajectory', record: trajectory },
    { type: 'trajectory_chunk', trajectory_id: trajectory.trajectory_id, part: 0, frames }];
  const synthetic = await readAbxTeachingFile(file(rawTask(header, nativeLines), 'fixture.abxteach.ndjson'));
  assert.equal(synthetic.tasks[0].parkingPoints[0].abx.located, false);
  const syntheticBundle = await buildExtendedArchive(nativePayload(synthetic));
  await writeFile(path.join(folder, 'synthetic.zip'), syntheticBundle.bytes);
  run('tests/abx_workspace_exchange_contract.py', 'verify', folder, brain, workspace);
  assert.equal(await hashFile(workspace), originalHash, 'workspace.zip must remain byte-for-byte unchanged');
  console.log('ABX deployed teaching/route import, editing, persistence, checksum rejection and native round-trip passed; workspace.zip unchanged');
} finally {
  await rm(folder, { recursive: true, force: true });
}
