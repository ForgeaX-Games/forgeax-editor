// FloatingMenu — the single hand-rolled overlay primitive for the app's simple
// floating menus (context menus, toolbar dropdowns, the layout panel, etc.).
//
// Background (architecture review §B2): the codebase had ~4 ad-hoc ways to do
// "floating menu that closes when you click elsewhere" — portal+backdrop,
// document mousedown listeners, onMouseLeave, and Radix. This unifies the
// hand-rolled cases into ONE component so every such menu automatically gets:
//   • portal to <body>  → escapes overflow/transform/stacking traps
//   • token z-index (--z-menu / --z-menu-backdrop) → never covered, never
//     guesses a magic number
//   • a full-viewport backdrop → closes on ANY outside click (never mouse-out)
//   • Escape to close
//   • viewport clamping so it never renders off-screen
//
// (Rich, keyboard-navigable menus keep using the Radix DropdownMenu in
// components/ui/dropdown-menu.tsx — FloatingMenu is for the simple cases.)
//
// Positioning — pass exactly one of:
//   point  : {x, y}      → context-menu style, top-left at the cursor
//   anchor : DOMRect-ish → dropdown style, below the anchor; `align` picks the
//                          edge the menu lines up with ('start' = left edges,
//                          'end' = right edges).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface AnchorRect { top: number; bottom: number; left: number; right: number }

interface FloatingMenuProps {
  open: boolean;
  onClose: () => void;
  point?: { x: number; y: number };
  anchor?: AnchorRect | null;
  align?: 'start' | 'end';
  /** gap (px) between the anchor and the menu. Default 6. */
  offset?: number;
  className?: string;
  children: ReactNode;
}

const VIEWPORT_PAD = 8;

export function FloatingMenu({ open, onClose, point, anchor, align = 'start', offset = 6, className, children }: FloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left?: number; top: number; right?: number }>({ top: 0 });

  // Compute position from point / anchor, then clamp into the viewport once the
  // menu has measured itself.
  useLayoutEffect(() => {
    if (!open) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const m = menuRef.current;
    const mw = m?.offsetWidth ?? 0, mh = m?.offsetHeight ?? 0;
    if (point) {
      const left = Math.min(point.x, vw - mw - VIEWPORT_PAD);
      const top = Math.min(point.y, vh - mh - VIEWPORT_PAD);
      setPos({ left: Math.max(VIEWPORT_PAD, left), top: Math.max(VIEWPORT_PAD, top) });
    } else if (anchor) {
      const top = Math.min(anchor.bottom + offset, vh - mh - VIEWPORT_PAD);
      if (align === 'end') {
        setPos({ right: Math.max(VIEWPORT_PAD, vw - anchor.right), top: Math.max(VIEWPORT_PAD, top) });
      } else {
        const left = Math.min(anchor.left, vw - mw - VIEWPORT_PAD);
        setPos({ left: Math.max(VIEWPORT_PAD, left), top: Math.max(VIEWPORT_PAD, top) });
      }
    }
  }, [open, point?.x, point?.y, anchor?.top, anchor?.bottom, anchor?.left, anchor?.right, align, offset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-menu-backdrop)' }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={menuRef}
        className={className}
        style={{ position: 'fixed', left: pos.left, right: pos.right, top: pos.top, zIndex: 'var(--z-menu)' }}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
