import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, X } from 'lucide-react';

// Compatibility path when the browser cannot open a native save picker.
export default function ModelExportDialog({ filename, onSave, onClose }) {
  const dialogRef = useRef(null), inputRef = useRef(null);
  const [name, setName] = useState(() => filename.replace(/\.ply$/i, ''));
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement, dialog = dialogRef.current;
    dialog.showModal(); inputRef.current?.select();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const save = (event) => {
    event.preventDefault();
    const basename = name.trim().replace(/\.ply$/i, '').trim();
    if (!basename || /^\.+$/.test(basename)) { setError('请输入文件名'); return; }
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(basename) || basename.endsWith('.')) {
      setError('文件名不能包含路径或特殊字符，也不能以句点结尾'); return;
    }
    onSave(`${basename}.ply`);
  };
  return <dialog ref={dialogRef} className="model-editor__export-dialog" aria-labelledby="model-export-title" aria-describedby="model-export-location"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <form onSubmit={save}>
      <header><ArrowDownToLine size={20} /><h2 id="model-export-title">保存模型副本</h2><button type="button" aria-label="关闭模型导出窗口" onClick={onClose}><X size={18} /></button></header>
      <label htmlFor="model-export-name">文件名</label>
      <div className="model-editor__export-name"><input ref={inputRef} id="model-export-name" value={name} autoComplete="off" maxLength={180}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'model-export-error' : undefined}
        onChange={(event) => { setName(event.target.value); setError(''); }} />{!/\.ply$/i.test(name.trim()) && <span>.ply</span>}</div>
      {error && <p id="model-export-error" className="model-editor__export-error" role="alert">{error}</p>}
      <p id="model-export-location">当前浏览器无法打开系统保存对话框，文件将按浏览器的下载设置保存。可在浏览器设置中开启“下载前询问保存位置”。</p>
      <footer><button type="button" onClick={onClose}>取消</button><button type="submit" className="model-editor__primary" disabled={!name.trim()}><ArrowDownToLine size={15} />下载 PLY</button></footer>
    </form>
  </dialog>;
}
