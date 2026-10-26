import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { List, LoaderCircle, Pencil, Plus, Save, TextCursorInput, Trash2, X } from 'lucide-react';
import { presetMatchesRobot } from '../lib/robotJointPresets.js';
import './RobotPresetDialog.css';
import './RobotPresetManagerDialog.css';

export default function RobotPresetManagerDialog({
  poses, robot, canEdit, hidden, onNew, onEdit, onRename, onDelete, onClose, returnFocusRef,
}) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const newRef = useRef(null);
  const nameRef = useRef(null);
  const cancelRef = useRef(null);
  const actionReturnRef = useRef(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    const previous = returnFocusRef?.current || document.activeElement;
    closeRef.current?.focus();
    return () => {
      mountedRef.current = false;
      previous?.focus?.();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (action?.type === 'rename') {
      nameRef.current?.focus();
      nameRef.current?.select();
    } else if (action?.type === 'delete') {
      cancelRef.current?.focus();
    } else if (actionReturnRef.current) {
      const target = actionReturnRef.current;
      (target.isConnected ? target : newRef.current?.disabled ? closeRef.current : newRef.current)?.focus();
      actionReturnRef.current = null;
    }
  }, [action?.id, action?.type]);

  const beginAction = (type, pose, event) => {
    actionReturnRef.current = event.currentTarget;
    setError('');
    setAction({ type, id: pose.id, name: pose.name });
  };
  const cancelAction = () => {
    setAction(null);
    setError('');
  };
  const edit = (id) => {
    setError('');
    try { onEdit(id); } catch (reason) { setError(reason.message || '无法编辑该预设姿态'); }
  };
  const submitAction = async (event) => {
    event.preventDefault();
    if (!action || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (action.type === 'rename') await onRename(action.id, action.name);
      else await onDelete(action.id);
      if (mountedRef.current) setAction(null);
    } catch (reason) {
      if (mountedRef.current) setError(reason.message || '预设姿态保存失败');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };
  const keyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busyRef.current) {
        if (action) cancelAction();
        else onClose();
      }
    } else if (event.key === 'Tab') {
      const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      if (event.shiftKey && [controls[0], panelRef.current].includes(document.activeElement)) {
        event.preventDefault(); controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault(); controls[0]?.focus();
      }
    }
  };

  return createPortal(
    <div className="robot-preset-modal robot-preset-manager-modal" hidden={hidden}
      onKeyDown={keyDown} onKeyUp={(event) => event.stopPropagation()}>
      <section className="robot-preset-dialog robot-preset-manager" role="dialog" aria-modal="true"
        aria-labelledby="robot-preset-manager-title" aria-busy={busy} tabIndex={-1} ref={panelRef}>
        <header>
          <span className="robot-preset-dialog__icon"><List size={23} /></span>
          <div><small>ROBOT / POSE LIBRARY</small><h2 id="robot-preset-manager-title">管理预设姿态</h2>
            <p>地图示教与独立示教共用 · {poses.length} 个预设姿态</p></div>
          <button type="button" ref={closeRef} aria-label="关闭预设姿态管理" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="robot-preset-manager__toolbar">
          <p>{robot ? `当前机器人：${robot.name}` : '加载机器人后可新增或编辑关节值。'}</p>
          <button type="button" ref={newRef} className="robot-preset-dialog__save" disabled={!canEdit || busy || Boolean(action)}
            title={canEdit ? '使用当前机器人姿态新建预设' : '请先加载具有可动关节的机器人模型'} onClick={onNew}>
            <Plus size={14} />新建预设姿态
          </button>
        </div>
        <div className="robot-preset-manager__body">
          {!poses.length ? <div className="robot-preset-manager__empty">
            <List size={30} /><strong>暂无预设姿态</strong>
            <p>{canEdit ? '点击“新建预设姿态”，保存常用的关节姿态。' : '请先加载机器人，再创建预设姿态。'}</p>
          </div> : <ul className="robot-preset-manager__list" aria-label="预设姿态列表">
            {poses.map((pose) => {
              const active = action?.id === pose.id;
              const editable = canEdit && presetMatchesRobot(pose, robot);
              return <li key={pose.id} data-preset-id={pose.id}>
                <div className="robot-preset-manager__row">
                  <div className="robot-preset-manager__identity">
                    <strong title={pose.name}>{pose.name}</strong>
                    <span>{pose.robot?.name || '未命名机器人'} · {pose.joints?.count || 0} 个关节</span>
                    {!presetMatchesRobot(pose, robot) && <small>切换到该机器人后可编辑关节值</small>}
                  </div>
                  <div className="robot-preset-manager__actions">
                    <button type="button" aria-label={`编辑预设姿态 ${pose.name}`} disabled={busy || Boolean(action) || !editable}
                      title={editable ? '编辑名称和关节值' : '请先加载此预设对应的机器人模型'} onClick={() => edit(pose.id)}>
                      <Pencil size={13} />编辑
                    </button>
                    <button type="button" aria-label={`重命名预设姿态 ${pose.name}`} disabled={busy || Boolean(action)}
                      onClick={(event) => beginAction('rename', pose, event)}><TextCursorInput size={13} />重命名</button>
                    <button type="button" className="robot-preset-manager__delete" aria-label={`删除预设姿态 ${pose.name}`}
                      disabled={busy || Boolean(action)} onClick={(event) => beginAction('delete', pose, event)}>
                      <Trash2 size={13} />删除
                    </button>
                  </div>
                </div>
                {active && <form className="robot-preset-manager__action" onSubmit={submitAction}>
                  {action.type === 'rename' ? <label>预设姿态名称
                    <input ref={nameRef} aria-label="预设姿态新名称" maxLength={80} value={action.name} disabled={busy}
                      onChange={(event) => { setAction({ ...action, name: event.target.value }); setError(''); }} />
                  </label> : <p>确定删除“{pose.name}”？<span>已插入示教任务的姿态会保留。</span></p>}
                  <div>
                    <button type="button" ref={cancelRef} disabled={busy} onClick={cancelAction}>取消</button>
                    <button type="submit" className={action.type === 'delete' ? 'robot-preset-manager__delete' : 'robot-preset-dialog__save'}
                      disabled={busy || (action.type === 'rename' && !action.name.trim())}>
                      {busy ? <LoaderCircle size={13} className="is-spinning" />
                        : action.type === 'rename' ? <Save size={13} /> : <Trash2 size={13} />}
                      {busy ? '正在保存' : action.type === 'rename' ? '保存名称' : '确认删除'}
                    </button>
                  </div>
                </form>}
              </li>;
            })}
          </ul>}
        </div>
        <footer><span className={error ? 'is-error' : ''} role={error ? 'alert' : undefined}>
          {error || '修改后自动保存，地图示教与独立示教同步生效。'}
        </span><div><button type="button" disabled={busy} onClick={onClose}>完成</button></div></footer>
      </section>
    </div>, document.body,
  );
}
