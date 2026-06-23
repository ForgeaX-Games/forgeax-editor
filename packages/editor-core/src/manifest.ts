// @forgeax/editor-shared — panel manifest (SSOT for all panel IDs)
//
// This is the single source of truth for the 8 dockable editor panel IDs.
// editor-core/sync-channel.ts imports from here; editor-panels/manifest.ts
// re-exports from here and injects the concrete panel component list.
//
// Every consumer that needs panel IDs imports from this file:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-shared';

/** The 10 dockable business panels of the forgeax editor. */
export const EDITOR_PANELS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'material',
  'timeline',
  'matgraph',
  'launcher',
  'asset-inspector',
] as const;

/** Union type of all editor panel IDs — derived from EDITOR_PANELS. */
export type EditorPanelId = (typeof EDITOR_PANELS)[number];