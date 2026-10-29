import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ListPlus, X } from 'lucide-react';
import "./TeachingInsertActionDialog.css";

export default function TeachingInsertActionDialog({ task, parkingPoint, pose, presets, onConfirm, onClose }) {
  const panelRef = useRef(null);
  const selectRef = useRef(null);
  const submittingRef = useRef(false);
  const [presetId, setPresetId] = useState(presets[0]?.id || '');
  const [position, setPosition] = useState('after');
  const [error, setError] = useState('');
  const preset = presets.find((item) => item.id === presetId);

  useEffect(() => {
    const previous = document.activeElement;
    (selectRef.current?.disabled ? panelRef.current : selectRef.current)?.focus();
    return () => previous?.isConnected && previous.focus();
  }, []);

  const keyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input:checked')];
      if (event.shiftKey && [controls[0], panelRef.current].includes(document.activeElement)) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    }
  };

  const submit = (event) => {
    event.preventDefault();
    if (!preset || submittingRef.current) return;
    submittingRef.current = true;
    try {
      onConfirm({ presetId, position });
    } catch (reason) {
      setError(reason.message || '动作插入失败，请重试');
    } finally {
      submittingRef.current = false;
    }
  };

  return createPortal(
    <div className="teaching-insert-modal" onKeyDown={keyDown} onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="teaching-insert-dialog" role="dialog" aria-modal="true" aria-labelledby="teaching-insert-title"
        ref={panelRef} tabIndex={-1} onSubmit={submit}>
        <header>
          <span className="teaching-insert-dialog__icon"><ListPlus size={21} /></span>
          <div><small>TEACHING / POSE LIBRARY</small><h2 id="teaching-insert-title">插入动作</h2></div>
          <button type="button" aria-label="关闭插入动作窗口" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="teaching-insert-dialog__body">
          <div className="teaching-insert-dialog__target">
            <span>插入目标</span><small>{task.name} / {parkingPoint.name}</small><strong>{pose.name}</strong>
          </div>
          <label className="teaching-insert-dialog__preset">预设动作
            <select ref={selectRef} aria-label="预设动作" value={presetId} disabled={!presets.length}
              onChange={(event) => { setPresetId(event.target.value); setError(''); }}>
              {!presets.length && <option value="">暂无匹配的预设姿态</option>}
              {presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {!presets.length
            ? <p className="teaching-insert-dialog__empty">请在工作台的“机器人”菜单中，为该任务的机器人新建并保存预设姿态，再返回插入。</p>
            : <p className="teaching-insert-dialog__hint">{Object.keys(preset?.joints?.values || {}).length} 个关节 · 沿用目标姿态的底盘位置和朝向</p>}
          <fieldset disabled={!presets.length}>
            <legend>插入位置</legend>
            <div className="teaching-insert-dialog__positions">
              {[['before', '之前', ArrowUp], ['after', '之后', ArrowDown]].map(([value, label, Icon]) => (
                <label key={value} className={position === value ? 'is-selected' : ''}>
                  <input type="radio" name="insert-position" value={value} checked={position === value}
                    onChange={() => setPosition(value)} />
                  <Icon size={15} /><span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {preset && <div className="teaching-insert-dialog__sequence" aria-label="插入顺序预览">
            <span>执行顺序</span>
            {(position === 'before'
              ? [{ name: preset.name, inserted: true }, { name: pose.name }]
              : [{ name: pose.name }, { name: preset.name, inserted: true }]
            ).map((item, index) => <div key={index} className={item.inserted ? 'is-inserted' : ''}>
              <i>{String(index + 1).padStart(2, '0')}</i><strong>{item.name}</strong>
              <small>{item.inserted ? '新动作' : '目标姿态'}</small>
            </div>)}
          </div>}
          {error && <p className="teaching-insert-dialog__error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="teaching-insert-dialog__confirm" disabled={!preset}><ListPlus size={14} />确认插入</button>
        </footer>
      </form>
    </div>, document.body,
  );
}
