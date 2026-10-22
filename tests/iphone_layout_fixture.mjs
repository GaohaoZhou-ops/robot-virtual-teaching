// Generate isolated projects for native iPhone UI tests. Never installs or edits
// a device's existing projects; copy these files into the test app container.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BoxGeometry, Matrix4 } from 'three';
import { packIPadModel } from '../src/lib/ipadTeaching.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node tests/iphone_layout_fixture.mjs <output-directory>');
await mkdir(output, { recursive: true });
const geometry = new BoxGeometry(0.4, 0.3, 0.25, 16, 12, 10);
const { buffer, manifest } = await packIPadModel({ geometry, name: process.argv[3] || 'UI-iPhone-Adaptation',
  mapId: 'iphone-layout-fixture', sourceHash: 'iphone-layout-fixture' });
const id = randomUUID(), segmentId = randomUUID(), now = new Date().toISOString();
const result = { protocol: 'atlas-ipad-teaching/1', id: randomUUID(), sessionId: id,
  modelHash: manifest.modelHash, coordinateFrame: 'virtual_origin', createdAt: now,
  device: { model: 'iPhone 15 Pro Max', lidar: true, platform: 'iOS', poseSource: 'camera' },
  calibrations: [{ id: segmentId, capturedAt: now, worldFromModel: new Matrix4().makeRotationX(-Math.PI / 2).toArray(),
    referencePoint: { x: 0, y: 0, z: 0 }, yawDegrees: 0 }],
  samples: Array.from({ length: 8 }, (_, index) => ({ id: randomUUID(), name: `Pose ${String(index + 1).padStart(3, '0')}`,
    segmentId, capturedAt: now, kind: 'keyframe', tracking: 'normal', origin: 'ipad',
    cameraPose: { frameName: 'ipad_camera_optical_frame', position: { x: (index - 4) * 0.02, y: 0, z: 0.8 },
      quaternion: { x: 1, y: 0, z: 0, w: 0 } } })) };
await writeFile(path.join(output, `${id}.json`), JSON.stringify({ serverURL: '', session: { id, deviceToken: '', manifest }, result }));
await writeFile(path.join(output, `${id}.atls`), new Uint8Array(buffer));
geometry.dispose();
console.log(id);
