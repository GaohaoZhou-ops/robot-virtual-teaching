import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Download, FileJson, FolderArchive, LoaderCircle, X } from 'lucide-react';
import './IndependentTeachingExportDialog.css';

export default function IndependentTeachingExportDialog({ state, onMapExport, onJsonExport, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  const keyDown = (event) => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const buttons = [...dialogRef.current.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  return createPortal(<dialog ref={dialogRef} className="independent-export-dialog"
    aria-labelledby="independent-export-title" aria-describedby="independent-export-description" aria-busy={state.busy}
    onCancel={(event) => { event.preventDefault(); if (!state.busy) onClose(); }}
    onKeyDown={keyDown} onKeyUp={(event) => event.stopPropagation()}>
    <header><Download size={22} /><h2 id="independent-export-title">导出示教数据</h2>
      <button type="button" aria-label="关闭独立示教导出" disabled={state.busy} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="independent-export-dialog__body">
      <p id="independent-export-description">当前独立示教已绑定地图示教并启用路网同步，请选择导出格式。</p>
      <p className="independent-export-dialog__map">绑定地图 <strong>{state.mapConfig.config.project.map?.fileName || '未命名地图'}</strong></p>
      <div className="independent-export-dialog__options">
        <button type="button" className="independent-export-dialog__option is-map" disabled={state.busy}
          aria-label="地图示教任务 ZIP" onClick={onMapExport}>
          <span className="independent-export-dialog__icon"><FolderArchive size={23} /><ArrowUpRight size={16} /></span>
          <strong>地图示教任务 ZIP</strong>
          <span>将当前任务转换到地图坐标，携带对应路网，供机器人导入。</span>
        </button>
        <button type="button" className="independent-export-dialog__option" disabled={state.busy}
          aria-label="独立示教任务 JSON" onClick={onJsonExport}>
          <span className="independent-export-dialog__icon"><FileJson size={23} /><ArrowUpRight size={16} /></span>
          <strong>独立示教任务 JSON</strong>
          <span>保留独立模型坐标，导出当前任务、停车点与姿态数据。</span>
        </button>
      </div>
      {state.busy && <p className="independent-export-dialog__status" role="status"><LoaderCircle size={15} className="is-spinning" />正在准备地图示教任务…</p>}
      {state.error && <p className="independent-export-dialog__error" role="alert">{state.error}</p>}
    </div>
    <footer><button type="button" disabled={state.busy} onClick={onClose}>取消</button></footer>
  </dialog>, document.body);
}
