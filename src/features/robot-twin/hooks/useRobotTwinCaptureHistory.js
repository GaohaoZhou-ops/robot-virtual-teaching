import { useEffect, useState } from 'react';

// Mounted only in the enlarged viewer. Closing it or changing runs aborts the
// index and metadata requests; binary assets remain in the selected-pair loader.
export function useRobotTwinCaptureHistory(read, runId, enabled) {
  const [state, setState] = useState({}), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !runId) return undefined;
    const controller = new AbortController(), { signal } = controller;
    const results = new Map(), captures = new Map(), pending = new Set(), errors = new Map();
    let timer, cursor = 0, total = 0, scanned = false;
    setState({ runId, results: [], captures: [], loading: true, error: '' });
    const publish = (loading, error = [...errors.values()].find(Boolean) || '') => {
      if (!signal.aborted) setState({ runId, results: [...results.values()], captures: [...captures.values()], loading, error });
    };
    async function page(offset) {
      const value = await read(runId, offset, signal);
      signal.throwIfAborted();
      if (value.runId !== runId || !Number.isSafeInteger(value.nextOffset) || value.nextOffset < offset
        || !Number.isSafeInteger(value.total) || value.nextOffset > value.total
        || (offset < value.total && value.nextOffset === offset)) throw new Error('算法结果列表格式无效');
      for (const item of value.results) results.set(item.key, item);
      for (const item of value.captures) captures.set(item.id, item);
      value.pending ? pending.add(offset) : pending.delete(offset);
      errors.set(offset, value.error);
      total = value.total;
      return value.nextOffset;
    }
    async function sync() {
      try {
        if (scanned) for (const offset of [...pending]) { await page(offset); publish(false); }
        do { cursor = await page(cursor); publish(cursor < total); } while (cursor < total);
        scanned = true;
        // Old jobs can finish after leaving the compact monitor's recent list.
        // Revisit only unfinished pages and the index tail, not all old jobs.
        timer = setTimeout(sync, 3000);
      } catch (error) { publish(false, error.message); }
    }
    void sync();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [read, runId, enabled, attempt]);
  return { ...(state.runId === runId ? state : { results: [], captures: [], loading: Boolean(runId), error: '' }),
    retry: () => setAttempt((value) => value + 1) };
}
