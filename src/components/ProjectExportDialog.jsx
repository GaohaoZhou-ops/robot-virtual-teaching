import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileArchive, X } from 'lucide-react';
import './ProjectExportDialog.css';

// Used when the browser cannot offer a native Save As dialog.
export default function ProjectExportDialog({ filename, onSave, onClose }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const [name, setName] = useState(() => filename.replace(/\.zip$/i, ''));
  const [error, setError] = useState('');

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    inputRef.current?.select();
    return () => {
      dialog.close();
      previous?.focus?.();
    };
  }, []);

  const save = (event) => {
    event.preventDefault();
    const basename = name.trim().replace(/\.zip$/i, '').trim();
    if (!basename || /^\.+$/.test(basename)) {
      setError('请输入工程名称');
      return;
    }
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(basename) || basename.endsWith('.')) {
      setError('名称不能包含路径或特殊字符，也不能以句点结尾');
      return;
    }
    onSave(`${basename}.zip`);
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="project-export-dialog"
      aria-labelledby="project-export-title"
      aria-describedby="project-export-location-note"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <form onSubmit={save}>
        <header>
          <FileArchive size={24} />
          <div><small>PORTABLE PROJECT / ZIP</small><h2 id="project-export-title">保存工程副本</h2></div>
          <button type="button" aria-label="关闭工程导出窗口" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="project-export-dialog__body">
          <label htmlFor="project-export-name">工程名称</label>
          <div className="project-export-dialog__filename">
            <input
              ref={inputRef}
              id="project-export-name"
              value={name}
              autoComplete="off"
              maxLength={180}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'project-export-name-error' : undefined}
              onChange={(event) => { setName(event.target.value); setError(''); }}
            />
            {!/\.zip$/i.test(name.trim()) && <span>.zip</span>}
          </div>
          {error && <p id="project-export-name-error" className="project-export-dialog__error" role="alert">{error}</p>}
          <p id="project-export-location-note">当前浏览器不支持直接选择保存位置。文件将按浏览器的下载设置保存；如需选择文件夹，请开启“下载前询问保存位置”。</p>
        </div>
        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="project-export-dialog__save" disabled={!name.trim()}><Download size={15} />保存工程 ZIP</button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
