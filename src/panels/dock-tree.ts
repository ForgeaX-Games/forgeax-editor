// Recursive dock layout tree (design EDITOR-MODE §0.2.1): the editor's panel
// shell is a tree of Splits (row/col, recursive) whose leaves are TabGroups. This
// is the same abstraction as VSCode GridView · UE FTabManager::FLayout · Godot
// split-dock · Blender area-tree, and supersedes the earlier fixed left/right/
// bottom regions (which could only TAB, never arbitrarily split).
//
// This module is the PURE tree algebra (no React/DOM), unit-tested headlessly —
// the renderer (Dock.tsx) is a thin shell over it. All operations are immutable:
// they return a NEW tree, never mutate. Floating/popped-out panels live outside
// this tree (overlays), so the tree only ever holds DOCKED panels.

export type Dir = 'row' | 'col';
export type DockPanelId = string;
/** Where a drag is dropped over a leaf: tab it (center) or split (4 edges). */
export type DropSide = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface TabsNode {
  kind: 'tabs';
  id: string;
  panels: DockPanelId[];
  active: number;
}
export interface SplitNode {
  kind: 'split';
  id: string;
  dir: Dir;
  children: DockNode[];
  /** fraction per child, summing to 1 (parallel to `children`). */
  sizes: number[];
}
export type DockNode = TabsNode | SplitNode;

let _seq = 0;
/** Reset the id counter — for deterministic tests. */
export function resetIds(): void { _seq = 0; }
function nid(p: string): string { return `${p}${++_seq}`; }

export function tabs(panels: DockPanelId[], active = 0, id: string = nid('t')): TabsNode {
  return { kind: 'tabs', id, panels, active: clampActive(active, panels.length) };
}
export function split(dir: Dir, children: DockNode[], sizes?: number[], id: string = nid('s')): SplitNode {
  return { kind: 'split', id, dir, children, sizes: sizes && sizes.length === children.length ? sizes : even(children.length) };
}

function clampActive(a: number, len: number): number { return len === 0 ? 0 : Math.max(0, Math.min(a, len - 1)); }
function even(n: number): number[] { return n > 0 ? Array.from({ length: n }, () => 1 / n) : []; }

// ── queries ──────────────────────────────────────────────────────────────────

export function allPanels(n: DockNode): DockPanelId[] {
  return n.kind === 'tabs' ? [...n.panels] : n.children.flatMap(allPanels);
}
export function leafById(n: DockNode, id: string): TabsNode | null {
  if (n.kind === 'tabs') return n.id === id ? n : null;
  for (const c of n.children) { const r = leafById(c, id); if (r) return r; }
  return null;
}
export function leafOfPanel(n: DockNode, panel: DockPanelId): TabsNode | null {
  if (n.kind === 'tabs') return n.panels.includes(panel) ? n : null;
  for (const c of n.children) { const r = leafOfPanel(c, panel); if (r) return r; }
  return null;
}
export function firstLeaf(n: DockNode): TabsNode | null {
  if (n.kind === 'tabs') return n;
  for (const c of n.children) { const r = firstLeaf(c); if (r) return r; }
  return null;
}

// ── transforms (immutable) ─────────────────────────────────────────────────────

/** Replace the tabs leaf with `id` via `fn` (returns a new tree). */
function mapLeaf(n: DockNode, id: string, fn: (leaf: TabsNode) => DockNode): DockNode {
  if (n.kind === 'tabs') return n.id === id ? fn(n) : n;
  return { ...n, children: n.children.map((c) => mapLeaf(c, id, fn)) };
}

/** Collapse a split of one child, drop empty leaves, and flatten same-dir nesting
 *  so the tree stays canonical. Returns null if the whole tree becomes empty. */
export function normalize(n: DockNode | null): DockNode | null {
  if (!n) return null;
  if (n.kind === 'tabs') return n.panels.length ? n : null;
  const kids = n.children.map(normalize).filter((c): c is DockNode => c !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]!;
  const flat: DockNode[] = [];
  for (const c of kids) {
    if (c.kind === 'split' && c.dir === n.dir) flat.push(...c.children);
    else flat.push(c);
  }
  return { ...n, children: flat, sizes: even(flat.length) };
}

export function setActive(root: DockNode, leafId: string, index: number): DockNode {
  return mapLeaf(root, leafId, (leaf) => ({ ...leaf, active: clampActive(index, leaf.panels.length) }));
}
export function setActivePanel(root: DockNode, leafId: string, panel: DockPanelId): DockNode {
  return mapLeaf(root, leafId, (leaf) => ({ ...leaf, active: Math.max(0, leaf.panels.indexOf(panel)) }));
}

/** Update the sizes of the split with `id` (validated/renormalized). */
export function setSizes(root: DockNode, splitId: string, sizes: number[]): DockNode {
  if (root.kind === 'tabs') return root;
  if (root.id === splitId && sizes.length === root.children.length) {
    const sum = sizes.reduce((s, x) => s + Math.max(0, x), 0) || 1;
    return { ...root, sizes: sizes.map((x) => Math.max(0.05, x) / sum) };
  }
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) };
}

function addToLeaf(root: DockNode, leafId: string, panel: DockPanelId): DockNode {
  return mapLeaf(root, leafId, (leaf) => {
    const panels = leaf.panels.includes(panel) ? leaf.panels : [...leaf.panels, panel];
    return { ...leaf, panels, active: panels.indexOf(panel) };
  });
}

function splitAtLeaf(root: DockNode, leafId: string, side: Exclude<DropSide, 'center'>, panel: DockPanelId): DockNode {
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  return mapLeaf(root, leafId, (leaf) => {
    const fresh = tabs([panel]);
    return split(dir, before ? [fresh, leaf] : [leaf, fresh], [0.5, 0.5]);
  });
}

/** Remove a panel from wherever it sits; collapse the tree. May return null. */
export function removePanel(root: DockNode, panel: DockPanelId): DockNode | null {
  const strip = (n: DockNode): DockNode => {
    if (n.kind === 'tabs') {
      if (!n.panels.includes(panel)) return n;
      const panels = n.panels.filter((p) => p !== panel);
      return { ...n, panels, active: clampActive(n.active, panels.length) };
    }
    return { ...n, children: n.children.map(strip) };
  };
  return normalize(strip(root));
}

/** Move a panel to `targetLeafId` with a drop side. center = add as tab; an edge =
 *  split that leaf. Self-drops that would be no-ops are ignored. */
export function movePanel(root: DockNode, panel: DockPanelId, targetLeafId: string, side: DropSide): DockNode {
  const target = leafById(root, targetLeafId);
  if (target && target.panels.includes(panel)) {
    // dropping onto its own leaf: center = already there; splitting a singleton
    // off itself is a no-op too.
    if (side === 'center') return root;
    if (target.panels.length === 1) return root;
  }
  const removed = removePanel(root, panel);
  if (!removed) return tabs([panel]);
  // after removal the target leaf might be gone (it WAS the panel's singleton
  // leaf). Fall back to the first leaf so the panel never disappears.
  if (!leafById(removed, targetLeafId)) {
    const f = firstLeaf(removed);
    return f ? addToLeaf(removed, f.id, panel) : tabs([panel]);
  }
  const next = side === 'center'
    ? addToLeaf(removed, targetLeafId, panel)
    : splitAtLeaf(removed, targetLeafId, side, panel);
  return normalize(next)!;
}

/** Reconcile a loaded tree with the authoritative panel set: drop unknown panels,
 *  append any missing ones to the first leaf. Guarantees every valid panel shows
 *  exactly once (used on layout load + when the panel registry changes). */
export function reconcile(root: DockNode | null, valid: readonly DockPanelId[]): DockNode {
  const validSet = new Set(valid);
  let tree = root;
  if (tree) {
    // drop unknowns + de-dupe
    const seen = new Set<DockPanelId>();
    const filter = (n: DockNode): DockNode => {
      if (n.kind === 'tabs') {
        const panels = n.panels.filter((p) => validSet.has(p) && !seen.has(p));
        for (const p of panels) seen.add(p);
        return { ...n, panels, active: clampActive(n.active, panels.length) };
      }
      return { ...n, children: n.children.map(filter) };
    };
    tree = normalize(filter(tree));
  }
  const present = new Set(tree ? allPanels(tree) : []);
  const missing = valid.filter((p) => !present.has(p));
  if (!tree) return tabs([...missing]);
  if (missing.length === 0) return tree;
  // append every missing panel to the (stable) first leaf.
  return missing.reduce((acc, p) => addToLeaf(acc, firstLeaf(acc)!.id, p), tree);
}
