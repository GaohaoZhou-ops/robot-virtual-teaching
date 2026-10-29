import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakeRobotServer } from "../../scripts/lib/fake_robot_server.mjs";
import { createRobotTwinService } from "../../src/server/robots/robotTwinService.js";
import { RobotTwinClient } from "../../src/features/robot-twin/client/robotTwinClient.js";

const robot = createFakeRobotServer();
const handler = robot.listeners('request')[0]; robot.removeAllListeners('request');
let old = false, reads = 0;
robot.on('request', async (req, res) => {
  if (['/api/v1/slam', '/api/v1/state'].includes(req.url)) {
    reads++;
    await delay(400);
    const end = res.end.bind(res), head = res.writeHead.bind(res);
    let status, headers;
    res.writeHead = (code, values) => { status = code; headers = values; return res; };
    res.end = (bytes, ...args) => {
      const payload = JSON.parse(bytes);
      if (payload.sample) payload.age_ms = old ? 1800 : 400;
      if (payload.robot) payload.robot.state_age_ms = old ? 1800 : 400;
      bytes = Buffer.from(JSON.stringify(payload));
      head(status, { ...headers, 'Content-Length': bytes.length }); return end(bytes, ...args);
    };
  }
  void handler(req, res);
});
const service = createRobotTwinService();
const proxy = createServer((req, res) => service(req, res, () => { res.writeHead(404); res.end(); }));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await listen(robot); await listen(proxy);
const phases = [];
const client = new RobotTwinClient({ request: (path, options) => fetch(`http://127.0.0.1:${proxy.address().port}${path}`, options),
  onChange: (state) => phases.push(state.phase) });
const until = async (predicate) => {
  const until = Date.now() + 6000;
  while (!predicate()) { assert.ok(Date.now() < until, 'timed out waiting for telemetry'); await delay(20); }
};
try {
  assert.equal(await client.connect(`127.0.0.1:${robot.address().port}`, 'admin'), true);
  assert.equal(client.state.phase, 'live', 'session setup must not be charged against a snapshot created at the end');
  const start = phases.length, before = reads;
  await delay(3100);
  assert.ok(phases.slice(start).every((phase) => phase === 'live'), '400 ms upstream reads must not charge the same wait twice');
  assert.ok(reads - before <= 14, 'pose/state reads stay at no more than about 2 Hz per endpoint');
  old = true;
  await until(() => client.state.phase === 'stale');
  assert.ok(client.state.active && client.token, 'stale data does not destroy the session');
  old = false;
  await until(() => client.state.phase === 'live');
  client.disconnect();
  await delay(500);
  const stopped = reads;
  await delay(700);
  assert.equal(reads, stopped);
  console.log('Robot freshness: slow setup/reads, no duplicate aging, bounded polling, real expiry, recovery and stop passed.');
} finally {
  client.disconnect(); await service.close();
  await Promise.all([proxy, robot].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
}
