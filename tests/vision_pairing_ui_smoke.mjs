import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { BoxGeometry } from 'three';
import { packIPadModel } from "../src/features/devices/model/ipadTeaching.js";
import { createIPadTeachingService } from "../src/server/devices/ipadTeachingService.js";
import { modelThumbnail } from "../src/server/devices/modelThumbnail.js";

const simulator = process.env.VISION_SIMULATOR_ID || Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])).devices)
  .flat().find(device => device.name.includes('Vision Pro'))?.udid;
assert.ok(simulator, 'Boot a visionOS simulator first');
const artifacts = path.resolve('vision/test-artifacts/model-sync');
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'atlas-vision-pairing-ui-'));
const middleware = createIPadTeachingService({ directory });
const stats = { downloads: 0, previews: 0 };
let fixtures;
const server = createServer((req, res) => {
  if (['/__test/screenshot', '/__test/screenshot-preview'].includes(req.url)) {
    const filename = req.url.endsWith('screenshot-preview') ? 'model-preview.png' : 'model-sync-dialog.png';
    execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', path.join(artifacts, filename)], { stdio: 'ignore' });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
  }
  if (req.url === '/__test/fixture' || req.url === '/__test/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('fixture') ? fixtures : stats)); return;
  }
  if (req.method === 'GET' && req.url.endsWith('/thumbnail') && ++stats.previews === 1) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '测试预览中断，请重试' })); return;
  }
  if (req.method === 'GET' && req.url.endsWith('/model') && ++stats.downloads === 1) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '测试下载中断，请重试' })); return;
  }
  middleware(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ids = [];
async function ready(geometry, name) {
  const packed = await packIPadModel({ geometry, name, mapId: 'pairing-ui-test' });
  const response = await fetch(base + '/__atlas/ipad/sessions', { method: 'POST', body: JSON.stringify({ manifest: packed.manifest }) });
  assert.equal(response.status, 201);
  const task = await response.json(); ids.push(task.id);
  const uploaded = await fetch(base + `/__atlas/ipad/sessions/${task.id}/model`, { method: 'PUT', body: packed.buffer,
    headers: { Authorization: `Bearer ${task.ownerToken}` } });
  assert.equal(uploaded.status, 200);
  return { code: task.pairingCode, packed };
}
try {
  const geometry = new BoxGeometry(0.43 + Math.random() / 100, 0.27, 0.61);
  const first = await ready(geometry, '模型同步测试.ply');
  const reuse = await ready(geometry, '本地复用测试.ply');
  const changed = await ready(geometry.clone().scale(1.4, 1, 1), '模型同步测试.ply');
  fixtures = { firstCode: first.code, reuseCode: reuse.code, changedCode: changed.code };
  await writeFile(path.join(artifacts, 'thumbnail.png'), await modelThumbnail(Buffer.from(first.packed.buffer)));
  const log = createWriteStream(path.join(artifacts, 'ui.log'));
  const report = path.join(artifacts, `ui-${Date.now()}.xcresult`);
  await new Promise((resolve, reject) => {
    const child = spawn('xcodebuild', ['-project', 'vision/AtlasVisionTeaching.xcodeproj', '-scheme', 'AtlasVisionTeaching',
      '-destination', `platform=visionOS Simulator,id=${simulator}`, '-derivedDataPath', 'vision/test-artifacts/simulator-dev/DerivedData',
      '-resultBundlePath', report, '-only-testing:AtlasVisionTeachingUITests/AtlasVisionTeachingUITests/testPairedModelVerificationAndSyncConsent',
      'CODE_SIGNING_ALLOWED=NO', 'test'], { env: { ...process.env, TEST_RUNNER_ATLAS_PAIRING_ADDRESS: base } });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on('error', reject);
    child.on('exit', code => { log.end(); code === 0 ? resolve() : reject(new Error(`UI tests failed; see ${artifacts}/ui.log`)); });
  });
  assert.equal(stats.downloads, 2, 'one explicit failed download and one successful retry; local reuse downloads nothing');
  assert.ok(stats.previews >= 2, 'both new models display a preview before download consent');
  console.log('Vision simulator passed: preview before consent, defer, download failure/retry, local reuse and same-name mismatch.');
  console.log(`UI report: ${report}`);
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  // Only remove projects created by this test. Preserve the user's simulator library.
  try {
    const root = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, 'com.atlasroute.teaching.vision', 'data'], { encoding: 'utf8' }).trim();
    for (const id of ids) for (const ext of ['json', 'atls']) await rm(path.join(root, 'Library/Application Support/AtlasTeaching', `${id}.${ext}`), { force: true });
  } catch { /* The app may not have installed if compilation failed. */ }
}
