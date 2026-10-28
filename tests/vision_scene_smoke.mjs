import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { buildVisionScenePackage, partitionVisionGeometry } from '../src/lib/visionScenePackage.js';
import { validateVisionScene } from '../src/lib/visionSceneProtocol.js';
import { createVisionSceneService } from '../src/server/visionSceneService.js';
import { sampleTeachingTrajectorySegment } from '../src/lib/teachingPlayback.js';
import { applyRobotJointValues, disposeRobotModel } from '../src/lib/robotLoader.js';
import { visionSceneFixture } from './vision_scene_fixture.mjs';
import { normalizeProject } from '../src/lib/io.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-vision-scene-'));
const middleware = createVisionSceneService({ directory: path.join(directory, 'server') });
const fixture = visionSceneFixture(), buffers = new Map();
let scene, ticket, simulator, downloads = 0;
const artifacts = path.resolve('vision/test-artifacts/scene-review');
const server = createServer((req, res) => {
  if (req.url.startsWith('/__test/screenshot/')) {
    const name = req.url.split('/').at(-1);
    if (simulator && /^[a-z-]+$/.test(name)) execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', path.join(artifacts, `${name}.png`)], { stdio: 'ignore' });
    res.writeHead(200); res.end('{}'); return;
  }
  if (req.method === 'GET' && req.url.includes('/assets/')) downloads++;
  middleware(req, res, () => { res.writeHead(404); res.end(); });
});
const run = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', ...options });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
});
try {
  // Placing a mesh in a scan leaves the background points outside its index.
  // Those points must survive in separate point-only assets, with exact RGB
  // and coordinates, even when mesh and point tiles share the same grid cell.
  const hybridBytes = await readFile('tests/fixtures/hybrid-map.ply');
  const hybrid = new PLYLoader().parse(hybridBytes.buffer.slice(hybridBytes.byteOffset, hybridBytes.byteOffset + hybridBytes.byteLength));
  const sample = (geometry, vertex) => ['position', 'color'].flatMap(name => {
    const attribute = geometry.getAttribute(name);
    return [attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex)];
  }).join(',');
  const referenced = new Set(hybrid.index.array);
  const loose = Array.from({ length: hybrid.attributes.position.count }, (_, i) => i).filter(i => !referenced.has(i));
  for (const primitiveLimit of [1, 2, 97]) {
    const points = [], faces = [];
    for (const chunk of partitionVisionGeometry(hybrid, { primitiveLimit })) {
      assert.ok((chunk.index ? chunk.index.count / 3 : chunk.attributes.position.count) <= primitiveLimit);
      if (chunk.index) for (const vertex of chunk.index.array) faces.push(sample(chunk, vertex));
      else for (let i = 0; i < chunk.attributes.position.count; i++) points.push(sample(chunk, i));
      chunk.dispose();
    }
    assert.deepEqual(points.sort(), loose.map(i => sample(hybrid, i)).sort(), 'mixed maps retain every loose point exactly once');
    assert.deepEqual(faces.sort(), Array.from(hybrid.index.array, i => sample(hybrid, i)).sort(), 'mixed maps retain every source triangle');
  }
  const grouped = [...partitionVisionGeometry(hybrid, { tiled: false, start: 3, count: 3 })];
  assert.deepEqual(grouped.flatMap(chunk => Array.from(chunk.index.array, i => sample(chunk, i))).sort(),
    Array.from(hybrid.index.array.slice(3, 6), i => sample(hybrid, i)).sort(), 'robot material groups never acquire map points or other faces');
  grouped.forEach(chunk => chunk.dispose());
  const emptyIndex = hybrid.clone().setIndex([]);
  const pointChunks = [...partitionVisionGeometry(emptyIndex)];
  assert.ok(pointChunks.every(chunk => !chunk.index));
  assert.deepEqual(pointChunks.flatMap(chunk => Array.from({ length: chunk.attributes.position.count }, (_, i) => sample(chunk, i))).sort(),
    Array.from({ length: hybrid.attributes.position.count }, (_, i) => sample(hybrid, i)).sort(), 'an empty index still exports a point cloud');
  pointChunks.forEach(chunk => chunk.dispose()); emptyIndex.dispose();

  // Send a mixed map through the complete package, download and native path.
  for (const name of ['position', 'color']) {
    const source = fixture.mapData.geometry.getAttribute(name), extra = hybrid.getAttribute(name);
    const values = new Float32Array(source.array.length + loose.length * 3); values.set(source.array);
    loose.forEach((vertex, i) => values.set([extra.getX(vertex), extra.getY(vertex), extra.getZ(vertex)], source.array.length + i * 3));
    fixture.mapData.geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
  }
  hybrid.dispose();
  // Every source triangle and point survives tiling, including material groups.
  for (const indexed of [true, false]) {
    const geometry = indexed ? new THREE.PlaneGeometry(3, 4, 120, 120) : new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(Array.from({ length: 3015 }, (_, i) => i / 30), 3));
    const source = indexed ? geometry.index.count / 3 : geometry.attributes.position.count;
    let sum = 0; const actual = [];
    for (const chunk of partitionVisionGeometry(geometry, { primitiveLimit: 97 })) {
      const count = indexed ? chunk.index.count / 3 : chunk.attributes.position.count;
      sum += count; assert.ok(count <= 97);
      const positions = chunk.attributes.position;
      for (let i = 0; i < (chunk.index?.count ?? positions.count); i++) {
        const v = chunk.index ? chunk.index.getX(i) : i; actual.push([positions.getX(v), positions.getY(v), positions.getZ(v)].join(','));
      }
      chunk.dispose();
    }
    const expected = [];
    for (let i = 0; i < (geometry.index?.count ?? geometry.attributes.position.count); i++) {
      const v = geometry.index ? geometry.index.getX(i) : i, p = geometry.attributes.position;
      expected.push([p.getX(v), p.getY(v), p.getZ(v)].join(','));
    }
    assert.equal(sum, source); assert.deepEqual(actual.sort(), expected.sort()); geometry.dispose();
  }
  scene = await buildVisionScenePackage({ ...fixture, onAsset: async (asset, buffer) => buffers.set(asset.id, buffer) });
  assert.deepEqual(scene.paths.find(p => p.id === 'route-edge').points, [[-2, -1, 0], [2, -1, 0]], 'canonical waypoint poses retain a nonzero route');
  assert.deepEqual(scene.markers.find(m => m.id === 'waypoint-a').position, [-2, -1, 0]);
  // Exercise the import normalizer and both historical coordinate shapes.
  // Nonzero Z also catches accidental X/Y/Z reordering or flattening.
  const navigation = { waypoints: [
    { id: 'a', pose: { x: 4, y: -3, z: .25 }, position: { x: 99, y: 99, z: 99 } },
    { id: 'b', position: { x: 8, y: 2, z: .5 } },
    { id: 'c', x: 12, y: -5, z: .75 },
  ], edges: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }] };
  for (const input of [navigation, normalizeProject(navigation)]) {
    const exported = await buildVisionScenePackage({ mapData: fixture.mapData, waypoints: input.waypoints, edges: input.edges });
    assert.deepEqual(exported.markers.map(m => m.position), [[4, -3, .25], [8, 2, .5], [12, -5, .75]]);
    assert.deepEqual(exported.paths.map(p => p.points), [[[4, -3, .25], [8, 2, .5]], [[8, 2, .5], [12, -5, .75]]]);
  }
  assert.equal(scene.clips.length, 1); assert.equal(scene.nodes.filter(n => n.joint).length, 3);
  assert.ok(!scene.nodes.some(n => n.name === 'collision-only'));
  assert.ok(scene.nodes.filter(n => n.role === 'map').every(n => n.material == null), 'map colors remain unlit');
  for (const node of scene.nodes.filter(n => n.role === 'part' && n.asset)) {
    assert.deepEqual(node.material, { roughness: 0.58, metallic: 0.16 }, 'robot material parameters survive export');
  }
  assert.deepEqual(scene.markers.find(m => m.id === 'pose-mobile-key').position, [-.9, -.8, .9]);
  assert.deepEqual(scene.paths.find(p => p.id === 'line-motion-line').points, [[-1.7, 0, .85], [-1.2, .5, .85]]);
  assert.equal(scene.assets.reduce((sum, a) => sum + a.indices / 3, 0), 36 + 4 * 12, 'all map faces and all four robot visuals exported');
  const mapAssetIDs = new Set(scene.nodes.filter(n => n.role === 'map').map(n => n.asset));
  assert.equal(scene.assets.filter(a => mapAssetIDs.has(a.id) && a.indices === 0).reduce((sum, a) => sum + a.vertices, 0),
    loose.length, 'point-only map assets remain in the same scene as the mesh and robot');
  for (const node of scene.nodes.filter(n => n.name === '上臂' && n.asset)) {
    const asset = scene.assets.find(a => a.id === node.asset), rgb = new Uint8Array(buffers.get(asset.id), 32 + asset.vertices * 12, 3);
    assert.ok(rgb[0] > rgb[1] && rgb[1] > rgb[2], 'a single material applies to every geometry group');
  }
  const outside = await buildVisionScenePackage({ ...fixture, robotPose: { ...fixture.robotPose, position: { x: 10, y: 0, z: 0 } } });
  assert.ok(outside.bounds.max[0] > 10, 'framing includes robots outside the map bounds');
  for (const mutate of [s => { s.nodes[0].parent = 'missing'; }, s => { s.nodes[0].transform[15] = 0; },
    s => { s.nodes.find(n => n.joint).joint.axis = [0, 0, 0]; }, s => { s.assets[0].bounds = null; },
    s => { s.clips[0].segments[0].endOffsetMs++; }, s => { s.clips.push(s.clips[0]); },
    s => { s.nodes.find(n => n.material).material.roughness = 2; },
    s => { s.nodes.find(n => n.role === 'map').material = { roughness: 0.58, metallic: 0.16 }; }]) {
    const bad = structuredClone(scene); mutate(bad); assert.throws(() => validateVisionScene(bad));
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = base + '/__atlas/vision-scenes';
  ticket = await (await fetch(endpoint, { method: 'POST' })).json();
  const owner = { Authorization: `Bearer ${ticket.ownerToken}` };
  const publish = () => fetch(`${endpoint}/${ticket.id}/manifest`, { method: 'PUT', headers: owner, body: JSON.stringify(scene) });
  assert.equal((await publish()).status, 409, 'incomplete snapshots remain hidden');
  assert.equal((await (await fetch(endpoint)).json()).scenes.length, 0);
  const bad = Buffer.alloc(64, 7), badHash = createHash('sha256').update(bad).digest('hex');
  assert.equal((await fetch(`${endpoint}/${ticket.id}/assets/${badHash}`, { method: 'PUT', headers: owner, body: bad })).status, 400, 'malformed geometry cannot be published even with a matching hash');
  for (const [hash, buffer] of buffers) {
    assert.equal((await fetch(`${endpoint}/${ticket.id}/assets/${hash}`, { method: 'PUT', body: buffer })).status, 403);
    assert.equal((await fetch(`${endpoint}/${ticket.id}/assets/${hash}`, { method: 'PUT', headers: owner, body: buffer })).status, 200);
  }
  assert.equal((await publish()).status, 200);
  const offer = (await (await fetch(endpoint)).json()).scenes[0];
  assert.equal(offer.hasRobot, true); assert.equal(offer.clipCount, 1);
  assert.equal((await fetch(`${endpoint}/${ticket.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${offer.readToken}` } })).status, 403);
  assert.equal((await fetch(`${endpoint}/${ticket.id}/manifest`)).status, 403);
  scene.id = ticket.id;
  const expected = scene.clips[0].segments.flatMap(segment => [0, .25, .5, .95].map(progress => {
    const sample = sampleTeachingTrajectorySegment(segment, progress);
    applyRobotJointValues(fixture.robotModel, sample.robotJointValues);
    const p = sample.robotPose, placement = new THREE.Matrix4().compose(new THREE.Vector3(p.position.x, p.position.y, p.position.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rpy.roll * Math.PI / 180, p.rpy.pitch * Math.PI / 180, p.rpy.yaw * Math.PI / 180, 'ZYX')), new THREE.Vector3(1, 1, 1));
    return { milliseconds: segment.startOffsetMs + segment.durationMs * progress, pose: sample.robotPose, joints: sample.robotJointValues,
      tip: placement.clone().multiply(fixture.tip.matrixWorld).toArray(),
      cameras: Object.fromEntries(Object.entries(fixture.cameras).map(([side, node]) => [side, placement.clone().multiply(node.matrixWorld).toArray()])) };
  }));
  await writeFile(path.join(directory, 'scene.json'), JSON.stringify(scene));
  await writeFile(path.join(directory, 'expected.json'), JSON.stringify(expected));
  const binary = path.join(directory, 'native');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/AtlasTeaching/LANClient.swift',
    'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/AtlasTeaching/ModelGeometry.swift', 'vision/AtlasVisionTeaching/VisionPoseMath.swift',
    'vision/AtlasVisionTeaching/VisionMeshData.swift', 'ipad/AtlasTeaching/ZividFieldOfView.swift',
    'vision/AtlasVisionTeaching/VisionSceneModels.swift', 'vision/AtlasVisionTeaching/VisionSceneStore.swift',
    'vision/AtlasVisionTeaching/VisionScenePaths.swift', 'vision/AtlasVisionTeaching/VisionFloorGrid.swift', 'vision/Tests/VisionScenePathTests.swift',
    'vision/AtlasVisionTeaching/VisionSceneCameraRenderer.swift', 'vision/Tests/VisionSceneCameraTests.swift',
    'vision/AtlasVisionTeaching/VisionSurfaceRenderer.swift', 'vision/Tests/VisionSurfaceTests.swift',
    'vision/AtlasVisionTeaching/VisionSceneNavigation.swift', 'vision/AtlasVisionTeaching/VisionFloorPlacement.swift',
    'vision/AtlasVisionTeaching/VisionToolsPresentation.swift', 'vision/Tests/VisionToolsPresentationTests.swift',
    'vision/AtlasVisionTeaching/VisionRecallControl.swift', 'vision/Tests/VisionRecallControlTests.swift',
    'vision/AtlasVisionTeaching/VisionSceneMarkers.swift', 'vision/AtlasVisionTeaching/VisionParkingArrival.swift', 'vision/Tests/VisionParkingArrivalTests.swift',
    'vision/AtlasVisionTeaching/VisionObstacleProximity.swift', 'vision/Tests/VisionObstacleTests.swift',
    'vision/Tests/VisionFloorPlacementTests.swift', 'vision/Tests/VisionSceneTests.swift', '-o', binary]);
  await run(binary, [base, directory]);
  assert.equal(downloads, scene.assets.length + 1, 'native cache reuses valid assets and repairs exactly one corrupted asset');
  if (process.argv.includes('--ui')) {
    simulator = process.env.VISION_SIMULATOR_ID || Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])).devices).flat().find(d => d.name.includes('Vision Pro'))?.udid;
    assert.ok(simulator, 'Boot the visionOS simulator first'); await mkdir(artifacts, { recursive: true });
    const report = path.join(artifacts, `ui-${Date.now()}.xcresult`), log = createWriteStream(path.join(artifacts, 'ui.log'));
    try { await new Promise((resolve, reject) => {
      const child = spawn('xcodebuild', ['-project', 'vision/AtlasVisionTeaching.xcodeproj', '-scheme', 'AtlasVisionTeaching',
        '-destination', `platform=visionOS Simulator,id=${simulator}`, '-derivedDataPath', 'vision/build/scene-review', '-resultBundlePath', report,
        '-only-testing:AtlasVisionTeachingUITests/AtlasVisionTeachingUITests/testFullSceneReview', 'CODE_SIGNING_ALLOWED=NO', 'test'],
        { env: { ...process.env, TEST_RUNNER_ATLAS_SCENE_ADDRESS: base, TEST_RUNNER_ATLAS_SCENE_ID: ticket.id } });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`UI tests failed: ${artifacts}/ui.log`)));
    }); } finally { log.end(); }
    console.log(`Scene simulator report: ${report}`);
  }
  assert.equal((await fetch(`${endpoint}/${ticket.id}`, { method: 'DELETE', headers: owner })).status, 200);
  assert.equal((await (await fetch(endpoint)).json()).scenes.length, 0);
  assert.equal((await fetch(`${endpoint}/${ticket.id}/manifest`, { headers: { Authorization: `Bearer ${offer.readToken}` } })).status, 404);
  console.log('Vision scene passed: lossless mesh + point-cloud maps, complete hierarchy, transformed paths, authenticated snapshot lifecycle, native point rendering/download/cache and desktop/native playback parity.');
} finally {
  await new Promise(resolve => server.close(resolve));
  fixture.mapData.geometry.dispose(); disposeRobotModel(fixture.robotModel);
  await rm(directory, { recursive: true, force: true });
  if (simulator && scene) try {
    const root = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, 'com.atlasroute.teaching.vision', 'data'], { encoding: 'utf8' }).trim();
    const folder = path.join(root, 'Library/Application Support/AtlasVisionScenes');
    await rm(path.join(folder, `${scene.id}.json`), { force: true });
    const remaining = (await import('node:fs/promises')).readdir;
    const referenced = new Set(); let preserveAssets = false;
    for (const file of await remaining(folder)) if (file.endsWith('.json')) {
      try { for (const a of JSON.parse(await readFile(path.join(folder, file), 'utf8')).assets) referenced.add(a.id); } catch { preserveAssets = true; }
    }
    for (const a of scene.assets) if (!preserveAssets && !referenced.has(a.id)) await rm(path.join(folder, `${a.id}.atls`), { force: true });
  } catch { /* no installation if compilation failed */ }
}
