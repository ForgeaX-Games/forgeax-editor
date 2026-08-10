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

/** dockview drop overlay position (see dockview-core Position). */
type DropPosition = 'top' | 'bottom' | 'left' | 'right' | 'center';
/** dockview grid Direction accepted by addPanel({ position }). */
type Direction = 'left' | 'right' | 'above' | 'below' | 'within';

interface AddPanelPosition {
  referenceGroup?: unknown;
  direction?: Direction;
}

export interface CrossInstanceDropEvent {
  readonly api: DockviewApiLike & {
    addPanel(opts: { id: string; component: string; title?: string; position?: AddPanelPosition }): unknown;
  };
  /** Overlay position of the drop (edge vs. tab). Undefined on older events. */
  readonly position?: DropPosition;
  /** Target group the pointer was over at drop time (undefined = root edge). */
  readonly group?: unknown;
  getData(): { readonly viewId: string; readonly panelId: string | null } | undefined;
}

// Translate the drop overlay's Position into the addPanel Direction. Without
// this the panel lands at dockview's DEFAULT slot (a fresh group at the end),
// which is exactly why "落位 ≠ drop 指示" — the overlay showed one place, the
// panel appeared in another. 'center' → 'within' (add as a tab into the hovered
// group); the four edges map to grid splits.
function toDirection(pos: DropPosition | undefined): Direction | undefined {
  switch (pos) {
    case 'top': return 'above';
    case 'bottom': return 'below';
    case 'left': return 'left';
    case 'right': return 'right';
    case 'center': return 'within';
    default: return undefined;
  }
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
  // Honour the drop location: split/tab relative to the hovered group, or (no
  // group → a root-edge drop) split relative to the whole grid. 'within' only
  // makes sense with a reference group, so drop it at root edges.
  const dir = toDirection(event.position);
  let position: AddPanelPosition | undefined;
  if (event.group && dir) {
    position = { referenceGroup: event.group, direction: dir };
  } else if (dir && dir !== 'within') {
    position = { direction: dir };
  }
  try {
    event.api.addPanel({
      id: transfer.panelId,
      component: opts?.componentFor?.(transfer.panelId) ?? transfer.panelId,
      title: opts?.titleFor?.(transfer.panelId),
      ...(position ? { position } : {}),
    });
  } catch { /* target already has it, or add rejected */ }

  moveTo(transfer.panelId, targetRegion);
}
