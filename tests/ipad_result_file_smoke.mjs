import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { packIPadModel, ipadResultTask } from '../src/lib/ipadTeaching.js';
import { MAX_RESULT_FILE_BYTES, readIPadResultFile } from '../src/lib/ipadResultFile.js';
import { buildExport, normalizeProject } from '../src/lib/io.js';
import { buildProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
const directory = await mkdtemp(path.join(tmpdir(), 'atlas-result-file-'));
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
geometry.setIndex([0, 1, 2]);
const map = { geometry, name: '测试工件.ply', mapId: 'result-file-test', sourceHash: 'original-file',
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } } };
const blob = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' });
try {
  const packed = await packIPadModel(map), fixture = path.join(directory, 'fixture');
  await writeFile(`${fixture}.json`, JSON.stringify(packed.manifest));
  await writeFile(`${fixture}.atls`, new Uint8Array(packed.buffer));
  const binary = path.join(directory, 'native-export-test'), exports = path.join(directory, 'exports');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
    'ipad/AtlasTeaching/LANClient.swift', 'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/Tests/ResultFileTests.swift', '-o', binary]);
  await run(binary, [fixture, path.join(directory, 'private'), exports]);
  const deletionBinary = path.join(directory, 'native-delete-test');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
    'ipad/AtlasTeaching/LANClient.swift', 'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/Tests/LocalProjectDeletionTests.swift', '-o', deletionBinary]);
  await run(deletionBinary, [fixture, path.join(directory, 'local-delete')]);
  const files = await readdir(exports);
  assert.equal(files.length, 1, 'retry creates no duplicate file');
  assert.match(files[0], /\.atlas-teaching\.json$/);
  const bytes = await readFile(path.join(exports, files[0]));
  const archive = JSON.parse(bytes.toString());
  assert.deepEqual(Object.keys(archive).sort(), ['format', 'manifest', 'result', 'version']);
  assert.ok(!bytes.includes('deviceToken') && !bytes.includes('serverURL') && !bytes.includes('ownerToken'));
  const { result, ticket } = await readIPadResultFile(new Blob([bytes]));
  const task = await ipadResultTask(result, ticket, map);
  assert.equal(task.mobileCapture.samples[0].name, 'Pose 001');
  assert.deepEqual(task.mobileCapture.samples.slice(1).map((sample) => sample.name),
    ['中', '🤖', '👨‍👩‍👧‍👦', 'e\u0301'].map((character) => character.repeat(80)),
    'names allowed by the native 80-Character limit survive without truncation or normalization');
  assert.deepEqual(task.mobileCapture, archive.result, 'every native field survives file import');
  const retried = await ipadResultTask(result, ticket, { ...map, name: 'renamed.ply', mapId: 'reopened', sourceHash: 'new-metadata' });
  assert.equal(task.id, retried.id, 'file and LAN imports share the same deduplication key');
  const different = geometry.clone(); different.getAttribute('position').setX(0, 42);
  await assert.rejects(ipadResultTask(result, ticket, { ...map, geometry: different }), /模型内容不一致/);
  different.dispose();
  for (const [mutate, expected] of [
    [(value) => { value.version = 2; }, /格式或版本/],
    [(value) => { value.manifest.distanceUnit = 'millimeter'; }, /模型清单/],
    [(value) => { value.manifest.byteLength += 1; }, /模型清单/],
    [(value) => { value.manifest.indices = -3; }, /模型清单/],
    [(value) => { value.manifest = null; }, /模型清单/],
    [(value) => { value.result.sessionId = '../../other'; }, /任务标识/],
    [(value) => { value.result.modelHash = '0'.repeat(64); }, /不匹配/],
    [(value) => { delete value.result.completedAt; }, /示教时间/],
    [(value) => { value.result.samples[0].cameraPose.quaternion.w = 9; }, /四元数/],
    [(value) => { value.result.samples.push(value.result.samples[0]); }, /标识重复/],
    [(value) => { value.result.calibrations[0].worldFromModel[0] = 2; }, /缩放或拉伸/],
  ]) {
    const invalid = structuredClone(archive); mutate(invalid);
    await assert.rejects(readIPadResultFile(blob(invalid)), expected);
  }
  for (const name of ['a', '中', '🤖', '👨‍👩‍👧‍👦', 'e\u0301'].map((character) => character.repeat(81)).concat([123, {}])) {
    const invalid = structuredClone(archive); invalid.result.samples[0].name = name;
    await assert.rejects(readIPadResultFile(blob(invalid)), /Pose 名称过长/);
  }
  await assert.rejects(readIPadResultFile(new Blob(['{truncated'])), /有效的 JSON/);
  await assert.rejects(readIPadResultFile(blob(null)), /格式或版本/);
  await assert.rejects(readIPadResultFile(new Blob()), /64 MiB/);
  await assert.rejects(readIPadResultFile({ size: MAX_RESULT_FILE_BYTES + 1, text() { throw new Error('must not read oversized file'); } }), /64 MiB/);
  const config = buildExport({ mapData: map, teachingSpaceMode: 'independent', heightRange: [0, 1], waypoints: [], edges: [], teachingTasks: [task] });
  const zip = await buildProjectArchive(config, { mapResource: {
    positionBuffer: geometry.getAttribute('position').array.buffer, indexBuffer: geometry.index.array.buffer,
    indexComponentType: 'uint16', pointCount: 3, faceCount: 1, bounds: map.bounds, sourceHash: map.sourceHash,
  } });
  const restored = await readProjectArchive(zip.bytes);
  assert.deepEqual(normalizeProject(restored.payload).teachingTasks[0].mobileCapture, result);
  if (process.argv[2]) await copyFile(path.join(exports, files[0]), process.argv[2]);
  console.log('Native export → browser import → project archive passed; credentials excluded, local data preserved, frozen retry and malformed/mismatched result rejection verified.');
} finally {
  geometry.dispose(); await rm(directory, { recursive: true, force: true });
}
