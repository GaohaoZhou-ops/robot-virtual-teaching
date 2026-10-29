const canvases = new Map();

self.onmessage = async ({ data: { id, channel, bitmap } }) => {
  try {
    let canvas = canvases.get(channel);
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvases.set(channel, canvas);
    }
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    self.postMessage({ id, blob });
  } catch (error) {
    bitmap.close();
    self.postMessage({ id, error: error.message });
  }
};
