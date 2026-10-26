import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workbenchFixture } from './vision_workbench_fixture.mjs';
import { createServer } from 'node:http';
import { createWorkSyncService } from '../src/server/workSyncService.js';

const run = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', ...options });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
});
const dir = await mkdtemp(path.join(tmpdir(), 'atlas-vision-workbench-'));
let native;
async function stopNative() {
  if (!native || native.exitCode !== null) return;
  const done = new Promise(resolve => native.once('exit', resolve)); native.kill('SIGTERM'); await done; native = null;
}
async function startNative(remote) {
  const args = [path.resolve('vision/AtlasVisionTeaching/WebWorkbench'), dir, path.join(dir, 'project.zip')];
  if (remote) args.push(remote);
  native = spawn(path.join(dir, 'server'), args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const connection = await new Promise((resolve, reject) => {
    let data = ''; const timer = setTimeout(() => reject(new Error('Native server startup timed out')), 15000);
    native.stdout.on('data', chunk => { data += chunk; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
    native.once('exit', code => { clearTimeout(timer); reject(new Error(`Native server exited ${code}`)); });
  });
  await writeFile(path.join(dir, 'connection.json'), JSON.stringify(connection)); return connection;
}
const sync = createWorkSyncService({ isLocal: () => true });
const remote = createServer((req, res) => sync(req, res, () => { res.writeHead(404); res.end(); }));
try {
  await run('node', ['scripts/build_vision_workbench.mjs']);
  await writeFile(path.join(dir, 'project.zip'), (await workbenchFixture()).bytes);
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/AtlasTeaching/LANClient.swift',
    'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/AtlasTeaching/ModelGeometry.swift', 'vision/AtlasVisionTeaching/VisionPoseMath.swift',
    'vision/AtlasVisionTeaching/VisionSceneModels.swift', 'vision/AtlasVisionTeaching/VisionSceneStore.swift',
    'vision/AtlasVisionTeaching/VisionWorkbenchServer.swift', 'vision/Tests/VisionWorkbenchServerHarness.swift', '-o', path.join(dir, 'server')]);
  const c = await startNative();
  const get = (route, options) => fetch(c.origin + route, options);
  assert.equal((await get('/workbench')).status, 200);
  assert.equal((await get('/model-editor/dual')).status, 200);
  const example = await get('/xian_map.ply');
  assert.equal(example.status, 200);
  assert.deepEqual(Buffer.from(await example.arrayBuffer()), await readFile('maps/xian_map.ply'), 'large bundled map streams without truncation');
  assert.equal((await get('/__atlas/session')).status, 200);
  assert.equal((await get('/__atlas/vision-native/imports/' + c.importID)).status, 401);
  assert.equal((await get('/__atlas/session', { headers: { Origin: 'https://example.com' } })).status, 403);
  const response = await get('/__atlas/vision-native/imports/' + c.importID, { headers: { Authorization: `Bearer ${c.token}` } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(dir, 'project.zip')));
  if (process.argv.includes('--ui')) await run(process.env.VISION_PYTHON || 'python3', ['tests/vision_workbench_ui_smoke.py'], {
    env: { ...process.env, VISION_WORKBENCH_CONNECTION: path.join(dir, 'connection.json') },
  });
  await stopNative();
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${remote.address().port}`;
  const api = async (base, route, data, token) => {
    const response = await fetch(base + '/__atlas/work-sync' + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
    assert.ok(response.ok); return response.json();
  };
  const host = await api(base, '/clients', { name: 'Mac', project: { key: 'test', name: 'Fixture', mode: 'map' } });
  const proxy = await startNative(base);
  assert.equal((await (await fetch(proxy.origin + '/__atlas/work-sync/capabilities')).json()).local, false);
  const peer = await api(proxy.origin, '/clients', { name: 'Vision Pro', project: null });
  assert.equal(peer.role, 'peer');
  const requested = await api(proxy.origin, '/requests', {}, peer.token); assert.ok(requested.pending);
  const pending = await api(base, '/status', { project: { key: 'test', name: 'Fixture', mode: 'map' } }, host.token);
  assert.equal(pending.requests.length, 1); assert.equal(pending.requests[0].name, 'Vision Pro');
  await api(base, '/decision', { requestId: pending.requests[0].id, allow: false }, host.token);
  assert.match((await api(proxy.origin, '/status', {}, peer.token)).reason, /未授权/);
  if (process.argv.includes('--sync-ui')) {
    await stopNative();
    await startNative(process.env.VISION_WORKBENCH_HOST || 'http://127.0.0.1:22071');
    await run(process.env.VISION_PYTHON || 'python3', ['tests/vision_workbench_sync_ui.py'], {
      env: { ...process.env, VISION_WORKBENCH_CONNECTION: path.join(dir, 'connection.json'), VISION_WORKBENCH_FIXTURE: path.join(dir, 'project.zip') },
    });
  }
  console.log('Native workbench server: bundled engine, authenticated project transfer, origin isolation and peer-only LAN proxy passed.');
} finally {
  await stopNative(); sync.close(); remote.close(); await rm(dir, { recursive: true, force: true });
}
