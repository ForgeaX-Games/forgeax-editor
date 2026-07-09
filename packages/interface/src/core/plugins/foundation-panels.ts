// packages/interface/src/core/plugins/foundation-panels.ts
import type { AppHost, AppPlugin } from '../app-shell/types';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';

/** Merge helper — writes patch fields into host.panels mutably, returns
 *  cleanup that restores the previous value. `host.panels` is defined as
 *  readonly on AppHostBase for external consumers, but createAppHost
 *  intentionally makes it mutable so plugins can layer contributions.
 *
 *  Sub-object merge (recurse one level to preserve sibling keys) covers:
 *    overlays / surfaces / chrome / detached / slots / hostSDK  (6 category maps)
 *    panels / workbenchPanels                                    (2 flat keyed maps)
 *  Array fields (editorPanelIds) fall to the else branch and REPLACE. */
function mergePanels(host: AppHost, patch: Partial<PanelRenderers>): () => void {
  const target = host.panels as unknown as Record<string, unknown>;
  const undos: Array<() => void> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const parent = (target[key] as Record<string, unknown> | undefined)
        ?? (target[key] = {} as Record<string, unknown>);
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        const prev = parent[subKey];
        parent[subKey] = subVal;
        undos.push(() => { if (prev === undefined) delete parent[subKey]; else parent[subKey] = prev; });
      }
    } else {
      const prev = target[key];
      target[key] = value;
      undos.push(() => { if (prev === undefined) delete target[key]; else target[key] = prev; });
    }
  }
  let applied = true;
  return () => {
    if (!applied) return;
    applied = false;
    // .slice() so the array isn't mutated in place — safe if someone rebinds.
    for (const u of undos.slice().reverse()) u();
  };
}

export const foundationPanelsPlugin: AppPlugin & {
  contributePanels: (host: AppHost, patch: Partial<PanelRenderers>) => () => void;
} = {
  id: 'foundation.panels', version: '1.0.0', provides: [],
  contributePanels: mergePanels,
  setup(_ctx) {
    // ctx.contributePanels is wired at loader-glue level (see host bootstrap
    // in Task 20). This plugin only exposes the helper for the ctx factory
    // to close over.
  },
};
