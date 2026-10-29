import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, Box, Boxes, Crop, FileText, FolderOpen, Layers3, LoaderCircle, MousePointer2, Move3D, Rotate3D, RotateCcw, Upload, X } from 'lucide-react';
import ModelEditorViewport from "./ModelEditorViewport.jsx";
import ModelExportDialog from "./ModelExportDialog.jsx";
import { readModelOrigin, ZERO_MODEL_ORIGIN } from "../model/modelOriginTransform.js";
import { enclosingModelCrop, modelCropError, readModelCrop, sameModelCrop } from "../model/modelCrop.js";
import "./ModelEditorPage.css";

const AXES = ['x', 'y', 'z'];
const UNDO_LIMIT = 100;
const formatCount = (value = 0) => value.toLocaleString('zh-CN');
const formatBytes = (bytes = 0) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const clone = (value) => structuredClone(value);
const compactNumber = (value) => Number(value.toPrecision(7));
const isMissingModel = (failure) => failure.code === 'MODEL_NOT_LOADED';

function NumericField({ label, value, onChange, step = 0.01, unit, ...props }) {
  return <label className="model-editor__numeric"><span>{label}</span><div><input type="number" value={value} step={step} onChange={(event) => onChange(event.target.value)} {...props} /><small>{unit}</small></div></label>;
}

function ModelDetailsDialog({ source, result, pending, editError, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement, dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const bounds = result.stats.bounds;
  const reduction = source.stats.pointCount ? (1 - result.stats.pointCount / source.stats.pointCount) * 100 : 0;
  return <dialog ref={dialogRef} className="model-editor__details" aria-labelledby="model-editor-details-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header><FileText size={20} /><h2 id="model-editor-details-title">模型详情</h2><button type="button" aria-label="关闭模型详情" onClick={onClose}><X size={18} /></button></header>
    <div className="model-editor__details-file"><strong>{source.name}</strong><span>原始文件 · {formatBytes(source.byteLength)}</span></div>
    <div className="model-editor__statistics" aria-label="编辑结果统计" aria-busy={pending}>
      <div><small>顶点 / 点数</small><strong>{formatCount(result.stats.pointCount)}</strong><span>原始 {formatCount(source.stats.pointCount)}</span></div>
      <div><small>三角面</small><strong>{formatCount(result.stats.faceCount)}</strong><span>原始 {formatCount(source.stats.faceCount)}</span></div>
      <div><small>数据体积 · 约</small><strong>{formatBytes(result.stats.payloadBytes)}</strong><span>{reduction >= 0 ? `顶点减少 ${reduction.toFixed(1)}%` : '裁剪边界新增顶点'}</span></div>
      <div className="model-editor__dimensions"><small>结果尺寸 · m</small>{AXES.map((axis) => <span key={axis}><b>{axis.toUpperCase()}</b>{bounds ? (bounds.max[axis] - bounds.min[axis]).toFixed(3) : '—'}</span>)}</div>
    </div>
    {(pending || editError) && <p className="model-editor__details-status" role="status">{editError ? '当前为上次有效编辑结果。' : '正在更新编辑结果…'}</p>}
  </dialog>;
}

export default function ModelEditorPage({ active, onHome, onOpenPair }) {
  const inputRef = useRef(null), workerRef = useRef(null), pendingRef = useRef(new Map()), sequenceRef = useRef(0);
  const loadedRevisionRef = useRef(0), exportUrlRef = useRef(null), exportBusyRef = useRef(false);
  const settingsRef = useRef(null), historyRef = useRef({ past: [], group: null });
  const [source, setSource] = useState(null), [settings, setSettings] = useState(null), [result, setResult] = useState(null);
  const [phase, setPhase] = useState(''), [error, setError] = useState(''), [editError, setEditError] = useState('');
  const [notice, setNotice] = useState(''), [showOriginal, setShowOriginal] = useState(false), [dragging, setDragging] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [exportDialog, setExportDialog] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [display, setDisplay] = useState({ quality: 'balanced', pointSize: 3 });
  const [displayPending, setDisplayPending] = useState(false);
  const [originMode, setOriginMode] = useState('view'), [originDragging, setOriginDragging] = useState(false);
  const [cropDragging, setCropDragging] = useState(false);
  const displayRef = useRef(display);
  displayRef.current = display;
  // Draft box edits belong to undo history, but reach the worker only on Confirm.
  const editSettings = settings ? { origin: settings.origin, crop: settings.crop, reduction: settings.reduction } : null;
  const settingsKey = editSettings ? JSON.stringify(editSettings) : '';
  const cropDraft = settings?.cropDraft;
  const cropError = modelCropError(cropDraft);
  const cropDirty = Boolean(settings && !sameModelCrop(cropDraft, settings.crop));
  const previewCrop = useMemo(() => readModelCrop(cropDraft), [cropDraft]);
  const needsSourcePreview = showOriginal || Boolean(cropDraft?.enabled) || cropDirty;
  const pending = Boolean(source && (originDragging || processing || settingsKey !== result?.key) && !editError);
  const busy = Boolean(phase), manipulating = originDragging || cropDragging;
  const ready = Boolean(source && !busy && !editError && !pending && !cropDirty && !cropDragging && result?.stats.pointCount > 0);
  const loading = phase === 'loading';
  const previewOrigin = useMemo(() => result?.key ? JSON.parse(result.key).origin : ZERO_MODEL_ORIGIN, [result?.key]);

  useEffect(() => {
    if (!active) {
      if (historyRef.current.group?.kind === 'field') finishEditGroup();
      setOriginMode('view'); setOriginDragging(false); setCropDragging(false); setDetailsOpen(false); setExportDialog(null);
    }
  }, [active]);

  const returnToWelcome = (failure) => {
    loadedRevisionRef.current += 1;
    workerRef.current?.terminate(); workerRef.current = null;
    for (const promise of pendingRef.current.values()) promise.reject(failure);
    pendingRef.current.clear();
    settingsRef.current = null; historyRef.current = { past: [], group: null };
    if (exportUrlRef.current) { URL.revokeObjectURL(exportUrlRef.current); exportUrlRef.current = null; }
    setSource(null); setSettings(null); setResult(null);
    setPhase(''); setError(''); setEditError(''); setNotice('');
    setProcessing(false); setDisplayPending(false); setShowOriginal(false); setDragging(false);
    setDetailsOpen(false); setExportDialog(null); setOriginMode('view'); setOriginDragging(false); setCropDragging(false);
  };
  const getWorker = () => {
    if (!workerRef.current) {
      const worker = new Worker(new URL("../workers/modelEditor.worker.js", import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const promise = pendingRef.current.get(data.id);
        if (!promise) return;
        pendingRef.current.delete(data.id);
        if (data.error) {
          const failure = Object.assign(new Error(data.error), { code: data.code });
          if (isMissingModel(failure)) returnToWelcome(failure);
          promise.reject(failure);
        } else promise.resolve(data.data);
      };
      worker.onerror = () => {
        for (const promise of pendingRef.current.values()) promise.reject(new Error('模型处理线程异常，请重新导入模型'));
        pendingRef.current.clear(); worker.terminate(); workerRef.current = null;
      };
      workerRef.current = worker;
    }
    return workerRef.current;
  };
  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    if (type !== 'load' && !settingsRef.current) {
      reject(Object.assign(new Error('模型尚未导入'), { code: 'MODEL_NOT_LOADED' }));
      return;
    }
    const id = ++sequenceRef.current;
    try { const worker = getWorker(); pendingRef.current.set(id, { resolve, reject }); worker.postMessage({ id, type, ...payload }); }
    catch (failure) { pendingRef.current.delete(id); reject(failure); }
  });

  useEffect(() => () => {
    loadedRevisionRef.current += 1;
    workerRef.current?.terminate(); workerRef.current = null;
    for (const promise of pendingRef.current.values()) promise.reject(new Error('模型编辑已关闭'));
    pendingRef.current.clear();
    if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
  }, []);

  useEffect(() => {
    if (!source || loading || originDragging) return undefined;
    let cancelled = false;
    setProcessing(true);
    const timer = window.setTimeout(() => {
      request('edit', { settings: editSettings, key: settingsKey, quality: displayRef.current.quality }).then((next) => {
        if (!cancelled) { setResult(next); setEditError(''); setProcessing(false); }
      }).catch((failure) => { if (!cancelled && !isMissingModel(failure)) { setEditError(failure.message); setProcessing(false); } });
    }, 280);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [settingsKey, source?.revision, loading, originDragging]);

  // Display quality only rebuilds preview buffers from the worker's full model.
  // It must not rerun edits, change export data, or reset the camera.
  useEffect(() => {
    const targets = [];
    if (result?.preview?.quality !== display.quality) targets.push('result');
    if (needsSourcePreview && source?.preview?.quality !== display.quality) targets.push('source');
    if (!source || loading || originDragging || processing || settingsKey !== result?.key || !targets.length) {
      setDisplayPending(false);
      return undefined;
    }
    let cancelled = false;
    setDisplayPending(true);
    Promise.all(targets.map(async (target) => ({ target, ...await request('preview', { quality: display.quality, target, key: result?.key }) })))
      .then((previews) => {
        if (cancelled) return;
        for (const { target, preview } of previews) {
          if (target === 'source') setSource((current) => ({ ...current, preview }));
          else setResult((current) => ({ ...current, preview }));
        }
      })
      .catch((failure) => { if (!cancelled && !isMissingModel(failure)) setError(`显示质量更新失败：${failure.message}`); })
      .finally(() => { if (!cancelled) setDisplayPending(false); });
    return () => { cancelled = true; };
  }, [display.quality, needsSourcePreview, source?.revision, source?.preview?.quality, result?.key, result?.preview?.quality, loading, processing, settingsKey, originDragging]);

  const rememberSettings = (before) => {
    historyRef.current.past.push(clone(before));
    if (historyRef.current.past.length > UNDO_LIMIT) historyRef.current.past.shift();
  };
  const finishEditGroup = () => {
    const group = historyRef.current.group;
    historyRef.current.group = null;
    if (group && JSON.stringify(group.before) !== JSON.stringify(settingsRef.current)) rememberSettings(group.before);
  };
  const beginEditGroup = (kind, target = null) => {
    if (!settingsRef.current) return;
    const group = historyRef.current.group;
    if (group?.kind === kind && group.target === target) return;
    finishEditGroup();
    historyRef.current.group = { kind, target, before: clone(settingsRef.current) };
  };
  const applySettings = (next) => {
    settingsRef.current = next;
    setEditError(''); setNotice('');
    setSettings(next);
  };
  const updateSettings = (update) => {
    const before = settingsRef.current;
    if (!before) return;
    const next = update(clone(before));
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    if (!historyRef.current.group) rememberSettings(before);
    applySettings(next);
  };
  const undoSettings = () => {
    if (busy || !source) return;
    const field = historyRef.current.group?.kind === 'field' ? historyRef.current.group.target : null;
    finishEditGroup();
    const previous = historyRef.current.past.pop();
    if (previous) applySettings(previous);
    // Continue grouping edits if Undo was pressed inside a numeric field.
    if (field && document.activeElement === field) beginEditGroup('field', field);
  };
  const originDragChanged = (isDragging) => {
    if (isDragging) beginEditGroup('drag');
    else if (historyRef.current.group?.kind === 'drag') finishEditGroup();
    setOriginDragging(isDragging);
  };
  const cropDragChanged = (isDragging, cancelled = false) => {
    if (isDragging) beginEditGroup('crop-drag');
    else if (historyRef.current.group?.kind === 'crop-drag') {
      if (cancelled) applySettings(historyRef.current.group.before);
      finishEditGroup();
    }
    setCropDragging(isDragging);
  };
  const isHistoryField = (target) => target?.closest?.('.model-editor__controls')
    && target.matches('input[type="number"], input[type="range"]');
  const loadFile = async (file) => {
    if (!file || busy || manipulating) return;
    if (!/\.ply$/i.test(file.name)) { setError('请选择 .ply 格式的点云或网格文件'); return; }
    setPhase('loading'); setError(''); setEditError(''); setNotice('');
    const revision = ++loadedRevisionRef.current;
    try {
      const next = await request('load', { file, quality: displayRef.current.quality });
      if (revision !== loadedRevisionRef.current) return;
      historyRef.current = { past: [], group: null };
      const defaults = { ...next.defaults, cropDraft: clone(next.defaults.crop), cropEditing: false };
      settingsRef.current = defaults;
      setSource({ name: file.name, byteLength: file.size, stats: next.stats, preview: next.preview, defaults, revision });
      setSettings(defaults); setResult(next); setShowOriginal(false); setDetailsOpen(false); setExportDialog(null); setOriginMode('view'); setOriginDragging(false); setCropDragging(false);
    } catch (failure) { if (revision === loadedRevisionRef.current) setError(failure.message); }
    finally { if (revision === loadedRevisionRef.current) setPhase(''); }
  };
  const exportModel = async (downloadName) => {
    if (!ready || exportBusyRef.current) return;
    exportBusyRef.current = true;
    setError(''); setNotice('');
    const filename = typeof downloadName === 'string' ? downloadName : `${source.name.replace(/\.ply$/i, '')}-edited.ply`;
    let fileHandle = null, writable = null;
    try {
      if (typeof downloadName !== 'string') {
        if (typeof window.showSaveFilePicker !== 'function') { setExportDialog(filename); return; }
        setPhase('selecting');
        try {
          // Open during the click's user activation, before the worker encodes a large model.
          fileHandle = await window.showSaveFilePicker({
            id: 'model-editor-ply-export', suggestedName: filename, excludeAcceptAllOption: true,
            types: [{ description: 'PLY 点云 / 网格', accept: { 'application/octet-stream': ['.ply'] } }],
          });
        } catch (failure) {
          if (failure.name === 'AbortError') return;
          if (['SecurityError', 'NotSupportedError'].includes(failure.name)) { setExportDialog(filename); return; }
          throw failure;
        }
      }
      setExportDialog(null); setPhase('exporting');
      const { buffer } = await request('export', { key: settingsKey });
      if (fileHandle) {
        writable = await fileHandle.createWritable();
        await writable.write(buffer);
        await writable.close(); writable = null;
        setNotice(`已保存 ${fileHandle.name} · ${formatBytes(buffer.byteLength)}`);
      } else {
        if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
        const url = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
        exportUrlRef.current = url;
        const link = document.createElement('a'); link.href = url; link.download = filename;
        document.body.appendChild(link); link.click(); link.remove();
        setNotice(`已开始下载 ${filename} · ${formatBytes(buffer.byteLength)}`);
      }
    } catch (failure) {
      if (writable) { try { await writable.abort(); } catch { /* The stream may already be closed or errored. */ } }
      if (!isMissingModel(failure)) setError(`模型导出失败：${failure.message || '无法写入所选文件'}`);
    } finally { exportBusyRef.current = false; setPhase(''); }
  };

  if (!active) return null;
  const hasMesh = source?.stats.faceCount > 0;
  const resetCrop = () => updateSettings((next) => ({ ...next, cropDraft: enclosingModelCrop(result.transformedBounds, next.cropDraft) }));
  const toggleCropEditing = (enabled) => {
    finishEditGroup();
    if (enabled) setOriginMode('view');
    updateSettings((next) => {
      // Closing the tool discards only the draft; the confirmed crop stays applied.
      const draft = enabled && !next.crop.enabled && result?.key === settingsKey
        ? enclosingModelCrop(result.transformedBounds, next.crop) : clone(next.crop);
      return { ...next, cropEditing: enabled, cropDraft: { ...draft, enabled: enabled || next.crop.enabled } };
    });
  };
  const confirmCrop = () => {
    if (busy || manipulating || pending || !settings.cropEditing || cropError || !cropDirty) return;
    finishEditGroup();
    updateSettings((next) => ({ ...next, crop: clone(next.cropDraft) }));
  };

  return <div className="model-editor" data-app-page="model-editor" data-editor-state={phase || (editError ? 'error' : pending || displayPending ? 'processing' : source ? 'ready' : 'empty')}
    data-model-point-count={result?.stats.pointCount} data-model-face-count={result?.stats.faceCount}
    data-crop-state={cropError ? 'invalid' : cropDirty ? 'draft' : settings?.crop.enabled ? 'applied' : 'disabled'}
    onFocusCapture={(event) => { if (isHistoryField(event.target)) beginEditGroup('field', event.target); }}
    onBlurCapture={(event) => { if (historyRef.current.group?.target === event.target) finishEditGroup(); }}
    onPointerDownCapture={(event) => {
      if (isHistoryField(event.target) && event.target.type === 'range') { finishEditGroup(); beginEditGroup('field', event.target); }
    }}
    onPointerUpCapture={(event) => {
      if (event.target.type === 'range' && historyRef.current.group?.target === event.target) finishEditGroup();
    }}
    onKeyDownCapture={(event) => {
      if (event.key === 'Enter' && isHistoryField(event.target)) { finishEditGroup(); beginEditGroup('field', event.target); }
    }}>
    <input ref={inputRef} type="file" accept=".ply" className="visually-hidden" aria-label="导入模型文件" onChange={(event) => { loadFile(event.target.files?.[0]); event.target.value = ''; }} />
    <header className="model-editor__header">
      <button type="button" className="model-editor__home" onClick={onHome} disabled={manipulating}><ArrowLeft size={16} />主页面</button>
      <span className="model-editor__brand-icon"><Box size={22} strokeWidth={1.5} /></span>
      <div className="model-editor__title"><small>VIRTUAL TEACHING / MODEL STUDIO</small><h1>模型编辑</h1></div>
      <div className="model-editor__header-actions">
        {source && onOpenPair && <button type="button" className="model-editor__pair-shortcut" onClick={onOpenPair} disabled={busy || manipulating} aria-label="双模型处理" title="双模型处理"><Boxes size={15} /><span>双模型处理</span></button>}
        <button type="button" onClick={() => setDetailsOpen(true)} disabled={!source || busy || manipulating} aria-haspopup="dialog"><FileText size={15} />模型详情</button>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy || manipulating}><FolderOpen size={15} />{source ? '更换模型' : '导入 PLY'}</button>
        <button type="button" className="model-editor__primary" onClick={() => exportModel()} disabled={!ready}><ArrowDownToLine size={15} />导出 PLY</button>
      </div>
    </header>

    <main className={`model-editor__main ${source ? '' : 'is-empty'}`}>
      {!source ? <div className={`model-editor__empty ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); loadFile(event.dataTransfer.files[0]); }}>
        <div className="model-editor__empty-art"><Box size={76} strokeWidth={0.8} /><span className="is-x">X</span><span className="is-y">Y</span><span className="is-z">Z</span></div>
        <small>PREPARE YOUR SCENE</small><h2>模型编辑空间</h2>
        <div className="model-editor__workspaces">
          <section><div className="model-editor__workspace-title"><Box size={22} /><h3>单模型处理</h3><small>01</small></div>
            <p>坐标原点 · 裁剪 · 降采样</p><button type="button" className="model-editor__primary" onClick={() => inputRef.current?.click()} disabled={busy}><Upload size={17} />选择 PLY 模型</button></section>
          <section><div className="model-editor__workspace-title"><Boxes size={23} /><h3>双模型处理</h3><small>02</small></div>
            <p>模型 A + B · 姿态调整 · 替换与合并</p><button type="button" onClick={onOpenPair} disabled={busy}><Boxes size={17} />打开双模型处理</button></section>
        </div>
      </div> : <>
        <section className="model-editor__scene" aria-label="模型预览">
          <ModelEditorViewport fileName={source.name} preview={cropDirty ? source.preview : result?.preview} crop={previewCrop}
            cropPreview={cropDirty} cropEditing={settings.cropEditing} onCropChange={(crop) => updateSettings((next) => ({ ...next, cropDraft: crop }))} onCropDragChange={cropDragChanged}
            originalPreview={source.preview} showOriginal={showOriginal} onShowOriginalChange={setShowOriginal}
            revision={source.revision} display={display} onDisplayChange={setDisplay}
            originPose={settings.origin} previewOrigin={cropDirty ? ZERO_MODEL_ORIGIN : previewOrigin} sourceBounds={source.stats.bounds} originMode={originMode} onOriginModeChange={setOriginMode} originDisabled={busy}
            onOriginChange={(origin) => updateSettings((next) => ({ ...next, origin }))} onOriginDragChange={originDragChanged} onUndo={undoSettings} />
        </section>
        <aside className="model-editor__settings" aria-label="模型编辑参数">
          <div className="model-editor__settings-title"><div><small>EDIT PIPELINE</small><strong>编辑参数</strong></div><button type="button" disabled={busy || manipulating} onClick={() => updateSettings(() => clone(source.defaults))}><RotateCcw size={13} />重置全部</button></div>
          <fieldset disabled={busy || manipulating} className="model-editor__controls">
            <section className="model-editor__section">
              <h2><span>01</span><Move3D size={16} />坐标原点</h2>
              <div className="model-editor__origin-tools" role="group" aria-label="三维调整坐标原点">
                {[['view', '浏览视图', MousePointer2], ['translate', '移动模型', Move3D], ['rotate', '旋转模型', Rotate3D]].map(([mode, label, Icon]) => <button
                  type="button" key={mode} aria-pressed={originMode === mode} disabled={mode !== 'view' && !readModelOrigin(settings.origin)}
                  aria-keyshortcuts={mode === 'view' ? 'Escape' : undefined}
                  title={mode === 'view' ? '结束模型操纵，浏览视角（Esc）' : `${label}：原点固定，直接拖动画布或操纵柄；右键 / Shift + 左键移动模型，Esc 退出调整，Ctrl + Z 撤销`}
                  onClick={() => setOriginMode(mode)}><Icon size={13} />{label}</button>)}
              </div>
              <div className="model-editor__triple">{AXES.map((axis) => <NumericField key={axis} label={axis.toUpperCase()} unit="m" aria-label={`原点 ${axis.toUpperCase()}`} value={settings.origin[axis]} onChange={(value) => updateSettings((next) => { next.origin[axis] = value; return next; })} />)}</div>
              <div className="model-editor__triple">{['roll', 'pitch', 'yaw'].map((axis) => <NumericField key={axis} label={axis.toUpperCase()} unit="°" step={1} aria-label={`原点 ${axis}`} value={settings.origin[axis]} onChange={(value) => updateSettings((next) => { next.origin[axis] = value; return next; })} />)}</div>
              <div className="model-editor__inline-actions"><button type="button" onClick={() => updateSettings((next) => { AXES.forEach((a) => { next.origin[a] = compactNumber((source.stats.bounds.min[a] + source.stats.bounds.max[a]) / 2); }); return next; })}>原点置于模型中心</button><button type="button" onClick={() => updateSettings((next) => ({ ...next, origin: clone(source.defaults.origin) }))}>归零</button></div>
            </section>
            <section className="model-editor__section">
              <h2><span>02</span><Crop size={16} />裁剪模型<label className="model-editor__switch"><input type="checkbox" aria-label="启用模型裁剪" checked={settings.cropEditing} onChange={(event) => toggleCropEditing(event.target.checked)} /><i /></label></h2>
              <fieldset disabled={!settings.cropEditing} className="model-editor__crop-fields">
                <div className="model-editor__range-heading"><span>轴</span><span>下限 / m</span><span>上限 / m</span></div>
                {AXES.map((a) => <div className="model-editor__range-row" key={a}><b>{a.toUpperCase()}</b>{['min', 'max'].map((edge) => <input type="number" key={edge} step="0.01" aria-label={`裁剪 ${a.toUpperCase()} ${edge === 'min' ? '下限' : '上限'}`} value={cropDraft[edge][a]} onChange={(event) => updateSettings((next) => { next.cropDraft[edge][a] = event.target.value; return next; })} />)}</div>)}
                <button type="button" className="model-editor__text-action" disabled={pending} onClick={resetCrop}>使用变换后完整范围</button>
                <div className="model-editor__crop-choice" role="radiogroup" aria-label="裁剪保留区域">
                  {[['inside', '取内'], ['outside', '取外']].map(([mode, label]) => <label key={mode}><input type="radio" name="model-crop-mode" value={mode} checked={cropDraft.mode === mode}
                    onChange={() => updateSettings((next) => ({ ...next, cropDraft: { ...next.cropDraft, mode } }))} /><span>{label}</span></label>)}
                </div>
              </fieldset>
              {cropError && <p className="model-editor__crop-error" role="alert">{cropError}</p>}
              <div className="model-editor__crop-actions"><span>{cropDirty ? '待确认' : settings.crop.enabled ? '已应用' : '未启用'}</span><button type="button" className="model-editor__primary" onClick={confirmCrop} disabled={!settings.cropEditing || !cropDirty || Boolean(cropError) || pending} aria-label="确定裁剪">确定</button></div>
            </section>
            <section className="model-editor__section">
              <h2><span>03</span><Layers3 size={16} />降采样 / 降质量</h2>
              <label className="model-editor__select-label"><select aria-label="降采样方式" value={settings.reduction.mode} onChange={(event) => updateSettings((next) => { next.reduction.mode = event.target.value; return next; })}><option value="none">保持原始质量</option><option value="voxel">{hasMesh ? '体素网格简化' : '体素降采样'}</option>{!hasMesh && <option value="uniform">按比例均匀抽稀</option>}</select></label>
              {settings.reduction.mode === 'voxel' && <><NumericField label="体素尺寸" unit="m" aria-label="体素尺寸" min="0.000001" step="0.001" value={settings.reduction.voxelSize} onChange={(value) => updateSettings((next) => { next.reduction.voxelSize = value; return next; })} /><small className="model-editor__note">尺寸越大，模型越精简，细节损失越多。合并点使用平均位置与颜色。</small></>}
              {settings.reduction.mode === 'uniform' && <><NumericField label="保留比例" unit="%" aria-label="保留比例" min="1" max="100" step={1} value={settings.reduction.percentage} onChange={(value) => updateSettings((next) => { next.reduction.percentage = value; return next; })} /><input className="model-editor__slider" type="range" aria-label="调整保留比例" min="1" max="100" value={settings.reduction.percentage || 1} onChange={(event) => updateSettings((next) => { next.reduction.percentage = event.target.value; return next; })} /></>}
            </section>
          </fieldset>
        </aside>
      </>}
    </main>
    {detailsOpen && source && <ModelDetailsDialog source={source} result={result} pending={pending} editError={editError} onClose={() => setDetailsOpen(false)} />}
    {exportDialog && <ModelExportDialog filename={exportDialog} onSave={exportModel} onClose={() => setExportDialog(null)} />}
    {(error || editError || notice || (!pending && !cropDirty && result?.stats.pointCount === 0)) && <div className={`model-editor__message ${error || editError || result?.stats.pointCount === 0 ? 'is-error' : ''}`} role={error || editError ? 'alert' : 'status'}>{error || editError || notice || '裁剪结果为空，请调整范围或取内／取外后再确认。'}{editError && <small>当前显示上次有效预览。</small>}<button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }} disabled={Boolean(editError) || result?.stats.pointCount === 0}><X size={14} /></button></div>}
    {busy && <div className="model-editor__busy" role="status"><LoaderCircle size={23} /><strong>{phase === 'loading' ? '正在读取模型…' : phase === 'selecting' ? '请选择文件名和保存位置…' : '正在导出模型…'}</strong>{phase !== 'selecting' && <span>正在后台处理，请稍候</span>}</div>}
  </div>;
}
