// material-category-state — module-level UI-chrome store for the Material
// parameter editor's collapsed-category set.
//
// Collapse/expand is pure viewport chrome (never saved into the material pack,
// never seen in Play, never undoable), so per the editor chrome-vs-authored
// litmus it lives OUTSIDE the gateway/ledger — the same shape as
// hierarchy-state.ts. Hoisting it out of React lets the panel-header commands
// (Expand All / Collapse All, contributed via panelActions) drive it without a
// component-local handler bridge, while the panel body reads it through
// useSyncExternalStore.

let collapsed: ReadonlySet<string> = new Set();
// The collapse "universe" the panel currently renders. Registered by the panel
// (the sole owner of the category id list) so the parameterless Collapse-All
// command can collapse every card without the extension re-encoding the ids.
let categoryIds: readonly string[] = [];

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeMaterialCategoryState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMaterialCategoryCollapsed(): ReadonlySet<string> {
  return collapsed;
}

/** Panel registers the full id universe each time its category set changes;
 *  no-ops (and does not emit) when the list is unchanged. */
export function registerMaterialCategoryIds(ids: readonly string[]): void {
  if (ids.length === categoryIds.length && ids.every((id, i) => id === categoryIds[i])) return;
  categoryIds = [...ids];
}

export function toggleMaterialCategory(id: string): void {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed = next;
  emit();
}

export function expandAllMaterialCategories(): void {
  if (collapsed.size === 0) return;
  collapsed = new Set();
  emit();
}

export function collapseAllMaterialCategories(): void {
  collapsed = new Set(categoryIds);
  emit();
}
