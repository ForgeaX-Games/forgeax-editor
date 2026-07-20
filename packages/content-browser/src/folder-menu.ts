import type { ContextMenuItem } from './CBContextMenu';

/** Shape consumed by `showContextMenu` (label + click + optional disabled). */
export interface ResolvedMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Turn a raw `buildFolderContextMenu` list into the flat items `showContextMenu`
 * expects: strip separators, rewire the builder's caller-handled placeholders
 * (`open` → navigate, `toggle-fav` → favorites toggle) to real handlers, and
 * disable ops the backend can't do yet (folder rename/delete have no server
 * API — only `createDirectory` exists).
 */
export function resolveFolderMenuItems(
  items: ContextMenuItem[],
  handlers: {
    onOpen: () => void;
    onToggleFavorite: () => void;
    unsupportedIds?: string[];
  },
): ResolvedMenuItem[] {
  const unsupported = new Set(handlers.unsupportedIds ?? []);
  return items
    .filter((m) => !m.separator)
    .map((m) => {
      let onClick = m.action;
      if (m.id === 'open') onClick = handlers.onOpen;
      else if (m.id === 'toggle-fav') onClick = handlers.onToggleFavorite;
      return { label: m.label, onClick, disabled: unsupported.has(m.id) || m.disabled };
    });
}
