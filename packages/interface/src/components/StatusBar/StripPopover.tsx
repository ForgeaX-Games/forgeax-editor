/**
 * StripPopover — a status-bar chip that opens a small card ANCHORED just above
 * itself (UE/VS Code status-item popover affordance, mirrors the demo's
 * `.sb-pop`). Business-agnostic shell: it owns only the button, the anchored
 * fixed-position card, and open/close (outside-click + Esc). Callers pass the
 * header title and the card body as children.
 *
 * This is a `custom` StatusItemContribution's rendered node (ADR-0030 §2.2) —
 * NOT a new contribution sub-type: the taxonomy stays text/button/custom, and
 * this widget is just the reusable shape shared by every popover-style chip
 * (project version, diagnostics, …) so the anchoring/close logic lives once.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { icons as LucideIcons } from 'lucide-react';
import './StripPopover.css';

export interface StripPopoverProps {
  /** lucide icon name for the chip button. */
  readonly icon?: string;
  /** chip button label (text or node, e.g. version + draft badge). */
  readonly label?: ReactNode;
  /** popover header content (icon + title). */
  readonly title: ReactNode;
  /** native title/tooltip on the chip button. */
  readonly tooltip?: string;
  /** right-aligned header slot (e.g. a primary action button). */
  readonly headerAction?: ReactNode;
  readonly children: ReactNode;
}

export function StripPopover({
  icon,
  label,
  title,
  tooltip,
  headerAction,
  children,
}: StripPopoverProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const Icon = icon ? LucideIcons[icon as keyof typeof LucideIcons] : undefined;

  const closeOnEscape = (event: ReactKeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };

  // Anchor the card centered over the chip, clamped to the viewport, sitting
  // just above it (fixed `bottom` measured from the chip's top — grows upward).
  const place = useCallback(() => {
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    setPos({ left, bottom: window.innerHeight - r.top + 6 });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sb-chip is-button fx-strip-pop-btn${open ? ' is-active' : ''}`}
        title={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={closeOnEscape}
      >
        {Icon ? <Icon size={12} className="sb-chip-icon" /> : null}
        {label != null ? <span className="sb-chip-label">{label}</span> : null}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="fx-strip-pop"
            role="dialog"
            style={pos ? { left: pos.left, bottom: pos.bottom } : { left: -9999, bottom: 0 }}
            onKeyDown={closeOnEscape}
          >
            <div className="fx-strip-pop-h">
              {title}
              {headerAction ? <span className="fx-strip-pop-h-act">{headerAction}</span> : null}
            </div>
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
