import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, LoaderCircle, Trash2, X } from 'lucide-react';
import { independentWorkspaceLabel } from '../lib/independentTeachingName.js';
import ProjectExportButton from './ProjectExportButton.jsx';
import './WorkspaceCacheDialog.css';

export default function WorkspaceCacheDialog({ state, onConfirm, onClose,
  mapData, exportState, exportDisabled = false, exportDialogOpen = false, exportNotice, onExport }) {
  const dialogRef = useRef(null), cancelRef = useRef(null), saveAsRef = useRef(null);
  const exportingRef = useRef(false);
  const [exportRequested, setExportRequested] = useState(false);
  const reset = state.kind === 'reset';
  const exporting = reset && (exportDialogOpen || ['selecting', 'packing'].includes(exportState?.status));
  const busy = state.busy || exporting;
  useEffect(() => {
    const previous = document.activeElement, dialog = dialogRef.current;
    dialog.showModal(); cancelRef.current?.focus();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  useEffect(() => {
    // The nested save dialog closes before these controls are re-enabled.
    // Restore focus after the commit, rather than to a still-disabled button.
    if (exportingRef.current && !exporting) saveAsRef.current?.querySelector('button')?.focus();
    exportingRef.current = exporting;
  }, [exporting]);
  return createPortal(<dialog ref={dialogRef} className="workspace-cache-dialog" role="alertdialog" data-kind={state.kind}
    aria-labelledby="workspace-cache-title" aria-describedby="workspace-cache-description" aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <header><AlertTriangle size={22} /><h2 id="workspace-cache-title">{reset ? '确认全局重置？' : '删除独立示教缓存？'}</h2>
      <button type="button" className="workspace-cache-dialog__close" disabled={busy}
        aria-label={reset ? '关闭全局重置确认' : '关闭删除缓存确认'} onClick={onClose}><X size={18} /></button>
    </header>
    <div id="workspace-cache-description" className="workspace-cache-dialog__body">
      {reset ? <><p>将清空当前设备的全部地图示教、独立示教（包括历史缓存）和模型编辑缓存，以及工程恢复副本与记住的保存位置。</p>
        <p>同步连接会断开。已导出的工程文件和其他设备的数据保留。</p></>
        : <><p>将删除独立示教缓存 <strong>“{independentWorkspaceLabel(state.entry)}”</strong> 及其模型和示教数据。</p>
          {state.entry.current && <p>这是当前工作区缓存；如果正在使用它，删除后将返回欢迎页。</p>}
          <p>其他缓存、地图中已转换的示教结果和已导出的工程文件保留。</p></>}
      <p className="workspace-cache-dialog__warning">此操作无法撤销，请确认需要的数据已另行保存。</p>
      {reset && exportRequested && exportNotice && <p className="workspace-cache-dialog__export-notice"
        data-kind={exportNotice.kind} role={exportNotice.kind === 'error' ? 'alert' : 'status'}>{exportNotice.message}</p>}
      {state.error && <p className="workspace-cache-dialog__error" role="alert">{state.error}</p>}
    </div>
    <footer>{reset && <div ref={saveAsRef} className="workspace-cache-dialog__save-as"><ProjectExportButton
      label="另存为工程" mapData={mapData} exportState={exportState} disabled={busy || exportDisabled}
      onExport={() => { setExportRequested(true); onExport(); }} /></div>}
      <button ref={cancelRef} type="button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="is-danger" disabled={busy} onClick={onConfirm}>
        {state.busy ? <LoaderCircle size={14} className="transfer-spinner" /> : <Trash2 size={14} />}
        {state.busy ? '正在清理…' : reset ? '确认全局重置' : '确认删除'}</button></footer>
  </dialog>, document.body);
}
