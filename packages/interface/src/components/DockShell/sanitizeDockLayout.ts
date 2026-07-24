import type { SerializedDockview } from 'dockview';

/** Retired viewport panel keys from the pre-2026-06-30 edit/preview split. */
const RETIRED_VIEWPORT_KEYS = new Set(['edit', 'preview']);

type GridNode = {
  type?: string;
  data?: unknown;
  views?: string[];
  activeView?: string;
};

function remapGridViews(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const n = node as GridNode;
  if (n.type === 'leaf' && n.data && typeof n.data === 'object') {
    const leaf = n.data as { views?: string[]; activeView?: string };
    if (Array.isArray(leaf.views)) {
      leaf.views = leaf.views.map((v) => (RETIRED_VIEWPORT_KEYS.has(v) ? 'viewport' : v));
    }
    if (leaf.activeView && RETIRED_VIEWPORT_KEYS.has(leaf.activeView)) {
      leaf.activeView = 'viewport';
    }
    return;
  }
  if (n.type === 'branch' && Array.isArray(n.data)) {
    for (const child of n.data) remapGridViews(child);
  }
}

/** Rewrite legacy `edit`/`preview` dock keys to `viewport` before `api.fromJSON`. */
export function sanitizeRetiredDockLayout(layout: SerializedDockview): SerializedDockview {
  const out = structuredClone(layout) as SerializedDockview & {
    panels?: Record<string, { id?: string; contentComponent?: string; title?: string }>;
    grid?: { root?: unknown };
  };

  if (out.grid?.root) remapGridViews(out.grid.root);

  if (out.panels) {
    for (const key of Object.keys(out.panels)) {
      const panel = out.panels[key];
      if (!panel) continue;
      if (RETIRED_VIEWPORT_KEYS.has(panel.contentComponent ?? '')) {
        panel.contentComponent = 'viewport';
      }
      if (RETIRED_VIEWPORT_KEYS.has(key)) {
        const migrated = { ...panel, id: 'viewport', contentComponent: 'viewport' };
        out.panels.viewport = migrated;
        delete out.panels[key];
      } else if (panel.id && RETIRED_VIEWPORT_KEYS.has(panel.id)) {
        panel.id = 'viewport';
      }
    }
  }

  return out;
}
