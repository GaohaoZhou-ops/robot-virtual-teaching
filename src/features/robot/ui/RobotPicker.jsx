import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  FileBox,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { fetchRobotCatalog } from "../model/robotLoader.js";
import { WorkbenchMenuContext } from "../../../shared/ui/WorkbenchMenuContext.js";

const statusLabel = {
  idle: '选择模型',
  pending: '等待地图',
  loading: '正在装配',
  loaded: '原点就绪',
  error: '加载失败',
};

export default function RobotPicker({ selectedRobot, loadState, onSelect, showRobot = true, onShowRobotChange, robotOpacity = 1, onRobotOpacityChange, visibilityDisabled = false, robotPose, coordinateFrame = 'map', onFindRobot, menuAnchorRef, menuLabel, isActive = true, inline = false, disabled = false }) {
  const menuId = useId();
  const menuContext = useContext(WorkbenchMenuContext);
  const parentMenu = inline ? null : menuContext;
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const focusFirstRef = useRef(false);
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const open = parentMenu ? parentMenu.isOpen && parentMenu.submenuId === menuId : standaloneOpen;
  const setOpen = (value) => {
    if (parentMenu) parentMenu.setSubmenuId(value ? menuId : (current) => current === menuId ? null : current);
    else setStandaloneOpen(value);
  };
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const [catalog, setCatalog] = useState([]);
  const [catalogState, setCatalogState] = useState('idle');
  const [catalogError, setCatalogError] = useState('');
  const requestRevisionRef = useRef(0);
  const catalogRequestRef = useRef(null);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) (parentMenu ? triggerRef.current : menuAnchorRef?.current || triggerRef.current)?.focus();
  };
  const showMenu = (focusFirst = false) => {
    focusFirstRef.current = focusFirst;
    setOpen(true);
    if (open) {
      (focusFirst ? menuRef.current?.querySelector('button:not(:disabled)') : menuRef.current)?.focus();
      focusFirstRef.current = false;
    }
  };
  const run = (action) => {
    close(!parentMenu);
    parentMenu?.close(true);
    action();
  };

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
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    if (!parentMenu) window.addEventListener('keydown', onKeyDown);
    if (parentMenu || focusFirstRef.current) {
      (focusFirstRef.current ? menuRef.current?.querySelector('button:not(:disabled)') : menuRef.current)?.focus();
    }
    focusFirstRef.current = false;
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || inline) return undefined;

    const updateMenuPosition = () => {
      const trigger = (parentMenu ? triggerRef.current : menuAnchorRef?.current || triggerRef.current)?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const menuWidth = menu.offsetWidth;
      const padding = 8, gap = parentMenu ? 4 : 8;
      const root = triggerRef.current?.closest('.workbench-menu-panel')?.getBoundingClientRect();
      const side = parentMenu && root
        ? root.right + gap + menuWidth <= window.innerWidth - padding ? 'right'
          : root.left - gap - menuWidth >= padding ? 'left' : 'below'
        : 'below';
      const left = side === 'right' ? root.right + gap : side === 'left' ? root.left - gap - menuWidth : trigger.right - menuWidth;
      const top = side === 'below' ? trigger.bottom + gap : trigger.top - menu.clientTop - 5;
      setMenuPosition({
        left: Math.max(padding, Math.min(left, window.innerWidth - menuWidth - padding)),
        top: parentMenu ? Math.max(padding, Math.min(top, window.innerHeight - Math.min(menu.offsetHeight, window.innerHeight - padding * 2) - padding)) : top,
        maxHeight: Math.max(0, window.innerHeight - (parentMenu ? padding : top) - padding),
        side,
      });
    };

    updateMenuPosition();
    const observer = new ResizeObserver(updateMenuPosition);
    observer.observe(menuRef.current);
    observer.observe(triggerRef.current);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open, menuAnchorRef, inline, parentMenu?.ownerId]);

  const onMenuKeyDown = (event) => {
    event.stopPropagation();
    const controls = [...menuRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (parentMenu && event.key === 'Tab') {
      if (event.target === (event.shiftKey ? controls[0] : controls.at(-1))) {
        close();
        parentMenu.close(true);
      }
    } else if (event.target.closest('input')) {
      // Sliders own their arrows, Home and End instead of navigating the menu.
      return;
    } else if (parentMenu && event.key === 'ArrowLeft') {
      event.preventDefault();
      close(true);
    } else if (parentMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = controls.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
    }
  };

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
      onBlur={(event) => {
        if (parentMenu && !triggerRef.current?.contains(event.relatedTarget) && !menuRef.current?.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if ((inline || parentMenu) && open && event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); close(true);
        }
      }}
    >
      <button
        type="button"
        className={`action-button robot-picker__trigger ${selectedRobot ? 'has-model' : ''}`}
        ref={triggerRef}
        data-workbench-submenu-trigger={parentMenu ? menuId : undefined}
        data-submenu-side={open ? menuPosition.side : undefined}
        aria-label="加载机器人"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={selectedRobot ? `${selectedRobot.name} · 位于地图原点` : '从 robots 目录选择机器人模型'}
        onClick={() => { if (open && !parentMenu) close(); else showMenu(); }}
        onPointerMove={(event) => { if (parentMenu && isActive && !disabled && event.pointerType === 'mouse') setOpen(true); }}
        onKeyDown={(event) => {
          if (parentMenu && event.key === 'ArrowRight') {
            event.preventDefault(); event.stopPropagation(); showMenu(true);
          }
        }}
      >
        <StatusIcon className={currentStatus === 'loading' ? 'is-spinning' : ''} size={15} />
        <span>{menuLabel || (selectedRobot ? selectedRobot.name : '加载机器人')}
          {menuLabel && selectedRobot && <small>{selectedRobot.name}</small>}
        </span>
        <i>{statusLabel[currentStatus] || statusLabel.idle}</i>
        {parentMenu ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && isActive && createPortal(
        <div
          className="robot-picker__menu"
          id={menuId}
          ref={menuRef}
          role="dialog"
          aria-label="robots 目录模型"
          tabIndex={-1}
          data-workbench-menu-owner={parentMenu?.ownerId}
          data-side={menuPosition.side}
          style={inline ? { position: 'static', width: '100%', maxHeight: 320 }
            : { left: menuPosition.left, top: menuPosition.top, maxHeight: menuPosition.maxHeight }}
          onKeyDown={onMenuKeyDown}
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
            {onRobotOpacityChange && <label className="viewer-display-settings__opacity robot-picker__opacity">
              <span>机器人透明度</span>
              <input type="range" min="0" max="100" step="1" aria-label="机器人透明度"
                value={Math.round(robotOpacity * 100)} aria-valuetext={`${Math.round(robotOpacity * 100)}%`}
                title="100% 为完全不透明，调低可透过机器人观察表面"
                disabled={!isActive || disabled || visibilityDisabled || !selectedRobot || currentStatus !== 'loaded'}
                style={{ '--vision-coverage-opacity': `${Math.round(robotOpacity * 100)}%` }}
                onChange={(event) => onRobotOpacityChange(Math.max(0, Math.min(100, Number(event.target.value) || 0)) / 100)} />
              <output>{Math.round(robotOpacity * 100)}%</output>
            </label>}
          </div>}

          {onFindRobot && <section className="robot-picker__position" role="group" aria-label="机器人实时坐标"
            title={`机器人在 ${coordinateFrame.toUpperCase()} 坐标系中的实时 X/Y 位置（米）与 Yaw 朝向（度）`}>
            <div className="robot-picker__position-heading">
              <span>机器人定位</span><small>{coordinateFrame.toUpperCase()}</small>
            </div>
            <strong className="robot-picker__position-name" title={selectedRobot?.name}>
              {selectedRobot?.name || '尚未选择机器人模型'}
            </strong>
            <div className="robot-picker__coordinates">
              {['x', 'y', 'yaw'].map((axis) => {
                const value = axis === 'yaw' ? robotPose?.rpy?.yaw : robotPose?.position?.[axis];
                const precision = axis === 'yaw' ? 1 : 3;
                const scale = 10 ** precision;
                return <div key={axis} data-axis={axis}>
                  <span>{axis === 'yaw' ? 'Yaw' : axis.toUpperCase()}</span>
                  <div><b>{selectedRobot && currentStatus === 'loaded' && Number.isFinite(value)
                    ? (Math.round(value * scale) / scale).toFixed(precision) : '—'}</b>
                    <small>{axis === 'yaw' ? '°' : 'm'}</small></div>
                </div>;
              })}
            </div>
            <button type="button" className="robot-focus-button" aria-label="找到机器人"
              disabled={!isActive || disabled || currentStatus !== 'loaded' || visibilityDisabled}
              title={currentStatus === 'loading' ? '机器人模型加载中'
                : currentStatus !== 'loaded' ? '请先加载机器人'
                  : visibilityDisabled ? '正在记录姿态，请稍后定位'
                    : !showRobot ? '显示机器人并将其完整移入视野'
                      : '将当前机器人完整移入视野，保持机器人位置、姿态与控制模式'}
              onClick={() => run(onFindRobot)}>
              <Crosshair size={14} aria-hidden="true" /><span>找到机器人</span>
            </button>
          </section>}

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
                  onClick={() => run(() => onSelect(robot))}
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
