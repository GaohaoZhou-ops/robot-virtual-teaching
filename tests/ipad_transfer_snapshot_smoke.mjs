import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { createIPadTeachingService } from "../src/server/devices/ipadTeachingService.js";
import { prepareIPadTransfer } from "../src/features/devices/model/ipadTransferPreparation.js";
import { buildIPadPoseSeed } from "../src/features/devices/model/ipadPoseSeed.js";
import { ipadPoseSeedHash } from "../src/shared/protocols/ipadTransferSnapshot.js";

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-ipad-snapshot-'));
let middleware = createIPadTeachingService({ directory });
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad`;
const requests = [];
const request = async (route, { body, token, method = 'GET' } = {}) => {
  requests.push(`${method} ${route}`);
  const response = await fetch(base + route, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' },
    body: body == null ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
geometry.setIndex([0, 1, 2]);
const mapData = { geometry, name: 'snapshot.ply', mapId: 'snapshot-map', sourceHash: 'snapshot-source' };
const task = { map: { id: mapData.mapId, sourceHash: mapData.sourceHash }, coordinateFrame: 'virtual_origin',
  parkingPoints: [{ poses: [1, 2, 3].map((i) => ({ id: `pose-${i}`, name: `Pose ${i}`,
    opticalTargets: { left: { position: { x: i, y: 0, z: 1 }, quaternion: { x: 1, y: 0, z: 0, w: 0 } } } })) }] };
const prepare = (ticket, teachingTasks = [task], options = {}) => prepareIPadTransfer({ ticket,
  teachingTasks, mapData, request, ...options });
const creations = () => requests.filter((r) => r === 'POST /sessions').length;
try {
  const old = await prepare(null, []);
  // Reproduce a model-only transfer created before Pose snapshots existed.
  const oldFile = path.join(directory, old.id, 'session.json');
  const legacy = JSON.parse(await readFile(oldFile, 'utf8')); delete legacy.referencePoseHash;
  await writeFile(oldFile, JSON.stringify(legacy));
  await request('/pair', { method: 'POST', body: { code: old.pairingCode, deviceId: randomUUID() } });
  const oldBefore = await readFile(oldFile, 'utf8');
  const current = await prepare(old);
  assert.notEqual(current.id, old.id, 'opening pairing replaces the stale zero-Pose snapshot');
  assert.equal(current.referencePoseCount, 3);
  assert.equal(current.referenceIPadPoseCount, 0);
  assert.equal(current.manifest.modelHash, old.manifest.modelHash, 'Pose changes do not change model identity');
  assert.equal(await readFile(oldFile, 'utf8'), oldBefore, 'existing device sessions and results remain untouched');
  const paired = await request('/pair', { method: 'POST', body: { code: current.pairingCode, deviceId: randomUUID() } });
  assert.equal(paired.poseSeed.samples.length, 3, 'the actual iPad pairing response contains all three poses');
  assert.ok(paired.poseSeed.samples.every((s) => s.origin === 'desktop'));
  assert.equal(current.referencePoseHash, await ipadPoseSeedHash(paired.poseSeed));
  const reordered = { samples: paired.poseSeed.samples.map((s) => Object.fromEntries(Object.entries(s).reverse())) };
  assert.equal(await ipadPoseSeedHash(reordered), current.referencePoseHash, 'JSON key order is not a content change');
  const count = creations();
  assert.equal((await prepare(current)).id, current.id, 'reopening unchanged poses reuses the transfer');
  assert.equal((await prepare(current, [task], { renew: true })).id, current.id, 'refresh only rotates the code for unchanged data');
  assert.equal(creations(), count);
  assert.deepEqual(buildIPadPoseSeed([task], mapData, current.manifest),
    buildIPadPoseSeed([task], mapData, current.manifest), 'legacy poses without dates have a stable payload');
  const editedTask = structuredClone(task);
  editedTask.parkingPoints[0].poses[1].opticalTargets.left.position.x += 0.25;
  const edited = await prepare(current, [editedTask], { renew: true });
  assert.notEqual(edited.id, current.id, 'same-count position edits refresh the snapshot too');
  assert.equal(edited.referencePoseCount, 3);
  const removed = await prepare(edited, []);
  assert.notEqual(removed.id, edited.id, 'deleting all poses cannot leave stale references on the iPad');
  assert.equal(removed.referencePoseCount, 0);
  assert.equal((await prepare(old, [task], { preserveSnapshot: true })).id, old.id,
    'history and receive-result flows preserve the explicitly selected task');
  const editFile = path.join(directory, edited.id, 'session.json');
  const completed = JSON.parse(await readFile(editFile, 'utf8')); completed.status = 'completed';
  await writeFile(editFile, JSON.stringify(completed));
  assert.equal((await prepare(edited, [])).id, edited.id, 'a waiting result stays available to receive');
  assert.notEqual((await prepare(edited, [], { forceNew: true })).id, edited.id);

  let pending;
  const interrupted = async (route, options) => {
    if (options?.method === 'PUT') throw new Error('interrupted upload');
    return request(route, options);
  };
  await assert.rejects(prepare(null, [task], { request: interrupted, onUpdate: (value) => { pending = value; } }), /interrupted/);
  assert.equal(pending.status, 'preparing');
  assert.equal((await prepare(pending)).id, pending.id, 'an unchanged failed upload resumes without a duplicate task');
  await assert.rejects(prepare(null, [], { request: interrupted, onUpdate: (value) => { pending = value; } }), /interrupted/);
  assert.notEqual((await prepare(pending)).id, pending.id, 'retrying an upload after recording poses rebuilds the seed');
  middleware = createIPadTeachingService({ directory });
  assert.equal((await prepare(removed, [])).id, removed.id, 'snapshot identity survives service restart');
  console.log('iPad transfer snapshots: legacy 0 → 3 poses, edits/deletions, reuse, renewal, history/results, retry and restart passed.');
} finally {
  geometry.dispose();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
