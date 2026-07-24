import { useCallback, useRef, type ReactElement } from 'react';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { DockPanelHost } from '../DockShell/DockPanelHost';
import { useShellStore } from '../../store';
import { useChatWidth } from './useChatWidth';

// Fixed shell-level chat column (right of the ActivityRail). Chat was pulled out
// of the dockview so a shell rail can sit immediately to its left; this keeps it
// drag-resizable via a left-edge handle. During drag a body class disables iframe
// pointer-events (engine viewport / plugin iframes) so the pointer isn't stolen
// mid-drag — same technique as AuxBarResizer.
const DRAGGING_CLASS = 'fx-chat-resizing';

export function ChatColumn(): ReactElement | null {
  const hasChat = !!usePanelRenderers().panels?.chat;
  const collapsed = useShellStore((s) => s.chatpanelCollapsed);
  const width = useChatWidth((s) => s.width);
  const setWidth = useChatWidth((s) => s.setWidth);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    startWidthRef.current = useChatWidth.getState().width;
    document.body.classList.add(DRAGGING_CLASS);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // Chat sits on the RIGHT edge → dragging the handle LEFT (positive delta)
    // grows the column; dragging RIGHT shrinks it.
    const delta = startXRef.current - e.clientX;
    setWidth(startWidthRef.current + delta);
  }, [setWidth]);
  const finish = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    document.body.classList.remove(DRAGGING_CLASS);
  }, []);

  if (!hasChat || collapsed) return null;
  return (
    <aside className="studio-chat-col" data-fx-slot="ChatColumn" data-tour-id="chat" style={{ width }}>
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
      <DockPanelHost id="chat" />
    </aside>
  );
}
