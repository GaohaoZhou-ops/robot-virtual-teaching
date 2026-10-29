import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, Pencil, X } from 'lucide-react';
import { independentWorkspaceLabel, INDEPENDENT_TEACHING_NAME_MAX_LENGTH, validateIndependentTeachingName } from "../model/independentTeachingName.js";
import "./IndependentTeachingNameDialog.css";

export default function IndependentTeachingNameDialog({ state, onSave, onClose }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const [name, setName] = useState(independentWorkspaceLabel(state.entry));
  let validationError = '';
  try { validateIndependentTeachingName(name); } catch (error) { validationError = error.message; }
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    inputRef.current?.select();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  return createPortal(<dialog ref={dialogRef} className="independent-name-dialog"
    aria-labelledby="independent-name-title" aria-busy={state.busy}
    onCancel={(event) => { event.preventDefault(); if (!state.busy) onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => { event.preventDefault(); if (!validationError && !state.busy) onSave(name.trim()); }}>
      <header><Pencil size={20} /><h2 id="independent-name-title">重命名独立示教</h2>
        <button type="button" aria-label="关闭重命名窗口" disabled={state.busy} onClick={onClose}><X size={17} /></button></header>
      <div className="independent-name-dialog__body">
        <p>模型文件：<span>{state.entry.mapName}</span></p>
        <label>独立示教名称<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)}
          maxLength={INDEPENDENT_TEACHING_NAME_MAX_LENGTH} required disabled={state.busy} autoComplete="off"
          placeholder="例如：1 号工位 · 左侧阀门" aria-describedby="independent-name-hint" /></label>
        <small id="independent-name-hint">名称用于缓存列表、工作台和工程保存，最多 80 个字符。</small>
        {(validationError || state.error) && <p className="independent-name-dialog__error" role="alert">{validationError || state.error}</p>}
      </div>
      <footer><button type="button" disabled={state.busy} onClick={onClose}>取消</button>
        <button type="submit" disabled={state.busy || Boolean(validationError)}>
          {state.busy ? <LoaderCircle size={14} className="transfer-spinner" /> : <Check size={14} />}保存名称</button></footer>
    </form>
  </dialog>, document.body);
}
