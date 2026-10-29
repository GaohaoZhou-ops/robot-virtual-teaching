import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  GripHorizontal,
  Minus,
  MoveDiagonal,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import RobotJointPanel from "./RobotJointPanel.jsx";

const WINDOW_WIDTH = 520;
const TEACHING_POSE_WINDOW_WIDTH = 440;
const WINDOW_EDGE = 10;
const WINDOW_TOP = 82;
const WINDOW_TITLE_HEIGHT = 52;
const RESIZE_HANDLES = [
  { axis: 'width', label: '调整全关节窗口宽度' },
  { axis: 'height', label: '调整全关节窗口高度' },
  { axis: 'both', label: '调整全关节窗口宽高' },
];

const defaultWindowPosition = () => {
  if (typeof window === 'undefined') return { x: 24, y: WINDOW_TOP };
  return {
    x: 18,
    y: Math.min(WINDOW_TOP, Math.max(WINDOW_EDGE, window.innerHeight - WINDOW_TITLE_HEIGHT)),
  };
};

const jointCountFor = (robotLoadState, jointValues) => {
  const names = new Set();
  (robotLoadState?.movableJoints || []).forEach((joint) => {
    if (joint?.name) names.add(joint.name);
  });
  Object.keys(jointValues || {}).forEach((name) => names.add(name));
  return names.size;
};

export default function FloatingRobotJointPanel({
  open,
  onClose,
  robot,
  robotLoadState,
  jointValues,
  teachingPoseEditing = false,
  ...jointPanelProps
}) {
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [sizes, setSizes] = useState({});
  const [position, setPosition] = useState(defaultWindowPosition);
  const windowRef = useRef(null);
  const positionRef = useRef(position);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const sizeKey = teachingPoseEditing ? 'teaching' : 'normal';
  const size = sizes[sizeKey];
  const jointCount = useMemo(
    () => jointCountFor(robotLoadState, jointValues),
    [jointValues, robotLoadState],
  );
  const robotReady = Boolean(robot) && robotLoadState?.status === 'loaded';

  positionRef.current = position;

  const clampPosition = useCallback((candidate) => {
    const bounds = windowRef.current?.getBoundingClientRect();
    const fallbackWidth = teachingPoseEditing ? TEACHING_POSE_WINDOW_WIDTH : WINDOW_WIDTH;
    const width = Math.min(bounds?.width || fallbackWidth, window.innerWidth - WINDOW_EDGE * 2);
    const height = Math.min(
      bounds?.height || WINDOW_TITLE_HEIGHT,
      window.innerHeight - WINDOW_EDGE * 2,
    );
    const maxX = Math.max(WINDOW_EDGE, window.innerWidth - width - WINDOW_EDGE);
    const maxY = Math.max(WINDOW_EDGE, window.innerHeight - height - WINDOW_EDGE);
    return {
      x: Math.min(maxX, Math.max(WINDOW_EDGE, Number(candidate?.x) || 0)),
      y: Math.min(maxY, Math.max(WINDOW_EDGE, Number(candidate?.y) || 0)),
    };
  }, [teachingPoseEditing]);

  const resetPosition = useCallback(() => {
    const nextPosition = clampPosition(defaultWindowPosition());
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, [clampPosition]);

  useEffect(() => {
    resizeRef.current = null;
    setResizing(false);
  }, [open, minimized, teachingPoseEditing]);

  useEffect(() => {
    if (!teachingPoseEditing) return;
    setMinimized(false);
    const width = windowRef.current?.getBoundingClientRect().width || TEACHING_POSE_WINDOW_WIDTH;
    const nextPosition = clampPosition({
      x: window.innerWidth - width - WINDOW_EDGE,
      y: WINDOW_TOP,
    });
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, [clampPosition, teachingPoseEditing]);

  useEffect(() => {
    if (!open) {
      dragRef.current = null;
      setDragging(false);
      setMinimized(false);
      return undefined;
    }
    const keepWindowVisible = () => {
      setPosition((current) => {
        const next = clampPosition(current);
        positionRef.current = next;
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    keepWindowVisible();
    const resizeObserver = new ResizeObserver(keepWindowVisible);
    if (windowRef.current) resizeObserver.observe(windowRef.current);
    window.addEventListener('resize', keepWindowVisible);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', keepWindowVisible);
    };
  }, [clampPosition, open]);

  if (!open) return null;

  const finishDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const resizeWindow = (candidate) => {
    const maxWidth = Math.max(1, window.innerWidth - positionRef.current.x - WINDOW_EDGE);
    const maxHeight = Math.max(1, window.innerHeight - positionRef.current.y - WINDOW_EDGE);
    const next = {
      width: Math.min(maxWidth, Math.max(Math.min(420, maxWidth), candidate.width)),
      height: Math.min(maxHeight, Math.max(Math.min(robotReady ? 340 : 180, maxHeight), candidate.height)),
    };
    setSizes((current) => ({ ...current, [sizeKey]: next }));
  };

  const finishResize = (event) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  };

  return createPortal(
    <aside
      ref={windowRef}
      className={`joint-float-window ${robotReady ? 'is-ready' : 'is-waiting'} ${teachingPoseEditing ? 'is-teaching-pose-edit' : ''} ${minimized ? 'is-minimized' : ''} ${dragging ? 'is-dragging' : ''} ${resizing ? 'is-resizing' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="全关节控制浮动窗口"
      data-floating-window="robot-joints"
      data-window-state={minimized ? 'minimized' : 'open'}
      data-window-x={position.x.toFixed(1)}
      data-window-y={position.y.toFixed(1)}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, ...size }}
    >
      <header
        className="joint-float-window__titlebar"
        title="拖动移动浮窗 · 双击恢复默认位置"
        onDoubleClick={(event) => {
          if (!event.target.closest('button')) resetPosition();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target.closest('button')) return;
          event.preventDefault();
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
          const next = clampPosition({
            x: drag.origin.x + event.clientX - drag.clientX,
            y: drag.origin.y + event.clientY - drag.clientY,
          });
          positionRef.current = next;
          setPosition(next);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <div className="joint-float-window__grip" aria-hidden="true">
          <GripHorizontal size={15} />
        </div>
        <div className="joint-float-window__identity">
          <span><SlidersHorizontal size={13} /></span>
          <div>
            <small>FLOATING JOINT DIRECTOR</small>
            <strong>全关节控制</strong>
          </div>
        </div>
        <div className={`joint-float-window__status ${robotReady ? 'is-ready' : ''}`}>
          <i /> {robotReady ? `${jointCount} DOF` : 'WAIT'}
        </div>
        <div className="joint-float-window__actions">
          <button
            type="button"
            aria-label={minimized ? '展开全关节浮动窗口' : '最小化全关节浮动窗口'}
            title={minimized ? '展开浮窗' : '最小化浮窗'}
            onClick={() => setMinimized((current) => !current)}
          >
            {minimized ? <SlidersHorizontal size={12} /> : <Minus size={13} />}
          </button>
          <button
            type="button"
            aria-label="关闭全关节浮动窗口"
            title="关闭浮窗"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
      </header>

      <div className="joint-float-window__body" hidden={minimized}>
        <RobotJointPanel
          robot={robot}
          robotLoadState={robotLoadState}
          jointValues={jointValues}
          {...jointPanelProps}
        />
      </div>
      {!minimized && RESIZE_HANDLES.map(({ axis, label }) => <button
        key={axis}
        type="button"
        className={`joint-float-window__resize joint-float-window__resize--${axis}`}
        aria-label={label}
        title={`${label} · 拖动或使用方向键，Shift 加快调整`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = windowRef.current.getBoundingClientRect();
          resizeRef.current = {
            pointerId: event.pointerId, axis,
            clientX: event.clientX, clientY: event.clientY,
            width: bounds.width, height: bounds.height,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const resize = resizeRef.current;
          if (!resize || resize.pointerId !== event.pointerId) return;
          event.stopPropagation();
          resizeWindow({
            width: resize.width + (resize.axis === 'height' ? 0 : event.clientX - resize.clientX),
            height: resize.height + (resize.axis === 'width' ? 0 : event.clientY - resize.clientY),
          });
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = windowRef.current.getBoundingClientRect();
          const step = event.shiftKey ? 40 : 10;
          resizeWindow({
            width: bounds.width + (axis === 'height' ? 0 : event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            height: bounds.height + (axis === 'width' ? 0 : event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
          });
        }}
      >{axis === 'both' && <MoveDiagonal size={16} aria-hidden="true" />}</button>)}
    </aside>,
    document.body,
  );
}
