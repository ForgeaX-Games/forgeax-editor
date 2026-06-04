// Dock bridge stub. The unveil-studio prototype docked panels with dockview and
// could open a Workbench "source editor" panel (the Native/Source state of the
// three-state data model) or focus another dock panel (e.g. the Timeline).
//
// editor-runtime (P1) is a fixed two-pane layout (Hierarchy + Inspector over the
// engine canvas), not a dockview workspace yet — so these are intentional no-ops.
// They keep the ported panels' call sites intact:
//   • openSourcePanel → P2 will postMessage the parent interface to switch the
//     ✎ Edit workspace to the originating Workbench plugin ("编辑源" round-trip).
//   • focusPanel('timeline') → P2 when a Timeline panel is ported.
//
// Kept as thin stubs (rather than deleting the call sites) so re-syncing with the
// prototype later is a diff, not a rewrite.

export function openSourcePanel(plugin: string, docId: string): void {
  try {
    window.parent?.postMessage({ type: 'VAG_EDITOR_OPEN_SOURCE', payload: { plugin, docId } }, '*');
  } catch {
    /* cross-origin — non-fatal */
  }
}

export function focusPanel(_id: string): boolean {
  return false;
}
