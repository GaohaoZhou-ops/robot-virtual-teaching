import { encodeModelPly, modelPreview, modelStats, parseEditablePly } from '../lib/modelEditing.js';
import { composeModels } from '../lib/modelComposition.js';
import { resolveModelEditorDisplayQuality } from '../lib/modelEditorDisplay.js';

const sources = { a: null, b: null };
const latestLoads = { a: 0, b: 0 }, sourceVersions = { a: 0, b: 0 };
let result = null, resultKey = '';
const preview = (model, quality) => {
  const option = resolveModelEditorDisplayQuality(quality);
  return { ...modelPreview(model, option.pointBudget, option.faceBudget), quality: option.id };
};
const transfers = (value) => [...new Set(['positions', 'colors', 'normals', 'indices', 'pointIndices'].map((key) => value[key]?.buffer).filter(Boolean))];
const requireModel = (model) => { if (!model) throw Object.assign(new Error('模型尚未导入'), { code: 'MODEL_NOT_LOADED' }); };

self.onmessage = async ({ data: { id, type, slot, file, settings, key, quality, loadToken } }) => {
  const stale = () => self.postMessage({ id, data: { stale: true } });
  try {
    if (type === 'load') {
      if (!['a', 'b'].includes(slot)) throw new Error('请选择模型 A 或 B');
      if (loadToken < latestLoads[slot]) { stale(); return; }
      latestLoads[slot] = loadToken;
      if (!/\.ply$/i.test(file.name)) throw new Error('请选择 .ply 格式的点云或网格文件');
      const buffer = await file.arrayBuffer();
      // Loading either slot is independent; a superseded read must never replace
      // the newest file, even if the older file finishes reading last.
      if (loadToken !== latestLoads[slot]) { stale(); return; }
      const model = parseEditablePly(buffer), data = preview(model, quality);
      sources[slot] = model; sourceVersions[slot] = loadToken; result = null; resultKey = '';
      self.postMessage({ id, data: { stats: modelStats(model), preview: data } }, transfers(data));
    } else if (type === 'preview') {
      requireModel(sources[slot]);
      if (loadToken !== sourceVersions[slot]) { stale(); return; }
      const data = preview(sources[slot], quality);
      self.postMessage({ id, data: { preview: data } }, transfers(data));
    } else if (type === 'compose') {
      requireModel(sources.a); requireModel(sources.b);
      const composed = composeModels(sources.a, sources.b, settings);
      result = composed.model; resultKey = key;
      self.postMessage({ id, data: { key, stats: modelStats(result) } });
    } else if (type === 'export') {
      requireModel(result);
      if (resultKey !== key) throw new Error('请先确认当前处理结果');
      const buffer = encodeModelPly(result);
      self.postMessage({ id, data: { buffer } }, [buffer]);
    }
  } catch (error) {
    if (type === 'load' && loadToken !== latestLoads[slot]) { stale(); return; }
    self.postMessage({ id, error: error.message || '模型处理失败', code: error.code });
  }
};
