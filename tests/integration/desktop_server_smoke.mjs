import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDesktopServer } from '../../desktop/server.mjs';
import { atlasWorkspacePlugin } from '../../src/server/workspace/workspaceService.js';
import { createReleaseClock } from '../../desktop/release-policy.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-desktop-server-'));
let server;
try {
  await mkdir(path.join(directory, 'web/assets'), { recursive: true });
  await mkdir(path.join(directory, 'robots/demo'), { recursive: true });
  await writeFile(path.join(directory, 'web/index.html'), '<html>desktop</html>');
  await writeFile(path.join(directory, 'web/assets/app.js'), 'window.loaded=true');
  await writeFile(path.join(directory, 'web/assets/app.js.map'), '{}');
  await writeFile(path.join(directory, 'robots/demo/robot.urdf'), '<robot name="demo"/>');
  const start = Date.now(); let now = start, closed = false;
  const releaseClock = createReleaseClock({ version: '1.0.0', buildId: 'server.1', builtAt: new Date(start).toISOString(),
    expiresAt: new Date(start + 60000).toISOString(), warnBeforeDays: 7 }, { wallNow: () => now, monotonicNow: () => 0 });
  server = await startDesktopServer({ resources: directory, userData: directory, key: 'local-secret', releaseClock, host: '127.0.0.1',
    plugins: [atlasWorkspacePlugin(), { configureServer({ middlewares }) {
      middlewares.use((req, res, next) => { if (req.url === '/__atlas/work-sync/mutate') { res.end('changed'); return; } next(); });
    }, closeBundle() { closed = true; } }] });
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (url, init = {}) => fetch(origin + url, { headers: { 'X-Atlas-Desktop-Key': 'local-secret' }, ...init });
  assert.equal((await fetch(origin)).status, 403, 'external browsers cannot read bundled UI');
  assert.equal((await fetch(origin + '/assets/app.js')).status, 403);
  assert.equal((await request('/model-editor/dual')).status, 200, 'deep links use SPA shell');
  assert.equal((await request('/assets/app.js.map')).status, 404, 'source maps cannot be served');
  assert.equal((await request('/assets/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await request('/__atlas/robots').then(r => r.json())).robots[0].name, 'demo');
  assert.equal((await request('/__atlas/work-sync/mutate', { method: 'POST' })).status, 200);
  now = start + 60000; server.refreshPolicy();
  assert.ok(closed, 'collaboration is stopped at expiry');
  assert.equal((await request('/__atlas/work-sync/mutate', { method: 'POST' })).status, 403);
  assert.equal((await request('/__atlas/release').then(r => r.json())).status, 'expired');
  assert.equal((await request('/__atlas/robot-files/demo/robot.urdf')).status, 200, 'backup can still read robot resources');
  assert.equal((await request('/__atlas/session')).status, 200, 'cached workspace can restore after expiry');
  console.log('Desktop service: protected assets, routes, cutoff enforcement and backup resources passed.');
} finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
