const canvasJPEG = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('相机画面编码失败')), 'image/jpeg', 0.8);
});

// Canvas.toBlob may schedule encoding as idle work on a busy workbench. Keep
// realtime JPEG preparation off that thread without changing size or quality.
export function createScreenJPEGEncoder() {
  let worker, disposed = false, sequence = 0;
  const pending = new Map();
  const abortError = () => new DOMException('画面编码已停止', 'AbortError');
  const disableWorker = (error) => {
    worker?.terminate(); worker = null;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
    && typeof createImageBitmap === 'function') {
    try {
      worker = new Worker(new URL("./ipadScreenEncoder.worker.js", import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        clearTimeout(job.timer); pending.delete(data.id);
        if (data.blob) job.resolve(data.blob); else job.reject(new Error(data.error || '相机画面编码失败'));
      };
      worker.onerror = () => disableWorker(new Error('画面编码线程不可用'));
      worker.onmessageerror = worker.onerror;
    } catch { worker = null; }
  }
  return {
    async encode(canvas, channel) {
      if (disposed) throw abortError();
      if (!worker) return canvasJPEG(canvas);
      let bitmap;
      try {
        bitmap = await createImageBitmap(canvas);
        if (disposed) throw abortError();
        if (!worker) { bitmap.close(); bitmap = null; return canvasJPEG(canvas); }
        return await new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => disableWorker(new Error('画面编码线程超时')), 5000);
          pending.set(id, { resolve, timer, reject: (error) => { clearTimeout(timer); reject(error); } });
          try { worker.postMessage({ id, channel, bitmap }, [bitmap]); bitmap = null; }
          catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      } catch (error) {
        bitmap?.close();
        if (disposed) throw abortError();
        disableWorker(error);
        return canvasJPEG(canvas);
      }
    },
    dispose() { disposed = true; disableWorker(abortError()); },
  };
}
