import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, Check, FileText, FolderOpen, LoaderCircle, Map, MapPin, Plus, Route, ScanLine, X } from 'lucide-react';
import { identityTransferPose, parseTransferMatrixFile, transformTeachingPose } from "../../teaching/model/teachingTransfer.js";
import { defaultIndependentTeachingName, INDEPENDENT_TEACHING_NAME_MAX_LENGTH, validateIndependentTeachingName } from "../model/independentTeachingName.js";
import { TEACHING_WAYPOINT_SOURCE, TEMPORARY_MAP_ROUTE_SOURCE } from "../../teaching/model/teachingNavigation.js";
import { loadIndependentCreationPreferences, saveIndependentCreationPreferences } from "../model/independentCreationPreferences.js";
import "./NewIndependentTeachingDialog.css";

export default function NewIndependentTeachingDialog({ state, progress, onCreate, onClose, onLoadRoute }) {
  const dialogRef = useRef(null);
  const modelInputRef = useRef(null);
  const matrixInputRef = useRef(null);
  const routeInputRef = useRef(null);
  const modelButtonRef = useRef(null);
  const matrixReadRevision = useRef(0);
  const nameEditedRef = useRef(false);
  const [name, setName] = useState('');
  const [modelFile, setModelFile] = useState(null);
  const [modelError, setModelError] = useState('');
  const [matrix, setMatrix] = useState(null);
  const [matrixError, setMatrixError] = useState('');
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [creationPreferences, setCreationPreferences] = useState(loadIndependentCreationPreferences);
  const hasMap = Boolean(state.mapSnapshot);
  const busy = state.busy === true || state.routeLoading === true;
  const hasRoute = Boolean(state.mapSnapshot?.config?.config?.project?.waypoints?.some((point) =>
    point.source !== TEACHING_WAYPOINT_SOURCE && point.source !== TEMPORARY_MAP_ROUTE_SOURCE));
  const canLoadRoute = hasMap && !hasRoute;
  const canPlace = hasMap && Boolean(modelFile) && !modelError && Boolean(matrix) && !matrixError && !matrixLoading;
  const canSyncRoute = canPlace && hasRoute;
  const syncRoute = canSyncRoute && creationPreferences.syncRoute;
  const placeInMap = canPlace && creationPreferences.placeInMap;
  const placementDisabledReason = !hasMap ? '请先加载地图示教工程'
    : !modelFile || modelError ? '请先选择有效的独立模型'
      : matrixLoading ? '正在读取转换矩阵'
        : !matrix || matrixError ? '请先加载有效的转换矩阵' : '';
  const routeDisabledReason = !hasMap ? placementDisabledReason
    : !hasRoute ? '请先在地图示教中导入路网' : placementDisabledReason;

  const toggleCreationOption = (key) => {
    const next = { ...creationPreferences, [key]: !creationPreferences[key] };
    setCreationPreferences(next);
    // Only explicit choices change the memory. Missing files merely disable it.
    saveIndependentCreationPreferences(next);
  };

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    modelButtonRef.current?.focus();
    return () => {
      matrixReadRevision.current += 1;
      dialog.close();
      previous?.focus?.();
    };
  }, []);

  const chooseModel = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    if (!/\.ply$/i.test(file.name)) {
      setModelError('请选择 PLY 点云或模型文件');
      return;
    }
    setModelError('');
    setModelFile(file);
    if (!nameEditedRef.current) setName(defaultIndependentTeachingName(file.name));
  };

  const chooseMatrix = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || !hasMap) return;
    const revision = ++matrixReadRevision.current;
    setMatrixLoading(true);
    setMatrixError('');
    try {
      if (!/\.txt$/i.test(file.name)) throw new Error('请选择 .txt 转换矩阵文件');
      if (file.size > 1024 * 1024) throw new Error('转换矩阵文件不能超过 1 MB');
      const imported = parseTransferMatrixFile(await file.text());
      if (revision !== matrixReadRevision.current) return;
      setMatrix({ name: file.name, values: imported.values,
        localToMap: transformTeachingPose(identityTransferPose(), imported.matrix) });
    } catch (error) {
      if (revision === matrixReadRevision.current) setMatrixError(error.message || '转换矩阵读取失败');
    } finally {
      if (revision === matrixReadRevision.current) setMatrixLoading(false);
    }
  };

  const clearMatrix = () => {
    matrixReadRevision.current += 1;
    setMatrix(null);
    setMatrixError('');
    setMatrixLoading(false);
  };
  let nameError = '';
  try { validateIndependentTeachingName(name); } catch (error) { nameError = error.message; }
  const canCreate = Boolean(modelFile && !nameError && !modelError && !matrixError && !matrixLoading && !busy);

  return createPortal(<dialog ref={dialogRef} className="new-independent-dialog"
    aria-labelledby="new-independent-title" aria-describedby="new-independent-description" aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (canCreate) onCreate({ file: modelFile, matrix: hasMap ? matrix : null, name: name.trim(),
        syncRoute, placeInMap });
    }}>
      <header className="new-independent-dialog__header">
        <span className="new-independent-dialog__mark"><ScanLine size={24} /></span>
        <div><small>INDEPENDENT TEACHING</small><h2 id="new-independent-title">新增独立示教</h2>
          <p id="new-independent-description">选择独立模型，可同时设置它与地图的转换关系。</p></div>
        <button type="button" className="new-independent-dialog__close" aria-label="关闭新增独立示教"
          disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="new-independent-dialog__body">
        <label className="new-independent-dialog__name">独立示教名称
          <input value={name} onChange={(event) => { nameEditedRef.current = true; setName(event.target.value); }}
            aria-label="独立示教名称"
            maxLength={INDEPENDENT_TEACHING_NAME_MAX_LENGTH} required disabled={busy}
            placeholder="例如：1 号工位 · 左侧阀门" autoComplete="off" />
          {nameEditedRef.current && nameError && <small role="alert">{nameError}</small>}
        </label>
        <section className="new-independent-dialog__section" aria-labelledby="new-independent-model-title">
          <div className="new-independent-dialog__section-title"><span>01</span>
            <h3 id="new-independent-model-title">独立模型</h3><small>必选 · PLY</small></div>
          <div className={`new-independent-dialog__file${modelFile ? ' is-selected' : ''}`}>
            <ScanLine size={21} />
            <div><strong title={modelFile?.name}>{modelFile?.name || '选择点云或模型文件'}</strong>
              <span>{modelFile ? `${(modelFile.size / 1024 / 1024).toFixed(2)} MB · 保留模型原始坐标` : '使用模型原点建立独立示教空间'}</span></div>
            <button ref={modelButtonRef} type="button" disabled={busy} onClick={() => modelInputRef.current?.click()}>
              <FolderOpen size={14} />{modelFile ? '更换模型' : '选择模型'}</button>
          </div>
          <input ref={modelInputRef} type="file" accept=".ply,application/octet-stream" hidden
            aria-label="新增独立示教模型" disabled={busy} onChange={chooseModel} />
          {modelError && <p className="new-independent-dialog__error" role="alert">{modelError}</p>}
        </section>
        <section className={`new-independent-dialog__section${hasMap ? '' : ' is-unavailable'}`}
          aria-labelledby="new-independent-matrix-title">
          <div className="new-independent-dialog__section-title"><span>02</span>
            <h3 id="new-independent-matrix-title">转换矩阵</h3><small>可选 · TXT</small></div>
          <p className="new-independent-dialog__map" role="status">
            {state.mapLoading ? <LoaderCircle size={14} className="transfer-spinner" /> : <Map size={14} />}
            {state.mapLoading ? '正在检查地图示教…' : hasMap
              ? <>目标地图 <strong title={state.mapSnapshot.map.name}>{state.mapSnapshot.map.name}</strong></>
              : state.mapError || '未加载地图示教，暂不可选择转换矩阵'}
          </p>
          <div className={`new-independent-dialog__file${matrix ? ' is-selected' : ''}`}>
            <ArrowLeftRight size={21} />
            <div><strong title={matrix?.name}>{matrix?.name || '独立模型 → 地图'}</strong>
              <span>4 × 4 转换矩阵 · 平移单位为米</span></div>
            <button type="button" disabled={!hasMap || busy || matrixLoading}
              aria-describedby="new-independent-matrix-note" onClick={() => matrixInputRef.current?.click()}>
              {matrixLoading ? <LoaderCircle size={14} className="transfer-spinner" /> : <FileText size={14} />}
              {matrixLoading ? '读取中…' : matrix ? '更换矩阵' : '加载转换矩阵'}</button>
          </div>
          <input ref={matrixInputRef} type="file" accept=".txt,text/plain" hidden
            aria-label="新增独立示教转换矩阵" disabled={!hasMap || busy || matrixLoading} onChange={chooseMatrix} />
          {matrix && <div className="new-independent-dialog__matrix" aria-label="已加载的转换矩阵">
            <div className="new-independent-dialog__matrix-values">{matrix.values.map((value, index) => (
              <span key={index}>{Number(value.toFixed(6))}</span>
            ))}</div>
            <span><Check size={13} />矩阵已校验</span>
          </div>}
          {matrixError && <p className="new-independent-dialog__error" role="alert">{matrixError}</p>}
          <div className="new-independent-dialog__matrix-note">
            <p id="new-independent-matrix-note">可先创建模型，之后通过“示教转换”加载或修改转换关系。
              {!hasMap && ' 加载矩阵前需先打开地图示教工程。'}</p>
            {(matrix || matrixError) && <button type="button" disabled={busy} onClick={clearMatrix}>移除矩阵</button>}
          </div>
          <div className="new-independent-dialog__options" role="group" aria-label="创建时同步与放置">
            <button type="button" aria-pressed={canLoadRoute ? undefined : syncRoute}
              aria-describedby="new-independent-options-note"
              disabled={(canLoadRoute ? !onLoadRoute : !canSyncRoute) || busy || matrixLoading}
              title={canLoadRoute ? '将路网 JSON 加载到当前地图，也可跳过直接创建独立示教'
                : routeDisabledReason || '创建时将地图路网同步到独立模型坐标系'}
              onClick={() => canLoadRoute ? routeInputRef.current?.click() : toggleCreationOption('syncRoute')}>
              {state.routeLoading ? <LoaderCircle size={15} className="transfer-spinner" /> : <Route size={15} />}
              {canLoadRoute ? '加载路网' : '同步路网'}{syncRoute && <Check size={14} />}
            </button>
            <button type="button" aria-pressed={placeInMap} aria-describedby="new-independent-options-note"
              disabled={!canPlace || busy || matrixLoading}
              title={placementDisabledReason || '创建时按转换矩阵放置模型，并进入地图示教'}
              onClick={() => toggleCreationOption('placeInMap')}>
              <MapPin size={15} />放置进入地图{placeInMap && <Check size={14} />}
            </button>
          </div>
          <p id="new-independent-options-note" className="new-independent-dialog__options-note">
            条件满足后默认自动开启；可手动关闭，下次沿用上次选择。
          </p>
          <input ref={routeInputRef} type="file" accept=".route.json,.json,application/json" hidden
            aria-label="新增独立示教地图路网" disabled={!canLoadRoute || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file && canLoadRoute && !busy) onLoadRoute?.(file);
            }} />
          {state.routeError && <p className="new-independent-dialog__error" role="alert">{state.routeError}</p>}
          {state.routeNotice && <p className="new-independent-dialog__route-status" role="status">{state.routeNotice}</p>}
        </section>
        {state.error && <p className="new-independent-dialog__error" role="alert">{state.error}</p>}
        {busy && <p className="new-independent-dialog__progress" role="status">
          <LoaderCircle size={15} className="transfer-spinner" />{state.routeLoading ? '正在加载地图路网…' : progress?.phase || '正在创建独立示教…'}
        </p>}
      </div>
      <footer>
        <span>{state.sourceMode === 'map' ? '当前地图示教将保留' : '当前独立示教将保存到缓存列表'}</span>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="new-independent-dialog__create" disabled={!canCreate}>
          {busy ? <LoaderCircle size={15} className="transfer-spinner" /> : <Plus size={15} />}创建独立示教
        </button>
      </footer>
    </form>
  </dialog>, document.body);
}
