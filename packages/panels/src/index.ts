// @forgeax/editor-panels — 8 business panel components + manifest
//
// The panel manifest SSOT is in @forgeax/editor-core/manifest. This package
// re-exports the manifest (via manifest.ts, which imports from core and injects
// the concrete component list).
//
// Import panel IDs from the SSOT:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-core';
// Or from panels (which re-exports the same const):
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels';

// ── Manifest (re-exported from @forgeax/editor-core) ──
export { EDITOR_PANELS } from './manifest';
export type { EditorPanelId } from './manifest';
export { EDITOR_PANEL_COMPONENTS } from './manifest';

// ── Panel components ──
export { AssetsPanel } from './Assets';
export { CapabilitiesPanel } from './Capabilities';
export { HierarchyPanel } from './Hierarchy';
export { HistoryPanel } from './History';
export { InspectorPanel } from './Inspector';
// M6/M7 collapse: MaterialGraphPanel + TimelinePanel deleted (engine has no
// MatGraph/Anim equivalent). See plan-strategy S2 D-3, requirements AC-13.
export { LauncherPanel } from './Launcher';
export { AssetInspectorPanel } from './AssetInspector';