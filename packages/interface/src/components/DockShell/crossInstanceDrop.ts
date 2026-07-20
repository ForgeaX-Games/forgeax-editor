// Pure orchestration helper for cross-instance dockview drops. dockview 6.6.1
// does NOT auto-move panels between DockviewComponent instances — same-instance
// moves are handled natively via `moveGroupOrPanel`, cross-instance drops just
// fire `onDidDrop` with the foreign transfer data and do nothing else. So the
// consumer must:
//   1. If transfer.viewId !== targetApi.id: this is a cross-instance drop
//   2. Look up the source api in the shared registry, close the source panel
//   3. Ask the target api to add the panel
//   4. Call moveTo(id, targetRegion) so the layout store persists the intent
// Same-instance drops (transfer.viewId === targetApi.id) return without
// touching anything — dockview already reconciled.
import type { DockRegion } from './regions';
import { getDockviewApi, type DockviewApiLike } from './dockviewRegistry';

export interface CrossInstanceDropEvent {
  readonly api: DockviewApiLike & { addPanel(opts: { id: string; component: string; title?: string }): unknown };
  getData(): { readonly viewId: string; readonly panelId: string | null } | undefined;
}

export function handleCrossInstanceDrop(
  event: CrossInstanceDropEvent,
  targetRegion: DockRegion,
  moveTo: (panelId: string, region: DockRegion) => void,
  opts?: {
    /** Component id for the added panel; defaults to `panelId` (matches how
     *  panelRegistry keys PANEL_COMPONENTS). */
    componentFor?: (panelId: string) => string;
    /** Title to attach to the new panel; defaults to panelId. */
    titleFor?: (panelId: string) => string | undefined;
  },
): void {
  const transfer = event.getData();
  if (!transfer?.panelId) return;
  if (transfer.viewId === event.api.id) return; // same-instance, dockview handled

  const sourceApi = getDockviewApi(transfer.viewId);
  if (sourceApi) {
    try { sourceApi.getPanel(transfer.panelId)?.api.close(); } catch { /* source already closed */ }
  }
  try {
    event.api.addPanel({
      id: transfer.panelId,
      component: opts?.componentFor?.(transfer.panelId) ?? transfer.panelId,
      title: opts?.titleFor?.(transfer.panelId),
    });
  } catch { /* target already has it, or add rejected */ }

  moveTo(transfer.panelId, targetRegion);
}
