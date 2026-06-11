import { useEffect, useState } from 'react';
import { CtxMenu } from './CtxMenu';

// Single context-menu entry point for ALL editor panels (Hierarchy / Assets /
// Inspector / …). Architecture: an editor panel lives in an iframe and can't
// paint a menu outside its own rect, so when embedded in the interface we POST
// the menu to the parent window, which renders it at the top layer of the WHOLE
// window through the same menu host as main-window right-clicks (no clipping,
// one renderer). When this editor doc is a POP-OUT window (no interface parent)
// we render the menu locally (full window, clamped by CtxMenu).
//
// Wire protocol (must match interface/src/components/ContextMenu/ContextMenu.tsx):
//   iframe → parent : { type:'VAG_CONTEXT_MENU', menuId, x, y, items:[{id,label,disabled,danger,sep}] }
//   parent → iframe : { type:'VAG_CONTEXT_MENU_ACTION', menuId, actionId }

export interface MenuItemDef {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
}

type LocalMenu = { x: number; y: number; items: MenuItemDef[] };
let renderLocal: ((m: LocalMenu | null) => void) | null = null;
let menuSeq = 0;

/** Open a context menu at the event position with the given items. Call from a
 *  panel's onContextMenu (it calls preventDefault for you). */
export function showContextMenu(
  e: { clientX: number; clientY: number; preventDefault: () => void },
  items: MenuItemDef[],
): void {
  e.preventDefault();
  const usable = items.filter((it) => it.sep || it.label);
  if (usable.length === 0) return;

  if (window.parent && window.parent !== window) {
    // Embedded → render in the interface parent (top layer of the whole window).
    const menuId = `em-${++menuSeq}`;
    const handlers = new Map<string, () => void>();
    const wire = usable.map((it, idx) => {
      if (it.sep) return { sep: true as const };
      const id = `i${idx}`;
      if (it.onClick && !it.disabled) handlers.set(id, it.onClick);
      return { id, label: it.label, disabled: it.disabled, danger: it.danger };
    });
    const onAction = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; menuId?: string; actionId?: string } | null;
      if (!d || d.type !== 'VAG_CONTEXT_MENU_ACTION' || d.menuId !== menuId) return;
      window.removeEventListener('message', onAction);
      handlers.get(d.actionId ?? '')?.();
    };
    window.addEventListener('message', onAction);
    // Drop the listener if the menu is dismissed without a pick.
    setTimeout(() => window.removeEventListener('message', onAction), 30000);
    window.parent.postMessage({ type: 'VAG_CONTEXT_MENU', menuId, x: e.clientX, y: e.clientY, items: wire }, '*');
  } else {
    // Pop-out window → render locally.
    renderLocal?.({ x: e.clientX, y: e.clientY, items: usable });
  }
}

/** Mounted once at the editor root. Renders the LOCAL menu for pop-out windows
 *  (embedded mode renders in the interface parent instead). */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<LocalMenu | null>(null);
  useEffect(() => {
    renderLocal = setMenu;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => { renderLocal = null; window.removeEventListener('click', close); window.removeEventListener('blur', close); };
  }, []);
  if (!menu) return null;
  return (
    <CtxMenu x={menu.x} y={menu.y} onClickCapture={() => setMenu(null)}>
      {menu.items.map((it, i) =>
        it.sep ? (
          <div className="ctxsep" key={`s${i}`} />
        ) : (
          <div
            key={`i${i}`}
            className={`ctxitem${it.disabled ? ' disabled' : ''}`}
            onClick={() => { if (!it.disabled) it.onClick?.(); setMenu(null); }}
          >
            {it.label}
          </div>
        ),
      )}
    </CtxMenu>
  );
}
