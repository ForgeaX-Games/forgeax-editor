// @forgeax/editor-panels — panel manifest re-export + component injection
//
// The SSOT for panel IDs lives in @forgeax/editor-shared (manifest.ts).
// This file imports from there, re-exports the manifest, and injects the
// concrete panel component list that shared (which has no UI dep on panels)
// cannot hold.

// ── Manifest SSOT (from @forgeax/editor-shared) ──
export { EDITOR_PANELS } from '@forgeax/editor-shared';
export type { EditorPanelId } from '@forgeax/editor-shared';

// ── Panel component lookup — injected by panels, not carried by shared ──
import React from 'react';
import { AssetsPanel } from './Assets';
import { CapabilitiesPanel } from './Capabilities';
import { HierarchyPanel } from './Hierarchy';
import { HistoryPanel } from './History';
import { InspectorPanel } from './Inspector';
import { MaterialPanel } from './Material';
import { MeshPanel } from './Mesh';
import { MaterialGraphPanel } from './MaterialGraph';
import { TimelinePanel } from './Timeline';
import { LauncherPanel } from './Launcher';
import { AssetInspectorPanel } from './AssetInspector';

export const PANEL_COMPONENTS: Record<string, React.ComponentType<any>> = {
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  assets: AssetsPanel,
  history: HistoryPanel,
  capabilities: CapabilitiesPanel,
  material: MaterialPanel,
  mesh: MeshPanel,
  timeline: TimelinePanel,
  matgraph: MaterialGraphPanel,
  launcher: LauncherPanel,
  'asset-inspector': AssetInspectorPanel,
};