import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Crosshair,
  Globe2,
  GripHorizontal,
  Lock,
  Move3D,
  Orbit,
  Rotate3D,
  RotateCcw,
  Unlock,
  X,
} from 'lucide-react';

function PoseField({ axis, label, value, unit, step, tone, disabled, onCommit }) {
  const [draft, setDraft] = useState(Number(value).toFixed(unit === 'm' ? 3 : 1));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(Number(value).toFixed(unit === 'm' ? 3 : 1));
    }
  }, [unit, value]);

  const commit = () => {
    focusedRef.current = false;
    // Focusing a rounded readout alone must not edit the pose or discard drag undo.
    if (draft === Number(value).toFixed(unit === 'm' ? 3 : 1)) return;
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(Number(value).toFixed(unit === 'm' ? 3 : 1));
  };

  return (
    <label className={`space-ball-field tone-${tone}`}>
      <span>{axis}</span>
      <input
        type="number"
        aria-label={`末端 ${label}`}
        value={draft}
        step={step}
        disabled={disabled}
        onFocus={() => { focusedRef.current = true; }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(Number(value).toFixed(unit === 'm' ? 3 : 1));
            event.currentTarget.blur();
          }
        }}
      />
      <em>{unit}</em>
    </label>
  );
}

const sideLabel = { left: '左机械臂', right: '右机械臂' };
const sideShortLabel = { left: '左端', right: '右端' };
const PANEL_EDGE = 10;
const initialPanelPosition = () => ({ x: PANEL_EDGE, y: PANEL_EDGE });

export default function EndEffectorControlPanel({
  control,
  viewportRef,
  lockModes,
  onModeChange,
  onPoseChange,
  onReset,
  onToggleBodyLock,
  onToggleMapLock,
  onClose,
}) {
  const panelRef = useRef(null);
  const dragRef = useRef(null);
  const [position, setPosition] = useState(initialPanelPosition);
  const positionRef = useRef(position);
  const [dragging, setDragging] = useState(false);
  const open = Boolean(control);

  const movePanel = useCallback((candidate) => {
    const panel = panelRef.current;
    const viewport = viewportRef.current;
    // Hidden/collapsed views have no usable bounds; retain the last position.
    if (!panel || !viewport?.clientWidth || !viewport.clientHeight) return;
    const next = {
      x: Math.max(PANEL_EDGE, Math.min(
        candidate.x, viewport.clientWidth - panel.offsetWidth - PANEL_EDGE,
      )),
      y: Math.max(PANEL_EDGE, Math.min(
        candidate.y, viewport.clientHeight - panel.offsetHeight - PANEL_EDGE,
      )),
    };
    positionRef.current = next;
    setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
  }, [viewportRef]);

  useLayoutEffect(() => {
    dragRef.current = null;
    setDragging(false);
    if (!open) return undefined;
    movePanel(initialPanelPosition());
    const keepPanelVisible = () => movePanel(positionRef.current);
    const observer = new ResizeObserver(keepPanelVisible);
    observer.observe(viewportRef.current);
    observer.observe(panelRef.current);
    return () => {
      observer.disconnect();
      dragRef.current = null;
    };
  }, [movePanel, open, viewportRef]);

  const finishDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  if (!control) return null;
  const pose = control.pose;
  const activeLockMode = control.lockMode || null;
  const bodyLocked = activeLockMode === 'body';
  const mapLocked = activeLockMode === 'map';
  const locked = bodyLocked || mapLocked;
  const locks = lockModes || control.lockModes || { left: null, right: null };
  const updatePosition = (axis, value) => {
    onPoseChange({
      ...pose,
      position: { ...pose.position, [axis]: value },
    });
  };
  const updateRotation = (axis, value) => {
    onPoseChange({
      ...pose,
      rpy: { ...pose.rpy, [axis]: value },
    });
  };

  return (
    <section
      ref={panelRef}
      className={`end-effector-panel is-draggable ${dragging ? 'is-dragging' : ''} is-${control.status || 'tracking'} ${bodyLocked ? 'is-body-locked is-locked' : ''} ${mapLocked ? 'is-map-locked is-locked' : ''}`}
      style={{ left: position.x, top: position.y, right: 'auto' }}
      aria-label="机械臂末端空间球"
      data-end-effector-side={control.side}
      data-transform-mode={control.mode}
      data-ik-status={control.status}
      data-end-effector-locked={locked}
      data-end-effector-lock-mode={activeLockMode || 'free'}
      data-left-end-effector-locked={Boolean(locks.left)}
      data-right-end-effector-locked={Boolean(locks.right)}
      data-left-end-effector-lock-mode={locks.left || 'free'}
      data-right-end-effector-lock-mode={locks.right || 'free'}
      data-position-error={control.positionError || 0}
      data-rotation-error={control.rotationError || 0}
    >
      <header
        className="end-effector-panel__header"
        role="group"
        tabIndex={0}
        aria-label="移动机械臂末端面板"
        title="拖动移动面板 · 方向键微调 · 双击回到左上角"
        onDoubleClick={(event) => {
          if (!event.target.closest('button')) movePanel(initialPanelPosition());
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const delta = {
            ArrowLeft: [-10, 0], ArrowRight: [10, 0],
            ArrowUp: [0, -10], ArrowDown: [0, 10],
          }[event.key];
          if (!delta && event.key !== 'Home') return;
          event.preventDefault();
          event.stopPropagation();
          movePanel(delta
            ? { x: positionRef.current.x + delta[0], y: positionRef.current.y + delta[1] }
            : initialPanelPosition());
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || event.target.closest('button')) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            origin: positionRef.current,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          movePanel({
            x: drag.origin.x + event.clientX - drag.clientX,
            y: drag.origin.y + event.clientY - drag.clientY,
          });
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <div className="space-ball-emblem" aria-hidden="true">
          <span /><i /><b />
          <Orbit size={17} />
        </div>
        <div>
          <small>6D SPACE BALL · MAP FRAME</small>
          <strong>{sideLabel[control.side]}末端</strong>
        </div>
        <GripHorizontal size={14} className="end-effector-panel__drag-grip" aria-hidden="true" />
        <button type="button" aria-label="退出机械臂末端控制" title="保留当前姿态并退出末端控制" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <div className="end-effector-panel__status">
        <span>
          {bodyLocked ? <Lock size={12} /> : mapLocked ? <Globe2 size={12} /> : <CheckCircle2 size={12} />}
          {bodyLocked
            ? '本体姿态已锁定'
            : mapLocked
              ? `全局姿态 · IK ${control.status === 'limited' ? '受限' : '跟踪'}`
              : `IK ${control.status === 'limited' ? '受限' : '跟踪'}`}
        </span>
        {bodyLocked ? (
          <em className="end-effector-panel__hold-copy">BODY HOLD · JOINTS FROZEN</em>
        ) : (
          <>
            <em>ΔP {(control.positionError || 0).toFixed(4)} m</em>
            <em>ΔR {(control.rotationError || 0).toFixed(2)}°</em>
          </>
        )}
      </div>

      <div className="end-effector-lock-state" aria-label="双臂末端锁定状态">
        {['left', 'right'].map((side) => (
          <span
            key={side}
            className={`${locks[side] ? `is-locked is-${locks[side]}-locked` : ''} ${control.side === side ? 'is-current' : ''}`}
            data-lock-side={side}
            data-lock-mode={locks[side] || 'free'}
          >
            <i>{side === 'left' ? 'L' : 'R'}</i>
            {sideShortLabel[side]}
            <b>
              {locks[side] === 'body'
                ? <><Lock size={9} /> BODY</>
                : locks[side] === 'map'
                  ? <><Globe2 size={9} /> MAP</>
                  : 'FREE'}
            </b>
          </span>
        ))}
      </div>

      <div className="space-ball-mode" role="group" aria-label="空间球控制模式">
        <button
          type="button"
          className={control.mode === 'translate' ? 'is-active' : ''}
          aria-pressed={control.mode === 'translate'}
          disabled={locked}
          onClick={() => onModeChange('translate')}
        >
          <Move3D size={13} /> XYZ 位移
        </button>
        <button
          type="button"
          className={control.mode === 'rotate' ? 'is-active' : ''}
          aria-pressed={control.mode === 'rotate'}
          disabled={locked}
          onClick={() => onModeChange('rotate')}
        >
          <Rotate3D size={13} /> RPY 旋转
        </button>
      </div>

      <div className={`space-ball-fields ${control.mode === 'translate' ? 'is-primary' : ''}`}>
        <div className="space-ball-fields__heading"><Crosshair size={11} /> POSITION</div>
        <div className="space-ball-fields__grid">
          <PoseField axis="X" label="X (m)" value={pose.position.x} unit="m" step="0.005" tone="x" disabled={locked} onCommit={(value) => updatePosition('x', value)} />
          <PoseField axis="Y" label="Y (m)" value={pose.position.y} unit="m" step="0.005" tone="y" disabled={locked} onCommit={(value) => updatePosition('y', value)} />
          <PoseField axis="Z" label="Z (m)" value={pose.position.z} unit="m" step="0.005" tone="z" disabled={locked} onCommit={(value) => updatePosition('z', value)} />
        </div>
      </div>

      <div className={`space-ball-fields ${control.mode === 'rotate' ? 'is-primary' : ''}`}>
        <div className="space-ball-fields__heading"><Rotate3D size={11} /> ORIENTATION</div>
        <div className="space-ball-fields__grid">
          <PoseField axis="R" label="ROLL (°)" value={pose.rpy.roll} unit="°" step="0.5" tone="x" disabled={locked} onCommit={(value) => updateRotation('roll', value)} />
          <PoseField axis="P" label="PITCH (°)" value={pose.rpy.pitch} unit="°" step="0.5" tone="y" disabled={locked} onCommit={(value) => updateRotation('pitch', value)} />
          <PoseField axis="Y" label="YAW (°)" value={pose.rpy.yaw} unit="°" step="0.5" tone="z" disabled={locked} onCommit={(value) => updateRotation('yaw', value)} />
        </div>
      </div>

      <footer className="end-effector-panel__footer">
        <span>
          {bodyLocked
            ? '本体锁定：关节角保持不变 · Esc 取消调整'
            : mapLocked
              ? '全局锁定：地图 XYZ / RPY 保持不变 · Esc 取消调整'
              : 'Ctrl+Z 撤销拖拽 · Esc 取消本次调整'}
        </span>
        <div className="end-effector-panel__actions">
          <button type="button" disabled={locked || control.dragging} onClick={onReset}>
            <RotateCcw size={11} /> 关节归零
          </button>
          <button
            type="button"
            className={`end-effector-lock-button is-body ${bodyLocked ? 'is-active' : ''}`}
            aria-label={`${bodyLocked ? '解除本体姿态锁定' : '锁定本体姿态'}${sideLabel[control.side]}末端`}
            aria-pressed={bodyLocked}
            disabled={control.dragging}
            title={
              bodyLocked
                ? '解除机器人本体坐标系下的关节姿态锁定'
                : '冻结当前臂与共享关节；机器人移动时末端跟随本体'
            }
            onClick={onToggleBodyLock}
          >
            {bodyLocked ? <Unlock size={11} /> : <Lock size={11} />}
            {bodyLocked ? '解除本体' : '本体锁定'}
          </button>
          <button
            type="button"
            className={`end-effector-lock-button is-map ${mapLocked ? 'is-active' : ''}`}
            aria-label={`${mapLocked ? '解除全局姿态锁定' : '锁定全局姿态'}${sideLabel[control.side]}末端`}
            aria-pressed={mapLocked}
            disabled={control.dragging}
            title={
              mapLocked
                ? '解除地图坐标系下的绝对末端姿态锁定'
                : '固定地图坐标系下的末端 XYZ/RPY；底盘移动时整条关节链持续补偿'
            }
            onClick={onToggleMapLock}
          >
            {mapLocked ? <Unlock size={11} /> : <Globe2 size={11} />}
            {mapLocked ? '解除全局' : '全局锁定'}
          </button>
        </div>
      </footer>
    </section>
  );
}
