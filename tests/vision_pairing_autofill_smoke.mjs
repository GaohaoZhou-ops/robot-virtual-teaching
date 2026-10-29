import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createIPadTeachingService } from "../src/server/devices/ipadTeachingService.js";
import { IPAD_PROTOCOL } from "../src/shared/protocols/ipadProtocol.js";
import { publishVisionPairingOffer } from "../src/features/devices/model/visionPairingOffer.js";

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-vision-pairing-autofill-'));
const identity = { serverId: randomUUID(), serverName: 'Atlas Automatic Pairing Test' };
let middleware = createIPadTeachingService({ directory, ...identity });
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const address = `http://127.0.0.1:${server.address().port}`, base = `${address}/__atlas/ipad`;
const model = Buffer.alloc(48); model.writeUInt32LE(0x534c5441); model.writeUInt32LE(1, 4); model.writeUInt32LE(1, 8);
const modelHash = createHash('sha256').update(model).digest('hex');
const manifest = { protocol: IPAD_PROTOCOL, name: '自动填码测试物体', modelHash, sourceHash: modelHash, sourceMapId: '',
  coordinateFrame: 'virtual_origin', distanceUnit: 'meter', verticalAxis: 'Z', vertices: 1, indices: 0,
  sampled: false, originalVertices: 1, byteLength: 48 };
let simulator, advertisement;
const run = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', ...options });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
});
async function api(route, { body, token, method = 'GET', status = 200, headers = {} } = {}) {
  const response = await fetch(base + route, { method, headers: { ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}
const offers = async () => (await api('/vision-pairing')).offers;
async function waitUntil(condition) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('pairing window publication did not settle');
}
const publish = (task, publisherId = randomUUID(), options = {}) => api(`/sessions/${task.id}/vision-pairing`, {
  method: 'POST', token: task.ownerToken, body: { publisherId, code: task.pairingCode }, ...options });
async function create(targetDevice = 'vision', ready = true) {
  const task = await api('/sessions', { method: 'POST', body: { manifest, targetDevice }, status: 201 });
  if (ready) await api(`/sessions/${task.id}/model`, { method: 'PUT', token: task.ownerToken, body: model });
  return task;
}
try {
  assert.deepEqual(await offers(), []);
  const ipad = await create('ipad');
  await publish(ipad, randomUUID(), { status: 409 });
  const preparing = await create('vision', false);
  await publish(preparing, randomUUID(), { status: 409 });
  const first = await create();
  assert.deepEqual(await offers(), [], 'an unopened pairing window never shares a code');
  await publish(first, randomUUID(), { token: 'invalid', status: 401 });
  await publish(first, randomUUID(), { body: { publisherId: randomUUID(), code: '----' }, status: 409 });
  const windowA = randomUUID(), windowB = randomUUID();
  await publish(first, windowA); await publish(first, windowB);
  assert.deepEqual(await offers(), [{ sessionId: first.id, name: manifest.name, code: first.pairingCode, expiresAt: first.pairingExpiresAt }]);
  assert.ok(!JSON.stringify(await api('/info')).includes(first.pairingCode), 'Bonjour identification never includes pairing codes');
  const stored = JSON.parse(await readFile(path.join(directory, first.id, 'session.json'), 'utf8'));
  assert.equal(stored.pairingCode, undefined, 'plaintext codes are not persisted');
  await api(`/sessions/${first.id}/vision-pairing`, { method: 'DELETE', token: first.ownerToken, body: { publisherId: windowA } });
  assert.equal((await offers()).length, 1, 'closing one browser leaves another open window available');
  await publish(first, windowA, { status: 409 });
  await api(`/sessions/${first.id}/vision-pairing`, { method: 'DELETE', token: first.ownerToken, body: { publisherId: windowB } });
  assert.deepEqual(await offers(), []);
  const closedBeforePublish = randomUUID();
  await api(`/sessions/${first.id}/vision-pairing`, { method: 'DELETE', token: first.ownerToken, body: { publisherId: closedBeforePublish } });
  await publish(first, closedBeforePublish, { status: 409 });

  await publish(first);
  const originalNow = Date.now;
  try { Date.now = () => originalNow() + 46_000; assert.deepEqual(await offers(), [], 'a disconnected window lease expires'); }
  finally { Date.now = originalNow; }
  await publish(first);
  Object.assign(first, await api(`/sessions/${first.id}/renew`, { method: 'POST', token: first.ownerToken }));
  assert.deepEqual(await offers(), [], 'renewing a code invalidates the previous offer');
  await publish(first);
  const second = await create(); await publish(second);
  assert.equal((await offers()).length, 2, 'different active models remain distinct');
  await api(`/sessions/${second.id}`, { method: 'DELETE', token: second.ownerToken });
  assert.equal((await offers()).length, 1, 'cancelled tasks cannot be automatically filled');
  await api('/pair', { method: 'POST', body: { code: first.pairingCode, deviceId: randomUUID(), deviceName: 'Apple Vision Pro' } });
  assert.deepEqual(await offers(), [], 'claimed tasks are not offered to another device');
  await publish(first, randomUUID(), { status: 409 });
  const expiring = await create(); await publish(expiring);
  const expiredFile = path.join(directory, expiring.id, 'session.json');
  const expiredSession = JSON.parse(await readFile(expiredFile, 'utf8')); expiredSession.pairingExpiresAt = Date.now() - 1;
  await writeFile(expiredFile, JSON.stringify(expiredSession));
  assert.deepEqual(await offers(), []);
  await publish(expiring, randomUUID(), { status: 410 });
  await api('/vision-pairing', { headers: { Origin: 'http://unrelated.invalid' }, status: 403 });

  const active = await create(); await publish(active);
  middleware = createIPadTeachingService({ directory, ...identity });
  assert.deepEqual(await offers(), [], 'restarting never resurrects stale pairing windows');
  // Exercise the browser publisher against the real service, including LAN
  // HTTP (where crypto.randomUUID is unavailable) and browser back navigation.
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  const originalUUID = crypto.randomUUID;
  let closeWindow;
  try {
    globalThis.window = new EventTarget();
    crypto.randomUUID = undefined;
    globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/__atlas/') ? address + url : url, options);
    closeWindow = publishVisionPairingOffer(active, () => {});
    await waitUntil(async () => (await offers()).length === 1);
    window.dispatchEvent(new Event('pagehide'));
    await waitUntil(async () => (await offers()).length === 0);
    const restored = new Event('pageshow'); Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    await waitUntil(async () => (await offers()).length === 1);
    closeWindow();
    await waitUntil(async () => (await offers()).length === 0);
  } finally {
    closeWindow?.(); globalThis.fetch = originalFetch; globalThis.window = originalWindow; crypto.randomUUID = originalUUID;
  }
  const binary = path.join(directory, 'autofill-tests');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
    'ipad/AtlasTeaching/LANClient.swift', 'ipad/AtlasTeaching/LANServiceDiscovery.swift',
    'vision/AtlasVisionTeaching/VisionPairingAutofill.swift', 'vision/Tests/VisionPairingAutofillTests.swift', '-o', binary]);
  await publish(active);
  await run(binary, [address, identity.serverId, active.pairingCode]);
  assert.equal((await api(`/sessions/${active.id}`, { token: active.ownerToken })).status, 'ready', 'autofill does not claim or download a model');
  console.log('Vision active-window pairing: authorization, lifecycle, expiry, renewal, task selection, restart and native autofill passed.');

  if (process.argv.includes('--ui')) {
    // Use a disposable device, never the user's interactive simulator.
    const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices;
    const runtime = Object.keys(devices).filter(key => /xrOS|visionOS/.test(key)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    assert.ok(runtime, 'Install a visionOS Simulator runtime');
    const deviceType = devices[runtime].find(device => device.isAvailable)?.deviceTypeIdentifier;
    assert.ok(deviceType, 'Create a compatible visionOS Simulator device in Xcode first');
    simulator = execFileSync('xcrun', ['simctl', 'create', `Atlas Autofill Test ${Date.now()}`,
      deviceType, runtime], { encoding: 'utf8' }).trim();
    advertisement = spawn('dns-sd', ['-R', `Atlas Autofill Test ${server.address().port}`, '_atlas-teach._tcp', 'local.', String(server.address().port)], { stdio: 'ignore' });
    const publisherId = randomUUID();
    await publish(active, publisherId);
    const pulse = setInterval(() => publish(active, publisherId).catch(() => {}), 10_000);
    try {
      const artifacts = path.resolve('vision/test-artifacts/pairing-autofill'); await mkdir(artifacts, { recursive: true });
      const log = createWriteStream(path.join(artifacts, 'ui.log'));
      const info = await api('/info');
      await new Promise((resolve, reject) => {
        const child = spawn('xcodebuild', ['-project', 'vision/AtlasVisionTeaching.xcodeproj', '-scheme', 'AtlasVisionTeaching',
          '-destination', `platform=visionOS Simulator,id=${simulator}`, '-derivedDataPath', 'vision/test-artifacts/simulator-dev/DerivedData',
          '-parallel-testing-enabled', 'NO', '-only-testing:AtlasVisionTeachingUITests/AtlasVisionTeachingUITests/testDiscoveryAutofillsIPv4AndPort',
          '-only-testing:AtlasVisionTeachingUITests/AtlasVisionTeachingUITests/testPairingCodeTypingAndCorrections', 'CODE_SIGNING_ALLOWED=NO', 'test'],
        { env: { ...process.env, TEST_RUNNER_ATLAS_DISCOVERY_SERVER_ID: identity.serverId,
          TEST_RUNNER_ATLAS_DISCOVERY_ADDRESS: info.addresses[0], TEST_RUNNER_ATLAS_DISCOVERY_CODE: active.pairingCode } });
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        child.on('error', reject); child.on('exit', code => { log.end(); code === 0 ? resolve() : reject(new Error(`UI test failed; see ${artifacts}/ui.log`)); });
      });
      console.log('Isolated visionOS UI: discovered computer selection fills all four code cells; manual corrections remain available.');
    } finally { clearInterval(pulse); }
  }
} finally {
  advertisement?.kill('SIGTERM');
  if (simulator) {
    try { execFileSync('xcrun', ['simctl', 'shutdown', simulator], { stdio: 'ignore' }); } catch {}
    execFileSync('xcrun', ['simctl', 'delete', simulator], { stdio: 'ignore' });
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
