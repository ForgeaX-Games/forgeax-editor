// ChatDockResizer — vertical drag handle on the LEFT edge of the ChatDock
// DockRegion (the fixed chat column right of the ActivityRail). Mirrors
// AuxBarResizer: pointer capture keeps a drag alive past the 6px handle, and a
// body class locks the engine iframe out of pointer events during the drag so
// the cursor isn't stolen mid-motion. Width is persisted via useChatWidth.
import { useCallback, useRef, type ReactElement } from 'react';
import { useChatWidth } from '../ChatColumn/useChatWidth';

const DRAGGING_CLASS = 'fx-chat-resizing';

export function ChatDockResizer(): ReactElement {
  const setWidth = useChatWidth((s) => s.setWidth);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    startWidthRef.current = useChatWidth.getState().width;
    document.body.classList.add(DRAGGING_CLASS);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // Chat sits on the RIGHT edge of the studio → dragging the handle LEFT
    // (positive delta) grows the column; dragging RIGHT shrinks it.
    const delta = startXRef.current - e.clientX;
    setWidth(startWidthRef.current + delta);
  }, [setWidth]);

  const finish = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    document.body.classList.remove(DRAGGING_CLASS);
  }, []);

  return (
    <div
      className="fx-chat-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
