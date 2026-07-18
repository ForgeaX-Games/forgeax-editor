// Declarative registry of built-in workbenches. Each entry owns its default
// dockview layout as `SerializedDockview` DATA — the same shape user-saved
// layouts round-trip through (dockview `api.toJSON()` / `api.fromJSON()`).
// `buildDefault()` (below) is a thin wrapper: pick the spec, filter by region
// membership, hand the JSON to `api.fromJSON`. Adding a new built-in workbench
// is a data-only change; no imperative code path.
//
// To add a new built-in workbench:
//   1. Add an entry to BUILTIN_WORKBENCHES with its layout constant
//   2. Add its id to BUILTIN_WORKBENCH_IDS in workbenches.ts
//   3. Add its entry to DEFAULT_WORKBENCHES in workbenches.ts
// No DockRegion.tsx changes required.
import type { DockviewApi, SerializedDockview } from 'dockview';
import { Orientation } from 'dockview';

// Phase 1 region-membership filter — a stable "everything belongs here" default
// so existing callers (tests, HMR paths) can invoke buildDefault without needing
// to plumb a region check. Real callers pass a real isMember from the component.
const ACCEPT_ALL: (id: string) => boolean = () => true;

export interface BuiltinWorkbenchSpec {
  id: 'scene' | 'ai';
  name: string;
  icon?: string;
  /** Default dockview layout. Same shape as `Workbench.layout` — user-saved
   *  layouts round-trip through this exact type. Region filtering is applied
   *  at load time by `filterLayoutByMembership`. */
  layout: SerializedDockview;
}

// AI workbench: `tools | main | chat`, sizes 300 / 520 / 380 (total 1200).
// Mirrors the former imperative `seedAiWorkbench(api, isMember)` byte-for-byte
// modulo dockview's internal leaf-id naming.
const AI_DEFAULT_LAYOUT: SerializedDockview = {
  grid: {
    height: 800,
    width: 1200,
    orientation: Orientation.HORIZONTAL,
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { views: ['tools'], activeView: 'tools', id: 'g-tools' }, size: 300 },
        { type: 'leaf', data: { views: ['main'], activeView: 'main', id: 'g-main' }, size: 520 },
        { type: 'leaf', data: { views: ['chat'], activeView: 'chat', id: 'g-chat' }, size: 380 },
      ],
      size: 800,
    },
  },
  panels: {
    tools: { id: 'tools', contentComponent: 'tools', title: 'Tools' },
    main: { id: 'main', contentComponent: 'main', title: 'Studio' },
    chat: { id: 'chat', contentComponent: 'chat', title: 'ForgeaX CLI' },
  },
  activeGroup: 'g-main',
};

// Interface-alone Scene fallback. An editor host supplies the complete Scene
// arrangement through PanelRenderers.builtinWorkbenchLayouts; this neutral
// shell deliberately contains no editor-business (`ep:*`) panel ids.
const SCENE_DEFAULT_LAYOUT: SerializedDockview = {
  grid: {
    height: 800,
    width: 1200,
    orientation: Orientation.HORIZONTAL,
    root: {
      type: 'branch',
      size: 800,
      data: [
        { type: 'leaf', size: 900, data: { views: ['viewport'], activeView: 'viewport', id: 'g-viewport' } },
        { type: 'leaf', size: 300, data: { views: ['chat'], activeView: 'chat', id: 'g-chat' } },
      ],
    },
  },
  panels: {
    viewport: { id: 'viewport', contentComponent: 'viewport', title: 'Viewport' },
    chat: { id: 'chat', contentComponent: 'chat', title: 'ForgeaX CLI' },
  },
  activeGroup: 'g-viewport',
};

export const BUILTIN_WORKBENCHES: Record<string, BuiltinWorkbenchSpec> = {
  scene: {
    id: 'scene',
    name: 'Scene',
    icon: 'pencil',
    layout: SCENE_DEFAULT_LAYOUT,
  },
  ai: {
    id: 'ai',
    name: 'AI',
    icon: 'bot',
    layout: AI_DEFAULT_LAYOUT,
  },
};

// A branch/leaf node in the dockview grid tree — matches
// `SerializedGridObject<GroupPanelViewState>` from dockview but recursively.
// dockview's own generic types collapse to `T | SerializedGridObject<T>[]` at
// the data slot, so we redeclare in a shape that's easier to narrow here.
interface LeafNode {
  type: 'leaf';
  data: { views: string[]; activeView?: string; id: string };
  size?: number;
}
interface BranchNode {
  type: 'branch';
  data: TreeNode[];
  size?: number;
}
type TreeNode = LeafNode | BranchNode;

/**
 * Filter a SerializedDockview by region membership. Walks the grid tree, drops
 * views/leaves/branches whose panels all fail `isMember`, and returns a new
 * layout containing only the surviving subtree + a compacted `panels` map. If
 * no panel survives, returns null so callers can skip `api.fromJSON` entirely.
 *
 * Region filtering — a panel may live in AuxBar instead of DockShell — happens
 * at layout-load time, not at seed-authoring time; each region owns one
 * DockviewApi instance and passes its own `isMember` predicate.
 */
export function filterLayoutByMembership(
  layout: SerializedDockview,
  isMember: (id: string) => boolean,
): SerializedDockview | null {
  const filterNode = (node: TreeNode): TreeNode | null => {
    if (node.type === 'leaf') {
      const kept = node.data.views.filter(isMember);
      if (kept.length === 0) return null;
      const activeView = node.data.activeView && kept.includes(node.data.activeView)
        ? node.data.activeView
        : kept[0];
      return {
        type: 'leaf',
        size: node.size,
        data: { ...node.data, views: kept, activeView },
      };
    }
    // branch — children may be leaves or nested branches
    const children = node.data
      .map((child) => filterNode(child as TreeNode))
      .filter((child): child is TreeNode => child !== null);
    if (children.length === 0) return null;
    return { type: 'branch', size: node.size, data: children };
  };

  // Cast: dockview types the root as SerializedGridObject<GroupPanelViewState>
  // which is a leaf-OR-branch union spelled the same way we spell it above.
  const filteredRoot = filterNode(layout.grid.root as unknown as TreeNode);
  if (!filteredRoot) return null;

  // Collect the ids of surviving leaves so we can prune the `panels` map.
  const keptIds = new Set<string>();
  const walk = (n: TreeNode): void => {
    if (n.type === 'leaf') n.data.views.forEach((v) => keptIds.add(v));
    else n.data.forEach((c) => walk(c as TreeNode));
  };
  walk(filteredRoot);

  const keptPanels: SerializedDockview['panels'] = {};
  for (const [id, spec] of Object.entries(layout.panels)) {
    if (keptIds.has(id)) keptPanels[id] = spec;
  }

  // Preserve activeGroup only if that leaf survived; otherwise let dockview
  // pick a default (undefined → dockview will use the last-added leaf).
  const survivingLeafIds = new Set<string>();
  const collectLeafIds = (n: TreeNode): void => {
    if (n.type === 'leaf') survivingLeafIds.add(n.data.id);
    else n.data.forEach((c) => collectLeafIds(c as TreeNode));
  };
  collectLeafIds(filteredRoot);

  return {
    grid: {
      ...layout.grid,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root: filteredRoot as any,
    },
    panels: keptPanels,
    activeGroup: layout.activeGroup && survivingLeafIds.has(layout.activeGroup)
      ? layout.activeGroup
      : undefined,
  };
}

/**
 * Materialize the default layout for a workbench. Looks up the spec, filters
 * by region membership, and hands the JSON to dockview. Unknown ids fall
 * through to the AI default (matches the pre-refactor "custom workbench →
 * seedAiWorkbench" branch collapse).
 */
export function buildDefault(
  api: DockviewApi,
  workbenchId: string = 'scene',
  isMember: (id: string) => boolean = ACCEPT_ALL,
  layoutOverride?: SerializedDockview,
): void {
  const spec = BUILTIN_WORKBENCHES[workbenchId] ?? BUILTIN_WORKBENCHES.ai;
  const filtered = filterLayoutByMembership(layoutOverride ?? spec.layout, isMember);
  if (!filtered) return; // no panels survive filter → leave dockview empty
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.fromJSON(filtered as any);
  } catch (e) {
    // fromJSON can throw on invalid layouts; fall back to empty region.
    // eslint-disable-next-line no-console
    console.warn(`[buildDefault] fromJSON failed for '${workbenchId}':`, e);
  }
}
