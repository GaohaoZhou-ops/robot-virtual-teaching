import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, FolderOpen, X } from 'lucide-react';
import './ProjectImportErrorDialog.css';

export default function ProjectImportErrorDialog({ error, onClose, onChooseProject }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);

  return createPortal(
    <dialog ref={dialogRef} className="project-import-error" role="alertdialog"
      aria-labelledby="project-import-error-title" aria-describedby="project-import-error-message"
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header>
        <AlertCircle size={24} />
        <h2 id="project-import-error-title">工程加载失败</h2>
        <button type="button" aria-label="关闭工程加载错误" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="project-import-error__body">
        <p className="project-import-error__source">{error.sourceName || '所选工程'}</p>
        <p id="project-import-error-message">{error.message}</p>
        <p>请检查所选工程后重新加载。</p>
      </div>
      <footer>
        <button type="button" onClick={onClose}>关闭</button>
        <button type="button" onClick={onChooseProject}><FolderOpen size={15} />重新选择工程</button>
      </footer>
    </dialog>, document.body,
  );
}
