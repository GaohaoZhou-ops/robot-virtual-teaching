import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix4, Scene, Vector3 } from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { setTimeout as delay } from 'node:timers/promises';
import { robotPedestrianSnapshot } from '../../src/shared/protocols/robotTwinPedestrians.js';
import { RobotTwinPedestriansClient } from '../../src/features/robot-twin/client/robotTwinPedestriansClient.js';
import { RobotTwinPedestriansLayer } from '../../src/features/robot-twin/model/robotTwinPedestriansLayer.js';
import { ROBOT_PEDESTRIAN_MODEL_URL } from '../../src/features/robot-twin/model/robotTwinPedestrianGeometry.js';

const raw = () => ({ ok: true, mode: 'resident', enabled: true, ready: true, state: 'running', frame: 'base_link',
  captured_at_ms: 1793800000000, ttl_ms: 600, result_age_ms: 20, source_age_ms: 50,
  boxes: [{ label: 'person', center_m: [2, 1, .9], size_m: [.5, .6, 1.8], yaw_rad: .3, score: .85 }] });
const result = robotPedestrianSnapshot(raw(), 30);
assert.equal(result.validForMs, 500);
assert.equal(result.sampleAgeMs, 100);
assert.equal(result.boxes.length, 1);
assert.equal(robotPedestrianSnapshot(raw(), 600).boxes.length, 0);
assert.equal(robotPedestrianSnapshot({ ...raw(), state: 'waiting', boxes: [] }).phase, 'waiting');
assert.equal(robotPedestrianSnapshot({ ...raw(), enabled: false, ready: false }).boxes.length, 0);
assert.equal(robotPedestrianSnapshot({ ...raw(), mode: 'on_demand' }).phase, 'unavailable');
assert.equal(robotPedestrianSnapshot({ ...raw(), boxes: [] }).phase, 'live', 'fresh zero detections differ from unavailable');
for (const patch of [{ frame: 'map' }, { ttl_ms: 1600 }, { result_age_ms: null }, { source_age_ms: -1 },
  { captured_at_ms: NaN }, { boxes: Array(129).fill(raw().boxes[0]) }]) {
  assert.throws(() => robotPedestrianSnapshot({ ...raw(), ...patch }));
}
for (const patch of [{ center_m: [1, NaN, 0] }, { size_m: [1, 0, 1] }, { score: 2 }, { yaw_rad: Infinity }, { label: 'car' }]) {
  assert.throws(() => robotPedestrianSnapshot({ ...raw(), boxes: [{ ...raw().boxes[0], ...patch }] }));
}

const asset = await readFile(ROBOT_PEDESTRIAN_MODEL_URL);
const geometry = new PLYLoader().parse(asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength));
geometry.computeBoundingBox();
const dimensions = geometry.boundingBox.getSize(new Vector3());
assert.ok(Math.abs(dimensions.z - 1) < 1e-6 && Math.abs(geometry.boundingBox.min.z) < 1e-6, 'asset is height-normalized and grounded at the feet');
assert.ok(dimensions.x > .15 && dimensions.x < .25 && dimensions.y > .25 && dimensions.y < .4, 'natural depth and shoulder/hand span survive preprocessing');
assert.ok(geometry.index.count / 3 > 5000 && geometry.index.count / 3 <= 12000, 'the detailed human stays within the instancing budget');
assert.equal(geometry.getAttribute('normal').count, geometry.getAttribute('position').count);
let geometryLoads = 0;
const scene = new Scene(), layer = new RobotTwinPedestriansLayer(scene, {
  loadGeometry: async () => { geometryLoads++; return geometry.clone(); },
}), heightOffsets = new Map();
assert.equal(geometryLoads, 0, 'offline scenes do not load the pedestrian model');
const robot = { id: 'a', localizationFresh: true, motionSample: { time: 0, sourceTime: 0, id: 1 },
  pose: { position: { x: 10, y: 20, z: .2 }, rpy: { yaw: 90 } },
  pedestrians: { ...result, enabled: true, generation: 1,
    frame: { id: result.sampleId, receivedAt: 0, sourceTime: 0, boxes: result.boxes } } };
const original = structuredClone(robot), robots = [robot];
try {
  layer.update(robots, true, heightOffsets, 10);
  assert.equal(layer.mesh.visible, false, 'wait for the real mesh instead of displaying a primitive fallback');
  await layer.loading;
  layer.update(robots, true, heightOffsets, 10);
  assert.equal(layer.mesh.count, 1);
  assert.equal(layer.mesh.geometry, layer.heldMesh.geometry, 'fresh and retained people share one mesh');
  assert.equal(layer.mesh.material.color.getHexString(), 'ffffff');
  assert.equal(layer.heldMesh.material.color.getHexString(), 'ffffff');
  assert.ok(layer.heldMesh.material.transparent);
  const p = layer.positions[0];
  assert.ok(Math.abs(p.x - 9) < 1e-9 && Math.abs(p.y - 22) < 1e-9, 'rotate base_link XY by SLAM yaw, then translate');
  assert.ok(Math.abs(p.z - .2) < 1e-9 && Math.abs(p.yaw - Math.PI / 2 - .3) < 1e-9);
  const matrix = new Matrix4(); layer.mesh.getMatrixAt(0, matrix);
  const scale = new Vector3().setFromMatrixScale(matrix);
  assert.ok(scale.toArray().every((value) => Math.abs(value - 1.8) < 1e-6), 'box width/depth cannot distort the head and limbs');
  const top = new Vector3(0, 0, 1).applyMatrix4(matrix);
  assert.ok(Math.abs(top.z - 2) < 1e-6, 'human height comes from box dimensions, feet from the bottom of the box');
  const version = layer.mesh.instanceMatrix.version;
  layer.update(robots, true, heightOffsets, 20);
  assert.equal(geometryLoads, 1, 'new observations reuse the loaded asset');
  assert.equal(layer.mesh.instanceMatrix.version, version, 'unchanged frames reuse geometry and transforms');
  heightOffsets.set('a', -.1); layer.dirty = true;
  layer.update(robots, true, heightOffsets, 30);
  assert.ok(Math.abs(layer.positions[0].z - .1) < 1e-9);
  assert.deepEqual(robot, original, 'rendering must not write into offline or telemetry poses');
  layer.update(robots, true, heightOffsets, 601);
  assert.equal(layer.mesh.count, 1); assert.equal(layer.heldMesh.count, 0, 'one missed poll keeps the solid presentation');
  layer.update(robots, true, heightOffsets, 1700);
  assert.equal(layer.mesh.count, 0); assert.equal(layer.heldMesh.count, 1, 'briefly missing detections use a dim material');
  assert.ok(Math.abs(layer.heldOpacity.getX(0) - .5) < 1e-6);
  assert.equal(layer.heldDepthMesh.count, 1);
  assert.equal(layer.heldDepthMesh.visible, true);
  assert.equal(layer.heldDepthMesh.geometry, layer.heldMesh.geometry);
  assert.equal(layer.heldDepthMesh.instanceMatrix, layer.heldMesh.instanceMatrix, 'surface and fade transforms cannot drift');
  layer.update(robots, true, heightOffsets, 2200);
  assert.equal(layer.positions.length, 0, 'retention has a hard deadline, even if the client stops updating');
  assert.equal(layer.heldDepthMesh.count, 0);
  assert.equal(layer.heldDepthMesh.visible, false, 'expired people must not leave invisible occluders');
  const next = { ...robot, motionSample: { time: 2500, sourceTime: 2500, id: 2 },
    pedestrians: { ...robot.pedestrians, generation: 2,
      frame: { id: 'next', receivedAt: 2500, sourceTime: 2500, boxes: result.boxes } } };
  layer.update([next], true, heightOffsets, 2500);
  assert.equal(layer.positions.length, 1);
  layer.update([{ ...next, localizationFresh: false }], true, heightOffsets, 2510);
  assert.equal(layer.positions.length, 0, 'localization loss clears held and live models immediately');
  layer.update([next], true, heightOffsets, 2520);
  assert.equal(layer.positions.length, 0, 'restored localization does not revive the old detection frame');
  layer.update(robots, false, heightOffsets, 2600);
  assert.equal(layer.mesh.count, 0);
} finally { layer.dispose(); }
assert.equal(scene.children.length, 0);

// Leaving a scene while the local asset is loading must not revive its meshes
// or retain a geometry that has no owner to dispose it.
let finishGeometry;
const pendingLayer = new RobotTwinPedestriansLayer(scene, {
  loadGeometry: () => new Promise((resolve) => { finishGeometry = resolve; }),
});
pendingLayer.update(robots, true, heightOffsets, 10);
const loading = pendingLayer.loading;
await Promise.resolve();
pendingLayer.dispose();
const lateGeometry = geometry.clone();
let lateDisposed = false;
lateGeometry.addEventListener('dispose', () => { lateDisposed = true; });
finishGeometry(lateGeometry);
await loading;
assert.equal(lateDisposed, true);
assert.equal(scene.children.length, 0);
assert.equal(pendingLayer.mesh.visible, false);
geometry.dispose();

// A transport that deliberately resolves after cancellation must not revive an
// old frame or create another poll. Also cover a rapid off/on round trip.
const requests = [];
const client = new RobotTwinPedestriansClient({ getPose: () => ({ x: 1, y: 2, yaw: 0 }),
  request: (path, { signal }) => new Promise((resolve) => requests.push({ path, signal, resolve })) });
assert.equal(requests.length, 0);
client.setEnabled(true);
assert.equal(requests.length, 1);
client.setEnabled(false); assert.equal(requests[0].signal.aborted, true);
client.setEnabled(true); assert.equal(requests.length, 2);
requests[0].resolve(result); await delay(0);
assert.equal(client.state.phase, 'loading');
requests[1].resolve({ ...result, validForMs: 40 }); await delay(0);
assert.equal(client.state.phase, 'live');
const acceptedFrame = client.state.frame;
await delay(50); assert.equal(client.state.boxes.length, 0);
assert.equal(client.state.frame, acceptedFrame, 'a presentation frame survives network expiry without renewing its timestamp');
client.setVisible(false); assert.equal(client.state.enabled, true); assert.equal(client.state.phase, 'paused');
await delay(550); assert.equal(requests.length, 2, 'background tabs perform no reads');
client.setVisible(true); assert.equal(requests.length, 3);
client.reset(); requests[2].resolve(result); await delay(0);
assert.equal(client.state.enabled, false); assert.equal(client.state.boxes.length, 0);
assert.equal(client.state.frame, null);

const ticks = [];
const clocked = new RobotTwinPedestriansClient({ externallyClocked: true, getPose: () => ({ x: 0, y: 0, yaw: 0 }),
  request: () => { ticks.push(performance.now()); return Promise.resolve(result); } });
clocked.setEnabled(true); await delay(30);
assert.equal(ticks.length, 0, 'enabling waits for the robot telemetry clock');
clocked.tick(); await delay(0); assert.equal(ticks.length, 1);
clocked.tick(); await delay(20); assert.equal(ticks.length, 1, 'early telemetry ticks cannot increase upstream rate');
await delay(520); assert.equal(ticks.length, 1, 'no independent pedestrian timer');
clocked.tick(); await delay(0); assert.equal(ticks.length, 2);
clocked.nextDue = performance.now() + 25;
clocked.tick(); await delay(35); assert.equal(ticks.length, 3, 'minor rate-window skew must not drop a full telemetry cycle');
clocked.reset();
console.log('Pedestrians: ABX validation, TTL, map coordinates, detailed white model, uniform proportions, lazy asset lifecycle, stale localization, cancellation and visibility passed.');
