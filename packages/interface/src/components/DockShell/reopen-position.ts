// reopen-position.ts — derive a closed panel's DESIGNED dock seat from the
// active Page Type's default layout.
//
// The generic reopen path (DockRegion.reopen) used to anchor every re-added
// panel to `lastGridPanelId` + direction 'right'. On document pages whose
// default layout is not a plain left-to-right strip (Material: preview left,
// properties/overview stacked right) that dropped the reopened panel into a
// foreign group — users perceived close→reopen as "the panel comes back bound
// to whatever is showing". This helper walks the default layout tree so a
// reopened panel returns to its authored seat: rejoining its tab group when a
// tab-mate survives, else docking beside the nearest open sibling subtree with
// the direction implied by the branch orientation (dockview flips orientation
// per depth: root uses grid.orientation, each nested branch the orthogonal).
import { Orientation, type SerializedDockview } from 'dockview';

export type ReopenDirection = 'left' | 'right' | 'above' | 'below' | 'within';

export type DesignedPosition =
  /** Dock beside / rejoin a specific open panel. */
  | { readonly kind: 'relative'; readonly referencePanel: string; readonly direction: ReopenDirection }
  /** Dock at a grid edge (root-level split) — the panel's designed seat is a
   *  full-height/-width outer column/row, so anchoring to a sibling panel
   *  would only capture that sibling's slice of the grid. */
  | { readonly kind: 'edge'; readonly direction: Exclude<ReopenDirection, 'within'> };

type GridNode = SerializedDockview['grid']['root'];

function leafViews(node: GridNode): readonly string[] {
  if (node.type !== 'leaf') return [];
  const views = (node.data as { views?: unknown }).views;
  return Array.isArray(views) ? (views as readonly string[]) : [];
}

/** First open panel inside the subtree, in layout (DFS) order. */
function firstOpenPanel(node: GridNode, isOpen: (id: string) => boolean): string | undefined {
  if (node.type === 'leaf') return leafViews(node).find(isOpen);
  for (const child of node.data as GridNode[]) {
    const hit = firstOpenPanel(child, isOpen);
    if (hit) return hit;
  }
  return undefined;
}

/** Path from root to the leaf holding `panelId` (inclusive), or null. */
function findPath(root: GridNode, panelId: string): GridNode[] | null {
  if (root.type === 'leaf') return leafViews(root).includes(panelId) ? [root] : null;
  for (const child of root.data as GridNode[]) {
    const sub = findPath(child, panelId);
    if (sub) return [root, ...sub];
  }
  return null;
}

function branchOrientation(rootOrientation: Orientation, depth: number): Orientation {
  return depth % 2 === 0
    ? rootOrientation
    : rootOrientation === Orientation.HORIZONTAL
      ? Orientation.VERTICAL
      : Orientation.HORIZONTAL;
}

/**
 * The seat `panelId` occupies in `layout`, expressed against a panel that is
 * currently open. Returns undefined when the panel is absent from the layout
 * or no sibling subtree has an open panel to anchor to (caller falls back to
 * the generic last-grid-panel behavior).
 */
export function designedPanelPosition(
  layout: SerializedDockview,
  panelId: string,
  isOpen: (id: string) => boolean,
): DesignedPosition | undefined {
  const root = layout.grid?.root;
  if (!root) return undefined;
  const path = findPath(root, panelId);
  if (!path) return undefined;

  const leaf = path[path.length - 1];
  const tabMate = leafViews(leaf).find((view) => view !== panelId && isOpen(view));
  if (tabMate) return { kind: 'relative', referencePanel: tabMate, direction: 'within' };

  // A leaf that is a DIRECT child of the root branch and sits at its outer
  // edge owns a full grid edge (Material preview's left column, Level's chat
  // column). Restore it with an absolute edge split — a relative anchor would
  // only capture the sibling's slice (the "preview reopened as a half-height
  // tab strip" geometry bug).
  if (path.length === 2) {
    const siblings = path[0].data as GridNode[];
    const index = siblings.indexOf(leaf);
    const horizontal = layout.grid.orientation === Orientation.HORIZONTAL;
    if (index === 0) return { kind: 'edge', direction: horizontal ? 'left' : 'above' };
    if (index === siblings.length - 1) return { kind: 'edge', direction: horizontal ? 'right' : 'below' };
  }

  for (let depth = path.length - 2; depth >= 0; depth--) {
    const siblings = path[depth].data as GridNode[];
    const index = siblings.indexOf(path[depth + 1]);
    if (index < 0) continue;
    const horizontal = branchOrientation(layout.grid.orientation, depth) === Orientation.HORIZONTAL;
    // A subtree listed AFTER ours sits to our right/below → dock before it.
    for (let i = index + 1; i < siblings.length; i++) {
      const ref = firstOpenPanel(siblings[i], isOpen);
      if (ref) return { kind: 'relative', referencePanel: ref, direction: horizontal ? 'left' : 'above' };
    }
    for (let i = index - 1; i >= 0; i--) {
      const ref = firstOpenPanel(siblings[i], isOpen);
      if (ref) return { kind: 'relative', referencePanel: ref, direction: horizontal ? 'right' : 'below' };
    }
  }
  return undefined;
}
