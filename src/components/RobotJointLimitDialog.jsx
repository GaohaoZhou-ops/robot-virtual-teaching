import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { ARM_SOFT_LIMIT_RATIO, MIN_ARM_SOFT_LIMIT_RATIO, getRobotSoftLimitRange,
  normalizeArmSoftLimitOverrides, robotSoftLimitJointGroup } from '../lib/robotJointLimits.js';
import RobotJointLimitPreview from './RobotJointLimitPreview.jsx';
import './RobotPresetDialog.css';
import './RobotJointLimitDialog.css';

const format = (value) => String(Number(value.toFixed(3)));
const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const WAIST_LABELS = { ankle_pitch: '踝部俯仰', knee_pitch: '膝部俯仰', waist_pitch: '腰部俯仰', waist_yaw: '腰部旋转' };
const jointLabel = (joint) => WAIST_LABELS[joint.name.replace(/[_-]J$/i, '').toLowerCase()]
  || joint.name.replace(/^(left|right)[_-]/i, '');

function LimitNumber({ label, value, min, max, suffix, onChange, disabled }) {
  const [draft, setDraft] = useState(format(value));
  useEffect(() => setDraft(format(value)), [value]);
  const commit = () => {
    if (draft === format(value) || disabled) return;
    const parsed = draft.trim() ? Number(draft) : NaN;
    const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : value;
    setDraft(format(next));
    if (Math.abs(next - value) > 1e-9) onChange(next);
  };
  return <label className="joint-limit-number"><span>{label}</span><div>
    <input type="number" aria-label={label} min={min} max={max} step="0.1" value={draft} disabled={disabled}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
    <small>{suffix}</small>
  </div></label>;
}

export default function RobotJointLimitDialog({ snapshot, onApply, onClose, returnFocusRef }) {
  const [ratio, setRatio] = useState(snapshot.ratio);
  const [overrides, setOverrides] = useState(() => normalizeArmSoftLimitOverrides(snapshot.overrides));
  const [selectedName, setSelectedName] = useState(snapshot.joints.find((joint) => /^left[_-]/i.test(joint.name))?.name || snapshot.joints[0]?.name);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const panelRef = useRef(null), closeRef = useRef(null), mountedRef = useRef(false), busyRef = useRef(false);
  const selected = snapshot.joints.find((joint) => joint.name === selectedName) || snapshot.joints[0];
  const range = getRobotSoftLimitRange(selected?.name, ratio, overrides[selected?.name]);
  const isWaist = robotSoftLimitJointGroup(selected?.name) === 'waist';
  const hardSpan = selected ? selected.hardUpper - selected.hardLower : 1;
  const lower = (selected?.hardLower || 0) + hardSpan * range.lower;
  const upper = (selected?.hardLower || 0) + hardSpan * range.upper;
  const customCount = Object.keys(overrides).length;
  const groups = useMemo(() => ['left', 'right', 'waist'].map((side) => ({ side, label: { left: '左臂', right: '右臂', waist: '腰部' }[side],
    joints: snapshot.joints.filter((joint) => robotSoftLimitJointGroup(joint.name) === side),
  })), [snapshot.joints]);
  const clampedCount = snapshot.joints.filter((joint) => {
    const limits = getRobotSoftLimitRange(joint.name, ratio, overrides[joint.name]), span = joint.hardUpper - joint.hardLower;
    const value = snapshot.values[joint.name];
    return Number.isFinite(value) && (value < joint.hardLower + span * limits.lower - 1e-8
      || value > joint.hardLower + span * limits.upper + 1e-8);
  }).length;

  useEffect(() => {
    mountedRef.current = true;
    const previous = returnFocusRef?.current || document.activeElement;
    closeRef.current?.focus();
    return () => { mountedRef.current = false; previous?.focus?.(); };
  }, [returnFocusRef]);

  const changeEndpoint = (key, value) => {
    const next = { ...range, [key]: key === 'lower'
      ? clamp(value, 0, range.upper - MIN_ARM_SOFT_LIMIT_RATIO)
      : clamp(value, range.lower + MIN_ARM_SOFT_LIMIT_RATIO, 1) };
    setOverrides((current) => ({ ...current, [selected.name]: next })); setError('');
  };
  const resetJoint = () => setOverrides((current) => {
    const next = { ...current }; delete next[selected.name]; return next;
  });
  const apply = async (event) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await onApply({ ratio, overrides }); }
    catch (reason) { if (mountedRef.current) setError(reason.message || '设置保存失败，请重试'); }
    finally { busyRef.current = false; if (mountedRef.current) setBusy(false); }
  };
  const keyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) onClose(); }
    if (event.key === 'Tab') {
      const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), canvas[tabindex="0"]')];
      if (event.shiftKey && [controls[0], panelRef.current].includes(document.activeElement)) {
        event.preventDefault(); controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault(); controls[0]?.focus();
      }
    }
  };

  return createPortal(<div className="robot-preset-modal joint-limit-modal" onKeyDown={keyDown}
    onKeyUp={(event) => event.stopPropagation()}>
    <form className="robot-preset-dialog joint-limit-dialog" role="dialog" aria-modal="true"
      aria-labelledby="joint-limit-dialog-title" aria-busy={busy} ref={panelRef} tabIndex={-1} onSubmit={apply} noValidate>
      <header><span className="robot-preset-dialog__icon"><SlidersHorizontal size={23} /></span>
        <div><small>ROBOT / JOINT LIMITS</small><h2 id="joint-limit-dialog-title">关节软限位详细设置</h2>
          <p>{snapshot.robot.name} · {snapshot.joints.length} 个可配置关节</p></div>
        <button type="button" ref={closeRef} aria-label="关闭关节软限位设置" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="joint-limit-dialog__body">
        <RobotJointLimitPreview robot={snapshot.robot} joint={selected} values={snapshot.values} ratio={ratio} overrides={overrides} />
        <div className="joint-limit-dialog__editor">
          <section className="joint-limit-dialog__default" aria-label="统一软限位比例">
            <div><strong>双臂统一比例</strong><span>双臂使用硬限位中间范围；腰部未单独设置时保留 100%。</span></div>
            <LimitNumber label="统一软限位百分比" value={ratio * 100} min={1} max={100} suffix="%" disabled={busy}
              onChange={(percent) => setRatio(percent / 100)} />
            <input type="range" aria-label="统一软限位比例滑块" min="1" max="100" step="0.1" value={ratio * 100} disabled={busy}
              onChange={(event) => setRatio(Number(event.target.value) / 100)} />
          </section>
          <section className="joint-limit-dialog__joint-picker" aria-label="选择预览关节">
            {groups.filter((group) => group.joints.length).map((group) => <div key={group.side} data-joint-group={group.side}>
              <span>{group.label}</span><div>{group.joints.map((joint) => <button type="button" key={joint.name}
                disabled={busy} aria-label={`设置 ${joint.name} 软限位`} aria-pressed={joint.name === selected?.name}
                title={joint.name} data-custom={Boolean(overrides[joint.name])} onClick={() => setSelectedName(joint.name)}>
                {jointLabel(joint)}{overrides[joint.name] && <i />}
              </button>)}</div>
            </div>)}
          </section>
          {selected && <section className="joint-limit-dialog__range" aria-label={`${selected.name} 软限位范围`} key={selected.name}>
            <div className="joint-limit-dialog__range-heading"><div><strong>{selected.name}</strong>
              <span>硬限位 {format(selected.hardLower)}° ～ {format(selected.hardUpper)}°</span></div>
              <b>{overrides[selected.name] ? '单独设置' : isWaist ? '默认 100%' : '统一比例'}</b></div>
            <div className="joint-limit-dialog__endpoints">
              {[['lower', '起点 / 下限', lower], ['upper', '终点 / 上限', upper]].map(([key, title, value]) => <div key={key} data-limit-end={key}>
                <h3><i />{title}</h3>
                <LimitNumber label={key === 'lower' ? '下限角度' : '上限角度'} value={value} suffix="°" disabled={busy}
                  min={key === 'lower' ? selected.hardLower : lower + hardSpan * MIN_ARM_SOFT_LIMIT_RATIO}
                  max={key === 'upper' ? selected.hardUpper : upper - hardSpan * MIN_ARM_SOFT_LIMIT_RATIO}
                  onChange={(angle) => changeEndpoint(key, (angle - selected.hardLower) / hardSpan)} />
                <LimitNumber label={key === 'lower' ? '下限百分比' : '上限百分比'} value={range[key] * 100} suffix="%" disabled={busy}
                  min={key === 'lower' ? 0 : (range.lower + MIN_ARM_SOFT_LIMIT_RATIO) * 100}
                  max={key === 'upper' ? 100 : (range.upper - MIN_ARM_SOFT_LIMIT_RATIO) * 100}
                  onChange={(percent) => changeEndpoint(key, percent / 100)} />
              </div>)}
            </div>
            <div className="joint-limit-dual-slider" role="group" aria-label="关节软限位双端滑块"
              style={{ '--range-start': `${range.lower * 100}%`, '--range-end': `${range.upper * 100}%` }}>
              <div className="joint-limit-dual-slider__track"><i /></div>
              <input type="range" min="0" max="100" step="0.1" value={range.lower * 100} disabled={busy} data-limit-end="lower"
                aria-label="软限位下限滑块" aria-valuemax={(range.upper - MIN_ARM_SOFT_LIMIT_RATIO) * 100}
                aria-valuetext={`${format(lower)} 度，${format(range.lower * 100)}%`}
                onChange={(event) => changeEndpoint('lower', Number(event.target.value) / 100)} />
              <input type="range" min="0" max="100" step="0.1" value={range.upper * 100} disabled={busy} data-limit-end="upper"
                aria-label="软限位上限滑块" aria-valuemin={(range.lower + MIN_ARM_SOFT_LIMIT_RATIO) * 100}
                aria-valuetext={`${format(upper)} 度，${format(range.upper * 100)}%`}
                onChange={(event) => changeEndpoint('upper', Number(event.target.value) / 100)} />
            </div>
            <div className="joint-limit-dialog__scale"><span>0% · {format(selected.hardLower)}°</span><strong>保留 {format((range.upper - range.lower) * 100)}%</strong><span>100% · {format(selected.hardUpper)}°</span></div>
            <p className="joint-limit-dialog__explanation">百分比按硬限位的下限（0%）至上限（100%）计算。左右滑块分别调整起点和终点，最小范围为 1%。</p>
            <button type="button" className="joint-limit-dialog__reset-joint" disabled={busy || !overrides[selected.name]} onClick={resetJoint}>
              <RotateCcw size={12} />{isWaist ? '此关节恢复 100%' : '此关节恢复统一比例'}</button>
          </section>}
          <div className="joint-limit-dialog__summary"><span>{customCount ? `${customCount} 个关节已单独设置` : '所有关节使用默认范围'}</span>
            <button type="button" disabled={busy} title="双臂恢复 95%，腰部恢复 100%"
              onClick={() => { setRatio(ARM_SOFT_LIMIT_RATIO); setOverrides({}); setError(''); }}><RotateCcw size={12} />全部恢复默认</button></div>
        </div>
      </div>
      <footer><span className={error ? 'is-error' : clampedCount ? 'is-warning' : ''} role={error ? 'alert' : undefined}>
        {error || (clampedCount ? `应用后，${clampedCount} 个超出新范围的当前关节将收回到边界。` : '应用后用于关节控制与路径规划，并随工程保存。预览不改变当前机器人姿态。')}</span>
        <div><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="robot-preset-dialog__save" disabled={busy || !selected}>
          {busy ? <LoaderCircle size={14} className="is-spinning" /> : <Check size={14} />}{busy ? '正在应用' : '应用设置'}</button></div>
      </footer>
    </form>
  </div>, document.body);
}
