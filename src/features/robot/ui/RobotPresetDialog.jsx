import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, ClipboardPaste, Crosshair, FolderOpen, LoaderCircle, Play, RotateCcw, Save, X } from 'lucide-react';
import TeachingPoseRobotPreview from "../../teaching/ui/TeachingPoseRobotPreview.jsx";
import {
  groupPresetJoints,
  jointPresetErrors,
  jointValueFromInput,
  jointValueToInput,
  readRobotPresetFile,
} from "../model/robotJointPresets.js";
import "./RobotPresetDialog.css";

const formatValue = (value) => Number.isFinite(value) ? String(Number(value.toFixed(10))) : '';
const unitLabel = (joint, unit) => joint.type === 'prismatic' ? 'm' : unit === 'radian' ? 'rad' : '°';

function limitLabel(joint, unit) {
  const format = (value, fallback) => Number.isFinite(value)
    ? String(Number(jointValueToInput(value, joint, unit).toFixed(4))) : fallback;
  return `${joint.softLimitRatio ? '软限位 ' : ''}${format(joint.lower, '−∞')} ～ ${format(joint.upper, '+∞')} ${unitLabel(joint, unit)}`;
}

export default function RobotPresetDialog({ snapshot, currentJointValues = snapshot.values, onSave, onClose, returnFocusRef }) {
  const panelRef = useRef(null);
  const nameInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const pasteButtonRef = useRef(null);
  const pasteInputRef = useRef(null);
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const importingRef = useRef(false);
  const [name, setName] = useState(snapshot.name || '');
  const [unit, setUnit] = useState(snapshot.unit || 'degree');
  const [drafts, setDrafts] = useState(() => Object.fromEntries(snapshot.joints.map((joint) => {
    const value = snapshot.values[joint.name] ?? Math.max(joint.lower ?? -Infinity, Math.min(joint.upper ?? Infinity, 0));
    const previewValue = Math.max(joint.lower ?? -Infinity, Math.min(joint.upper ?? Infinity, Number.isFinite(value) ? value : 0));
    return [joint.name, { value, previewValue, text: formatValue(jointValueToInput(value, joint, snapshot.unit || 'degree')) }];
  })));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null);
  const [importing, setImporting] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState('');
  const busy = Boolean(saving || importing);
  const groups = useMemo(() => groupPresetJoints(snapshot.joints), [snapshot.joints]);
  const previewValues = useMemo(() => ({ ...currentJointValues,
    ...Object.fromEntries(Object.entries(drafts).map(([joint, draft]) => [joint, draft.previewValue])),
  }), [drafts, currentJointValues]);
  const previewPose = useMemo(() => ({ id: snapshot.id, name: name.trim() || '未命名姿态',
    fullBodyJoints: { values: previewValues },
  }), [name, previewValues, snapshot.id]);
  const hasInvalidValues = Object.keys(jointPresetErrors(snapshot.joints,
    Object.fromEntries(Object.entries(drafts).map(([joint, draft]) => [joint, draft.value])))).length > 0;

  useEffect(() => {
    mountedRef.current = true;
    const previous = returnFocusRef?.current || document.activeElement;
    nameInputRef.current?.focus();
    return () => {
      mountedRef.current = false;
      previous?.focus?.();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (pasteMode) pasteInputRef.current?.focus();
  }, [pasteMode]);

  const applyImportedValues = (imported) => {
    setDrafts((current) => Object.fromEntries(snapshot.joints.map((joint) => {
      const value = imported.values[joint.name] ?? current[joint.name].value;
      return [joint.name, { value, previewValue: imported.values[joint.name] ?? current[joint.name].previewValue,
        text: formatValue(jointValueToInput(value, joint, imported.unit)) }];
    })));
    setUnit(imported.unit);
    setErrors((current) => Object.fromEntries(Object.entries(current)
      .filter(([joint]) => !Object.hasOwn(imported.values, joint))));
  };

  const leavePasteMode = () => {
    setPasteMode(false);
    setPasteError('');
    pasteButtonRef.current?.focus();
  };

  const parsePastedValues = () => {
    if (savingRef.current || importingRef.current) return;
    setPasteError('');
    try {
      if (!pasteText.trim()) throw new Error('请先粘贴关节值 JSON');
      if (new Blob([pasteText]).size > 1024 * 1024) throw new Error('关节值文本不能超过 1 MB');
      const imported = readRobotPresetFile(pasteText, snapshot.joints);
      applyImportedValues(imported);
      setPasteText('');
      setError('');
      leavePasteMode();
    } catch (reason) {
      setPasteError(reason.message || '关节值解析失败，请检查粘贴的内容');
      pasteInputRef.current?.focus();
    }
  };

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
      applyImportedValues(imported);
      setName((current) => current.trim() ? current : imported.name);
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
      ...current[joint.name],
      text: formatValue(jointValueToInput(current[joint.name].value, joint, nextUnit)),
    }])));
    setUnit(nextUnit);
  };

  const replacePoseValues = (source) => {
    if (savingRef.current || importingRef.current) return;
    const values = Object.fromEntries(snapshot.joints.map((joint) => [joint.name, source[joint.name] ?? 0]));
    const nextErrors = jointPresetErrors(snapshot.joints, values);
    setDrafts((current) => Object.fromEntries(snapshot.joints.map((joint) => {
      const value = values[joint.name];
      return [joint.name, { value, text: formatValue(jointValueToInput(value, joint, unit)),
        previewValue: nextErrors[joint.name] ? current[joint.name].previewValue : value }];
    })));
    setErrors(nextErrors);
    setError('');
  };

  const save = async (event) => {
    event.preventDefault();
    if (savingRef.current || importingRef.current || pasteMode) return;
    const apply = event.nativeEvent.submitter?.value === 'apply';
    const values = Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.value]));
    const nextErrors = jointPresetErrors(snapshot.joints, values);
    setErrors(nextErrors);
    setError('');
    if (!name.trim()) { setError('请输入预设姿态名称'); return; }
    if (Object.keys(nextErrors).length) { setError('请修正标出的关节值后保存'); return; }
    savingRef.current = true;
    setSaving(apply ? 'apply' : 'save');
    try {
      await onSave({ name, values, apply });
    } catch (reason) {
      if (mountedRef.current) setError(reason.message || '预设姿态保存失败，请重试');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(null);
    }
  };

  const keyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!savingRef.current && !importingRef.current) onClose();
    } else if (event.key === 'Tab') {
      const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="file"]), textarea:not(:disabled), canvas[tabindex="0"]')];
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
          <div><small>ROBOT / POSE LIBRARY</small><h2 id="robot-preset-title">
            {snapshot.mode === 'edit' ? '编辑预设姿态' : '新建预设姿态'}
          </h2>
            <p>{snapshot.robot.name} · {snapshot.joints.length} 个关节</p></div>
          <button type="button" aria-label="关闭预设姿态窗口" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="robot-preset-dialog__body">
          <div className="robot-preset-dialog__preview">
            <TeachingPoseRobotPreview variant="preset" robot={snapshot.robot} pose={previewPose} />
            <p className={hasInvalidValues ? 'is-warning' : ''} role="status">
              {hasInvalidValues ? '部分关节输入无效，预览保留这些关节上次有效的位置。'
                : '修改或导入后实时预览；点击“保存并应用”后，工作台机器人使用该姿态。'}
            </p>
          </div>
          <div className="robot-preset-dialog__editor">
            <div className="robot-preset-dialog__settings">
              <label className="robot-preset-dialog__name">预设姿态名称
                <input ref={nameInputRef} aria-label="预设姿态名称" placeholder="例如：准备姿态" maxLength={80}
                  value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setError(''); }} />
              </label>
              <div className="robot-preset-dialog__controls">
                <div className="robot-preset-dialog__units" role="group" aria-label="关节角度单位">
                  <span>输入单位</span>
                  <div>{[['degree', '角度 °'], ['radian', '弧度 rad']].map(([value, label]) => (
                    <button type="button" key={value} aria-pressed={unit === value} disabled={busy || pasteMode}
                      onClick={() => changeUnit(value)}>{label}</button>
                  ))}</div>
                </div>
                <input ref={fileInputRef} type="file" hidden tabIndex={-1} disabled={busy || pasteMode}
                  accept=".json,application/json" aria-label="预设姿态文件" onChange={importFile} />
                <div className="robot-preset-dialog__pose-actions">
                  <button type="button" disabled={busy || pasteMode} onClick={() => replacePoseValues({})}>
                    <RotateCcw size={14} />重置姿态
                  </button>
                  <button type="button" disabled={busy || pasteMode} onClick={() => replacePoseValues(currentJointValues)}>
                    <Crosshair size={14} />当前姿态
                  </button>
                  <button type="button" disabled={busy || pasteMode} onClick={() => fileInputRef.current?.click()}>
                    {importing ? <LoaderCircle size={14} className="is-spinning" /> : <FolderOpen size={14} />}
                    {importing ? '正在读取…' : '导入预设姿态'}
                  </button>
                  <button ref={pasteButtonRef} type="button" disabled={busy} aria-pressed={pasteMode}
                    onClick={() => {
                      setError('');
                      if (pasteMode) leavePasteMode();
                      else setPasteMode(true);
                    }}>
                    <ClipboardPaste size={14} />粘贴关节值
                  </button>
                </div>
              </div>
            </div>
            {pasteMode ? <div className="robot-preset-dialog__paste">
              <label htmlFor="robot-preset-paste">关节值 JSON</label>
              <p id="robot-preset-paste-help">在下方粘贴 JSON，支持 deg（角度）和 rad（弧度）。解析成功后返回关节表单。</p>
              <textarea id="robot-preset-paste" ref={pasteInputRef} value={pasteText} disabled={busy}
                spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={Boolean(pasteError)}
                aria-describedby={`robot-preset-paste-help${pasteError ? ' robot-preset-paste-error' : ''}`}
                placeholder={'{\n  "unit": "deg",\n  "joints": {\n    "head": [0, 0],\n    "torso": [0, 0, 0, 0],\n    "left_arm": [0, 0, 0, 0, 0, 0, 0],\n    "right_arm": [0, 0, 0, 0, 0, 0, 0]\n  }\n}'}
                onChange={(event) => { setPasteText(event.target.value); setPasteError(''); }} />
              {pasteError && <p id="robot-preset-paste-error" className="is-error" role="alert">{pasteError}</p>}
              <div className="robot-preset-dialog__paste-actions">
                <button type="button" disabled={busy} onClick={leavePasteMode}>返回关节表单</button>
                <button type="button" className="robot-preset-dialog__save" disabled={busy || !pasteText.trim()}
                  onClick={parsePastedValues}>解析关节值</button>
              </div>
            </div> : <div className="robot-preset-dialog__groups">
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
                        const value = jointValueFromInput(text, joint, unit);
                        const valid = !Object.keys(jointPresetErrors([joint], { [joint.name]: value })).length;
                        setDrafts((current) => ({ ...current, [joint.name]: {
                          text, value, previewValue: valid ? value : current[joint.name].previewValue,
                        } }));
                        setErrors((current) => ({ ...current, [joint.name]: undefined }));
                        setError('');
                      }} />
                    <small>{unitLabel(joint, unit)}</small>
                  </span>
                </label>)}
              </fieldset>)}
            </div>}
          </div>
        </div>
        <footer>
          <span className={error ? 'is-error' : ''} role={error ? 'alert' : undefined}>
            {error || (pasteMode ? '请先解析关节值，再保存预设姿态。' : '地图示教与独立示教共用；选择“保存并应用”可立即使用该姿态。')}
          </span>
          <div><button type="button" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" name="action" value="save" className="robot-preset-dialog__save" disabled={busy || pasteMode}>
              {saving === 'save' ? <LoaderCircle size={14} className="is-spinning" /> : <Save size={14} />}
              {saving === 'save' ? '正在保存' : '保存姿态'}
            </button>
            <button type="submit" name="action" value="apply" className="robot-preset-dialog__apply" disabled={busy || pasteMode}>
              {saving === 'apply' ? <LoaderCircle size={14} className="is-spinning" /> : <Play size={14} />}
              {saving === 'apply' ? '正在保存并应用' : '保存并应用'}
            </button></div>
        </footer>
      </form>
    </div>, document.body,
  );
}
