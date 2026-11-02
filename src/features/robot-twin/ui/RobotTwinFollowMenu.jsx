import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, Check, ChevronRight, Eye, ScanEye, Undo2 } from 'lucide-react';
import ViewerMenu from '../../../shared/ui/ViewerMenu.jsx';
import { RobotTwinBevSettings } from './RobotTwinBevSettings.jsx';
import './RobotTwinFollow.css';

const MODES = [
  { value: 'bev', label: 'BEV', description: '从机器人后上方跟随观察', icon: Eye },
  { value: 'chest', label: '第一人称-胸摄', description: '从胸前相机位置随躯干朝向观察', icon: Camera },
  { value: 'head', label: '第一人称-头部', description: '双摄中心透视观察，随头部转动', icon: ScanEye },
];

export function RobotTwinFollowMenu({ mode, onChange, disabled, bevAngles, onBevAnglesChange }) {
  const [open, setOpen] = useState(false);
  const [bevOpen, setBevOpen] = useState(false);
  const bevId = useId();
  const bevTrigger = useRef(null), bevPanel = useRef(null), focusFrame = useRef(null);
  const root = useRef(null);
  const changeOpen = useCallback(next => {
    setOpen(next);
    if (!next) setBevOpen(false);
  }, []);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const openBev = (focus = false) => {
    cancelAnimationFrame(focusFrame.current);
    setBevOpen(true);
    if (focus) focusFrame.current = requestAnimationFrame(() => bevPanel.current?.querySelector('input')?.focus());
  };
  const closeBev = () => {
    cancelAnimationFrame(focusFrame.current);
    if (bevPanel.current?.contains(document.activeElement)) bevTrigger.current?.focus({ preventScroll: true });
    setBevOpen(false);
  };
  const select = (next) => {
    onChange(next);
    changeOpen(false);
    root.current?.querySelector('.viewer-menu__trigger')?.focus({ preventScroll: true });
  };
  return <div ref={root} className="robot-twin-follow">
    <ViewerMenu label="跟随视角" panelLabel="选择跟随形态" icon={Eye}
      triggerClassName="robot-twin-follow-toggle"
      triggerContent={<><Eye size={13} /><span>{mode ? `跟随 · ${MODES.find(item => item.value === mode)?.label}` : '跟随视角'}</span></>}
      triggerProps={{ disabled, 'aria-pressed': Boolean(mode) }}
      title="选择机器人的视角跟随形态" isActive={!disabled}
      open={open} onOpenChange={changeOpen} panelClassName="robot-twin-follow-menu">
      <div className="robot-twin-follow-menu__options" role="group" aria-label="跟随形态">
        {MODES.map(({ value, label, description, icon: Icon }) => <div key={value}
          className={`robot-twin-follow-menu__row ${value === 'bev' && bevOpen ? 'is-expanded' : ''}`}
          onPointerMove={event => {
            if (event.pointerType !== 'mouse') return;
            if (value === 'bev') { if (!bevOpen) openBev(); }
            else if (bevOpen) closeBev();
          }}>
          <button type="button" ref={value === 'bev' ? bevTrigger : undefined}
          className="robot-twin-follow-menu__option" aria-label={label} aria-pressed={mode === value}
          onKeyDown={event => {
            if (value === 'bev' && event.key === 'ArrowRight') {
              event.preventDefault(); event.stopPropagation(); openBev(true);
            }
          }}
          onClick={() => select(value)}>
          <Icon size={16} /><span><strong>{label}</strong><small>{description}</small></span>
          <Check size={14} className="robot-twin-follow-menu__check" aria-hidden="true" />
          </button>
          {value === 'bev' && <button type="button" className="robot-twin-follow-menu__expand"
            aria-label="调整 BEV 观测角度" title="调整 BEV 观测角度" aria-haspopup="dialog"
            aria-expanded={bevOpen} aria-controls={bevOpen ? bevId : undefined}
            onClick={() => openBev(true)}><ChevronRight size={13} /></button>}
        </div>)}
      </div>
      <RobotTwinBevSettings id={bevId} open={bevOpen} triggerRef={bevTrigger} panelRef={bevPanel}
        angles={bevAngles} onChange={onBevAnglesChange} onClose={closeBev} />
      <button type="button" className="robot-twin-follow-menu__exit" disabled={!mode}
        title="退出跟随并恢复之前的视角" onClick={() => select(null)}><Undo2 size={13} />退出跟随</button>
    </ViewerMenu>
  </div>;
}
