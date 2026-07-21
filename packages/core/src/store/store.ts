// store — the editor's app-level state facade.
//
// Pure re-export facade: the concern clusters live in sibling store/ sub-modules
// (gateway / selection / gizmo-mode / frame-request / rename-request / hover /
// field-preview / ref-request / doc-version / scene-persistence / disk-watch /
// asset-selection / mesh-stats / assets-changed). Consumers keep importing from
// '../store/store'; grep "how does hover work" lands in hover.ts.
//
// NOT forwarded here (@internal-store seams — store/ internal only, never in
// this facade nor the barrel): scene-persistence's worldToPack / scenePath /
// loadSceneByGuid / the `ctx` ScenePersistenceContext handle.
//
// requestFrame applier is registered by edit-runtime via registerSessionApplier;
// headless core returns UNKNOWN_OP (same pattern as play/stop).
//
// Anchor: requirements AC-09 — facade is re-export only, no logic.

// ── cluster 1: gateway (init root) ──
export { gateway } from './gateway';

// ── cluster 2: selection ──
// M3 (D-5, AC-08): the setters (setSelection/toggleSelection/setSelectionMany)
// are SEALED — no longer on this facade nor the barrel. They stay `export`ed at
// the submodule level for in-package tests + the 2 internal callers, but the
// package `exports` map only publishes the barrel, so nothing outside core can
// reach them: the single entry is structurally enforced. Getters/hooks/subscribe
// stay public (consumers still READ state).
export {
  getSelection,
  getSelectionList,
  onSelectionChange,
  useSelection,
  useSelectionList,
} from './selection';

// ── cluster 3: gizmo-mode (setGizmoMode sealed — M3) ──
export {
  getGizmoMode,
  onGizmoModeChange,
  useGizmoMode,
} from './gizmo-mode';
export type { GizmoMode } from './gizmo-mode';

// ── cluster 4: frame-request (applier migrated to edit-runtime via registerSessionApplier — D-11 pattern) ──

// ── cluster 5: rename-request (requestRename sealed — M3; onRenameRequest kept) ──
export { onRenameRequest } from './rename-request';

// ── cluster 6: hover (setHoverEntity sealed — M3) ──
export { getHoverEntity, useHoverEntity } from './hover';

// ── cluster 7: field-preview (setFieldPreview sealed — M3) ──
export { getFieldPreview, useFieldPreview } from './field-preview';

// ── cluster 8: ref-request ──
export {
  requestRefEntity,
  requestRefComponent,
  requestRefAsset,
  requestAddAssetsToChat,
} from './ref-request';

// ── cluster 9: doc-version ──
// M3 (D-6): the origin-less `dispatch` wrapper was deleted (no compat layer,
// AC-08) — consumers call gateway.dispatch(op) directly through the gateway.
export { notifyDocChanged, useDocVersion } from './doc-version';

// ── cluster 10: scene-persistence ──
// M3 (AC-08): setSceneId + saveDocToDisk are SEALED (session ops now dispatched
// via the gateway). switchSceneFile/createSceneFile/loadDocFromDisk stay public —
// host-boot awaits their async result (they are not in the AC-03 sealed set).
export {
  getSceneId,
  getLoadedSceneEntities,
  getSceneFile,
  getSceneList,
  onSceneListChange,
  useSceneList,
  useSceneFile,
  initSceneList,
  switchSceneFile,
  readPlayConfig,
  writePlayConfig,
  createSceneFile,
  loadDocFromStorage,
  stripEditorHiddenMarker,
  loadDocFromDisk,
  instantiateSceneRefUnderWorld,
  resolveAssetRefToHandle,
  hasPendingDiskSave,
  cancelPendingDiskSave,
  flushPendingSaveBeacon,
  replaceDoc,
  inlineAssetCount,
  wouldDropInlineAssets,
  mergeLoadedInlineOrphans,
} from './scene-persistence';
export type { SceneFileEntry, PlayConfig, LoadedInlineSnapshot } from './scene-persistence';

// ── cluster 11: disk-watch ──
export { initDiskWatch } from './disk-watch';

// ── cluster 12: asset-selection (setAssetSelection sealed — M3) ──
export {
  getAssetSelection,
  useAssetSelection,
  getAssetSelectionList,
  useAssetSelectionList,
  clearAssetSelection,
  onAssetSelectionChange,
} from './asset-selection';
export { registerAssetSelectAllHandler, triggerAssetSelectAll } from './asset-select-all';
export type { SelectedAsset } from './asset-selection';

// ── cluster 13: mesh-stats ──
export { publishMeshStats, getMeshStats, useMeshStats } from './mesh-stats';
export type { MeshStats } from './mesh-stats';

// ── cluster 14: assets-changed ──
export { broadcastAssetsChanged } from './assets-changed';
