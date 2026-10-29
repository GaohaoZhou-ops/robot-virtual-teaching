import assert from 'node:assert/strict';
import { RobotTwinCameraClient } from "../../src/features/robot-twin/client/robotTwinCameraClient.js";

const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const allocated = new Set();
URL.createObjectURL = (blob) => { const url = originalCreate(blob); allocated.add(url); return url; };
URL.revokeObjectURL = (url) => { allocated.delete(url); originalRevoke(url); };
let sequence = 0, receive, decode, fail;
const client = new RobotTwinCameraClient({
  request: async (path) => {
    if (path === '/camera') return {};
    if (receive) await receive;
    if (fail) throw fail;
    return { blob: new Blob(['fixture'], { type: 'image/jpeg' }), headers: new Headers({
      'X-Atlas-Camera': 'head-left', 'X-Atlas-Camera-Revision': String(client.epoch),
      'X-Atlas-Frame-Sequence': String(++sequence), 'X-Atlas-Frame-Width': '640', 'X-Atlas-Frame-Height': '480',
    }) };
  },
  decode: async () => { if (decode) await decode; },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = async () => { clearTimeout(client.timer); await client.frame(client.epoch); clearTimeout(client.timer); };
try {
  client.publish({ cameras: [{ id: 'head-left', available: true }], selected: 'head-left' });
  await client.start(); await tick(); clearTimeout(client.timer);
  const first = client.state.imageUrl;
  assert.ok(first && allocated.has(first));
  let received, decoded;
  receive = new Promise((resolve) => { received = resolve; });
  decode = new Promise((resolve) => { decoded = resolve; });
  const pending = frame();
  await tick();
  assert.equal(client.state.imageUrl, first, 'download occurs behind the current frame');
  received(); receive = null; await tick();
  assert.equal(client.state.imageUrl, first, 'an undecoded frame must not replace the image');
  assert.ok(allocated.has(first));
  decoded(); decode = null; await pending;
  const second = client.state.imageUrl;
  assert.notEqual(second, first);
  assert.ok(allocated.has(first), 'the old URL survives the React paint that swaps the images');
  await frame();
  assert.ok(!allocated.has(first));
  assert.equal(allocated.size, 2, 'only current and previous displayed images are retained');
  const held = client.state.imageUrl;
  fail = new Error('temporary network error');
  await frame(); fail = null;
  assert.equal(client.state.phase, 'stale');
  assert.equal(client.state.imageUrl, held, 'temporary failures keep the most recent frame');
  await frame();
  assert.equal(client.state.phase, 'live');
  decode = new Promise((resolve) => { decoded = resolve; });
  const cancelled = frame(); await tick();
  await client.stop(); decoded(); await cancelled;
  assert.equal(client.state.imageUrl, null, 'stopping still clears the subscription image');
  assert.equal(allocated.size, 0, 'late decoded frames are released after stop');
  assert.equal(client.state.phase, 'idle');
} finally {
  client.reset(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
}
console.log('Robot camera frames: background download/decode, retained frame, recovery, URL lifetime and cancellation passed.');
