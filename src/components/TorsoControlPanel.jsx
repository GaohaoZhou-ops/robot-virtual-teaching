import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Check, Rotate3D, RotateCcw, SlidersHorizontal, X } from 'lucide-react';

const AXES = [
  { key: 'height', label: '高度', unit: 'm', step: 0.005, digits: 3, Icon: ArrowUpDown },
  { key: 'yaw', label: 'YAW', unit: '°', step: 1, digits: 1, Icon: RotateCcw },
  { key: 'pitch', label: 'PITCH', unit: '°', step: 1, digits: 1, Icon: Rotate3D },
];

function TorsoField({ axis, value, limits, active, onModeChange, onChange }) {
  const [draft, setDraft] = useState(value.toFixed(axis.digits));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value.toFixed(axis.digits));
  }, [value, axis.digits]);
  const commit = () => {
    focused.current = false;
    if (draft === value.toFixed(axis.digits)) return;
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onChange({ [axis.key]: parsed });
    setDraft(value.toFixed(axis.digits));
  };
  return (
    <div className={`torso-control-field ${active ? 'is-active' : ''}`} data-axis={axis.key}>
      <button type="button" aria-label={`调整躯干${axis.label}`} aria-pressed={active} onClick={onModeChange}>
        <axis.Icon size={13} /><span>{axis.label}</span>
      </button>
      <input type="range" aria-label={`躯干${axis.label}滑杆`} min={limits[0]} max={limits[1]} step={axis.step}
        value={value} onPointerDown={onModeChange} onFocus={onModeChange}
        onChange={(event) => onChange({ [axis.key]: Number(event.target.value) })} />
      <label>
        <input type="number" aria-label={`躯干${axis.label} (${axis.unit})`} value={draft} step={axis.step}
          onFocus={() => { focused.current = true; onModeChange(); }}
          onChange={(event) => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        <span>{axis.unit}</span>
      </label>
    </div>
  );
}

export default function TorsoControlPanel({ control, onModeChange, onPoseChange, onCancel, onClose }) {
  return (
    <section className={`end-effector-panel torso-control-panel is-${control.status}`} aria-label="躯干联动控制"
      data-control-mode={control.mode} data-ik-status={control.status}>
      <header className="end-effector-panel__header">
        <div className="space-ball-emblem"><SlidersHorizontal size={19} /></div>
        <div><small>TORSO · HEIGHT / YAW / PITCH</small><strong>躯干联动控制</strong></div>
        <button type="button" aria-label="完成躯干调整" title="保留当前姿态并退出" onClick={onClose}><X size={14} /></button>
      </header>
      <div className="torso-control-panel__body">
        <p className="torso-control-panel__description">高度相对底盘 · 踝、膝、腰联动</p>
        {AXES.map((axis) => (
          <TorsoField key={axis.key} axis={axis} value={control.torsoPose[axis.key]} limits={control.limits[axis.key]}
            active={control.mode === axis.key} onModeChange={() => onModeChange(axis.key)} onChange={onPoseChange} />
        ))}
        <p className={`torso-control-panel__status ${control.status === 'limited' ? 'is-limited' : ''}`} role="status">
          {control.armLockLimited ? '末端全局锁定已到补偿边界'
            : control.status === 'limited'
            ? `已到行程边界 · 高度差 ${(control.heightError * 1000).toFixed(0)} mm · 角度差 ${control.rotationError.toFixed(1)}°`
            : '拖动对应操作轴，或使用滑杆与数值微调'}
        </p>
      </div>
      <footer className="end-effector-panel__footer">
        <span>Ctrl+Z 撤销拖拽 · Esc 取消</span>
        <div className="end-effector-panel__actions">
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" onClick={onClose}><Check size={11} />完成调整</button>
        </div>
      </footer>
    </section>
  );
}
