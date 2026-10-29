import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute, Matrix4 } from 'three';
import { buildIPadPoseSeed } from "../src/features/devices/model/ipadPoseSeed.js";
import { packIPadModel } from "../src/features/devices/model/ipadTeaching.js";
import { validateIPadPoseSeed, ipadPoseArm } from "../src/shared/protocols/ipadProtocol.js";

const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 1, 1, 0, 1, 0, 1, 1], 3));
geometry.setIndex([0, 1, 2]);
const map = { geometry, mapId: 'origin-map', sourceHash: 'origin-source', name: 'origin.ply' };
const packed = await packIPadModel(map);
const camera = { frameName: 'zivid_left_optical_frame', position: { x: 1, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
const task = { map: { id: map.mapId, sourceHash: map.sourceHash }, coordinateFrame: 'virtual_origin', parkingPoints: [{ poses: [
  { name: 'Captured', cameraCapture: { frames: { left: { opticalPose: camera }, right: { opticalPose: camera } } } },
  { name: 'Planned', opticalTargets: { left: camera } },
  { name: 'Base only', mapPose: { position: camera.position } },
] }] };
const mobile = { map: task.map, coordinateFrame: 'virtual_origin', mobileTransform: new Matrix4().makeRotationZ(Math.PI / 2).setPosition(3, 4, 0).toArray(),
  mobileCapture: { modelHash: packed.manifest.modelHash, samples: [{ name: 'Previous iPad', kind: 'keyframe',
    cameraPose: { ...camera, frameName: 'ipad_camera_optical_frame' }, surfacePoint: { x: 2, y: 0, z: 0 } }] } };
const seed = buildIPadPoseSeed([task, mobile, { ...task, map: { id: 'foreign', sourceHash: 'other' } },
  { ...task, coordinateFrame: 'map' }], map, packed.manifest);
assert.equal(seed.samples.length, 4, 'only optical poses in this workpiece frame are synchronized');
assert.equal(new Set(seed.samples.map((s) => s.id)).size, 4);
assert.ok(seed.samples.every((s) => s.cameraPose.frameName === 'ipad_camera_optical_frame'));
assert.deepEqual(seed.samples.map((s) => s.origin), ['desktop', 'desktop', 'desktop', 'ipad'],
  'original teaching source survives a round trip through the Mac');
assert.deepEqual(seed.samples.map(ipadPoseArm), ['left', 'right', 'left', undefined]);
assert.equal(ipadPoseArm({ origin: 'desktop', name: 'Pose 001 · 右相机' }), 'right', 'already downloaded poses remain identifiable');
assert.equal(ipadPoseArm({ origin: 'ipad', name: 'Pose 001 · 右相机' }), undefined, 'names cannot turn an iPad recording into an arm pose');
const returningMac = { ...mobile, mobileCapture: { ...mobile.mobileCapture, samples: [seed.samples[1]] } };
assert.equal(buildIPadPoseSeed([returningMac], map, packed.manifest).samples[0].arm, 'right', 'arm metadata survives a round trip');
assert.deepEqual(seed.samples.at(-1).cameraPose.position, { x: 3, y: 5, z: 0 }, 'desktop placement transforms mobile poses into this model frame');
assert.deepEqual(seed.samples.at(-1).surfacePoint, { x: 3, y: 6, z: 0 });
assert.ok(Math.abs(seed.samples.at(-1).cameraPose.quaternion.z - Math.SQRT1_2) < 1e-10);
assert.equal(buildIPadPoseSeed([], map, packed.manifest), undefined, 'empty models retain the legacy transfer format');
assert.equal((await packIPadModel({ ...map, teachingTasks: [task] })).manifest.modelHash, packed.manifest.modelHash,
  'Pose metadata never changes the geometry fingerprint');
for (const mutate of [s => { s.samples[0].origin = 'unknown'; }, s => { s.samples[0].cameraPose.position.x = Infinity; },
  s => { s.samples[0].arm = 'both'; }, s => { s.samples[3].arm = 'left'; },
  s => { s.samples[1].id = s.samples[0].id; }, s => { s.samples[0].cameraPose.quaternion.w = 2; }]) {
  const invalid = structuredClone(seed); mutate(invalid);
  assert.throws(() => validateIPadPoseSeed(invalid, packed.manifest));
}
geometry.dispose();
console.log('Mac Pose origins: workpiece filtering, optical axes, transformed references, validation and unchanged geometry hash passed.');
