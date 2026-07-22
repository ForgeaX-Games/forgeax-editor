// Single context-menu entry point for ALL editor panels (Hierarchy / Assets /
// Inspector / …). Single-realm hosts inject their app-wide menu renderer through
// setContextMenuRenderer; handlers stay as closures in this realm, so no
// postMessage protocol duplicates a UI capability.

export interface MenuItemDef {
  label?: string;
  title?: string;
  icon?: string;
  shortcut?: string;
  forge?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
  children?: MenuItemDef[];
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
  const usable = items.filter((it) => it.sep || it.label || it.title || (it.children && it.children.length > 0));
  if (usable.length === 0) return;
  renderMenu?.({ x: e.clientX, y: e.clientY, items: usable });
}
