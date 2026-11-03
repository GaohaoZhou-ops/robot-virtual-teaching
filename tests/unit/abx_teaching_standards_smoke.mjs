import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { buildAbxTeachingArchive } from '../../src/features/teaching/model/abxTeachingExport.js';
import { parseAbxTeachingTask } from '../../src/features/teaching/model/abxTeachingImport.js';
import { teachingCloudXyzbin, teachingStandardAvailability } from '../../src/features/teaching/model/abxTeachingStandards.js';
import { abxTeachingStandardsFixture } from '../abx_teaching_standards_helpers.mjs';

const { payload, robotPackage, frame } = abxTeachingStandardsFixture();
const original = structuredClone(payload);
const json = (value) => JSON.parse(new TextDecoder().decode(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const build = (options, source = payload) => buildAbxTeachingArchive(source, { robotPackage, ...options });
const bare = await build({});
const bareManifest = json(bare.files['manifest.json']);
assert.deepEqual(teachingStandardAvailability(payload), { poseCount: 3, imageCount: 3, cloudCount: 2, missingImages: 3, missingClouds: 4 });
const bundles = [];
for (const [includeStandards, includeClouds] of [[false, false], [true, false], [false, true], [true, true]]) {
  const result = await build({ includeStandards, includeClouds });
  bundles.push(result);
  const manifest = json(result.files['manifest.json']);
  assert.equal(manifest.standards?.length || 0, includeStandards ? 3 : 0);
  assert.equal(manifest.clouds?.length || 0, includeClouds ? 2 : 0);
  assert.equal(manifest.include_images, false, 'standard references are not execution capture history');
  assert.deepEqual(manifest.tasks, bareManifest.tasks);
  assert.deepEqual(result.navigation, bare.navigation);
  for (const entry of [...manifest.standards || [], ...manifest.clouds || []]) {
    const data = result.files[entry.path];
    assert.equal(data.length, entry.bytes);
    assert.equal(hash(data), entry.sha256);
    assert.equal(entry.metadata.simulated, true);
    if (entry.kind === 'xyzbin') {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      assert.equal(new TextDecoder().decode(data.slice(0, 8)), 'ABXXYZ1\0');
      assert.equal(view.getUint32(8, true), 3); assert.equal(view.getUint32(12, true), 1);
      for (const [i, expected] of [-200, 110, 1255.35].entries()) assert.ok(Math.abs(view.getFloat32(16 + i * 4, true) - expected) < 0.001);
    } else {
      const png = PNG.sync.read(Buffer.from(data));
      assert.equal(png.width, 2); assert.equal(png.height, 1);
      assert.deepEqual([...png.data], [240, 30, 20, 255, 10, 80, 230, 255]);
    }
  }
  for (const task of manifest.tasks) {
    const parsed = await parseAbxTeachingTask(new TextDecoder().decode(result.files[task.file]));
    const source = await parseAbxTeachingTask(new TextDecoder().decode(bare.files[task.file]));
    assert.deepEqual(parsed.header, source.header);
    const restored = parsed.lines.map(JSON.parse).map((row) => {
      if (row.record?.standard_images) {
        const reference = row.record.standard_images;
        const associated = [...manifest.standards || [], ...manifest.clouds || []].filter((asset) => asset.id === reference.id);
        assert.ok(associated.length);
        assert.deepEqual([...new Set(associated.map((asset) => asset.camera))].sort(), reference.cameras);
        assert.deepEqual(associated.filter((asset) => asset.kind === 'xyzbin').map((asset) => asset.camera).sort(), reference.cloud_cameras || []);
        assert.ok(['姿态 a1', '姿态 a2'].includes(row.label), 'assets must attach to the right pose after navigation insertion/sorting');
        delete row.record.standard_images;
      }
      return row;
    });
    assert.deepEqual(restored, source.lines.map(JSON.parse), 'motion records, routes, counts and ordering must remain unchanged');
  }
}
assert.deepEqual(bundles[0].bytes, bare.bytes, 'unchecked choices retain the existing export');
assert.deepEqual(payload, original, 'export leaves captures, poses and workspace untouched');
assert.deepEqual((await build({ includeStandards: true, includeClouds: true })).bytes, bundles[3].bytes, 'same capture produces stable IDs/hashes');
const moved = structuredClone(payload);
moved.virtualTeaching.tasks[0].parkingPoints[1].poses[1].cameraCapture.frames.left.opticalPose.position.x += 2000;
assert.deepEqual((await build({ includeClouds: true }, moved)).bytes, bundles[2].bytes, 'world/display transforms must not affect camera-local XYZ');

const duplicateId = structuredClone(payload);
const secondParkingPose = duplicateId.virtualTeaching.tasks[0].parkingPoints[0].poses[0];
secondParkingPose.id = 'a1';
secondParkingPose.cameraCapture = { frames: { right: structuredClone(frame) } };
const duplicateBundle = await build({ includeClouds: true }, duplicateId);
const duplicateTask = await parseAbxTeachingTask(new TextDecoder().decode(duplicateBundle.files[bareManifest.tasks[0].file]));
assert.deepEqual(duplicateTask.points.filter((point) => point.record.standard_images).map((point) => point.label), ['姿态 a1', '姿态 b1']);

const corrupt = structuredClone(payload);
corrupt.virtualTeaching.tasks[0].parkingPoints[1].poses[1].cameraCapture.frames.left.pointCloud.positionData = 'AAAA';
await assert.rejects(build({ includeClouds: true }, corrupt), /姿态 a1 · 左相机.*长度与点数/);
await build({ includeStandards: true }, corrupt); // An unselected cloud cannot block PNG export.
const corruptImage = structuredClone(payload);
corruptImage.virtualTeaching.tasks[0].parkingPoints[1].poses[1].cameraCapture.frames.left.rgb.dataUrl = 'data:image/png;base64,YmFk';
await assert.rejects(build({ includeStandards: true }, corruptImage), /姿态 a1 · 左相机.*PNG/);
await build({ includeClouds: true }, corruptImage);
for (const change of [c => { c.positionEncoding = 'float32'; }, c => { c.convention = 'map'; },
  c => { c.positionOffset[0] = Infinity; }, c => { c.positionScale[0] = -1; }, c => { c.pointCount = 10000001; }]) {
  const cloud = structuredClone(frame.pointCloud); change(cloud);
  assert.throws(() => teachingCloudXyzbin(cloud));
}
const changed = structuredClone(payload);
changed.virtualTeaching.tasks[0].parkingPoints[1].poses[1].cameraCapture.frames.left.pointCloud.positionOffset[0] += 0.001;
assert.notEqual(json((await build({ includeClouds: true }, changed)).files['manifest.json']).clouds[0].id,
  json(bundles[2].files['manifest.json']).clouds[0].id, 're-captures get new resource identities');
const cancelled = new AbortController();
await assert.rejects(build({ includeClouds: true, signal: cancelled.signal, onProgress: () => cancelled.abort() }), { name: 'AbortError' });
await assert.rejects(build({ includeClouds: true, taskVersion: 11 }), /v11/);
console.log('Standard PNG/XYZ choices, optical coordinates/units, hashes, pose mapping, missing/corrupt assets and cancellation passed.');
