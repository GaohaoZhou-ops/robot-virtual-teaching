import assert from 'node:assert/strict';
import { saveProjectArchive, readProjectArchive } from '../src/lib/projectArchive.js';
import { teachingTransferFixture } from './teaching_transfer_helpers.mjs';

for (const mode of ['map', 'independent']) {
  const fixture = teachingTransferFixture(mode);
  const payload = fixture.config.config.project;
  const options = { mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage };
  const events = [];
  let written;
  const handle = {
    name: `${mode}-已重命名.zip`,
    async createWritable() {
      events.push('open');
      return {
        async write(blob) { written = blob; events.push('write'); },
        async close() { events.push('close'); },
        async abort() { events.push('abort'); },
      };
    },
  };
  const archive = await saveProjectArchive(payload, handle, {
    ...options,
    onProgress(progress) { if (progress.phase === '保存工程 ZIP') events.push(progress.detail); },
  });
  assert.deepEqual(events, [handle.name, 'open', 'write', 'close']);
  assert.equal(written.size, archive.byteLength);
  const restored = await readProjectArchive(new Uint8Array(await written.arrayBuffer()));
  assert.equal(restored.payload.workspace.teachingSpaceMode, mode);
  assert.equal(restored.payload.virtualTeaching.tasks[0].id, `${mode}-task`);

  // A failed build must not open or truncate the selected destination.
  events.length = 0;
  await assert.rejects(saveProjectArchive(null, handle, options), /工程配置为空/);
  assert.deepEqual(events, []);

  // Never report success on permission loss, write failure or a failed commit.
  for (const stage of ['open', 'write', 'close']) {
    const failure = new Error(`${stage} failed`);
    const calls = [];
    await assert.rejects(saveProjectArchive(payload, {
      name: handle.name,
      async createWritable() {
        calls.push('open');
        if (stage === 'open') throw failure;
        return {
          async write() { calls.push('write'); if (stage === 'write') throw failure; },
          async close() { calls.push('close'); if (stage === 'close') throw failure; },
          async abort() { calls.push('abort'); throw new Error('cleanup failed'); },
        };
      },
    }, options), (error) => error === failure);
    assert.deepEqual(calls, stage === 'open' ? ['open']
      : stage === 'write' ? ['open', 'write', 'abort'] : ['open', 'write', 'close', 'abort']);
  }
  console.log(`${mode}_save_commit_restore_and_failure_cleanup=ok`);
}
