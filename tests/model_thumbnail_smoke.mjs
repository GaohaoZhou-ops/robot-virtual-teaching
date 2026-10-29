import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three';
import { PNG } from 'pngjs';
import { packIPadModel } from "../src/features/devices/model/ipadTeaching.js";
import { modelThumbnail } from "../src/server/devices/modelThumbnail.js";
import { createIPadTeachingService } from "../src/server/devices/ipadTeachingService.js";

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-model-preview-'));
const middleware = createIPadTeachingService({ directory });
let downloads = 0;
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/model')) downloads++;
  middleware(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/__atlas/ipad`;
async function request(route, { method = 'GET', body, token, expected = 200 } = {}) {
  const response = await fetch(base + route, { method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body instanceof ArrayBuffer ? body : body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, expected);
  return response;
}
function checkPNG(data) {
  const image = PNG.sync.read(data);
  assert.equal(image.width, 384); assert.equal(image.height, 256);
  assert.ok(data.length < 512 * 1024);
  let foreground = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] !== 10 || image.data[i + 1] !== 19 || image.data[i + 2] !== 22) foreground++;
  assert.ok(foreground > 20, 'thumbnail contains actual model geometry');
}
try {
  const packed = await packIPadModel({ geometry: new BoxGeometry(1, 2, 3), name: 'thumbnail.ply', mapId: 'preview' });
  const task = await (await request('/sessions', { method: 'POST', body: { manifest: packed.manifest }, expected: 201 })).json();
  await request(`/sessions/${task.id}/model`, { method: 'PUT', body: packed.buffer, token: task.ownerToken });
  await request(`/sessions/${task.id}/thumbnail`, { expected: 401 });
  await request(`/sessions/${task.id}/thumbnail`, { token: task.ownerToken, expected: 401 });
  const paired = await (await request('/pair', { method: 'POST', body: { code: task.pairingCode, deviceId: randomUUID() } })).json();
  const response = await request(`/sessions/${task.id}/thumbnail`, { token: paired.deviceToken });
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-model-sha256'), packed.manifest.modelHash);
  const image = Buffer.from(await response.arrayBuffer()); checkPNG(image);
  const cached = await request(`/sessions/${task.id}/thumbnail`, { token: paired.deviceToken });
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), image);
  assert.deepEqual(await readFile(path.join(directory, task.id, 'model.atls')), Buffer.from(packed.buffer));
  assert.equal(downloads, 0, 'preview never downloads the full model to the device');
  const cloud = new BufferGeometry(); cloud.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 1, 0, 2, 0, 1, 2, 1], 3));
  const points = await packIPadModel({ geometry: cloud, name: 'cloud' });
  checkPNG(await modelThumbnail(Buffer.from(points.buffer)));
  console.log('Authenticated mesh/point thumbnails, bounded images, cache reuse and zero full-model downloads passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
