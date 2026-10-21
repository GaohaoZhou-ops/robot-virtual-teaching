import { unzipSync } from 'fflate';

self.onmessage = async ({ data }) => {
  try {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
      : data instanceof Uint8Array ? data : new Uint8Array(data);
    let compressedBytes = 0;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        self.postMessage({ type: 'progress', value: {
          phase: '解压工程包', detail: entry.name,
          progress: Math.min(0.99, compressedBytes / bytes.byteLength),
        } });
        compressedBytes += entry.size;
        return true;
      },
    });
    self.postMessage({ type: 'progress', value: { phase: '解压工程包', detail: '解压完成，开始校验', progress: 1 } });
    self.postMessage({ type: 'complete', files }, [...new Set(Object.values(files).map((file) => file.buffer))]);
  } catch (error) {
    self.postMessage({ type: 'error', message: `工程包解压失败：${error.message || '无法读取 ZIP 文件'}` });
  }
};
