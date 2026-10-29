import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Clock3, LoaderCircle, Plus, ScanLine, X } from 'lucide-react';
import { independentWorkspaceLabel } from "../model/independentTeachingName.js";

const savedTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date) : '保存时间未知';
};

export default function IndependentWorkspaceDialog({ state, disabled = false, onSelect, onCreate, onClose }) {
  const panelRef = useRef(null);
  const firstButtonRef = useRef(null);
  const { entries, busy = false, selectedId, error } = state;
  useEffect(() => {
    const previousFocus = document.activeElement;
    (firstButtonRef.current?.disabled ? panelRef.current : firstButtonRef.current)?.focus();
    return () => { previousFocus?.focus?.(); };
  }, []);
  useEffect(() => {
    if (busy) panelRef.current?.focus();
  }, [busy]);

  return createPortal(
    <div className="project-load-modal is-independent independent-workspace-picker"
      role="dialog" aria-modal="true" aria-labelledby="independent-workspace-picker-title"
      aria-describedby="independent-workspace-picker-description" aria-busy={busy}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!busy) onClose();
        } else if (event.key === 'Tab') {
          const buttons = [...panelRef.current.querySelectorAll('button:not(:disabled)')];
          const first = buttons[0], last = buttons.at(-1);
          if (!first) {
            event.preventDefault();
          } else if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) {
            event.preventDefault(); first.focus();
          }
        }
      }}>
      <section className="project-load-dialog" ref={panelRef} tabIndex={-1}>
        <header className="project-load-dialog__header">
          <span className="project-load-dialog__mark"><ScanLine size={22} /></span>
          <div>
            <small>INDEPENDENT TEACHING</small>
            <h2 id="independent-workspace-picker-title">选择独立示教</h2>
            <p id="independent-workspace-picker-description">{onCreate
              ? '选择已有工程，或新增独立示教；地图中已完成的示教结果会继续保留。'
              : '选择要进入的工程，地图中已完成的示教结果会继续保留。'}</p>
          </div>
          <span className="project-load-dialog__mode">{entries.length} 份工程</span>
          <button type="button" aria-label="关闭独立示教选择" disabled={busy} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="project-load-dialog__body">
          {error && <p className="independent-workspace-picker__error" role="alert">{error}</p>}
          <div className="project-load-history independent-workspace-picker__list">
            <ul>
              {entries.map((entry, index) => {
                const id = entry.historyId || 'current';
                const label = independentWorkspaceLabel(entry);
                return <li key={id} data-workspace-kind={entry.current ? 'current' : 'history'}
                  data-map-id={entry.mapId} data-history-id={entry.historyId || undefined}>
                  <ScanLine size={18} />
                  <div>
                    <strong title={label}>{label}</strong>
                    <span>模型：{entry.mapName}</span>
                    <span><b>{entry.current ? '上次使用' : '已缓存'}</b> · {entry.activeTaskName || '暂无示教任务'}</span>
                    <span>{entry.taskCount} 个任务 · {entry.parkingPointCount} 个停车点 · {entry.teachingPoseCount} 组姿态</span>
                    <span className="independent-workspace-picker__time"><Clock3 size={10} /> {savedTime(entry.savedAt)}</span>
                  </div>
                  <button type="button" ref={index === 0 ? firstButtonRef : undefined}
                    disabled={busy || disabled} aria-label={`进入独立示教 ${label}`}
                    onClick={() => onSelect(entry)}>
                    {busy && selectedId === id
                      ? <><LoaderCircle size={14} className="transfer-spinner" />正在切换</>
                      : <>进入示教 <ArrowRight size={14} /></>}
                  </button>
                </li>;
              })}
            </ul>
          </div>
        </div>
        <footer className="project-load-dialog__footer">
          {onCreate && <button type="button" className="independent-workspace-picker__create"
            disabled={busy || disabled} onClick={onCreate}>
            <Plus size={14} />新增独立示教
          </button>}
          <span>切换前自动保存工作现场</span>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
