const SIDES = ['left', 'right'];
const assetKey = (id, side, kind) => `${id}/${side}/${kind}`;

async function decodeImage(url, signal) {
  if (typeof Image === 'undefined') return null; // Protocol tests have no DOM.
  const image = new Image(); image.decoding = 'async';
  let cancel;
  try {
    signal.throwIfAborted();
    const aborted = new Promise((_, reject) => {
      cancel = () => { image.src = ''; reject(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true });
    });
    image.src = url;
    await Promise.race([image.decode(), aborted]);
    return image;
  } finally { signal.removeEventListener('abort', cancel); }
}

// One cache per robot connection. Viewers may stop waiting, but only reset()
// cancels transfers or releases downloaded files. At most two binaries are read
// at once, matching the proxy's limit; new captures never interrupt older ones.
export class RobotTwinCaptureCache {
  constructor({ request, onChange = () => {}, decode = decodeImage }) {
    this.request = request; this.onChange = onChange; this.decode = decode;
    this.epoch = 0; this.controller = new AbortController();
    this.assets = new Map(); this.captures = new Map(); this.results = new Map(); this.runs = new Map();
    this.queue = []; this.running = 0;
  }

  reset() {
    ++this.epoch; this.controller.abort(); clearTimeout(this.historyTimer);
    for (const entry of this.assets.values()) {
      clearTimeout(entry.timer);
      entry.reject?.(this.controller.signal.reason);
      if (entry.value?.url) URL.revokeObjectURL(entry.value.url);
    }
    this.controller = new AbortController();
    this.assets.clear(); this.captures.clear(); this.results.clear(); this.runs.clear();
    this.queue = []; this.running = 0; this.historyLoading = false; this.historyTimer = null; this.activeRun = null;
    this.onChange();
  }

  peek(id, side, kind) { return this.assets.get(assetKey(id, side, kind)); }

  enqueue(id, side, kind, retry = false) {
    const key = assetKey(id, side, kind);
    let entry = this.assets.get(key);
    if (entry && (!retry || ['loading', 'queued', 'ready'].includes(entry.phase))) return entry;
    if (!entry) { entry = { id, side, kind, attempts: 0 }; this.assets.set(key, entry); }
    clearTimeout(entry.timer);
    entry.phase = 'queued'; entry.error = '';
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    // Prefetches have no viewer awaiting them yet.
    void entry.promise.catch(() => {});
    this.queue.push(entry); this.pump(); this.onChange();
    return entry;
  }

  async read(id, side, kind, signal) {
    signal?.throwIfAborted();
    const entry = this.enqueue(id, side, kind, this.peek(id, side, kind)?.phase === 'error');
    if (!signal) return entry.promise;
    let cancel;
    try {
      return await Promise.race([entry.promise, new Promise((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', cancel); }
  }

  retry(id, side, kind) {
    // XYZ decoding happens in the viewer's worker. An explicit retry after a
    // parse error must refetch the bytes, not hand back the same invalid blob.
    if (kind === 'xyzbin' && this.peek(id, side, kind)?.phase === 'ready') this.assets.delete(assetKey(id, side, kind));
    this.enqueue(id, side, kind, true);
  }

  invalidImage(id, side, url) {
    const entry = this.peek(id, side, 'png');
    if (entry?.phase !== 'ready' || entry.value.url !== url) return;
    URL.revokeObjectURL(url); entry.value = null; entry.phase = 'error';
    this.retry(id, side, 'png');
  }

  pump() {
    while (this.running < 2 && this.queue.length) {
      const entry = this.queue.shift(), epoch = this.epoch;
      entry.phase = 'loading'; ++entry.attempts; ++this.running;
      void this.download(entry, epoch);
    }
  }

  async download(entry, epoch) {
    const signal = this.controller.signal;
    let url;
    try {
      const value = await this.request(`/captures/${entry.id}/${entry.side}/${entry.kind}`,
        { binary: true, timeoutMs: 65_000, signal });
      signal.throwIfAborted();
      if (entry.kind === 'png') {
        url = URL.createObjectURL(value.blob);
        value.image = await this.decode(url, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        signal.throwIfAborted();
        value.url = url; url = null;
      }
      entry.value = value; entry.phase = 'ready'; entry.error = ''; entry.resolve(value);
    } catch (error) {
      if (signal.aborted) return;
      entry.phase = 'error'; entry.error = error.name === 'EncodingError' ? '图像解码失败，请重试' : error.message;
      entry.reject(error);
      if (![400, 401, 403, 413].includes(error.status)) {
        entry.timer = setTimeout(() => this.retry(entry.id, entry.side, entry.kind), Math.min(30_000, 1000 * 2 ** Math.min(entry.attempts - 1, 5)));
      }
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (epoch === this.epoch) { --this.running; this.pump(); this.onChange(); }
    }
  }

  remember({ captures = [], results = [] }) {
    for (const item of results) this.results.set(item.key, { ...item,
      sequence: Math.max(this.results.get(item.key)?.sequence || 0, item.sequence || 0) });
    for (const capture of captures) {
      if (capture.runId && !this.runs.has(capture.runId)) {
        this.runs.set(capture.runId, { order: this.runs.size, cursor: 0, pending: new Set(), errors: new Map(), scanned: false });
      }
      // A file already downloaded remains viewable even if a later metadata
      // read is incomplete or the robot has cleaned up its original file.
      const sides = Object.fromEntries(SIDES.map((side) => [side, { ...capture.sides[side],
        image: capture.sides[side].image || this.peek(capture.id, side, 'png')?.phase === 'ready' }]));
      this.captures.set(capture.id, { ...capture, sides });
      for (const side of SIDES) if (capture.sides[side].image) this.enqueue(capture.id, side, 'png');
    }
  }

  observe(monitor) {
    // A run can have Zivid photos older than the monitor's 24-row window, even
    // when all currently visible rows belong to body cameras.
    const task = monitor.task;
    if (task?.id && task.algorithmMode !== 'demo' && task.kind !== 'base-navigation'
      && (task.completedCaptures > 0 || monitor.resultTotal > 0) && !this.runs.has(task.id)) {
      this.runs.set(task.id, { order: this.runs.size, cursor: 0, pending: new Set(), errors: new Map(), scanned: false });
    }
    this.remember({ captures: monitor.captures, results: monitor.results });
    if (monitor.latestCapture && !monitor.captures?.some((item) => item.id === monitor.latestCapture.id)) {
      this.remember({ captures: [monitor.latestCapture] });
    }
    if (monitor.task && this.runs.has(monitor.task.id)) this.activeRun = monitor.task.id;
    if (this.runs.size && !this.historyLoading && !this.historyTimer) void this.syncHistory();
    this.onChange();
  }

  orderedCaptures() {
    const sequences = new Map();
    for (const item of this.results.values()) sequences.set(item.captureId, Math.max(sequences.get(item.captureId) || 0, item.sequence || 0));
    return [...this.captures.values()].sort((a, b) => (this.runs.get(b.runId)?.order || 0) - (this.runs.get(a.runId)?.order || 0)
      || (sequences.get(b.id) || 0) - (sequences.get(a.id) || 0) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  latestReady() {
    return this.orderedCaptures().find((capture) => SIDES.some((side) => this.peek(capture.id, side, 'png')?.phase === 'ready'));
  }

  history() {
    return { captures: this.orderedCaptures(), results: [...this.results.values()], loading: this.historyLoading,
      error: [...this.runs.values()].flatMap((run) => [...run.errors.values()]).find(Boolean) || '',
      retry: () => { clearTimeout(this.historyTimer); this.historyTimer = null; if (!this.historyLoading) void this.syncHistory(); } };
  }

  async syncHistory() {
    const epoch = this.epoch, signal = this.controller.signal;
    this.historyTimer = null; this.historyLoading = true; this.onChange();
    try {
      for (const [runId, run] of this.runs) {
        if (run.scanned && runId !== this.activeRun && !run.pending.size && !run.errors.size) continue;
        const page = async (offset) => {
          const value = await this.request(`/capture-history/${runId}/${offset}`, { timeoutMs: 30_000, signal });
          signal.throwIfAborted();
          if (value.runId !== runId || !Number.isSafeInteger(value.nextOffset) || value.nextOffset < offset
            || !Number.isSafeInteger(value.total) || value.nextOffset > value.total
            || (offset < value.total && value.nextOffset === offset)) throw new Error('采集记录列表格式无效');
          this.remember(value);
          value.pending ? run.pending.add(offset) : run.pending.delete(offset);
          value.error ? run.errors.set(offset, value.error) : run.errors.delete(offset);
          this.onChange();
          return value;
        };
        try {
          for (const offset of new Set([...run.pending, ...run.errors.keys()])) if (offset < run.cursor) await page(offset);
          let value;
          do { value = await page(run.cursor); run.cursor = value.nextOffset; } while (run.cursor < value.total);
          run.scanned = true;
        } catch (error) { if (signal.aborted) return; run.errors.set(run.cursor, error.message); }
      }
    } finally {
      if (epoch === this.epoch) {
        this.historyLoading = false; this.onChange();
        this.historyTimer = setTimeout(() => void this.syncHistory(), 3000);
      }
    }
  }
}
