import { defaultModelEditSettings, editModel, encodeModelPly, modelPreview, modelStats, parseEditablePly } from '../lib/modelEditing.js';
import { resolveModelEditorDisplayQuality } from '../lib/modelEditorDisplay.js';

let source = null, result = null, resultKey = '';
const previewTransfers = (preview) => [...new Set(['positions', 'colors', 'normals', 'indices', 'pointIndices']
  .map((key) => preview[key]?.buffer).filter(Boolean))];
const displayPreview = (model, quality) => {
  const option = resolveModelEditorDisplayQuality(quality);
  return { ...modelPreview(model, option.pointBudget, option.faceBudget), quality: option.id };
};
const requireModel = (model) => {
  if (!model) throw Object.assign(new Error('模型尚未导入'), { code: 'MODEL_NOT_LOADED' });
};

self.onmessage = async ({ data: { id, type, file, settings, key, quality, target } }) => {
  try {
    if (type === 'load') {
      const next = parseEditablePly(await file.arrayBuffer());
      const defaults = defaultModelEditSettings(next), stats = modelStats(next), preview = displayPreview(next, quality);
      source = next; result = next; resultKey = JSON.stringify(defaults);
      self.postMessage({ id, data: { defaults, stats, preview, key: resultKey, transformedBounds: stats.bounds } }, previewTransfers(preview));
    } else if (type === 'edit') {
      requireModel(source);
      const edited = editModel(source, settings);
      const stats = modelStats(edited.model), preview = displayPreview(edited.model, quality);
      result = edited.model; resultKey = key;
      self.postMessage({ id, data: { stats, preview, key, transformedBounds: edited.transformedBounds } }, previewTransfers(preview));
    } else if (type === 'preview') {
      const model = target === 'source' ? source : result;
      requireModel(model);
      if (target !== 'source' && resultKey !== key) throw new Error('模型正在更新，请稍后切换显示质量');
      const preview = displayPreview(model, quality);
      self.postMessage({ id, data: { preview } }, previewTransfers(preview));
    } else if (type === 'export') {
      requireModel(result);
      if (resultKey !== key) throw new Error('请等待当前参数的预览完成后再导出');
      const buffer = encodeModelPly(result);
      self.postMessage({ id, data: { buffer } }, [buffer]);
    }
  } catch (error) { self.postMessage({ id, error: error.message || '模型处理失败', code: error.code }); }
};
