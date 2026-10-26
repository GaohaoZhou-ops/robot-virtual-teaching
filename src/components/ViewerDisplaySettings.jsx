import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';

export default function ViewerDisplaySettings({ sections, expanded, onExpandedChange }) {
  const id = useId();
  const headings = useRef({});
  const submenuRef = useRef(null);
  const focusFrameRef = useRef(null);
  const [position, setPosition] = useState({});
  const section = sections.find(item => item.id === expanded);
  const active = section?.id || null;
  const Icon = section?.icon;

  useEffect(() => () => cancelAnimationFrame(focusFrameRef.current), []);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const heading = headings.current[active];
    const parent = heading?.closest('.viewer-menu__panel');
    const submenu = submenuRef.current;
    if (!heading || !parent || !submenu) return undefined;
    const updatePosition = () => {
      const root = parent.getBoundingClientRect();
      const trigger = heading.getBoundingClientRect();
      const padding = 8, gap = 4, width = submenu.offsetWidth;
      const side = root.right + gap + width <= window.innerWidth - padding ? 'right'
        : root.left - gap - width >= padding ? 'left' : 'below';
      const left = Math.max(padding, Math.min(
        side === 'right' ? root.right + gap : side === 'left' ? root.left - width - gap : root.left,
        window.innerWidth - width - padding,
      ));
      const top = Math.max(padding, Math.min(
        side === 'below' ? trigger.bottom + gap : trigger.top - submenu.clientTop - 5,
        window.innerHeight - Math.min(submenu.scrollHeight, window.innerHeight - padding * 2) - padding,
      ));
      const next = { left, top, maxHeight: Math.max(0, window.innerHeight - top - padding), side };
      setPosition(previous => Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    [heading, parent, submenu].forEach(element => observer.observe(element));
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [active]);

  const openSection = (key, focusChild = false) => {
    cancelAnimationFrame(focusFrameRef.current);
    // Move focus before hiding the previous controls so the parent popup's
    // blur handler does not mistake a category change for leaving the menu.
    if (active !== key && submenuRef.current?.contains(document.activeElement)) headings.current[key]?.focus();
    onExpandedChange(key);
    if (focusChild) focusFrameRef.current = requestAnimationFrame(() => {
      const content = submenuRef.current?.querySelector('.viewer-display-section__content:not([hidden])');
      const controls = [...(content?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || [])];
      (controls.find(element => element.getClientRects().length) || submenuRef.current)?.focus();
    });
  };
  const closeSection = () => {
    cancelAnimationFrame(focusFrameRef.current);
    headings.current[active]?.focus();
    onExpandedChange(null);
  };

  return (
    <div className="viewer-display-sections">
      {sections.map(({ id: key, label, icon: SectionIcon, description }, index) => {
        const open = active === key;
        return (
          <section key={key} className="viewer-display-section" data-expanded={open}>
            <button type="button" className="viewer-display-section__heading"
              ref={element => { headings.current[key] = element; }}
              id={`${id}-${key}-heading`} aria-label={label}
              aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? `${id}-submenu` : undefined}
              data-submenu-side={open ? position.side : undefined}
              onPointerMove={event => { if (event.pointerType === 'mouse' && !open) openSection(key); }}
              onClick={() => openSection(key, true)}
              onKeyDown={event => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault();
                  if (event.key === 'ArrowRight') openSection(key, true);
                  else closeSection();
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length;
                  headings.current[sections[next].id]?.focus();
                }
              }}>
              <SectionIcon size={15} aria-hidden="true" />
              <span><strong>{label}</strong><small>{description}</small></span>
              <ChevronRight size={13} className="viewer-display-section__chevron" aria-hidden="true" />
            </button>
          </section>
        );
      })}
      <div ref={submenuRef} id={`${id}-submenu`} className="viewer-display-submenu" hidden={!section}
        role="dialog" aria-label={section ? `${section.label}设置` : undefined} tabIndex={-1}
        data-side={position.side} style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
        onKeyDown={event => {
          // Form controls keep their native arrow-key behavior (notably sliders).
          if (event.key === 'Escape' || (event.key === 'ArrowLeft' && !event.target.closest('input, select, textarea'))) {
            event.preventDefault(); event.stopPropagation(); closeSection();
          }
        }}>
        <header className="viewer-display-submenu__heading">
          <strong>{Icon && <Icon size={14} aria-hidden="true" />}{section?.label}</strong>
          <button type="button" aria-label="返回显示设置分类" onClick={closeSection}><X size={13} /></button>
        </header>
        {sections.map(item => <div key={item.id} className="viewer-display-section__content" role="group"
          aria-labelledby={`${id}-${item.id}-heading`} hidden={active !== item.id}>{item.content}</div>)}
      </div>
    </div>
  );
}
