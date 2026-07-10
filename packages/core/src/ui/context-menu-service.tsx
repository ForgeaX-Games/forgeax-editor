import { useEffect, useState } from 'react';
import { CtxMenu } from './ctx-menu';

// Single context-menu entry point for ALL editor panels (Hierarchy / Assets /
// Inspector / …). Single-realm hosts inject their app-wide menu renderer through
// setContextMenuRenderer; handlers stay as closures in this realm, so no VAG
// postMessage protocol duplicates a UI capability. A standalone/pop-out host can
// instead mount ContextMenuHost for the same local renderer.

export interface MenuItemDef {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
}

export type ContextMenuRequest = { x: number; y: number; items: MenuItemDef[] };
export type ContextMenuRenderer = (menu: ContextMenuRequest | null) => void;

let renderMenu: ContextMenuRenderer | null = null;

/** Install the one host-level context-menu renderer. Single-realm hosts call this
 * once from their own top-layer menu component; it returns an idempotent disposer. */
export function setContextMenuRenderer(renderer: ContextMenuRenderer): () => void {
  renderMenu = renderer;
  return () => {
    if (renderMenu === renderer) renderMenu = null;
  };
}

/** Open a context menu at the event position with the given items. Call from a
 * panel's onContextMenu (it calls preventDefault for you). */
export function showContextMenu(
  e: { clientX: number; clientY: number; preventDefault: () => void },
  items: MenuItemDef[],
): void {
  e.preventDefault();
  const usable = items.filter((it) => it.sep || it.label);
  if (usable.length === 0) return;
  renderMenu?.({ x: e.clientX, y: e.clientY, items: usable });
}

/** Mounted by a standalone/pop-out editor root when it supplies the local menu
 * renderer itself instead of the interface's app-wide host. */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null);
  useEffect(() => {
    const dispose = setContextMenuRenderer(setMenu);
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => { dispose(); window.removeEventListener('click', close); window.removeEventListener('blur', close); };
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
