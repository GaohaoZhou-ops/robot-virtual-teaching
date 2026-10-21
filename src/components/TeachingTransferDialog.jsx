import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, ArrowRight, Check, Crosshair, FolderOpen, LoaderCircle, RotateCcw, Scissors, TriangleAlert, X } from 'lucide-react';
import { normalizeProject } from '../lib/io.js';
import { boundTeachingRelation, hasLoadedTransferMatrix, identityTransferPose, insideTransferBounds, normalizeTransferMatrixImports, parseTransferMatrixFile, placementTransform, transferMatrix, transformTeachingPose } from '../lib/teachingTransfer.js';
import TeachingTransferPreview from './TeachingTransferPreview.jsx';
import './TeachingTransferDialog.css';

const number = (value) => value === '' ? NaN : Number(value);
const display = (value) => Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : '';
const projectOf = (snapshot) => snapshot?.config?.config?.project ? normalizeProject(snapshot.config.config.project) : null;

export default function TeachingTransferDialog({ state, onClose, onApply, onLoadMap }) {
  const panelRef = useRef(null);
  const [settingsVisible, setSettingsVisible] = useState(true);
  const [pendingMatrix, setPendingMatrix] = useState(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    panelRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, []);
  const ready = !state.loading && state.source;
  return createPortal(<div className="teaching-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title"
    inert={pendingMatrix ? '' : undefined} aria-hidden={pendingMatrix ? true : undefined}>
    <section className="teaching-transfer-dialog" ref={panelRef} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !state.busy) {
          event.preventDefault(); event.stopPropagation();
          if (!settingsVisible) setSettingsVisible(true);
          else onClose();
        }
        if (event.key === 'Tab') {
          const items = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
            .filter((item) => item.getClientRects().length > 0);
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="transfer-header">
        <span className="transfer-header__icon"><ArrowLeftRight size={23} /></span>
        <div><small>LOCAL ↔ MAP</small><h2 id="transfer-title">示教转换</h2></div>
        <span className="transfer-header__hint">两种坐标 · 同一份示教</span>
        <button type="button" aria-label="关闭示教转换" onClick={onClose} disabled={state.busy}><X size={19} /></button>
      </header>
      {ready ? <TransferForm source={state.source} target={state.target} initialOperation={state.operation}
        settingsVisible={settingsVisible} setSettingsVisible={setSettingsVisible}
        pendingMatrix={pendingMatrix} setPendingMatrix={setPendingMatrix}
        busy={state.busy} error={state.error} onApply={onApply} onClose={onClose} onLoadMap={onLoadMap} />
        : <div className="transfer-loading" role="status">
          {state.loading && <LoaderCircle className="transfer-spinner" size={25} />}
          <span>{state.error || '正在保存当前工程并读取目标工作区…'}</span>
        </div>}
    </section>
  </div>, document.body);
}

function TransferForm({ source, target, initialOperation, settingsVisible, setSettingsVisible, pendingMatrix, setPendingMatrix, busy, error, onApply, onClose, onLoadMap }) {
  const matrixInputRef = useRef(null);
  const matrixButtonRef = useRef(null);
  const matrixLoadingRef = useRef(false);
  const mountedRef = useRef(false);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState('');
  const [matrixFileName, setMatrixFileName] = useState('');
  const [fitRequest, setFitRequest] = useState(0);
  const sourceProject = useMemo(() => projectOf(source), [source]);
  const targetProject = useMemo(() => projectOf(target), [target]);
  const link = sourceProject.workspace.transfer;
  const boundRelation = useMemo(() => initialOperation === 'extract' ? null
    : boundTeachingRelation(source.map, link, target?.map, targetProject?.workspace.transfer),
  [initialOperation, source, link, target, targetProject]);
  const boundTransform = boundRelation?.localToMap;
  const initialRelation = initialOperation === 'writeback' ? link : boundRelation;
  const [matrixImports, setMatrixImports] = useState(() => normalizeTransferMatrixImports(initialRelation?.matrixImports));
  const legacyBoundPose = initialRelation && !Array.isArray(initialRelation.matrixImports) ? initialRelation.localToMap : null;
  const [operation, setOperation] = useState(initialOperation);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { setMatrixError(''); setMatrixFileName(''); }, [operation]);
  const [previewDisplay, setPreviewDisplay] = useState({ colorMode: 'layer', meshQuality: 'performance' });
  const extraction = operation === 'extract';
  const writeback = operation === 'writeback';
  const map = extraction ? source.map : target?.map;
  const hasMap = map?.positionBuffer instanceof ArrayBuffer;
  const hasRobot = Boolean(sourceProject.robot);
  const [anchor, setAnchor] = useState(boundTransform ? 'origin' : 'center');
  const anchorPose = (value) => value === 'robot' && hasRobot ? sourceProject.robot.origin
    : value === 'center' ? { ...identityTransferPose(), position: {
      x: (source.map.bounds.min.x + source.map.bounds.max.x) / 2,
      y: (source.map.bounds.min.y + source.map.bounds.max.y) / 2,
      z: (source.map.bounds.min.z + source.map.bounds.max.z) / 2,
    } } : identityTransferPose();
  const [pose, setPose] = useState(() => {
    if (initialOperation === 'writeback') return structuredClone(link.localToMap);
    if (boundTransform) return structuredClone(boundTransform);
    const reference = initialOperation === 'extract' ? sourceProject.robot?.origin : targetProject?.robot?.origin;
    if (reference) return structuredClone(reference);
    const bounds = map?.bounds;
    return { ...identityTransferPose(), position: bounds ? {
      x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: bounds.min.z,
    } : { x: 0, y: 0, z: 0 } };
  });
  const [bounds, setBounds] = useState(() => structuredClone(source.map.bounds));
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const [name, setName] = useState(`${source.map.name.replace(/\.ply$/i, '')}-local.ply`);
  const validPose = ['x', 'y', 'z'].every((axis) => Number.isFinite(pose.position[axis]))
    && ['roll', 'pitch', 'yaw'].every((axis) => Number.isFinite(pose.rpy[axis]));
  const validBounds = ['x', 'y', 'z'].every((axis) => Number.isFinite(bounds.min[axis]) && Number.isFinite(bounds.max[axis]) && bounds.min[axis] <= bounds.max[axis])
    && bounds.min.x < bounds.max.x && bounds.min.y < bounds.max.y;
  const localToMap = useMemo(() => writeback ? link.localToMap : !validPose ? identityTransferPose()
    : extraction || anchor === 'origin' ? pose : placementTransform(pose, anchorPose(anchor)),
  [writeback, link, validPose, extraction, pose, anchor, hasRobot, sourceProject]);
  const usingBoundTransform = useMemo(() => {
    if (!boundTransform || !validPose) return false;
    const saved = transferMatrix(boundTransform).elements;
    return transferMatrix(localToMap).elements.every((value, index) => Math.abs(value - saved[index]) < 1e-10);
  }, [boundTransform, validPose, localToMap]);
  const stops = sourceProject.teachingTasks.flatMap((task) => task.parkingPoints);
  const selectedStops = extraction && validBounds ? stops.filter((point) => insideTransferBounds(point.mapPose.position, bounds)) : stops;
  const selectedPoseCount = selectedStops.reduce((count, point) => count + point.poses.length, 0);
  const needsReplace = extraction && Boolean(target?.map || targetProject);
  const title = extraction ? '提取局部，进入独立示教' : writeback ? '将精调结果回写原地图' : '将独立组件对齐到地图';
  const presets = (extraction ? sourceProject : targetProject)?.teachingTasks.flatMap((task) => task.parkingPoints.map((point) => ({ ...point, taskName: task.name }))) || [];
  const updatePose = (group, axis, value) => setPose((current) => ({ ...current, [group]: { ...current[group], [axis]: number(value) } }));
  const loading = busy || matrixLoading;
  const canApply = !loading && !pendingMatrix && hasMap && validPose
    && (!extraction || (validBounds && name.trim() && (!needsReplace || replaceAccepted)));
  const resetToIdentity = () => {
    if (loading || matrixLoadingRef.current || writeback) return;
    setAnchor('origin');
    setPose(identityTransferPose());
    setMatrixError('');
    setMatrixFileName('');
    setFitRequest((current) => current + 1);
  };
  const applyMatrixFile = (file, basePose = identityTransferPose()) => {
    // Left multiplication applies the file after the current local-to-map relation.
    const nextPose = transformTeachingPose(basePose, file.matrix);
    transferMatrix(nextPose);
    setAnchor('origin');
    setPose(nextPose);
    setMatrixFileName(file.name);
    setMatrixImports((current) => normalizeTransferMatrixImports([...current, { name: file.name, values: file.values }]));
    setFitRequest((current) => current + 1);
  };
  const importMatrix = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || matrixLoadingRef.current || writeback || pendingMatrix) return;
    matrixLoadingRef.current = true;
    setMatrixLoading(true);
    setMatrixError('');
    try {
      if (!file.name.toLowerCase().endsWith('.txt')) throw new Error('请选择 .txt 转换矩阵文件');
      if (file.size > 1024 * 1024) throw new Error('转换矩阵文件不能超过 1 MB');
      const imported = { ...parseTransferMatrixFile(await file.text()), name: file.name };
      if (!mountedRef.current) return;
      if (hasLoadedTransferMatrix(imported, matrixImports, legacyBoundPose)) {
        setPendingMatrix({ ...imported, basePose: validPose ? structuredClone(localToMap) : null });
        return;
      }
      // The file transforms the entire local coordinate system, not its center or robot base.
      applyMatrixFile(imported);
    } catch (reason) {
      if (mountedRef.current) setMatrixError(`${reason.message || '转换矩阵读取失败'}；原转换参数已保留`);
    } finally {
      matrixLoadingRef.current = false;
      if (mountedRef.current) setMatrixLoading(false);
    }
  };
  const visibleError = matrixError || error;

  return <form className={`transfer-form${settingsVisible ? '' : ' is-preview-expanded'}`}
    aria-busy={loading}
    onSubmit={(event) => {
      event.preventDefault();
      if (canApply && !matrixLoadingRef.current) onApply({ operation, localToMap, bounds, name, matrixImports });
    }}>
    <fieldset disabled={loading} className="transfer-fieldset">
      <div className="transfer-route">
        <div><small>{extraction ? '地图示教 / 来源' : '独立示教 / 来源'}</small><strong title={source.map.name}>{(!extraction && sourceProject.workspace.independentTeachingName) || source.map.name}</strong></div>
        <ArrowRight size={20} />
        <div><small>{extraction ? '独立示教 / 局部工程' : '地图示教 / 目标'}</small><strong>{extraction ? name || '局部工程' : map?.name || '尚未打开地图工程'}</strong></div>
      </div>
      {!hasMap ? <div className="transfer-empty"><FolderOpen size={32} /><h3>先打开目标地图工程</h3>
        <p>当前独立工程已保存。打开地图后，切换回独立示教即可整体放置。</p>
        <button type="button" onClick={onLoadMap}>前往主页面加载地图 <ArrowRight size={16} /></button></div>
        : <div className="transfer-body">
          <div className="transfer-visual">
            <TeachingTransferPreview key={operation} map={map} overlay={!extraction ? source.map : null}
              transform={localToMap} crop={extraction && validBounds ? bounds : null}
              fitRequest={fitRequest}
              display={previewDisplay} onDisplayChange={setPreviewDisplay}
              pose={validPose ? writeback ? link.localToMap : pose : null}
              settingsVisible={settingsVisible} onToggleSettings={() => setSettingsVisible((visible) => !visible)}
              onPoseChange={!writeback ? setPose : undefined} disabled={loading}
              onPick={!extraction && !writeback ? (point) => setPose((current) => ({ ...current, position: { ...current.position, ...point } })) : undefined}
              onCrop={extraction ? setBounds : undefined} />
          </div>
          <aside className="transfer-settings" id="transfer-settings" hidden={!settingsVisible} aria-label="转换参数">
            <div className="transfer-heading"><div><h3>{title}</h3><p>{extraction
              ? '调整裁剪盒和局部原点；范围内的停车点及其全部姿态会一起复制。'
              : writeback ? '按保存的转换关系回到原位置，更新关联内容。'
                : '点选地图位置，再拖动坐标轴或旋转环对齐组件。'}</p></div>
              {link?.kind === 'extraction' && !extraction && <div className="transfer-operation" role="group" aria-label="转换方式">
                <button type="button" className={writeback ? 'is-selected' : ''} onClick={() => { setOperation('writeback'); setPose(link.localToMap); }}>回写原地图</button>
                <button type="button" className={!writeback ? 'is-selected' : ''} onClick={() => { setOperation('place'); setPose(transformTeachingPose(anchorPose(anchor), transferMatrix(localToMap))); }}>作为新工位放置</button>
              </div>}
            </div>
            {extraction && <section><h4><Scissors size={14} /> 裁剪范围 <small>地图坐标 / m</small></h4>
              <div className="transfer-range-grid"><span>轴</span><span>最小值</span><span>最大值</span>
                {['x', 'y', 'z'].map((axis) => <div className="transfer-range-row" key={axis}><b>{axis.toUpperCase()}</b>
                  {['min', 'max'].map((side) => <input key={side} type="number" step="any" required aria-label={`裁剪 ${axis.toUpperCase()} ${side === 'min' ? '最小值' : '最大值'}`}
                    value={display(bounds[side][axis])} onChange={(event) => setBounds((current) => ({ ...current, [side]: { ...current[side], [axis]: number(event.target.value) } }))} />)}</div>)}
              </div>
              <button className="transfer-text-button" type="button" onClick={() => setBounds(structuredClone(source.map.bounds))}>恢复完整范围</button>
            </section>}
            <section><h4><Crosshair size={14} /> {extraction ? '局部原点在地图中的姿态' : writeback ? '保存的局部坐标关系' : '放置位置与朝向'}</h4>
              {!writeback && <div className="transfer-matrix-import">
                <input ref={matrixInputRef} type="file" hidden tabIndex={-1} accept=".txt,text/plain"
                  aria-label="转换矩阵文件" onChange={importMatrix} />
                <button ref={matrixButtonRef} type="button" aria-describedby="transfer-matrix-format" onClick={() => matrixInputRef.current?.click()}>
                  {matrixLoading ? <LoaderCircle className="transfer-spinner" size={15} /> : <FolderOpen size={15} />}
                  {matrixLoading ? '正在读取矩阵…' : '加载转换矩阵'}
                </button>
                <p id="transfer-matrix-format">4 × 4 TXT · 独立空间 → 地图 · 平移单位 m</p>
                {matrixFileName && <p className="transfer-matrix-file" role="status">已加载 {matrixFileName}，可继续手动调整。</p>}
                {usingBoundTransform && <p className="transfer-matrix-file" role="status">已沿用绑定关系，可直接放置。</p>}
              </div>}
              {!extraction && !writeback && <label className="transfer-select">定位基准<select aria-label="放置定位基准" value={anchor} onChange={(event) => {
                const value = event.target.value;
                setPose(transformTeachingPose(anchorPose(value), transferMatrix(localToMap)));
                setAnchor(value);
              }}>
                <option value="center">组件中心</option>
                {hasRobot && <option value="robot">机器人基座</option>}<option value="origin">独立空间原点</option></select></label>}
              {!writeback && <label className="transfer-select">快速对齐<select aria-label="对齐到已有位置" value="" onChange={(event) => {
                const value = event.target.value;
                if (value === 'robot') setPose(structuredClone((extraction ? sourceProject : targetProject).robot.origin));
                else if (value === 'center') setPose({ ...identityTransferPose(), position: { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: bounds.min.z } });
                else { const selected = presets.find((point) => point.id === value); if (selected) setPose(structuredClone(selected.mapPose)); }
              }}><option value="">选择参考位置…</option>{(extraction ? sourceProject : targetProject)?.robot && <option value="robot">当前机器人位置</option>}
                {extraction && <option value="center">裁剪区域中心</option>}{presets.map((point) => <option key={point.id} value={point.id}>{point.taskName} / {point.name}</option>)}</select></label>}
              <div className="transfer-pose-grid">{[['position', 'x', 'X', 'm'], ['position', 'y', 'Y', 'm'], ['position', 'z', 'Z', 'm'],
                ['rpy', 'roll', 'Roll', '°'], ['rpy', 'pitch', 'Pitch', '°'], ['rpy', 'yaw', 'Yaw', '°']].map(([group, axis, label, unit]) => <label key={axis}>
                  <span>{label} <small>{unit}</small></span><input type="number" step="any" required readOnly={writeback}
                    aria-label={`${extraction ? '局部原点' : '放置'} ${label}`} value={display((writeback ? link.localToMap : pose)[group][axis])}
                    onChange={(event) => updatePose(group, axis, event.target.value)} /></label>)}</div>
              {!writeback && <button type="button" className="transfer-identity"
                title="使用单位阵：以独立空间原点为基准，将 XYZ 和 Roll / Pitch / Yaw 全部归零"
                onClick={resetToIdentity}><RotateCcw size={14} /> 单位阵</button>}
              {extraction && <label className="transfer-name">局部工程名称<input value={name} required aria-label="局部工程名称" onChange={(event) => setName(event.target.value)} /></label>}
            </section>
            <div className="transfer-note"><Check size={15} /><p>{extraction ? '原地图保留。局部工程会记住来源，完成精调后可回写。'
              : writeback ? '仅更新关联的局部内容。原地图若有冲突修改，会保留现场并提示处理。'
                : '独立工程保留。地图中加入一份新的工位副本，已有示教任务继续保留。'}</p></div>
            {needsReplace && <label className="transfer-replace"><input type="checkbox" checked={replaceAccepted} onChange={(event) => setReplaceAccepted(event.target.checked)} />
              用本次提取结果替换已打开的独立工程“{target.map?.name || '未命名工程'}”</label>}
          </aside>
        </div>}
    </fieldset>
    <footer className="transfer-footer">
      <div role={visibleError ? 'alert' : 'status'} className={visibleError ? 'is-error' : ''}>{visibleError || (matrixLoading ? '正在读取转换矩阵…' : busy ? '正在转换并保存，请稍候…'
        : extraction && !validBounds ? '请设置有效裁剪范围'
          : !settingsVisible && needsReplace && !replaceAccepted ? '点击“显示参数”确认替换已打开的独立工程'
            : `${selectedStops.length} 停车点 · ${selectedPoseCount} 示教姿态 · 米 / 度`)}</div>
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      <button className="transfer-submit" type="submit" disabled={!canApply}>
        {busy ? <LoaderCircle className="transfer-spinner" size={16} /> : <ArrowRight size={16} />}
        {extraction ? '提取并进入独立示教' : writeback ? '回写并进入地图' : '放置并进入地图'}
      </button>
    </footer>
    {pendingMatrix && <RepeatedMatrixDialog fileName={pendingMatrix.name} returnFocusRef={matrixButtonRef}
      canStack={Boolean(pendingMatrix.basePose)}
      onCancel={() => setPendingMatrix(null)}
      onResolve={(action) => {
        if (action === 'stack' && !pendingMatrix.basePose) return;
        try {
          applyMatrixFile(pendingMatrix, action === 'reload' ? identityTransferPose() : pendingMatrix.basePose);
        } catch (reason) {
          setMatrixError(`${reason.message || '转换矩阵加载失败'}；原转换参数已保留`);
        }
        setPendingMatrix(null);
      }} />}
  </form>;
}

function RepeatedMatrixDialog({ fileName, returnFocusRef, canStack, onCancel, onResolve }) {
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      });
    };
  }, [returnFocusRef]);
  return createPortal(<div className="transfer-matrix-confirm-backdrop"
    onKeyUp={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = [...panelRef.current.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    <section ref={panelRef} className="transfer-matrix-confirm" role="alertdialog" aria-modal="true"
      aria-labelledby="transfer-matrix-confirm-title" aria-describedby="transfer-matrix-confirm-description">
      <TriangleAlert size={25} aria-hidden="true" />
      <h3 id="transfer-matrix-confirm-title">转换矩阵已加载过</h3>
      <p id="transfer-matrix-confirm-description">该文件的矩阵数据与之前加载的一致。可重载转换关系，或在当前关系上叠加转换。</p>
      <p className="transfer-matrix-confirm__file">{fileName}</p>
      <p className="transfer-matrix-confirm__hint">重载将用文件矩阵完整替换当前关系。取消保留当前参数；确认转换后才保存到工程。</p>
      {!canStack && <p className="transfer-matrix-confirm__hint">当前参数不完整，可重载文件恢复有效关系。</p>}
      <footer>
        <button ref={cancelRef} type="button" onClick={onCancel}>取消</button>
        <button type="button" className="transfer-matrix-confirm__reload" onClick={() => onResolve('reload')}>重载转换关系</button>
        <button type="button" className="transfer-matrix-confirm__apply" disabled={!canStack}
          onClick={() => onResolve('stack')}>叠加转换</button>
      </footer>
    </section>
  </div>, document.body);
}
