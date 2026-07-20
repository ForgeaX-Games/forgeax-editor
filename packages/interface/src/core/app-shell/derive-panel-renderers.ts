// packages/interface/src/core/app-shell/derive-panel-renderers.ts
//
// The fold from contribution entries to the PanelRenderers view — ADR 0025
// M2's "manifestToPanelRenderers" direction: the ContributionRegistry is the
// SSOT; host.panels is a memoized snapshot of this pure function.
//
// Merge semantics (carried over from the retired foundation-panels
// mergePanels, re-expressed as a side-effect-free fold):
//   - object fields (overlays / surfaces / chrome / detached / slots /
//     hostSDK / panels / workbenchPanels / editor / builtinWorkbenchLayouts):
//     one-level sub-merge — later patches win per sub-key, siblings preserved
//   - array fields (editorPanelIds): whole-value REPLACE
//   - undefined patch fields: skipped
//   - `base` and patch objects are never mutated (copy-on-write per field)
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';

export function derivePanelRenderers(
  base: PanelRenderers,
  patches: ReadonlyArray<Partial<PanelRenderers>>,
): PanelRenderers {
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const parent = { ...(out[key] as Record<string, unknown> | undefined) };
        for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
          parent[subKey] = subVal;
        }
        out[key] = parent;
      } else {
        out[key] = value;
      }
    }
  }
  return out as unknown as PanelRenderers;
}
