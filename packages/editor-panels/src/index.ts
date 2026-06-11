// @forgeax/editor-panels — 8 business panel components + manifest
//
// The panel manifest SSOT is in @forgeax/editor-shared (which breaks the
// dep cycle between core and panels). This package re-exports the manifest
// (via manifest.ts, which imports from shared and injects the concrete
// component list).
//
// Import panel IDs from the SSOT:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-shared';
// Or from panels (which re-exports from shared):
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels';

// ── Manifest (re-exported from @forgeax/editor-shared) ──
export { EDITOR_PANELS } from './manifest';
export type { EditorPanelId } from './manifest';
export { PANEL_COMPONENTS } from './manifest';

// ── Panel components ──
export { AssetsPanel } from './Assets';
export { CapabilitiesPanel } from './Capabilities';
export { HierarchyPanel } from './Hierarchy';
export { HistoryPanel } from './History';
export { InspectorPanel } from './Inspector';
export { MaterialPanel } from './Material';
export { MaterialGraphPanel } from './MaterialGraph';
export { TimelinePanel } from './Timeline';