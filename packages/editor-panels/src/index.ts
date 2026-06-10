// @forgeax/editor-panels — 8 business panel components + manifest
//
// The panel manifest (EDITOR_PANELS, EditorPanelId) is the SSOT for all
// dockable editor panel IDs. Import it via:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels';
// Or via the subpath export:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels/panels';

// ── Manifest (SSOT) ──
export { EDITOR_PANELS } from './manifest';
export type { EditorPanelId } from './manifest';

// ── Panel components ──
export { AssetsPanel } from './Assets';
export { CapabilitiesPanel } from './Capabilities';
export { HierarchyPanel } from './Hierarchy';
export { HistoryPanel } from './History';
export { InspectorPanel } from './Inspector';
export { MaterialPanel } from './Material';
export { MaterialGraphPanel } from './MaterialGraph';
export { TimelinePanel } from './Timeline';