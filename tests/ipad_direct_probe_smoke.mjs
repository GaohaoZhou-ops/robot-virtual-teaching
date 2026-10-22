import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { advertiseIPadService } from '../src/server/ipadDiscovery.js';

const directory = await mkdtemp(path.join(tmpdir(), 'atlas-directed-probe-'));
const id = randomUUID(), otherID = randomUUID();
const requests = [];
const servers = [];
const makeServer = (name, respond) => {
  const server = createServer((request, response) => {
    requests.push({ name, method: request.method, path: request.url });
    respond(request, response, server);
  });
  servers.push(server); return server;
};
const info = (server, serverId = id, protocol = 'atlas-ipad-teaching/1') => ({
  protocol, serverId, serverName: 'Directed Probe Test', port: server.address().port,
});
const sendInfo = (response, server, serverId = id, protocol) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(info(server, serverId, protocol)));
};
const target = makeServer('target', (_request, response, server) => sendInfo(response, server));
const unrelated = makeServer('unrelated', (_request, response, server) => sendInfo(response, server, otherID));
const wrong = makeServer('wrong', (_request, response, server) => sendInfo(response, server, otherID, 'other/1'));
const slow = makeServer('slow', (_request, response, server) => {
  const timer = setTimeout(() => sendInfo(response, server), 2000);
  response.once('close', () => clearTimeout(timer));
});
const hanging = makeServer('hanging', () => {});
const trickling = makeServer('trickling', (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.write('{');
  const timer = setInterval(() => response.write(' '), 100);
  response.once('close', () => clearInterval(timer));
});
const address = server => `http://127.0.0.1:${server.address().port}`;
const redirect = makeServer('redirect', (_request, response) => {
  response.writeHead(302, { Location: `${address(unrelated)}/__atlas/ipad/info` }); response.end();
});
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
});
let stopAdvertisement;
try {
  const binary = path.join(directory, 'probe-test');
  await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift',
    'ipad/AtlasTeaching/LANClient.swift', 'ipad/AtlasTeaching/LANServiceDiscovery.swift',
    'ipad/Tests/DirectedDiscoveryTests.swift', '-o', binary]);
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '0.0.0.0', resolve))));
  stopAdvertisement = advertiseIPadService(unrelated, { serverId: otherID, serverName: 'Unselected Atlas Server' });
  await run(binary, [id, ...[target, wrong, hanging, trickling, redirect, slow].map(address)]);
  assert.ok(requests.filter(request => request.name === 'target').length >= 2);
  assert.equal(requests.filter(request => request.name === 'unrelated').length, 0,
    'an advertised server at another address/port is never probed, including through a redirect');
  assert.ok(requests.every(request => request.method === 'GET' && request.path === '/__atlas/ipad/info'),
    'detection only reads the requested service identity');
} finally {
  stopAdvertisement?.();
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  })));
  await rm(directory, { recursive: true, force: true });
}
