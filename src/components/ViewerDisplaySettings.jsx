import { useId, useRef } from 'react';
import { ChevronRight } from 'lucide-react';

export default function ViewerDisplaySettings({ sections, expanded, onExpandedChange }) {
  const id = useId();
  const headings = useRef({});
  const active = sections.some(section => section.id === expanded) ? expanded : null;

  return (
    <div className="viewer-display-sections">
      {sections.map(({ id: key, label, icon: Icon, description, content }, index) => {
        const open = active === key;
        return (
          <section key={key} className="viewer-display-section" data-expanded={open}>
            <button type="button" className="viewer-display-section__heading"
              ref={element => { headings.current[key] = element; }}
              id={`${id}-${key}-heading`} aria-label={label}
              aria-expanded={open} aria-controls={`${id}-${key}-content`}
              onClick={() => onExpandedChange(open ? null : key)}
              onKeyDown={event => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault();
                  onExpandedChange(event.key === 'ArrowRight' ? key : null);
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length;
                  headings.current[sections[next].id]?.focus();
                }
              }}>
              <Icon size={15} aria-hidden="true" />
              <span><strong>{label}</strong><small>{description}</small></span>
              <ChevronRight size={13} className="viewer-display-section__chevron" aria-hidden="true" />
            </button>
            <div id={`${id}-${key}-content`} className="viewer-display-section__content"
              role="group" aria-labelledby={`${id}-${key}-heading`} hidden={!open}>
              {content}
            </div>
          </section>
        );
      })}
    </div>
  );
}
