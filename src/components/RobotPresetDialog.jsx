import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, FolderOpen, LoaderCircle, Save, X } from 'lucide-react';
import {
  groupPresetJoints,
  jointPresetErrors,
  jointValueFromInput,
  jointValueToInput,
  readRobotPresetFile,
} from '../lib/robotJointPresets.js';
import './RobotPresetDialog.css';

const formatValue = (value) => Number.isFinite(value) ? String(Number(value.toFixed(10))) : '';
const unitLabel = (joint, unit) => joint.type === 'prismatic' ? 'm' : unit === 'radian' ? 'rad' : '°';

function limitLabel(joint, unit) {
  const format = (value, fallback) => Number.isFinite(value)
    ? String(Number(jointValueToInput(value, joint, unit).toFixed(4))) : fallback;
  return `${format(joint.lower, '−∞')} ～ ${format(joint.upper, '+∞')} ${unitLabel(joint, unit)}`;
}

export default function RobotPresetDialog({ snapshot, onSave, onClose, returnFocusRef }) {
  const panelRef = useRef(null);
  const nameInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const importingRef = useRef(false);
  const [name, setName] = useState(snapshot.name || '');
  const [unit, setUnit] = useState(snapshot.unit || 'degree');
  const [drafts, setDrafts] = useState(() => Object.fromEntries(snapshot.joints.map((joint) => {
    const value = snapshot.values[joint.name] ?? Math.max(joint.lower ?? -Infinity, Math.min(joint.upper ?? Infinity, 0));
    return [joint.name, { value, text: formatValue(jointValueToInput(value, joint, snapshot.unit || 'degree')) }];
  })));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const busy = saving || importing;
  const groups = useMemo(() => groupPresetJoints(snapshot.joints), [snapshot.joints]);

  useEffect(() => {
    mountedRef.current = true;
    const previous = returnFocusRef?.current || document.activeElement;
    nameInputRef.current?.focus();
    return () => {
      mountedRef.current = false;
      previous?.focus?.();
    };
  }, [returnFocusRef]);

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importingRef.current || savingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setError('');
    try {
      if (!file.name.toLowerCase().endsWith('.json')) throw new Error('请选择 .json 预设姿态文件');
      if (file.size > 1024 * 1024) throw new Error('预设姿态文件不能超过 1 MB');
      const imported = readRobotPresetFile(await file.text(), snapshot.joints, file.name);
      if (!mountedRef.current) return;
      setDrafts((current) => Object.fromEntries(snapshot.joints.map((joint) => {
        const value = imported.values[joint.name] ?? current[joint.name].value;
        return [joint.name, { value, text: formatValue(jointValueToInput(value, joint, imported.unit)) }];
      })));
      setName((current) => current.trim() ? current : imported.name);
      setUnit(imported.unit);
      setErrors((current) => Object.fromEntries(Object.entries(current)
        .filter(([joint]) => !Object.hasOwn(imported.values, joint))));
    } catch (reason) {
      if (mountedRef.current) setError(reason.message || '预设姿态文件导入失败');
    } finally {
      importingRef.current = false;
      if (mountedRef.current) setImporting(false);
    }
  };

  const changeUnit = (nextUnit) => {
    if (unit === nextUnit) return;
    // Keep canonical degrees/meters so repeated unit switches never accumulate rounding.
    setDrafts((current) => Object.fromEntries(snapshot.joints.map((joint) => [joint.name, {
      value: current[joint.name].value,
      text: formatValue(jointValueToInput(current[joint.name].value, joint, nextUnit)),
    }])));
    setUnit(nextUnit);
  };

  const save = async (event) => {
    event.preventDefault();
    if (savingRef.current || importingRef.current) return;
    const values = Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.value]));
    const nextErrors = jointPresetErrors(snapshot.joints, values);
    setErrors(nextErrors);
    setError('');
    if (!name.trim()) { setError('请输入预设姿态名称'); return; }
    if (Object.keys(nextErrors).length) { setError('请修正标出的关节值后保存'); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave({ name, values });
    } catch (reason) {
      setError(reason.message || '预设姿态保存失败，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const keyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!savingRef.current && !importingRef.current) onClose();
    } else if (event.key === 'Tab') {
      const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="file"])')];
      if (event.shiftKey && [controls[0], panelRef.current].includes(document.activeElement)) {
        event.preventDefault(); controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault(); controls[0]?.focus();
      }
    }
  };

  return createPortal(
    <div className="robot-preset-modal" onKeyDown={keyDown} onKeyUp={(event) => event.stopPropagation()}>
      <form className="robot-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="robot-preset-title"
        ref={panelRef} tabIndex={-1} noValidate onSubmit={save} aria-busy={busy}>
        <header>
          <span className="robot-preset-dialog__icon"><Bot size={23} /></span>
          <div><small>ROBOT / POSE LIBRARY</small><h2 id="robot-preset-title">新建预设姿态</h2>
            <p>{snapshot.robot.name} · {snapshot.joints.length} 个关节</p></div>
          <button type="button" aria-label="关闭预设姿态窗口" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="robot-preset-dialog__body">
          <div className="robot-preset-dialog__settings">
            <label className="robot-preset-dialog__name">预设姿态名称
              <input ref={nameInputRef} aria-label="预设姿态名称" placeholder="例如：准备姿态" maxLength={80}
                value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setError(''); }} />
            </label>
            <div className="robot-preset-dialog__controls">
              <div className="robot-preset-dialog__units" role="group" aria-label="关节角度单位">
                <span>输入单位</span>
                <div>{[['degree', '角度 °'], ['radian', '弧度 rad']].map(([value, label]) => (
                  <button type="button" key={value} aria-pressed={unit === value} disabled={busy}
                    onClick={() => changeUnit(value)}>{label}</button>
                ))}</div>
              </div>
              <span className="robot-preset-dialog__divider" aria-hidden="true" />
              <input ref={fileInputRef} type="file" hidden tabIndex={-1} disabled={busy}
                accept=".json,application/json" aria-label="预设姿态文件" onChange={importFile} />
              <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                {importing ? <LoaderCircle size={14} className="is-spinning" /> : <FolderOpen size={14} />}
                {importing ? '正在读取…' : '导入预设姿态'}
              </button>
            </div>
          </div>
          <div className="robot-preset-dialog__groups">
            {groups.map((group) => <fieldset key={group.id} data-preset-group={group.id} disabled={busy}>
              <legend>{group.label}<span>{group.joints.length} 个关节</span></legend>
              {group.joints.map((joint) => <label key={joint.name} className="robot-preset-joint">
                <span><strong title={joint.name}>{joint.name}</strong><small>{limitLabel(joint, unit)}</small>
                  {errors[joint.name] && <em>{errors[joint.name]}</em>}</span>
                <span className="robot-preset-joint__input">
                  <input type="number" step="any" aria-label={`${joint.name} 预设关节值`}
                    aria-invalid={Boolean(errors[joint.name])} value={drafts[joint.name].text}
                    onChange={(event) => {
                      const text = event.target.value;
                      setDrafts((current) => ({ ...current, [joint.name]: {
                        text, value: jointValueFromInput(text, joint, unit),
                      } }));
                      setErrors((current) => ({ ...current, [joint.name]: undefined }));
                      setError('');
                    }} />
                  <small>{unitLabel(joint, unit)}</small>
                </span>
              </label>)}
            </fieldset>)}
          </div>
        </div>
        <footer>
          <span className={error ? 'is-error' : ''} role={error ? 'alert' : undefined}>
            {error || '保存到当前工程，之后可从机器人菜单一键应用。'}
          </span>
          <div><button type="button" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="robot-preset-dialog__save" disabled={busy}>
              {saving ? <LoaderCircle size={14} className="is-spinning" /> : <Save size={14} />}
              {saving ? '正在保存' : '保存预设姿态'}
            </button></div>
        </footer>
      </form>
    </div>, document.body,
  );
}
