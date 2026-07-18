// @forgeax/editor-core — panel manifest (single-SSOT for all editor panel IDs)
//
// This is the single source of truth for editor panel IDs. After
// feat-20260703 (single-realm injection), sync-channel.ts and its inline
// EDITOR_PANELS copy were deleted. lint:sync-channel now guards that this
// file is the ONLY place an EDITOR_PANELS literal exists.
//
// Every consumer that needs panel IDs imports from this file:
//   import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-core';

/** The dockable business panels of the forgeax editor. */
export const EDITOR_PANELS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'launcher',
  'asset-inspector',
] as const;

/** Union type of all editor panel IDs — derived from EDITOR_PANELS. */
export type EditorPanelId = (typeof EDITOR_PANELS)[number];