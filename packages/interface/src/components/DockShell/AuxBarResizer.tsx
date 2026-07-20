// AuxBarResizer — vertical drag handle on the LEFT edge of the AuxBar
// DockRegion. Uses pointer events + setPointerCapture so a drag that leaves
// the handle's bounding rect (only 6px wide) still tracks and only ends on
// pointerup anywhere. Adds a body class during drag so the studio's iframe
// (viewport engine) can be locked out via CSS (pointer-events: none) —
// otherwise the iframe swallows pointer moves once the cursor crosses its
// boundary and the drag stalls mid-motion.
import { useCallback, useRef, type ReactElement } from 'react';
import { useAuxBarWidth } from './useAuxBarWidth';

const DRAGGING_CLASS = 'fx-auxbar-resizing';

export function AuxBarResizer(): ReactElement {
  const setWidth = useAuxBarWidth((s) => s.setWidth);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    startWidthRef.current = useAuxBarWidth.getState().width;
    document.body.classList.add(DRAGGING_CLASS);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // AuxBar sits on the RIGHT edge of the studio → moving pointer LEFT
    // (delta positive) grows the bar; moving RIGHT (delta negative) shrinks it.
    const delta = startXRef.current - e.clientX;
    setWidth(startWidthRef.current + delta);
  }, [setWidth]);

  const finish = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    document.body.classList.remove(DRAGGING_CLASS);
  }, []);

  return (
    <div
      className="fx-auxbar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize auxiliary bar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
