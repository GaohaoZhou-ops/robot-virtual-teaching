// Disposable LAN fixture for testModelTransferProgressAndRetry on an iPad.
// Run with ATLAS_PROGRESS_HOST=<Mac LAN IPv4>; copy the printed variables into
// the UI test's xctestrun EnvironmentVariables. Never uses the user's service.
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { packIPadModel } from '../src/lib/ipadTeaching.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-transfer-progress-'));
const middleware = createIPadTeachingService({ directory });
const positions = new Float32Array(524_288 * 3);
for (let i = 0; i < positions.length; i += 3) {
  positions[i] = (i % 300) / 1000; positions[i + 1] = (i % 999) / 3000; positions[i + 2] = (i % 99) / 1000;
}
const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
const { buffer, manifest } = await packIPadModel({ geometry, name: '进度验证（临时）', mapId: 'progress-fixture', sourceHash: 'progress-fixture' });
const model = Buffer.from(buffer);
let downloadAttempts = 0;
const server = createServer((req, res) => {
  const serve = () => middleware(req, res, () => { res.writeHead(404); res.end(); });
  if (req.method === 'POST' && req.url === '/__atlas/ipad/pair') { setTimeout(serve, 4000); return; }
  if (req.method === 'GET' && /^\/__atlas\/ipad\/sessions\/[\w-]+\/model$/.test(req.url)) {
    downloadAttempts++;
    if (downloadAttempts % 2 === 1) { res.writeHead(503); res.end(JSON.stringify({ error: '测试下载失败，请重试' })); return; }
    // Deliberately omit Content-Length to exercise manifest-based totals.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    let offset = 0;
    const timer = setInterval(() => {
      const end = Math.min(offset + 64 * 1024, model.length);
      res.write(model.subarray(offset, end)); offset = end;
      if (offset === model.length) { clearInterval(timer); res.end(); }
    }, 250);
    res.on('close', () => clearInterval(timer));
    return;
  }
  serve();
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/__atlas/ipad`;
const creationResponse = await fetch(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ manifest }) });
if (!creationResponse.ok) throw new Error(await creationResponse.text());
const creation = await creationResponse.json();
const uploadResponse = await fetch(`${base}/sessions/${creation.id}/model`, {
  method: 'PUT', headers: { Authorization: `Bearer ${creation.ownerToken}` }, body: model,
});
if (!uploadResponse.ok) throw new Error(await uploadResponse.text());
const environment = {
  ATLAS_PROGRESS_ADDRESS: `http://${process.env.ATLAS_PROGRESS_HOST || '127.0.0.1'}:${port}`,
  ATLAS_PROGRESS_CODE: creation.pairingCode,
  ATLAS_PROGRESS_SESSION: creation.id,
};
if (process.env.ATLAS_PROGRESS_ENV_FILE) await writeFile(process.env.ATLAS_PROGRESS_ENV_FILE, JSON.stringify(environment));
console.log(JSON.stringify(environment, null, 2));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); process.exit(0);
});
