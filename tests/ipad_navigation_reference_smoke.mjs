import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { buildIPadNavigationReference, validateIPadNavigationReference } from '../src/lib/ipadNavigationReference.js';
import { prepareIPadTransfer } from '../src/lib/ipadTransferPreparation.js';
import { buildTeachingWaypoints } from '../src/lib/teachingNavigation.js';
import { syncMapRouteToIndependent } from '../src/lib/mapRouteSync.js';
import { transferMatrix } from '../src/lib/teachingTransfer.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-navigation-reference-'));
const sessionDirectory = path.join(directory, 'sessions');
let service = createIPadTeachingService({ directory: sessionDirectory });
const server = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const request = async (route, { body, token, method = 'GET' } = {}) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/__atlas/ipad${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' },
    body: body == null ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
};
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
const geometry = new BoxGeometry(0.8, 0.6, 1.2);
const mapData = { geometry, name: 'Parking reference fixture', mapId: 'independent-reference', sourceHash: 'reference-hash', teachingSpaceMode: 'independent' };
try {
  const absolutePoints = [0, 1].map((i) => ({ id: `map-${i}`, name: `N00${i + 1}`, pose: {
    x: 11 + i, y: -7, z: 1.8, roll: 10, pitch: -5, yaw: 130 + i * 50 } }));
  const localToMap = { position: { x: 10, y: -8, z: 2 }, rpy: { roll: 22, pitch: -31, yaw: 127 } };
  const absoluteMap = { mapId: 'absolute-map', sourceHash: 'absolute-hash' };
  const route = syncMapRouteToIndependent(mapData, { kind: 'alignment', sourceMap: absoluteMap, localToMap }, {
    mapId: absoluteMap.mapId, config: { project: { map: { id: absoluteMap.mapId, sourceHash: absoluteMap.sourceHash },
      workspace: { teachingSpaceMode: 'map' }, waypoints: absolutePoints,
      paths: [{ id: 'path-1', from: 'map-0', to: 'map-1', directed: false }] } } });
  const task = { id: 'task', name: 'Local teaching', map: { id: mapData.mapId, sourceHash: mapData.sourceHash },
    coordinateFrame: 'virtual_origin', parkingPoints: [{ id: 'local-parking', name: '本地停车点',
      mapPose: { position: { x: -0.8, y: -0.5, z: 0.2 }, rpy: { roll: 0, pitch: 0, yaw: 90 } }, poses: [] }] };
  const waypoints = buildTeachingWaypoints(route.waypoints, [task, { ...task, map: { sourceHash: 'foreign' },
    parkingPoints: [{ ...task.parkingPoints[0], id: 'foreign-parking' }] }], { mapData, coordinateFrame: 'virtual_origin' });
  const edges = route.edges;
  const reference = buildIPadNavigationReference(waypoints, edges);
  assert.equal(reference.parkingPoints.length, 3, 'current navigation includes local parking and temporary map route nodes only');
  assert.equal(reference.paths.length, 1, 'parking order never invents route connections');
  assert.equal(reference.paths[0].directed, false);
  const matrices = reference.parkingPoints.map((point) => new Matrix4().compose(new Vector3(...Object.values(point.position)),
    new Quaternion(point.quaternion.x, point.quaternion.y, point.quaternion.z, point.quaternion.w), new Vector3(1, 1, 1)));
  for (let i = 0; i < 2; i++) {
    const actual = transferMatrix(localToMap).multiply(matrices[i]).elements;
    const expected = transferMatrix({ position: absolutePoints[i].pose, rpy: absolutePoints[i].pose }).elements;
    assert.ok(actual.every((v, j) => Math.abs(v - expected[j]) < 1e-10), 'full tilted position/orientation is transformed exactly once');
  }
  assert.equal(buildIPadNavigationReference(), undefined);
  for (const mutate of [r => { r.coordinateFrame = 'map'; }, r => { r.parkingPoints[0].position.z = NaN; },
    r => { r.parkingPoints[0].quaternion.w = 2; }, r => { r.parkingPoints[1].id = r.parkingPoints[0].id; },
    r => { r.paths[0].to = 'missing'; }]) {
    const invalid = structuredClone(reference); mutate(invalid);
    assert.throws(() => validateIPadNavigationReference(invalid));
  }
  const prepare = (ticket, extra = {}) => prepareIPadTransfer({ ticket, mapData, teachingTasks: [], waypoints, edges, request, ...extra });
  const legacy = await prepare(null, { waypoints: [], edges: [] });
  const legacyFile = path.join(sessionDirectory, legacy.id, 'session.json');
  const old = JSON.parse(await readFile(legacyFile, 'utf8')); delete old.navigationReferenceHash;
  await writeFile(legacyFile, JSON.stringify(old));
  assert.equal((await prepare(legacy, { waypoints: [], edges: [] })).id, legacy.id);
  const ticket = await prepare(legacy);
  assert.notEqual(ticket.id, legacy.id);
  assert.equal(ticket.referenceParkingPointCount, 3); assert.equal(ticket.referencePathCount, 1);
  assert.equal(ticket.referencePoseCount, 0, 'parking references are never camera poses');
  assert.equal(ticket.manifest.modelHash, legacy.manifest.modelHash, 'geometry identity excludes navigation');
  const paired = await request('/pair', { method: 'POST', body: { code: ticket.pairingCode, deviceId: randomUUID() } });
  assert.deepEqual(paired.navigationReference, reference, 'LAN transmits the frozen graph');
  assert.equal((await prepare(ticket)).id, ticket.id);
  const edits = structuredClone(waypoints); edits[0].pose.yaw += 20;
  assert.notEqual((await prepare(ticket, { waypoints: edits })).id, ticket.id, 'heading-only edit refreshes the transfer');
  edits[0].name = 'Renamed';
  assert.notEqual((await prepare(ticket, { waypoints: edits })).id, ticket.id);
  assert.notEqual((await prepare(ticket, { edges: [] })).id, ticket.id, 'route-only change refreshes the transfer');
  const cleared = await prepare(ticket, { waypoints: [], edges: [] });
  assert.notEqual(cleared.id, ticket.id); assert.equal(cleared.referenceParkingPointCount, 0);
  assert.equal((await prepare(ticket, { waypoints: [], edges: [], preserveSnapshot: true })).id, ticket.id);
  service = createIPadTeachingService({ directory: sessionDirectory });
  assert.equal((await prepare(ticket)).id, ticket.id, 'references survive service restart');
  await assert.rejects(request('/sessions', { method: 'POST', body: { manifest: ticket.manifest,
    navigationReference: { ...reference, coordinateFrame: 'map' } } }), /坐标系/);

  if (process.platform === 'darwin') {
    await writeFile(path.join(directory, 'paired.json'), JSON.stringify(paired));
    await writeFile(path.join(directory, 'transforms.json'), JSON.stringify(matrices.map((m) => m.elements)));
    await writeFile(path.join(directory, 'model.atls'), await readFile(path.join(sessionDirectory, ticket.id, 'model.atls')));
    const binary = path.join(directory, 'native-navigation-tests');
    await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
      'ipad/AtlasTeaching/ModelGeometry.swift', 'ipad/AtlasTeaching/LANClient.swift', 'ipad/AtlasTeaching/ProjectStore.swift',
      'ipad/AtlasTeaching/ParkingReferenceRenderer.swift', 'ipad/Tests/NavigationReferenceTests.swift', '-o', binary]);
    await run(binary, [directory]);
  }
  console.log('Navigation references: local/tilted map parking, LAN, frozen snapshots, edits/removal, validation and restart passed.');
} finally {
  geometry.dispose(); await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
