// @forgeax/editor-panels — panel manifest re-export + component injection
//
// The SSOT for panel IDs lives in @forgeax/editor-core (manifest.ts).
// This file imports from there, re-exports the manifest, and injects the
// concrete panel component list that core (which has no UI dep on panels)
// cannot hold.

// ── Manifest SSOT (from @forgeax/editor-core) ──
export { EDITOR_PANELS } from '@forgeax/editor-core';
export type { EditorPanelId } from '@forgeax/editor-core';

// ── Panel component lookup — injected by panels, not carried by core ──
import React from 'react';
import { AssetsPanel } from './Assets';
import { CapabilitiesPanel } from './Capabilities';
import { HierarchyPanel } from './Hierarchy';
import { HistoryPanel } from './History';
import { InspectorPanel } from './Inspector';
import { MaterialPanel } from './Material';
import { MeshPanel } from './Mesh';
import { LauncherPanel } from './Launcher';
import { AssetInspectorPanel } from './AssetInspector';

// D5 (plan-strategy §2): renamed PANEL_COMPONENTS -> EDITOR_PANEL_COMPONENTS to
// disambiguate from interface's own same-named PANEL_COMPONENTS
// (panelRegistry.tsx). The host injects this map into DockShell's
// renderEditorPanel slot; the EDITOR_ prefix lets an agent grep the correct
// symbol in one hit (research §8 naming; AC-04/AC-05 single-realm injection).
//
// To add a panel: (1) register its id in the EDITOR_PANELS SSOT
// (@forgeax/editor-core manifest.ts); (2) add the component here keyed by that
// id. The host reads this map via renderEditorPanel(id); an unmapped id falls
// back to the "panel not assembled" placeholder (no crash).
export const EDITOR_PANEL_COMPONENTS: Record<string, React.ComponentType<any>> = {
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  assets: AssetsPanel,
  history: HistoryPanel,
  capabilities: CapabilitiesPanel,
  material: MaterialPanel,
  mesh: MeshPanel,
  launcher: LauncherPanel,
  'asset-inspector': AssetInspectorPanel,
};