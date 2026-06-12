import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Shared right-click menu for editor panels (Hierarchy / Assets / Inspector).
//
// These panels each render inside their OWN iframe (the flat-dockview ep:* host),
// so a `position: fixed` .ctxmenu is confined to that iframe's viewport and gets
// CLIPPED at the panel edge when opened near it — exactly the "menu cut off at
// the Hierarchy right edge" bug. CtxMenu measures itself and clamps the position
// into the iframe viewport (flips left/up near the right/bottom edge) so the
// whole menu stays visible inside the panel. useLayoutEffect adjusts before
// paint → no flash.
export function CtxMenu({
  x, y, testid, onClickCapture, children,
}: {
  x: number;
  y: number;
  testid?: string;
  onClickCapture?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 6;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="ctxmenu"
      data-testid={testid}
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => { e.stopPropagation(); onClickCapture?.(); }}
    >
      {children}
    </div>
  );
}
