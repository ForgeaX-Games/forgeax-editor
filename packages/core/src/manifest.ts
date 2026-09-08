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
  'asset-properties',
  'mesh-slots',
  'mesh-preview',
  'texture-preview',
  'uv-editor',
  'mi-preview',
  'mi-properties',
  'mat-preview',
  'input-map-properties',
  'vfx-system',
  'vfx-preview',
  'vfx-timeline',
  'vfx-details',
  'vfx-diagnostics',
  'settings',
] as const;

/** Union type of all editor panel IDs — derived from EDITOR_PANELS. */
export type EditorPanelId = (typeof EDITOR_PANELS)[number];

/**
 * Public read-model manifest for ScriptablePack consumers. This describes the
 * canonical projection and ordinary Scene operations; it does not register a
 * second operation table. Live operation descriptors remain Engine-owned and
 * are projected by sourceAuthoringOperationManifest().
 */
export const SCRIPTABLE_PACK_READ_MODEL_MANIFEST = Object.freeze({
  schema: 'scriptable-pack-read-model/1',
  sourceKind: 'asset-pack',
  outputKinds: ['mesh', 'material', 'scene'],
  dependencyUsage: ['referenced', 'content-read', 'both'],
  publication: [
    'sourceRevision',
    'generation',
    'digest',
    'outputSetDigest',
    'receipt',
    'current',
    'lastKnownGood',
  ],
  diagnostics: [
    'code',
    'stage',
    'sourcePath',
    'outputGuid',
    'expected',
    'actual',
    'reason',
    'recoveryActions',
  ],
  operations: ['asset.preflight', 'asset-source.create', 'asset-source.add-output', 'asset-source.add-external-asset', 'asset-source.rename', 'asset-source.remove-output', 'asset-source.clone', 'asset-source.rebuild', 'asset-source.cold-cook'],
  ordinaryOperations: ['addSceneAssetToScene', 'setDefaultScene', 'setSceneOverride', 'saveDocToDisk', 'play'],
} as const);

/** Generated Scene structure is producer-owned; only wrapper fields and member
 * fields exposed by SceneInstance overrides are authored in the editor. */
export const GENERATED_SCENE_EDIT_BOUNDARY_MANIFEST = Object.freeze({
  schema: 'generated-scene-edit-boundary/1',
  source: { readOnly: true, actions: ['revealInFileManager', 'promoteImportedScene', 'asset-source.clone'] },
  structure: { readOnly: true, actions: ['revealInFileManager', 'promoteImportedScene', 'asset-source.clone'] },
  outputReference: { readOnly: true, actions: ['revealInFileManager', 'promoteImportedScene', 'asset-source.clone'] },
  wrapper: { readOnly: false, operation: 'setSceneOverride' },
  memberField: { readOnly: false, operation: 'setSceneOverride' },
} as const);

/** Shared English fallback titles used by every host's panel registry. */
export const EDITOR_PANEL_TITLES: Readonly<Record<EditorPanelId, string>> = {
  hierarchy: 'Hierarchy',
  assets: 'Content Browser',
  inspector: 'Inspector',
  history: 'History',
  capabilities: 'Capabilities',
  launcher: 'Launcher',
  'asset-properties': 'Properties',
  'mesh-slots': 'Material Slots',
  'mesh-preview': 'Preview',
  'texture-preview': 'Preview',
  'uv-editor': 'UV Editor',
  'mi-preview': 'Preview',
  'mi-properties': 'Properties',
  'mat-preview': 'Preview',
  'input-map-properties': 'Input Map Properties',
  'vfx-system': 'System Outline',
  'vfx-preview': 'Preview',
  'vfx-timeline': 'Timeline',
  'vfx-details': 'Details',
  'vfx-diagnostics': 'Diagnostics',
  settings: 'Settings',
};
