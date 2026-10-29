import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Check,
  ChevronDown,
  FileBox,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { fetchRobotCatalog } from "../model/robotLoader.js";

const statusLabel = {
  idle: '选择模型',
  pending: '等待地图',
  loading: '正在装配',
  loaded: '原点就绪',
  error: '加载失败',
};

export default function RobotPicker({ selectedRobot, loadState, onSelect, showRobot = true, onShowRobotChange, visibilityDisabled = false, menuAnchorRef, menuLabel, isActive = true, inline = false, disabled = false }) {
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const [catalog, setCatalog] = useState([]);
  const [catalogState, setCatalogState] = useState('idle');
  const [catalogError, setCatalogError] = useState('');
  const requestRevisionRef = useRef(0);
  const catalogRequestRef = useRef(null);

  const refreshCatalog = () => {
    const revision = ++requestRevisionRef.current;
    catalogRequestRef.current?.abort();
    const controller = new AbortController();
    catalogRequestRef.current = controller;
    setCatalogState('loading');
    setCatalogError('');
    fetchRobotCatalog(controller.signal)
      .then((robots) => {
        if (requestRevisionRef.current !== revision) return;
        setCatalog(robots);
        setCatalogState('ready');
      })
      .catch((error) => {
        if (requestRevisionRef.current !== revision || error.name === 'AbortError') return;
        setCatalogError(error.message || '无法读取 robots 目录');
        setCatalogState('error');
      });
  };

  useEffect(() => {
    if (!isActive || disabled) setOpen(false);
  }, [isActive, disabled]);

  useEffect(() => {
    if (!open) return undefined;
    if (catalogState !== 'ready') refreshCatalog();
    return () => {
      requestRevisionRef.current += 1;
      catalogRequestRef.current?.abort();
      catalogRequestRef.current = null;
      setCatalogState((current) => current === 'loading' ? 'idle' : current);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (
        !rootRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)
      ) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        menuAnchorRef?.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || inline) return undefined;

    const updateMenuPosition = () => {
      const trigger = (menuAnchorRef?.current || rootRef.current)?.getBoundingClientRect();
      if (!trigger) return;
      const menuWidth = menuRef.current?.offsetWidth || 342;
      const viewportPadding = 8;
      const left = Math.min(
        Math.max(viewportPadding, trigger.right - menuWidth),
        window.innerWidth - menuWidth - viewportPadding,
      );
      setMenuPosition({
        left: Math.max(viewportPadding, left),
        top: trigger.bottom + 8,
        maxHeight: Math.max(0, window.innerHeight - trigger.bottom - 16),
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open, menuAnchorRef, inline]);

  const currentStatus = loadState?.status || (selectedRobot ? 'pending' : 'idle');
  const StatusIcon = currentStatus === 'loading'
    ? LoaderCircle
    : currentStatus === 'error'
      ? TriangleAlert
      : selectedRobot ? Check : Bot;

  return (
    <div
      className={`robot-picker is-${currentStatus}`}
      ref={rootRef}
      data-robot-picker-state={currentStatus}
      data-selected-robot={selectedRobot?.id || ''}
      onKeyDown={(event) => {
        if (inline && open && event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setOpen(false);
          rootRef.current?.querySelector('.robot-picker__trigger')?.focus();
        }
      }}
    >
      <button
        type="button"
        className={`action-button robot-picker__trigger ${selectedRobot ? 'has-model' : ''}`}
        aria-label="加载机器人"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={selectedRobot ? `${selectedRobot.name} · 位于地图原点` : '从 robots 目录选择机器人模型'}
        onClick={() => setOpen((current) => !current)}
      >
        <StatusIcon className={currentStatus === 'loading' ? 'is-spinning' : ''} size={15} />
        <span>{menuLabel || (selectedRobot ? selectedRobot.name : '加载机器人')}
          {menuLabel && selectedRobot && <small>{selectedRobot.name}</small>}
        </span>
        <i>{statusLabel[currentStatus] || statusLabel.idle}</i>
        <ChevronDown size={12} />
      </button>

      {open && isActive && createPortal(
        <div
          className="robot-picker__menu"
          ref={menuRef}
          role="dialog"
          aria-label="robots 目录模型"
          style={inline ? { position: 'static', width: '100%', maxHeight: 320 } : menuPosition}
        >
          <div className="robot-picker__heading">
            <div>
              <small>ROBOT LIBRARY</small>
              <strong>选择机器人模型</strong>
            </div>
            <button type="button" aria-label="刷新机器人列表" onClick={refreshCatalog}>
              <RefreshCw className={catalogState === 'loading' ? 'is-spinning' : ''} size={13} />
            </button>
          </div>

          {onShowRobotChange && <div className="robot-picker__visibility">
            <button type="button" className="robot-visibility-switch" role="switch"
              aria-label="显示机器人" aria-checked={showRobot}
              disabled={visibilityDisabled || !selectedRobot || currentStatus !== 'loaded'}
              title={showRobot ? '隐藏机器人模型' : '显示机器人模型'}
              onClick={() => onShowRobotChange?.(!showRobot)}>
              <span>显示机器人</span><span className="robot-visibility-switch__track" aria-hidden="true" />
            </button>
          </div>}

          <div className="robot-picker__list" role="listbox" aria-label="可用机器人模型">
            {catalogState === 'loading' && !catalog.length && (
              <div className="robot-picker__message">
                <LoaderCircle className="is-spinning" size={17} />
                <span>正在扫描 robots 目录…</span>
              </div>
            )}
            {catalogState === 'error' && (
              <div className="robot-picker__message is-error">
                <TriangleAlert size={17} />
                <span>{catalogError}</span>
              </div>
            )}
            {catalogState === 'ready' && !catalog.length && (
              <div className="robot-picker__message">
                <FileBox size={17} />
                <span>robots 目录中没有可加载的 URDF / GLB / STL</span>
              </div>
            )}
            {catalog.map((robot) => {
              const selected = selectedRobot?.id === robot.id;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`加载机器人 ${robot.name}`}
                  className={`robot-picker__option ${selected ? 'is-selected' : ''}`}
                  key={robot.id}
                  onClick={() => {
                    onSelect(robot);
                    setOpen(false);
                    (menuAnchorRef?.current || rootRef.current?.querySelector('.robot-picker__trigger'))?.focus();
                  }}
                >
                  <span className="robot-picker__model-icon"><Bot size={16} /></span>
                  <span className="robot-picker__model-copy">
                    <strong>{robot.name}</strong>
                    <small title={robot.relativePath}>{robot.relativePath}</small>
                  </span>
                  <em>{robot.format.toUpperCase()}</em>
                  {selected && <Check size={13} />}
                </button>
              );
            })}
          </div>

          <div className="robot-picker__footer">
            <span>初始位姿</span>
            <strong>XYZ 0 / 0 / 0 · RPY 0 / 0 / 0</strong>
          </div>
        </div>,
        inline ? rootRef.current : document.body,
      )}
    </div>
  );
}
