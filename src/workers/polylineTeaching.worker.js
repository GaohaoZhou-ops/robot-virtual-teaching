import { planPolylineWithSuggestion } from '../lib/polylineTeachingSuggestion.js';

self.onmessage = async ({ data }) => {
  try {
    const { robot: snapshot, ...options } = data;
    const plan = await planPolylineWithSuggestion({ ...options, snapshot,
      onProgress: (value) => self.postMessage({ type: 'progress', value }) });
    self.postMessage({ type: 'complete', value: plan });
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '路径检查失败' }); }
};
