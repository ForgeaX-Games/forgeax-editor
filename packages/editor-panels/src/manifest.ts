// @forgeax/editor-panels — panel manifest (SSOT for all panel IDs)
//
// This is the single source of truth for the 8 dockable editor panel IDs.
// editor-core/sync-channel.ts re-exports from here to eliminate the
// implicit handshake between panelRegistry, EditorPanelFrame, and the
// sync-channel protocol.
//
// Every consumer that needs panel IDs imports from this file:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels/panels';

/** The 8 dockable business panels of the forgeax editor. */
export const EDITOR_PANELS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'material',
  'timeline',
  'matgraph',
] as const;

/** Union type of all editor panel IDs — derived from EDITOR_PANELS. */
export type EditorPanelId = (typeof EDITOR_PANELS)[number];