import { ROBOT_PEDESTRIANS_INTERVAL, ROBOT_PEDESTRIANS_PATH, robotPedestrianSnapshot } from '../../shared/protocols/robotTwinPedestrians.js';

function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// No background timer: a robot is read only while a browser requests results.
// Coalesce concurrent reads, bound their rate, and cancel when all readers leave.
export function createRobotPedestrianReader(read) {
  let pending, cached, failure, polledAt = -Infinity, sampledAt = 0;
  return async function pedestrians(signal) {
    signal.throwIfAborted();
    if (pending?.controller.signal.aborted) {
      await pending.promise.catch(() => {});
      signal.throwIfAborted();
    }
    if (!pending && performance.now() - polledAt >= ROBOT_PEDESTRIANS_INTERVAL) {
      const record = { controller: new AbortController(), readers: 0 };
      pending = record;
      polledAt = performance.now();
      record.promise = (async () => {
        try {
          const result = await read(ROBOT_PEDESTRIANS_PATH, record.controller.signal);
          record.controller.signal.throwIfAborted();
          cached = robotPedestrianSnapshot(result, performance.now() - polledAt);
          sampledAt = performance.now(); failure = null;
        } catch (error) {
          if (record.controller.signal.aborted) { polledAt = -Infinity; cached = null; failure = null; }
          else { failure = error; cached = null; }
          throw error;
        } finally { if (pending === record) pending = null; }
      })();
    }
    const record = pending;
    if (record) {
      record.readers++;
      try { await waitFor(record.promise, signal); }
      finally {
        record.readers--;
        if (record.readers === 0 && pending === record) record.controller.abort();
      }
    }
    if (failure) throw failure;
    const heldMs = performance.now() - sampledAt;
    const validForMs = Math.max(0, cached.validForMs - heldMs);
    return { ...cached, validForMs,
      sampleAgeMs: cached.sampleAgeMs === null ? null : cached.sampleAgeMs + heldMs,
      ...(cached.phase === 'live' && !validForMs ? { phase: 'waiting', boxes: [], message: '行人感知已过期，等待新结果' } : {}),
      nextPollAfterMs: Math.max(0, ROBOT_PEDESTRIANS_INTERVAL - (performance.now() - polledAt)) };
  };
}
