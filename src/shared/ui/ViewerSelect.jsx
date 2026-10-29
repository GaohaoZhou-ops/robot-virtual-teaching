import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import ViewerMenu from "./ViewerMenu.jsx";
import "./ViewerSelect.css";

// Use the same trigger, popup placement and dismissal as the viewport menus.
export default function ViewerSelect({ id, label, ariaLabel = label, icon, options, value, onChange,
  placeholder = '请选择', disabled = false, isActive = true }) {
  const descriptionId = useId();
  const root = useRef(null), list = useRef(null), search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false), [focused, setFocused] = useState(null);
  const selected = options.find(option => option.value === value);
  const available = isActive && !disabled && options.length > 0;
  const focusTrigger = () => {
    const trigger = root.current?.querySelector('.viewer-menu__trigger');
    trigger?.focus({ preventScroll: true });
    // Selecting a robot replaces its monitor. Restore focus to the new field
    // after that commit, without stealing focus from another user action.
    if (id && trigger) requestAnimationFrame(() => {
      if (!trigger.isConnected && document.activeElement === document.body) document.getElementById(id)?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (!open) return undefined;
    search.current = { text: '', time: 0 };
    // ViewerMenu first focuses its popup; then focus the current enabled option.
    const frame = requestAnimationFrame(() => {
      const option = list.current?.querySelector('[aria-selected="true"]:not(:disabled)')
        || list.current?.querySelector('button:not(:disabled)');
      option?.focus({ preventScroll: true }); option?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const navigate = (event) => {
    const items = [...(list.current?.querySelectorAll('button:not(:disabled)') || [])];
    if (!items.length || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const current = items.indexOf(document.activeElement);
    let target;
    if (event.key === 'ArrowDown') target = items[(current + 1) % items.length];
    else if (event.key === 'ArrowUp') target = items[(current - 1 + items.length) % items.length];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items.at(-1);
    else if (event.key.length === 1 && event.key !== ' ') {
      const now = performance.now(), letter = event.key.toLocaleLowerCase();
      const previous = now - search.current.time < 700 ? search.current.text : '';
      const text = previous === letter ? letter : previous + letter;
      search.current = { text, time: now };
      const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
      target = ordered.find(item => item.textContent.trim().toLocaleLowerCase().startsWith(text));
    } else return;
    event.preventDefault(); event.stopPropagation();
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
  };
  return <div ref={root} className="viewer-select" data-selected-value={value || ''}>
    <ViewerMenu label={label} panelLabel={label} triggerLabel={ariaLabel} icon={icon}
      title={selected?.label || placeholder} triggerClassName="viewer-select__trigger"
      triggerProps={{ id, disabled: !available, 'aria-describedby': descriptionId }}
      triggerContent={<span id={descriptionId}>{selected?.label || placeholder}</span>}
      open={open} onOpenChange={setOpen} isActive={available} panelClassName="viewer-select__panel">
      <div ref={list} className="viewer-select__options" role="listbox" aria-label={ariaLabel} onKeyDown={navigate}>
        {options.map(option => <button key={option.value} type="button" role="option"
          className="viewer-select__option" aria-selected={option.value === value}
          disabled={option.disabled} data-value={option.value} title={option.label}
          tabIndex={(focused ?? value ?? options.find(item => !item.disabled)?.value) === option.value ? 0 : -1}
          onFocus={() => setFocused(option.value)} onClick={() => {
            if (option.value !== value) onChange(option.value);
            setOpen(false); focusTrigger();
          }}>
          {option.color && <i style={{ background: option.color }} aria-hidden="true" />}
          <span>{option.label}</span><Check size={13} aria-hidden="true" />
        </button>)}
      </div>
    </ViewerMenu>
  </div>;
}
