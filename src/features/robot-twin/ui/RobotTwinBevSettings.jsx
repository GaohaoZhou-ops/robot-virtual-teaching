import { useId, useLayoutEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { ROBOT_TWIN_BEV_ANGLE_LIMITS } from '../model/robotTwinFollowCamera.js';

const AXES = [
  { key: 'roll', label: 'R', name: '横滚' },
  { key: 'pitch', label: 'P', name: '俯仰' },
  { key: 'yaw', label: 'Y', name: '偏航' },
];

export function RobotTwinBevSettings({ id, open, triggerRef, panelRef, angles, onChange, onClose }) {
  const inputId = useId();
  const [position, setPosition] = useState({});
  useLayoutEffect(() => {
    if (!open) return undefined;
    const trigger = triggerRef.current, panel = panelRef.current;
    const parent = trigger?.closest('.viewer-menu__panel');
    if (!trigger || !panel || !parent) return undefined;
    const place = () => {
      const root = parent.getBoundingClientRect(), row = trigger.getBoundingClientRect();
      const padding = 8, gap = 4, width = panel.offsetWidth;
      const side = root.right + gap + width <= window.innerWidth - padding ? 'right'
        : root.left - gap - width >= padding ? 'left' : 'below';
      const left = Math.max(padding, Math.min(
        side === 'right' ? root.right + gap : side === 'left' ? root.left - width - gap : root.left,
        window.innerWidth - width - padding,
      ));
      const top = Math.max(padding, Math.min(side === 'below' ? row.bottom + gap : row.top,
        window.innerHeight - Math.min(panel.scrollHeight, window.innerHeight - padding * 2) - padding));
      const next = { left, top, maxHeight: Math.max(0, window.innerHeight - top - padding), side };
      setPosition(previous => Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    [trigger, parent, panel].forEach(element => observer.observe(element));
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, triggerRef, panelRef]);

  return <div ref={panelRef} id={id} className="robot-twin-bev-settings" hidden={!open}
    role="dialog" aria-label="BEV 观测角度" data-side={position.side}
    style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
    onKeyDown={event => {
      if (event.key === 'Escape' || (event.key === 'ArrowLeft' && !event.target.closest('input'))) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
    }}>
    <header><strong>BEV 观测角度</strong>
      <button type="button" aria-label="关闭 BEV 角度设置" onClick={onClose}><X size={13} /></button>
    </header>
    <p>默认角度为 0° · 调整后实时跟随</p>
    {AXES.map(({ key, label, name }) => <div className="robot-twin-bev-settings__axis" key={key}>
      <label htmlFor={`${inputId}-${key}`}><span><b>{label}</b>{name}</span>
        <output>{angles[key] > 0 ? '+' : ''}{angles[key]}°</output></label>
      <div className="robot-twin-bev-settings__control">
        <input id={`${inputId}-${key}`} type="range" aria-label={`BEV ${label} ${name}`}
          min={-ROBOT_TWIN_BEV_ANGLE_LIMITS[key]} max={ROBOT_TWIN_BEV_ANGLE_LIMITS[key]} step="1"
          value={angles[key]} aria-valuetext={`${angles[key]}°`}
          onChange={event => onChange({ ...angles, [key]: Number(event.currentTarget.value) })} />
        <button type="button" aria-label={`重置 BEV ${label} ${name}`} title={`重置 ${label} 为 0°`}
          disabled={angles[key] === 0} onClick={() => {
            document.getElementById(`${inputId}-${key}`)?.focus({ preventScroll: true });
            onChange({ ...angles, [key]: 0 });
          }}><RotateCcw size={13} /></button>
      </div>
    </div>)}
  </div>;
}
