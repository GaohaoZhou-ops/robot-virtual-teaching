import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { WorkbenchMenuContext } from './WorkbenchMenuContext.js';
import './WorkbenchToolbar.css';

export default function WorkbenchToolbar({ sections, isActive = true, children }) {
  const menuId = useId();
  const toolbarRef = useRef(null);
  const triggersRef = useRef(new Map());
  const panelsRef = useRef(new Map());
  const focusEdgeRef = useRef('first');
  const [openId, setOpenId] = useState(null);
  const [submenuId, setSubmenuId] = useState(null);
  const [position, setPosition] = useState({});

  const close = (restoreFocus = false) => {
    if (restoreFocus) triggersRef.current.get(openId)?.focus();
    setOpenId(null);
    setSubmenuId(null);
  };
  const open = (id, edge = 'first') => {
    focusEdgeRef.current = edge;
    setSubmenuId(null);
    setOpenId(id);
  };
  const moveSection = (id, direction, focusMenu) => {
    const index = sections.findIndex((section) => section.id === id);
    const next = sections[(index + direction + sections.length) % sections.length];
    triggersRef.current.get(next.id)?.focus();
    if (focusMenu) open(next.id);
  };

  useEffect(() => {
    if (!isActive) setOpenId(null);
  }, [isActive]);

  useLayoutEffect(() => {
    if (!openId || !isActive) return undefined;
    const trigger = triggersRef.current.get(openId);
    const panel = panelsRef.current.get(openId);
    if (!trigger || !panel) return undefined;
    const updatePosition = () => {
      const bounds = trigger.getBoundingClientRect();
      const padding = 10;
      const top = bounds.bottom + 8;
      setPosition({
        left: Math.max(padding, Math.min(bounds.left, window.innerWidth - panel.offsetWidth - padding)),
        top,
        maxHeight: Math.max(0, window.innerHeight - top - padding),
      });
    };
    updatePosition();
    const frame = requestAnimationFrame(() => {
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
      (focusEdgeRef.current === 'last' ? buttons.at(-1) : buttons[0])?.focus();
    });
    const observer = new ResizeObserver(updatePosition);
    observer.observe(trigger);
    observer.observe(panel);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [openId, isActive]);

  useEffect(() => {
    if (!openId) return undefined;
    const outside = (event) => {
      const owner = event.target.closest('[data-workbench-menu-owner]')?.dataset.workbenchMenuOwner;
      if (!toolbarRef.current?.contains(event.target)
        && !panelsRef.current.get(openId)?.contains(event.target)
        && owner !== panelsRef.current.get(openId)?.id) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [openId]);

  const onPanelKeyDown = (event, id) => {
    const panel = panelsRef.current.get(id);
    // Child device dialogs use portals and handle their own keyboard input.
    if (!panel?.contains(event.target)) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(true);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveSection(id, event.key === 'ArrowLeft' ? -1 : 1, true);
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  return (
    <nav className="topbar-actions workbench-toolbar" aria-label="工作台工具栏" ref={toolbarRef}>
      <div className="workbench-toolbar__menus">
        {sections.map(({ id, label, icon: Icon, triggerRef, busy }) => (
          <button
            key={id}
            ref={(element) => {
              if (element) triggersRef.current.set(id, element);
              else triggersRef.current.delete(id);
              if (triggerRef) triggerRef.current = element;
            }}
            type="button"
            className="workbench-menu-trigger"
            data-workbench-menu-trigger={id}
            aria-label={`${label}菜单`}
            aria-haspopup="dialog"
            aria-expanded={isActive && openId === id}
            aria-controls={`${menuId}-${id}`}
            aria-busy={busy || undefined}
            onClick={() => openId === id ? close() : open(id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                open(id, event.key === 'ArrowUp' ? 'last' : 'first');
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                event.stopPropagation();
                moveSection(id, event.key === 'ArrowLeft' ? -1 : 1, Boolean(openId));
              } else if (event.key === 'Escape') close(true);
            }}
          >
            {busy ? <LoaderCircle size={15} className="is-spinning" /> : <Icon size={15} />}
            <span>{label}</span>
            <ChevronDown size={12} className="workbench-menu-trigger__chevron" />
          </button>
        ))}
      </div>
      {children}
      {/* Keep device controllers mounted so closing a menu preserves connections. */}
      {sections.map(({ id, label, content }) => createPortal(
        <div
          key={id}
          id={`${menuId}-${id}`}
          ref={(element) => {
            if (element) panelsRef.current.set(id, element);
            else panelsRef.current.delete(id);
          }}
          className="workbench-menu-panel"
          data-workbench-menu={id}
          role="dialog"
          aria-label={`${label}菜单`}
          hidden={!isActive || openId !== id}
          style={position}
          onKeyDown={(event) => onPanelKeyDown(event, id)}
          onPointerMove={(event) => {
            const button = event.target.closest('button');
            if (event.pointerType === 'mouse' && button && event.currentTarget.contains(button)
              && !button.hasAttribute('data-workbench-submenu-trigger')) setSubmenuId(null);
          }}
          onClickCapture={(event) => {
            const button = event.target.closest('button');
            if (button && !button.disabled && event.currentTarget.contains(button)
              && !button.hasAttribute('data-workbench-submenu-trigger')) close(true);
          }}
        >
          <WorkbenchMenuContext.Provider value={{ isOpen: isActive && openId === id,
            ownerId: `${menuId}-${id}`, submenuId, setSubmenuId, close }}>
            {content}
          </WorkbenchMenuContext.Provider>
        </div>, document.body, id,
      ))}
    </nav>
  );
}
