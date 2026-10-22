import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { createIPadUSBBridge, wiredIPads } from '../src/server/ipadUSB.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { packIPadModel } from '../src/lib/ipadTeaching.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'atlas-ipad-usb-'));
const container = path.join(temporary, 'device-container');
const device = { identifier: randomUUID(), hardwareProperties: { deviceType: 'iPad', reality: 'physical' },
  connectionProperties: { transportType: 'wired', pairingState: 'paired', tunnelState: 'connected' }, deviceProperties: { name: 'USB test iPad' } };
const wireless = { ...device, connectionProperties: { ...device.connectionProperties, transportType: 'localNetwork' } };
let connected = [device], failCopy = false, unplugDuringCopy = false;
const calls = [];
const bridge = createIPadUSBBridge({ directory: path.join(temporary, 'bridge'), serverId: randomUUID(), serverName: 'USB Test Mac', platform: 'darwin',
  command: async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { devices: connected };
    assert.deepEqual(args.slice(0, 3), ['device', 'copy', 'to']);
    const argument = (name) => args[args.indexOf(name) + 1];
    assert.equal(argument('--domain-identifier'), 'com.atlasroute.teaching');
    assert.equal(argument('--domain-type'), 'appDataContainer');
    assert.equal(argument('--device'), device.identifier);
    const destination = argument('--destination');
    assert.ok(destination.startsWith('Documents/Atlas USB/'));
    if (destination.endsWith('model.atls') && failCopy) throw new Error('USB disconnected');
    const output = path.join(container, destination);
    await mkdir(path.dirname(output), { recursive: true });
    await cp(argument('--source'), output);
    if (destination.endsWith('model.atls') && unplugDuringCopy) connected = [wireless];
    return {};
  } });
const directory = path.join(temporary, 'server');
const middleware = createIPadTeachingService({ directory, usbBridge: bridge });
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad`;
const request = async (route, { method = 'GET', token, body, expected = 200 } = {}) => {
  const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' },
    body: body == null ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
};
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' }); child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
try {
  const phone = { ...device, identifier: randomUUID(), hardwareProperties: { deviceType: 'iPhone', reality: 'physical' } };
  assert.deepEqual(wiredIPads([device, wireless, phone]), [device, phone], 'both wired iOS device families can receive models');
  assert.equal(wiredIPads([{ ...phone, hardwareProperties: { deviceType: 'iPhone', reality: 'simulated' } }]).length, 0);
  assert.equal(wiredIPads([{ ...device, connectionProperties: { ...device.connectionProperties, tunnelState: 'unavailable' } }]).length, 0);
  assert.equal((await bridge.refresh()).devices[0].ready, true);
  assert.equal((await request('/usb')).devices.length, 1);
  connected = [wireless]; await bridge.refresh();
  assert.equal(bridge.status().devices.length, 0, 'wireless pairing must never be advertised as USB');
  connected = [device];

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)); geometry.setIndex([0, 1, 2]);
  const packed = await packIPadModel({ geometry, name: 'USB fixture.ply', mapId: 'usb-test', sourceHash: 'usb-fixture' });
  const poseSeed = { samples: [{ id: 'mac-usb-test', name: 'Mac USB Pose', origin: 'desktop', segmentId: 'mac-reference',
    capturedAt: new Date().toISOString(), kind: 'keyframe', tracking: 'normal',
    cameraPose: { frameName: 'ipad_camera_optical_frame', position: { x: 0, y: 0, z: 1 }, quaternion: { x: 1, y: 0, z: 0, w: 0 } } }] };
  poseSeed.samples.push({ ...poseSeed.samples[0], id: 'ipad-usb-returning', name: 'Returning iPad Pose', origin: 'ipad' });
  const prepare = async () => {
    const session = await request('/sessions', { method: 'POST', body: { manifest: packed.manifest, poseSeed }, expected: 201 });
    await request(`/sessions/${session.id}/model`, { method: 'PUT', token: session.ownerToken, body: packed.buffer });
    return session;
  };
  const session = await prepare();
  const route = `/sessions/${session.id}/usb`;
  const send = (extra = {}) => request(route, { method: 'POST', token: session.ownerToken, body: { deviceId: device.identifier }, ...extra });
  const beforeUnauthorized = calls.length;
  await send({ token: undefined, expected: 401 });
  assert.equal(calls.length, beforeUnauthorized, 'unauthorized requests cannot touch the device');
  await send({ body: { deviceId: '../../outside' }, expected: 400 });
  connected = [wireless]; await send({ expected: 409 }); connected = [device];
  const receipt = await send();
  assert.equal(receipt.id, (await send()).id, 'retry uses the same USB project and preserves existing Pose data');
  const transferred = path.join(container, 'Documents/Atlas USB/Inbox', receipt.id);
  assert.deepEqual(await readFile(path.join(transferred, 'model.atls')), Buffer.from(packed.buffer));
  const descriptor = JSON.parse(await readFile(path.join(transferred, 'ready.json'), 'utf8'));
  assert.equal(descriptor.manifest.modelHash, packed.manifest.modelHash);
  assert.deepEqual(descriptor.poseSeed, poseSeed, 'USB preserves exactly the same references as Wi-Fi');
  // Exercise the full send path for iPhone too, using the same app container and protocol.
  const originalFamily = device.hardwareProperties.deviceType;
  device.hardwareProperties.deviceType = 'iPhone';
  assert.equal((await bridge.refresh()).devices[0].ready, true);
  assert.equal((await send()).id, receipt.id);
  device.hardwareProperties.deviceType = originalFamily;
  assert.notEqual(descriptor.id, session.id, 'USB imports must not replace a LAN project and its credentials');
  assert.ok(!JSON.stringify(descriptor).includes(session.ownerToken));
  assert.equal((await request(`/sessions/${session.id}`, { token: session.ownerToken })).status, 'ready');
  await writeFile(path.join(directory, session.id, 'model.atls'), 'corrupt');
  const beforeCorrupt = calls.length; await send({ expected: 409 });
  assert.equal(calls.length, beforeCorrupt, 'verify the frozen model before USB sends any bytes');

  const interrupted = await prepare();
  failCopy = true;
  await request(`/sessions/${interrupted.id}/usb`, { method: 'POST', token: interrupted.ownerToken, body: { deviceId: device.identifier }, expected: 502 });
  failCopy = false; unplugDuringCopy = true;
  const beforeUnplug = calls.length;
  await request(`/sessions/${interrupted.id}/usb`, { method: 'POST', token: interrupted.ownerToken, body: { deviceId: device.identifier }, expected: 409 });
  assert.ok(!calls.slice(beforeUnplug).some((args) => args.some((arg) => arg.endsWith('/ready.json'))), 'disconnect before commit never publishes a ready file');
  unplugDuringCopy = false; connected = [device];

  if (process.platform === 'darwin') {
    const binary = path.join(temporary, 'usb-native-tests');
    await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
      'ipad/AtlasTeaching/ModelGeometry.swift', 'ipad/AtlasTeaching/USBFileReceiver.swift', 'ipad/Tests/USBFileTests.swift', '-o', binary]);
    await bridge.refresh();
    await run(binary, [path.join(container, 'Documents/Atlas USB'), receipt.id]);
  }
  console.log('USB transfer: wired detection, owner authorization, immutable model checks, complete bytes, retry identity and disconnect handling passed.');
} finally {
  bridge.close(); await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
