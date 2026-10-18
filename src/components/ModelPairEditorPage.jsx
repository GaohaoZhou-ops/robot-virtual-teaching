import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Box, Boxes, FileText, FolderOpen, LoaderCircle, MousePointer2, Move3D, Rotate3D, RotateCcw, Upload, X } from 'lucide-react';
import ModelEditorViewport from './ModelEditorViewport.jsx';
import ModelExportDialog from './ModelExportDialog.jsx';
import { compositionError, DEFAULT_MODEL_COMPOSITION, inverseModelPose } from '../lib/modelComposition.js';
import { readModelOrigin, ZERO_MODEL_ORIGIN } from '../lib/modelOriginTransform.js';
import { MODEL_EDITOR_DISPLAY_QUALITIES } from '../lib/modelEditorDisplay.js';
import './ModelEditorPage.css';
import './ModelPairEditorPage.css';

const clone = (value) => structuredClone(value);
const count = (value = 0) => value.toLocaleString('zh-CN');
const missingModel = (failure) => failure.code === 'MODEL_NOT_LOADED';
const slots = ['a', 'b'];
const emptyLoads = () => ({ a: { status: 'idle' }, b: { status: 'idle' } });
const defaultDisplay = () => ({ quality: 'balanced', pointSize: 3 });
const noop = () => {};

function useModelPreviewQuality({ slot, model, quality, loadStatus, busy, request, onPreview, onError }) {
  const [pending, setPending] = useState(false);
  const handlers = useRef(null);
  handlers.current = { request, onPreview, onError };
  useEffect(() => {
    if (!model || loadStatus !== 'ready' || busy || model.preview.quality === quality) { setPending(false); return undefined; }
    let cancelled = false; setPending(true);
    const sourceRevision = model.revision;
    handlers.current.request('preview', { slot, quality, loadToken: sourceRevision })
      .then(({ preview }) => { if (!cancelled && preview) handlers.current.onPreview(slot, sourceRevision, preview); })
      .catch((failure) => { if (!cancelled) handlers.current.onError(slot, failure); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; };
    // Each model owns its request lifetime: changing B never cancels or repeats A.
  }, [slot, model?.revision, model?.preview.quality, quality, loadStatus, busy]);
  return pending;
}

function ModelSlot({ slot, model, load, disabled, onChoose, onLoad }) {
  const selected = Boolean(model || load?.name);
  return <div className={`model-pair__file is-${slot} ${model ? 'is-loaded' : ''}`} role="group" aria-label={`模型 ${slot.toUpperCase()} 文件`}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (!disabled) onLoad(event.dataTransfer.files[0]); }}>
    <span className="model-pair__letter">{slot.toUpperCase()}</span>
    <div><strong>{slot === 'a' ? '基准模型' : '调整模型'}</strong><span title={model?.name || load?.name}>{model?.name || load?.name || '选择 PLY 文件'}</span></div>
    <button type="button" aria-label={`${selected ? '重新加载' : '加载'}模型 ${slot.toUpperCase()}`} disabled={disabled} onClick={onChoose}>{selected ? <FolderOpen size={15} /> : <Upload size={15} />}{selected ? '重新加载' : '加载'}</button>
  </div>;
}

function PairDetails({ models, result, dirty, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement, dialog = ref.current; dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="model-editor__details model-pair__details" aria-labelledby="model-pair-details-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><FileText size={20} /><h2 id="model-pair-details-title">模型详情</h2><button type="button" aria-label="关闭模型详情" onClick={onClose}><X size={18} /></button></header>
    <table><thead><tr><th>模型</th><th>顶点 / 点数</th><th>三角面</th></tr></thead><tbody>
      {slots.filter((slot) => models[slot]).map((slot) => <tr key={slot}><td><b>模型 {slot.toUpperCase()}</b><small>{models[slot].name}</small></td><td>{count(models[slot].stats.pointCount)}</td><td>{count(models[slot].stats.faceCount)}</td></tr>)}
      {result && <tr><td><b>{dirty ? '上次确认结果' : '处理结果'}</b></td><td>{count(result.stats.pointCount)}</td><td>{count(result.stats.faceCount)}</td></tr>}
    </tbody></table>
  </dialog>;
}

export default function ModelPairEditorPage({ active, onBack }) {
  const inputs = useRef({}), workerRef = useRef(null), requests = useRef(new Map()), sequence = useRef(0), revision = useRef(0);
  const loadTokens = useRef({ a: 0, b: 0 });
  const history = useRef({ past: [], group: null }), settingsRef = useRef(clone(DEFAULT_MODEL_COMPOSITION));
  const exportUrl = useRef(null), exportBusy = useRef(false);
  const [models, setModels] = useState({ a: null, b: null }), [settings, setSettings] = useState(settingsRef.current), [result, setResult] = useState(null);
  const [loads, setLoads] = useState(emptyLoads), [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [display, setDisplay] = useState({ pointSize: 3 });
  const [slotDisplays, setSlotDisplays] = useState(() => ({ a: defaultDisplay(), b: defaultDisplay() }));
  const [mode, setMode] = useState('view'), [dragging, setDragging] = useState(false), [showEnvelope, setShowEnvelope] = useState(true);
  const [details, setDetails] = useState(false), [exportDialog, setExportDialog] = useState(null);
  const settingsError = compositionError(settings), bothLoaded = Boolean(models.a && models.b), anyLoaded = Boolean(models.a || models.b);
  const settingsKey = JSON.stringify({ pose: readModelOrigin(settings.pose), mode: settings.mode });
  const dirty = !result || result.key !== settingsKey, busy = Boolean(phase);
  const loading = slots.some((slot) => loads[slot].status === 'loading');
  const canStart = bothLoaded && slots.every((slot) => loads[slot].status === 'ready') && !busy;
  const ready = editing && canStart && !dragging && !dirty && !settingsError;
  const validOrigin = useRef(ZERO_MODEL_ORIGIN);
  const convertedOrigin = useMemo(() => inverseModelPose(settings.pose), [settings.pose]);
  if (convertedOrigin) validOrigin.current = convertedOrigin;
  const composition = useMemo(() => ({ basePreview: models.a?.preview, baseBounds: models.a?.stats.bounds,
    bounds: models.b?.stats.bounds, mode: settings.mode, showEnvelope }), [models.a, models.b?.stats.bounds, settings.mode, showEnvelope]);

  const apply = (next) => { settingsRef.current = next; setSettings(next); setError(''); setNotice(''); };
  const remember = (before) => { history.current.past.push(clone(before)); if (history.current.past.length > 100) history.current.past.shift(); };
  const finishGroup = () => {
    const group = history.current.group; history.current.group = null;
    if (group && JSON.stringify(group.before) !== JSON.stringify(settingsRef.current)) remember(group.before);
  };
  const beginGroup = (kind, target = null) => {
    if (history.current.group?.kind === kind && history.current.group.target === target) return;
    finishGroup(); history.current.group = { kind, target, before: clone(settingsRef.current) };
  };
  const update = (change) => {
    const before = settingsRef.current, next = change(clone(before));
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    if (!history.current.group) remember(before);
    apply(next);
  };
  const undo = () => {
    if (busy) return;
    const field = history.current.group?.kind === 'field' ? history.current.group.target : null;
    finishGroup(); const previous = history.current.past.pop(); if (previous) apply(previous);
    if (field && document.activeElement === field) beginGroup('field', field);
  };
  const dragChanged = (value, cancelled = false) => {
    if (value) beginGroup('drag');
    else if (history.current.group?.kind === 'drag') { if (cancelled) apply(history.current.group.before); finishGroup(); }
    setDragging(value);
  };
  const resetMissingModels = (failure) => {
    revision.current++; workerRef.current?.terminate(); workerRef.current = null;
    loadTokens.current = { a: 0, b: 0 };
    for (const promise of requests.current.values()) promise.reject(failure);
    requests.current.clear(); history.current = { past: [], group: null };
    setModels({ a: null, b: null }); setLoads(emptyLoads()); setEditing(false); setResult(null); apply(clone(DEFAULT_MODEL_COMPOSITION));
    setPhase(''); setMode('view'); setDragging(false); setDetails(false); setExportDialog(null);
  };
  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    if (!workerRef.current) {
      const worker = new Worker(new URL('../workers/modelComposition.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const pending = requests.current.get(data.id); if (!pending) return;
        requests.current.delete(data.id);
        if (data.error) {
          const failure = Object.assign(new Error(data.error), { code: data.code });
          if (missingModel(failure)) resetMissingModels(failure);
          pending.reject(failure);
        } else pending.resolve(data.data);
      };
      worker.onerror = () => {
        resetMissingModels(Object.assign(new Error('模型处理线程已关闭'), { code: 'MODEL_NOT_LOADED' }));
      };
      workerRef.current = worker;
    }
    const id = ++sequence.current; requests.current.set(id, { resolve, reject });
    try { workerRef.current.postMessage({ id, type, ...payload }); }
    catch (failure) { requests.current.delete(id); reject(failure); }
  });

  useEffect(() => () => {
    revision.current++; workerRef.current?.terminate(); workerRef.current = null;
    loadTokens.current = { a: 0, b: 0 };
    for (const promise of requests.current.values()) promise.reject(new Error('模型编辑已关闭'));
    requests.current.clear(); if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
  }, []);
  useEffect(() => { if (!active) { finishGroup(); setMode('view'); setDragging(false); setDetails(false); setExportDialog(null); } }, [active]);
  const previewHandlers = { busy, request,
    onPreview: (slot, sourceRevision, preview) => setModels((current) => current[slot]?.revision === sourceRevision
      ? { ...current, [slot]: { ...current[slot], preview } } : current),
    onError: (slot, failure) => { if (!missingModel(failure)) setError(`模型 ${slot.toUpperCase()} 显示质量更新失败：${failure.message}`); },
  };
  const pendingA = useModelPreviewQuality({ ...previewHandlers, slot: 'a', model: models.a, quality: slotDisplays.a.quality, loadStatus: loads.a.status });
  const pendingB = useModelPreviewQuality({ ...previewHandlers, slot: 'b', model: models.b, quality: slotDisplays.b.quality, loadStatus: loads.b.status });
  const displayPending = pendingA || pendingB;

  const loadFile = async (slot, file) => {
    if (!file || busy || dragging) return;
    const currentRevision = ++revision.current;
    loadTokens.current[slot] = currentRevision;
    setEditing(false); setMode('view'); setError(''); setNotice(''); setResult(null);
    setLoads((current) => ({ ...current, [slot]: { status: 'loading', name: file.name } }));
    try {
      const next = await request('load', { slot, file, quality: slotDisplays[slot].quality, loadToken: currentRevision });
      if (currentRevision !== loadTokens.current[slot] || next.stale) return;
      setModels((current) => ({ ...current, [slot]: { ...next, name: file.name, revision: currentRevision } }));
      setLoads((current) => ({ ...current, [slot]: { status: 'ready', name: file.name } }));
      setResult(null); history.current = { past: [], group: null }; apply(clone(DEFAULT_MODEL_COMPOSITION));
      validOrigin.current = ZERO_MODEL_ORIGIN; setMode('view'); setShowEnvelope(true);
    } catch (failure) {
      if (currentRevision === loadTokens.current[slot] && !missingModel(failure)) {
        setLoads((current) => ({ ...current, [slot]: { status: 'error', name: file.name, error: failure.message } }));
      }
    }
  };
  const confirm = async () => {
    if (!editing || !canStart || dragging || settingsError || !dirty) return;
    finishGroup(); setPhase('composing'); setError(''); setNotice('');
    const currentRevision = revision.current;
    try {
      const next = await request('compose', { settings: JSON.parse(settingsKey), key: settingsKey });
      if (currentRevision === revision.current) { setResult(next); setMode('view'); }
    } catch (failure) { if (currentRevision === revision.current && !missingModel(failure)) setError(failure.message); }
    finally { if (currentRevision === revision.current) setPhase(''); }
  };
  const exportModel = async (downloadName) => {
    if (!ready || exportBusy.current) return;
    exportBusy.current = true; setError(''); setNotice('');
    const currentRevision = revision.current;
    const filename = typeof downloadName === 'string' ? downloadName : `${models.a.name.replace(/\.ply$/i, '')}-${settings.mode === 'replace' ? 'replaced' : 'merged'}.ply`;
    let handle = null, writable = null;
    try {
      if (typeof downloadName !== 'string') {
        if (typeof window.showSaveFilePicker !== 'function') { setExportDialog(filename); return; }
        setPhase('selecting');
        try { handle = await window.showSaveFilePicker({ id: 'model-pair-ply-export', suggestedName: filename, excludeAcceptAllOption: true,
          types: [{ description: 'PLY 点云 / 网格', accept: { 'application/octet-stream': ['.ply'] } }] }); }
        catch (failure) {
          if (failure.name === 'AbortError') return;
          if (['SecurityError', 'NotSupportedError'].includes(failure.name)) { setExportDialog(filename); return; }
          throw failure;
        }
      }
      if (currentRevision !== revision.current) return;
      setExportDialog(null); setPhase('exporting');
      const { buffer } = await request('export', { key: settingsKey });
      if (handle) {
        writable = await handle.createWritable(); await writable.write(buffer); await writable.close(); writable = null;
        setNotice(`已保存 ${handle.name}`);
      } else {
        if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
        exportUrl.current = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = exportUrl.current; link.download = filename;
        document.body.appendChild(link); link.click(); link.remove(); setNotice(`已开始下载 ${filename}`);
      }
    } catch (failure) {
      if (writable) { try { await writable.abort(); } catch { /* Already closed. */ } }
      if (!missingModel(failure)) setError(`模型导出失败：${failure.message}`);
    } finally { exportBusy.current = false; if (currentRevision === revision.current) setPhase(''); }
  };

  if (!active) return null;
  const slotCard = (slot) => <ModelSlot key={slot} slot={slot} model={models[slot]} load={loads[slot]} disabled={busy || dragging}
    onChoose={() => inputs.current[slot]?.click()} onLoad={(file) => loadFile(slot, file)} />;
  const numberField = (field, label, unit) => <label className="model-editor__numeric" key={field}><span>{label}</span><div>
    <input type="number" aria-label={`模型 B ${label}`} step={unit === 'm' ? 0.01 : 1} value={settings.pose[field]}
      onChange={(event) => update((next) => { next.pose[field] = event.target.value; return next; })} /><small>{unit}</small></div></label>;
  return <div className="model-editor model-pair-editor" data-app-page="model-pair-editor"
    data-editor-state={phase || (loading ? 'loading' : editing && settingsError ? 'error' : displayPending ? 'processing' : anyLoaded ? 'ready' : 'empty')}
    data-workspace-stage={editing ? 'editing' : 'loading'}
    data-composition-state={dirty ? 'draft' : 'applied'} data-model-point-count={result?.stats.pointCount} data-model-face-count={result?.stats.faceCount}
    onFocusCapture={(event) => { if (event.target.matches('input[type="number"]')) beginGroup('field', event.target); }}
    onBlurCapture={(event) => { if (history.current.group?.target === event.target) finishGroup(); }}
    onKeyDownCapture={(event) => { if (event.key === 'Enter' && event.target.matches('input[type="number"]')) { finishGroup(); beginGroup('field', event.target); } }}>
    {slots.map((slot) => <input key={slot} type="file" accept=".ply" className="visually-hidden" aria-label={`导入模型 ${slot.toUpperCase()} 文件`}
      ref={(element) => { inputs.current[slot] = element; }} onChange={(event) => { loadFile(slot, event.target.files?.[0]); event.target.value = ''; }} />)}
    <header className="model-editor__header">
      <button type="button" className="model-editor__home" onClick={onBack} disabled={busy || dragging}><ArrowLeft size={16} />模型编辑</button>
      <span className="model-editor__brand-icon"><Boxes size={24} strokeWidth={1.5} /></span>
      <div className="model-editor__title"><small>MODEL STUDIO / DUAL</small><h1>双模型处理</h1></div>
      <div className="model-editor__header-actions">{editing && <button type="button" onClick={() => { finishGroup(); setMode('view'); setEditing(false); }} disabled={busy || dragging}><FolderOpen size={15} />模型加载</button>}
        <button type="button" onClick={() => setDetails(true)} disabled={!anyLoaded || busy || dragging}><FileText size={15} />模型详情</button>
        <button type="button" className="model-editor__primary" disabled={!ready} onClick={() => exportModel()}><ArrowDownToLine size={15} />导出 PLY</button></div>
    </header>
    <main className={`model-editor__main ${editing ? '' : 'model-pair__preparation'}`}>
      {!editing ? <>
        <div className="model-pair__preparation-heading"><h2>双模型处理空间</h2><span>加载模型</span></div>
        <div className="model-pair__load-grid">{slots.map((slot) => <section key={slot} className={`model-pair__load-panel is-${slot}`} aria-label={`模型 ${slot.toUpperCase()} 加载与预览`} data-load-state={loads[slot].status}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
          onDrop={(event) => { event.preventDefault(); loadFile(slot, event.dataTransfer.files[0]); }}>
          {slotCard(slot)}
          <div className="model-pair__preview">
            {models[slot] ? <ModelEditorViewport ariaLabel={`模型 ${slot.toUpperCase()} 三维预览`} preview={models[slot].preview} revision={models[slot].revision}
              display={slotDisplays[slot]} onDisplayChange={(value) => setSlotDisplays((current) => ({ ...current, [slot]: value }))}
              originPose={ZERO_MODEL_ORIGIN} previewOrigin={ZERO_MODEL_ORIGIN} sourceBounds={models[slot].stats.bounds}
              originMode="view" originDisabled onOriginDragChange={noop} />
              : <div className="model-pair__placeholder" aria-hidden="true"><Box size={72} strokeWidth={0.7} /><span>{loads[slot].status === 'loading' ? '正在读取模型' : `等待加载模型 ${slot.toUpperCase()}`}</span></div>}
            {loads[slot].status === 'loading' && <div className="model-pair__load-status" role="status"><LoaderCircle size={15} /><span>正在读取 {loads[slot].name}…</span></div>}
            {loads[slot].status === 'error' && <div className="model-pair__load-status is-error" role="alert"><span>{loads[slot].name} 加载失败：{loads[slot].error}{models[slot] ? `。仍显示 ${models[slot].name}，请重新加载。` : ''}</span></div>}
          </div>
        </section>)}</div>
        <div className="model-pair__start">{canStart && <button type="button" className="model-editor__primary" onClick={() => { if (canStart) setEditing(true); }}>开始编辑<ArrowRight size={16} /></button>}</div>
      </> : <>
        <section className="model-editor__scene" aria-label="双模型预览"><ModelEditorViewport
          fileName={slots.filter((slot) => models[slot]).map((slot) => `${slot.toUpperCase()} · ${models[slot].name}`).join(' / ')}
          preview={models.b?.preview} revision={`${models.a?.revision || 0}:${models.b?.revision || 0}`} display={display} onDisplayChange={setDisplay}
          qualityControls={slots.map((slot) => <label key={slot} className={`model-pair__quality is-${slot}`}><span>{slot.toUpperCase()} 质量</span>
            <select aria-label={`模型 ${slot.toUpperCase()} 显示质量`} value={slotDisplays[slot].quality}
              onChange={(event) => { const quality = event.target.value; setSlotDisplays((current) => ({ ...current, [slot]: { ...current[slot], quality } })); }}>
              {MODEL_EDITOR_DISPLAY_QUALITIES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select></label>)}
          originPose={validOrigin.current} previewOrigin={ZERO_MODEL_ORIGIN} sourceBounds={models.b?.stats.bounds}
          originMode={mode} onOriginModeChange={setMode} originDisabled={busy || !models.b || Boolean(settingsError)}
          onOriginChange={(origin) => { if (workerRef.current) update((next) => ({ ...next, pose: inverseModelPose(origin, next.pose) })); }}
          onOriginDragChange={dragChanged} onUndo={undo} composition={composition} /></section>
        <aside className="model-editor__settings" aria-label="双模型处理参数">
          <div className="model-editor__settings-title"><div><small>DUAL MODEL WORKSPACE</small><strong>处理参数</strong></div><button type="button" disabled={busy || dragging} onClick={() => update(() => clone(DEFAULT_MODEL_COMPOSITION))}><RotateCcw size={13} />重置全部</button></div>
          <fieldset className="model-editor__controls" disabled={busy || dragging}>
            <section className="model-editor__section model-pair__files">{slots.map(slotCard)}</section>
            <section className="model-editor__section"><h2><span>01</span><Move3D size={16} />模型 B 姿态</h2>
              <fieldset disabled={!models.b}>
                <div className="model-editor__origin-tools" role="group" aria-label="调整模型 B 姿态">{[['view', '浏览视图', MousePointer2], ['translate', '移动模型', Move3D], ['rotate', '旋转模型', Rotate3D]].map(([value, label, Icon]) => <button type="button" key={value} aria-pressed={mode === value} disabled={value !== 'view' && Boolean(settingsError)} aria-keyshortcuts={value === 'view' ? 'Escape' : undefined} onClick={() => setMode(value)}><Icon size={13} />{label}</button>)}</div>
                <div className="model-editor__triple">{['x', 'y', 'z'].map((field) => numberField(field, field.toUpperCase(), 'm'))}</div>
                <div className="model-editor__triple">{['roll', 'pitch', 'yaw'].map((field) => numberField(field, field.toUpperCase(), '°'))}</div>
                <div className="model-editor__inline-actions"><button type="button" onClick={() => update((next) => ({ ...next, pose: clone(ZERO_MODEL_ORIGIN) }))}>归零</button><label className="model-pair__envelope"><input type="checkbox" checked={showEnvelope} onChange={(event) => setShowEnvelope(event.target.checked)} />显示 B 外包络</label></div>
              </fieldset>
            </section>
            <section className="model-editor__section"><h2><span>02</span><Boxes size={16} />处理模式</h2>
              <div className="model-pair__choices" role="radiogroup" aria-label="双模型处理模式">
                {[['replace', '替换', '移除 B 包络内的 A，再加入 B'], ['merge', '合并', '保留 A，加入调整后的 B']].map(([value, label, description]) => <label key={value}>
                  <input type="radio" name="model-pair-mode" value={value} checked={settings.mode === value} onChange={() => update((next) => ({ ...next, mode: value }))} /><span><strong>{label}</strong><small>{description}</small></span></label>)}
              </div>
              {settingsError && <p className="model-editor__crop-error" role="alert">{settingsError}</p>}
              <div className="model-editor__crop-actions"><span>{!bothLoaded ? '等待两个模型' : dirty ? '待确认' : '已确认'}</span><button type="button" className="model-editor__primary" aria-label="确定双模型处理" onClick={confirm} disabled={!bothLoaded || !dirty || Boolean(settingsError)}>确定</button></div>
            </section>
          </fieldset>
        </aside>
      </>}
    </main>
    {details && <PairDetails models={models} result={result} dirty={dirty} onClose={() => setDetails(false)} />}
    {exportDialog && <ModelExportDialog filename={exportDialog} onSave={exportModel} onClose={() => setExportDialog(null)} />}
    {(error || notice) && <div className={`model-editor__message ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}><X size={14} /></button></div>}
    {busy && <div className="model-editor__busy" role="status"><LoaderCircle size={23} /><strong>{phase === 'composing' ? '正在处理两个模型…' : phase === 'selecting' ? '请选择文件名和保存位置…' : '正在导出模型…'}</strong></div>}
  </div>;
}
