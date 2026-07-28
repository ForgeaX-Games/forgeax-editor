export interface SidebarEntry {
  id: string;
}

/** Resolve the requested workbench tab without masking a loading plugin as
 * Agents. ActivityRail and Sidebar load manifests independently, so a selected
 * plugin may be temporarily absent here. */
export function resolveSidebarActiveEntry<T extends SidebarEntry>(
  entries: readonly T[],
  workbenchTab: string,
): T | undefined {
  const selected = entries.find((entry) => entry.id === workbenchTab);
  if (selected) return selected;
  if (workbenchTab !== 'agents') return undefined;
  return entries.find((entry) => entry.id === 'agents');
}
