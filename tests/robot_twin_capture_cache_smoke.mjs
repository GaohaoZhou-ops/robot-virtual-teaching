import assert from 'node:assert/strict';
import { RobotTwinCaptureCache } from '../src/lib/robotTwinCaptureCache.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail('capture cache condition timed out');
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const runId = 'a'.repeat(32);
const capture = (n, extra = {}) => ({ id: n.toString(16).padStart(32, '0'), runId, pointName: `照片 ${n}`,
  sides: Object.fromEntries(['left', 'right'].map((side) => [side, { image: side === 'left', pending: false, boxes: [], state: 'processing' }])), ...extra });
const result = (item, sequence) => ({ key: `${item.id}:left`, captureId: item.id, camera: 'left', sequence, state: 'processing' });
const first = capture(1), second = capture(2), third = capture(3);
const created = URL.createObjectURL, revoked = URL.revokeObjectURL, urls = new Set();
URL.createObjectURL = (blob) => { const url = created(blob); urls.add(url); return url; };
URL.revokeObjectURL = (url) => { urls.delete(url); revoked(url); };
const transfers = [], decodes = [];
let automatic = false;
const cache = new RobotTwinCaptureCache({
  request: async (path, { signal }) => {
    if (path.startsWith('/capture-history/')) return { runId, nextOffset: 0, total: 0, captures: [], results: [] };
    const wait = deferred(); transfers.push({ path, signal, ...wait });
    if (!automatic) await wait.promise;
    return { blob: new Blob([path], { type: 'image/png' }) };
  },
  decode: async (url, signal) => {
    const wait = deferred(); decodes.push({ url, signal, ...wait });
    if (!automatic) await wait.promise;
    return { url };
  },
});
try {
  cache.remember({ captures: [first], results: [result(first, 1)] });
  const waiting = new AbortController();
  const viewer = cache.read(first.id, 'left', 'png', waiting.signal);
  waiting.abort(); await assert.rejects(viewer, { name: 'AbortError' });
  assert.equal(transfers[0].signal.aborted, false, 'closing a viewer cannot abort its download');
  assert.equal(cache.latestReady(), undefined);
  transfers[0].resolve(); await tick();
  assert.equal(cache.latestReady(), undefined, 'downloaded but undecoded images are not presented');
  decodes[0].resolve(); await tick();
  const held = await cache.read(first.id, 'left', 'png');
  assert.equal(transfers.length, 1, 'a completed photo is reused without another download');
  assert.equal(cache.latestReady().id, first.id);
  cache.observe({ captures: [{ ...first, pointName: '更新后的标注', sides: { ...first.sides, left: { ...first.sides.left, image: false } } }],
    latestCapture: first, results: [] });
  assert.equal(cache.latestReady().pointName, '更新后的标注', 'selected-pair metadata takes precedence over a retained latest-capture snapshot');
  assert.equal(cache.latestReady().sides.left.image, true, 'cached photos remain available when metadata stops advertising the file');

  cache.remember({ captures: [second], results: [result(second, 2)] });
  cache.remember({ captures: [third], results: [result(third, 3)] });
  assert.equal(transfers[1].signal.aborted, false, 'a later capture cannot cancel an earlier download');
  assert.equal(cache.latestReady().id, first.id, 'refreshes retain a decoded photo');
  transfers[2].resolve(); await tick(); decodes[1].resolve(); await tick();
  assert.equal(cache.latestReady().id, third.id);
  transfers[1].resolve(); await tick(); decodes[2].resolve(); await tick();
  assert.equal(cache.latestReady().id, third.id, 'out-of-order completions cannot move the display backward');
  assert.equal((await cache.read(first.id, 'left', 'png')).url, held.url);
  assert.equal(urls.size, 3, 'all completed photos stay cached');

  const fourth = capture(4), fifth = capture(5), sixth = capture(6);
  cache.remember({ captures: [fourth, fifth, sixth], results: [result(fourth, 4), result(fifth, 5), result(sixth, 6)] });
  assert.equal(transfers.length, 5, 'at most two transfers run concurrently');
  transfers[3].resolve(); await tick(); decodes[3].reject(new DOMException('broken PNG', 'EncodingError')); await tick();
  assert.equal(cache.latestReady().id, third.id, 'a corrupt PNG keeps the last valid photo');
  assert.equal(urls.size, 3, 'failed decoding releases only the rejected URL');
  assert.equal(transfers.length, 6, 'a failed download does not block the queue');
  automatic = true;
  cache.retry(fourth.id, 'left', 'png');
  transfers[4].resolve(); transfers[5].resolve();
  await until(() => cache.peek(fourth.id, 'left', 'png').phase === 'ready' && cache.latestReady().id === sixth.id);
  assert.equal(urls.size, 6);

  automatic = false;
  const seventh = capture(7), eighth = capture(8), ninth = capture(9);
  cache.remember({ captures: [seventh, eighth, ninth] });
  const pending = cache.read(seventh.id, 'left', 'png');
  const latestTransfers = transfers.slice(-2), before = transfers.length;
  latestTransfers[0].resolve(); await tick();
  const pendingDecode = decodes.at(-1);
  cache.reset(); await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(latestTransfers.every((item) => item.signal.aborted));
  assert.ok(pendingDecode.signal.aborted);
  pendingDecode.resolve(); latestTransfers[1].resolve(); await tick();
  assert.equal(transfers.length, before, 'disconnect never starts queued transfers');
  assert.equal(cache.latestReady(), undefined);
  assert.equal(cache.history().captures.length, 0);
  assert.equal(urls.size, 0, 'disconnect releases cached and late-decoding URLs');

  automatic = true;
  const cloud = await cache.read(first.id, 'left', 'xyzbin');
  cache.retry(first.id, 'left', 'xyzbin');
  assert.notEqual(await cache.read(first.id, 'left', 'xyzbin'), cloud, 'worker parse failures can refetch a cached cloud');
  cache.reset();

  // The compact monitor can omit captures or unfinished jobs. Background index
  // paging must discover every photo, including pending files and older runs.
  let filesReady = false;
  const requests = [], older = capture(10, { sides: { ...first.sides, left: { ...first.sides.left, image: false, pending: true } } });
  const newest = capture(11);
  const history = new RobotTwinCaptureCache({ decode: async () => null, request: async (path) => {
    requests.push(path);
    if (path.startsWith('/captures/')) return { blob: new Blob(['png']) };
    const offset = Number(path.split('/').at(-1));
    const item = offset === 0 ? filesReady ? capture(10) : older : newest;
    return { runId, nextOffset: Math.min(offset + 1, 2), total: 2,
      captures: offset < 2 ? [item] : [], results: offset < 2 ? [result(item, offset + 1)] : [], pending: offset === 0 && !filesReady };
  } });
  try {
    history.observe({ task: { id: runId, completedCaptures: 2 }, captures: [], results: [] });
    await until(() => !history.historyLoading && history.peek(newest.id, 'left', 'png')?.phase === 'ready');
    assert.ok(history.captures.has(older.id));
    assert.ok(requests.includes(`/capture-history/${runId}/1`), 'all index pages are read');
    filesReady = true;
    history.history().retry();
    await until(() => history.peek(older.id, 'left', 'png')?.phase === 'ready');
    assert.equal(history.latestReady().id, newest.id, 'late history downloads do not replace newer photos');
    assert.equal(history.history().captures.length, 2, 'algorithm completion is not required to browse photos');
    assert.equal(requests.filter((path) => path === `/captures/${newest.id}/left/png`).length, 1);
    history.reset();
    const previousReads = requests.filter((path) => path.startsWith('/capture-history/')).length;
    history.observe({ task: { id: runId }, captures: [newest], results: [result(newest, 2)] });
    await until(() => !history.historyLoading);
    assert.ok(requests.filter((path) => path.startsWith('/capture-history/')).length > previousReads, 'reconnecting starts a new history scan');
  } finally { history.reset(); }
  console.log('Robot capture cache: background download/decode, queue, cancellation isolation, retries, all-history paging and disconnect cleanup passed.');
} finally { cache.reset(); URL.createObjectURL = created; URL.revokeObjectURL = revoked; }
