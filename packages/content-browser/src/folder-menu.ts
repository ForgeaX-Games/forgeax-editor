import type { ContextMenuItem } from './CBContextMenu';

/** Shape consumed by `showContextMenu` (label + click + optional disabled). */
export interface ResolvedMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  forge?: boolean;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Turn a raw `buildFolderContextMenu` list into the flat items `showContextMenu`
 * expects: strip separators, rewire the builder's caller-handled placeholders
 * (`open` → navigate, `toggle-fav` → favorites toggle) to real handlers, and
 * disable ops the backend can't do yet. Folder delete is supported through the
 * editor gateway's `deleteDirectory`; rename still needs a move/rename API.
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
      return {
        id: m.id,
        label: m.label,
        icon: m.icon,
        shortcut: m.shortcut,
        danger: m.danger,
        forge: m.forge,
        onClick,
        disabled: unsupported.has(m.id) || m.disabled,
      };
    });
}
