import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { buildAbxTeachingArchive } from '../../src/features/teaching/model/abxTeachingExport.js';
import { abxTeachingStandardsFixture } from '../abx_teaching_standards_helpers.mjs';

const source = process.env.ABX_WORKSPACE_ZIP || 'ABXBrainSystem.zip';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const originalHash = hash(await readFile(source));
const directory = await mkdtemp(path.join(tmpdir(), 'atlas-abx-standards-'));
const brain = path.join(directory, 'brain');
const python = (...args) => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-B', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  process.stdout.write(result.stdout);
};
try {
  python('tests/abx_teaching_reference.py', source, brain);
  const context = { window: {}, TextDecoder, ReadableStream };
  vm.runInNewContext(await readFile(path.join(brain, 'web/teaching-import.js'), 'utf8'), context);
  const { payload, robotPackage } = abxTeachingStandardsFixture(6000);
  for (const [images, clouds] of [[false, false], [true, false], [false, true], [true, true]]) {
    const result = await buildAbxTeachingArchive(payload, { robotPackage, includeStandards: images, includeClouds: clouds });
    const opened = await context.window.ABXTeachingImport.open(result.blob);
    assert.equal(opened.standardWarnings, 0); assert.equal(opened.cloudWarnings, 0);
    assert.equal(opened.standards.length, images ? 3 : 0);
    assert.equal(opened.clouds.length, clouds ? 2 : 0);
    for (const entry of [...opened.tasks, ...opened.standards, ...opened.clouds]) {
      const actual = new Uint8Array(await new Response(entry.file.stream()).arrayBuffer());
      assert.deepEqual(actual, result.files[entry.file.name]);
    }
    await writeFile(path.join(directory, `standards-${Number(images)}-${Number(clouds)}.zip`), result.bytes);
  }
  python('tests/integration/abx_teaching_standards_contract.py', directory, brain);
} finally {
  await rm(directory, { recursive: true, force: true });
  assert.equal(hash(await readFile(source)), originalHash, 'robot reference source ZIP must remain unchanged');
}
console.log('Updated robot ZIP reader accepted all four standard-resource combinations without warnings.');
