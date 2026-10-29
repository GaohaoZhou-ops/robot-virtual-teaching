import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FileText, FolderOpen, Layers2, LoaderCircle, MapPin, Plus, Route, Trash2, X } from 'lucide-react';
import { createId } from '../model/io.js';
import { INDEPENDENT_TEACHING_NAME_MAX_LENGTH, validateIndependentTeachingName } from '../model/independentTeachingName.js';
import { loadIndependentCreationPreferences } from '../model/independentCreationPreferences.js';
import { matchingBatchMatrix, newIndependentBatchRow, readIndependentBatchMatrix } from '../model/independentTeachingBatch.js';
import { TEACHING_WAYPOINT_SOURCE, TEMPORARY_MAP_ROUTE_SOURCE } from '../../teaching/model/teachingNavigation.js';
import './NewIndependentTeachingDialog.css';
import './BatchIndependentTeachingDialog.css';

export default function BatchIndependentTeachingDialog({ state, progress, onCreate, onClose, onLoadRoute }) {
  const dialogRef = useRef(null);
  const filesRef = useRef(null);
  const directoryRef = useRef(null);
  const routeRef = useRef(null);
  const matrixInputRef = useRef(null);
  const matrixRowRef = useRef(null);
  const revisionRef = useRef(0);
  const [models, setModels] = useState([]);
  const [matrices, setMatrices] = useState([]);
  const [rows, setRows] = useState([]);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [defaults] = useState(loadIndependentCreationPreferences);
  const hasMap = Boolean(state.mapSnapshot);
  const hasRoute = Boolean(state.mapSnapshot?.config?.config?.project?.waypoints?.some((point) =>
    point.source !== TEACHING_WAYPOINT_SOURCE && point.source !== TEMPORARY_MAP_ROUTE_SOURCE));
  const busy = state.busy || state.routeLoading || reading;
  const matrixOptions = (matrix) => hasRoute && matrix?.matrix ? { syncRoute: true, placeInMap: true } : {};
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { revisionRef.current += 1; dialog.close(); previous?.focus?.(); };
  }, []);

  const addFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (busy || !files.length) return;
    const revision = ++revisionRef.current;
    setReading(true);
    setFileError('');
    try {
      const incomingModels = files.filter((file) => /\.ply$/i.test(file.name)).map((file) => ({
        id: createId('batch-model'), file, label: file.webkitRelativePath || file.name,
      }));
      const incomingMatrices = [];
      for (const file of files.filter((item) => /\.txt$/i.test(item.name))) {
        const item = { id: createId('batch-matrix'), name: file.name, label: file.webkitRelativePath || file.name };
        try { item.matrix = await readIndependentBatchMatrix(file); }
        catch (error) { item.error = error.message; }
        incomingMatrices.push(item);
      }
      if (revision !== revisionRef.current) return;
      if (!incomingModels.length && !incomingMatrices.length) throw new Error('请选择 PLY 模型和 TXT 转换矩阵');
      const nextMatrices = [...matrices, ...incomingMatrices];
      setModels((current) => [...current, ...incomingModels]);
      setMatrices(nextMatrices);
      setRows((current) => [...current, ...incomingModels.map((model) => newIndependentBatchRow(model.id, model.file.name, defaults))]
        .map((row) => {
          if (row.matrixManual) return row;
          const model = [...models, ...incomingModels].find((item) => item.id === row.modelId);
          // Prefer a same-directory pair before considering globally unique names.
          const directory = model?.label.slice(0, model.label.lastIndexOf('/') + 1);
          const siblings = directory ? nextMatrices.filter((item) => item.label.startsWith(directory)
            && !item.label.slice(directory.length).includes('/')) : [];
          const siblingModels = directory ? [...models, ...incomingModels].filter((item) => item.label.startsWith(directory)
            && !item.label.slice(directory.length).includes('/')) : [];
          const matched = matchingBatchMatrix(model?.file.name, siblings)
            || (siblings.length === 1 && siblingModels.length === 1 ? siblings[0].id : matchingBatchMatrix(model?.file.name, nextMatrices));
          return { ...row, matrixId: matched,
            ...(matched !== row.matrixId ? matrixOptions(nextMatrices.find((item) => item.id === matched)) : {}) };
        }));
    } catch (error) { if (revision === revisionRef.current) setFileError(error.message); }
    finally { if (revision === revisionRef.current) setReading(false); }
  };
  const updateRow = (id, patch) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const chooseRowMatrix = async (event) => {
    const file = event.target.files?.[0];
    const rowId = matrixRowRef.current;
    event.target.value = '';
    matrixRowRef.current = null;
    if (!file || !rowId || busy || !hasMap) return;
    const revision = ++revisionRef.current;
    setReading(true);
    updateRow(rowId, { matrixError: '', matrixManual: true });
    try {
      const matrix = await readIndependentBatchMatrix(file);
      if (revision !== revisionRef.current) return;
      const item = { id: createId('batch-matrix'), name: file.name, label: file.name, matrix };
      setMatrices((current) => [...current, item]);
      updateRow(rowId, { matrixId: item.id, matrixError: '', ...matrixOptions(item) });
    } catch (error) {
      if (revision === revisionRef.current) updateRow(rowId, { matrixError: `${file.name}：${error.message}` });
    } finally {
      if (revision === revisionRef.current) setReading(false);
    }
  };
  const expandMatrices = () => {
    if (models.length !== 1) return;
    setRows((current) => {
      const next = current.map((row) => ({ ...row }));
      for (const matrix of matrices) {
        if (next.some((row) => row.matrixId === matrix.id)) continue;
        let row = next.find((item) => !item.matrixId);
        if (!row) { row = newIndependentBatchRow(models[0].id, models[0].file.name, defaults); next.push(row); }
        row.matrixId = matrix.id;
        row.matrixManual = true;
        Object.assign(row, matrixOptions(matrix));
        if (!row.nameEdited) row.name = `${models[0].file.name.replace(/\.ply$/i, '')} · ${matrix.name.replace(/\.txt$/i, '')}`
          .slice(0, INDEPENDENT_TEACHING_NAME_MAX_LENGTH);
      }
      return next;
    });
  };
  const checkedRows = rows.map((row) => {
    const model = models.find((item) => item.id === row.modelId);
    const matrix = matrices.find((item) => item.id === row.matrixId);
    let error = '';
    try { validateIndependentTeachingName(row.name); } catch (reason) { error = reason.message; }
    if (!error && !model) error = '请选择模型';
    if (!error && row.matrixError) error = row.matrixError;
    if (!error && matrix?.error) error = matrix.error;
    if (!error && row.matrixId && !hasMap) error = '请先加载地图，或移除本组矩阵';
    const canPlace = hasMap && Boolean(matrix?.matrix);
    return { ...row, model, matrix, error, syncRoute: canPlace && hasRoute && row.syncRoute,
      placeInMap: canPlace && row.placeInMap, canPlace };
  });
  const valid = rows.length > 0 && checkedRows.every((row) => !row.error) && !busy && !state.mapLoading;
  const boundCount = checkedRows.filter((row) => row.matrix?.matrix && hasMap).length;

  return createPortal(<dialog ref={dialogRef} className="new-independent-dialog batch-independent-dialog"
    aria-labelledby="batch-independent-title" aria-busy={busy}
    onCancel={(event) => {
      // File inputs also emit a bubbling cancel event when their picker is dismissed.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (!busy) onClose();
    }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid) onCreate(checkedRows.map((row) => ({ file: row.model.file, name: row.name.trim(),
        matrix: row.matrix?.matrix || null, syncRoute: row.syncRoute, placeInMap: row.placeInMap })));
    }}>
      <header className="new-independent-dialog__header">
        <span className="new-independent-dialog__mark"><Layers2 size={24} /></span>
        <div><small>INDEPENDENT TEACHING / BATCH</small><h2 id="batch-independent-title">批量导入独立示教</h2></div>
        <button type="button" className="new-independent-dialog__close" aria-label="关闭批量导入"
          disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="new-independent-dialog__body">
        <div className="batch-independent-target" role="status">
          <span>{state.mapLoading ? '正在读取目标地图…' : hasMap ? `目标地图：${state.mapSnapshot.map.name}`
            : state.mapError || '未加载地图，可先批量创建模型，稍后配置转换关系。'}</span>
          {hasMap && !hasRoute && <button type="button" disabled={busy} onClick={() => routeRef.current?.click()}>加载地图路网</button>}
        </div>
        <div className="batch-independent-tools">
          <button type="button" disabled={busy} onClick={() => filesRef.current?.click()}><Plus size={15} />添加模型和矩阵</button>
          <button type="button" disabled={busy} onClick={() => directoryRef.current?.click()}><FolderOpen size={15} />选择文件夹</button>
          <button type="button" disabled={busy || models.length !== 1 || !matrices.length} onClick={expandMatrices}>按矩阵生成组</button>
          <span>{models.length} 个模型 · {matrices.length} 份矩阵</span>
        </div>
        <input ref={filesRef} type="file" accept=".ply,.txt" multiple hidden aria-label="批量模型和矩阵" disabled={busy} onChange={addFiles} />
        <input ref={directoryRef} type="file" webkitdirectory="" multiple hidden aria-label="批量导入文件夹" disabled={busy} onChange={addFiles} />
        <input ref={matrixInputRef} type="file" accept=".txt,text/plain" hidden aria-label="为当前组选择转换矩阵"
          disabled={busy || !hasMap} onChange={chooseRowMatrix} />
        <input ref={routeRef} type="file" accept=".json" hidden aria-label="批量导入地图路网" disabled={busy}
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onLoadRoute(file); }} />
        <div className="batch-independent-table-wrap">
          <table className="batch-independent-table">
            <thead><tr><th>组</th><th>独立示教名称</th><th>转换矩阵</th><th>创建选项</th><th>操作</th></tr></thead>
            <tbody>{checkedRows.map((row, index) => <tr key={row.id} data-batch-row={index + 1}>
              <td>{String(index + 1).padStart(2, '0')}</td>
              <td><input aria-label={`第 ${index + 1} 组名称`} value={row.name} required
                maxLength={INDEPENDENT_TEACHING_NAME_MAX_LENGTH} disabled={busy} aria-invalid={Boolean(row.error)}
                onChange={(event) => updateRow(row.id, { name: event.target.value, nameEdited: true })} />
                <span className="batch-independent-model" title={row.model?.label}>{row.model?.label}</span>
                {(row.error || row.matrix) && <small className={row.error ? 'is-error' : ''}>{row.error || '矩阵已校验'}</small>}</td>
              <td><button type="button" className="batch-independent-matrix-button" aria-label={`加载第 ${index + 1} 组转换矩阵`}
                disabled={busy || !hasMap} title={hasMap ? '选择本组的 TXT 转换矩阵' : '请先加载地图示教工程'}
                onClick={() => { matrixRowRef.current = row.id; matrixInputRef.current?.click(); }}>
                <FileText size={14} />加载转换矩阵</button>
                {(row.matrix || row.matrixError) && <div className="batch-independent-matrix-file">
                  <span title={row.matrix?.label}>{row.matrix?.label}</span>
                  <button type="button" aria-label={`移除第 ${index + 1} 组矩阵`} disabled={busy}
                    onClick={() => updateRow(row.id, { matrixId: '', matrixManual: true, matrixError: '' })}><X size={12} /></button>
                </div>}</td>
              <td><div className="new-independent-dialog__options batch-independent-options" role="group" aria-label={`第 ${index + 1} 组创建选项`}>
                <button type="button" aria-label={`第 ${index + 1} 组同步路网`} aria-pressed={row.syncRoute}
                  disabled={busy || !row.canPlace || !hasRoute} onClick={() => updateRow(row.id, { syncRoute: !row.syncRoute })}>
                  <Route size={14} />同步路网{row.syncRoute && <Check size={12} />}</button>
                <button type="button" aria-label={`第 ${index + 1} 组放入地图`} aria-pressed={row.placeInMap}
                  disabled={busy || !row.canPlace} onClick={() => updateRow(row.id, { placeInMap: !row.placeInMap })}>
                  <MapPin size={14} />放置进入地图{row.placeInMap && <Check size={12} />}</button>
              </div></td>
              <td><button type="button" aria-label={`复制第 ${index + 1} 组`} disabled={busy}
                onClick={() => setRows((current) => [...current, { ...row, id: createId('batch-row'),
                  matrixId: '', matrixManual: true, matrixError: '', name: `${row.name} 副本`.slice(0, INDEPENDENT_TEACHING_NAME_MAX_LENGTH) }])}><Copy size={14} /></button>
                <button type="button" aria-label={`移除第 ${index + 1} 组`} disabled={busy}
                  onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}><Trash2 size={14} /></button></td>
            </tr>)}</tbody>
          </table>
          {!rows.length && <p className="batch-independent-empty">选择多个 PLY 模型和 TXT 矩阵后，在这里逐组填写名称。</p>}
        </div>
        {matrices.some((item) => item.error) && <p className="new-independent-dialog__error" role="alert">
          无效矩阵：{matrices.filter((item) => item.error).map((item) => `${item.label}：${item.error}`).join('；')}</p>}
        {(fileError || state.error || state.routeError) && <p className="new-independent-dialog__error" role="alert">{fileError || state.error || state.routeError}</p>}
        {state.routeNotice && <p role="status">{state.routeNotice}</p>}
        {busy && <p className="new-independent-dialog__progress" role="status"><LoaderCircle size={15} className="transfer-spinner" />
          {reading ? '正在读取矩阵…' : state.routeLoading ? '正在加载地图路网…' : `${progress?.phase || '正在批量创建…'} ${progress?.detail || ''}`}</p>}
      </div>
      <footer><span>{rows.length} 组 · {boundCount} 组已配矩阵 · {checkedRows.filter((row) => row.placeInMap).length} 组放入地图</span>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="new-independent-dialog__create" disabled={!valid}>批量创建 {rows.length} 组</button>
      </footer>
    </form>
  </dialog>, document.body);
}
