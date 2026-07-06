// store — the editor's app-level state facade.
//
// This file used to hold the whole store (1344 lines). It is now a PURE
// re-export facade: the 14 concern clusters live in sibling store/ sub-modules
// (bus / selection / gizmo-mode / frame-request / rename-request / hover /
// field-preview / ref-request / doc-version / scene-persistence / disk-watch /
// asset-selection / mesh-stats / assets-changed) and this facade forwards
// exactly the 70 public symbols the barrel + intra-core consumers already
// import, so their import paths and the barrel snapshot (AC-01) are unchanged.
//
// Consumers keep importing from '../store/store'; grep "how does hover work"
// now lands in hover.ts, not 1344 lines (charter F1 / P1).
//
// NOT forwarded here (D-6 @internal-store seams — store/ internal only, never in
// this facade nor the barrel): scene-persistence's worldToPack / scenePath /
// loadSceneByGuid / _isDirty / currentSceneGuid / _setDirty / _setCurrentSceneGuid.
//
// The old clip-control import (F-10) had no consuming body left after the split,
// so it is absent here — not deleted as cleanup, simply nothing to host.
//
// Anchors:
//   plan-strategy §2 D-2: 14-cluster split + store.ts pure facade
//   plan-strategy §2 D-6: internal seams excluded; §2 D-7: 4 dead exports still
//     forwarded verbatim (onFrameRequest / isSelected / buildHiddenKey /
//     clearDocStorage)
//   requirements AC-01: barrel export-surface snapshot unchanged
//   requirements AC-09: facade is re-export only — no logic, no dispatch-op-ing

// ── cluster 1: bus (init root) ──
export { bus } from './bus';

// ── cluster 2: selection ──
export {
  getSelection,
  getSelectionList,
  isSelected,
  setSelection,
  toggleSelection,
  setSelectionMany,
  onSelectionChange,
  useSelection,
  useSelectionList,
} from './selection';

// ── cluster 3: gizmo-mode ──
export {
  getGizmoMode,
  setGizmoMode,
  onGizmoModeChange,
  useGizmoMode,
} from './gizmo-mode';
export type { GizmoMode } from './gizmo-mode';

// ── cluster 4: frame-request ──
export { requestFrame, onFrameRequest } from './frame-request';

// ── cluster 5: rename-request ──
export { requestRename, onRenameRequest } from './rename-request';

// ── cluster 6: hover ──
export { setHoverEntity, getHoverEntity, useHoverEntity } from './hover';

// ── cluster 7: field-preview ──
export { setFieldPreview, getFieldPreview, useFieldPreview } from './field-preview';

// ── cluster 8: ref-request ──
export {
  requestRefEntity,
  requestRefComponent,
  requestRefAsset,
  requestAddAssetsToChat,
} from './ref-request';

// ── cluster 9: doc-version ──
export { notifyDocChanged, useDocVersion, dispatch } from './doc-version';

// ── cluster 10: scene-persistence ──
export {
  buildHiddenKey,
  setSceneId,
  getSceneId,
  getLoadedSceneRoot,
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
  rebindLoadedScene,
  saveDocToDisk,
  hasPendingDiskSave,
  cancelPendingDiskSave,
  flushPendingSaveBeacon,
  replaceDoc,
  clearDocStorage,
  inlineAssetCount,
} from './scene-persistence';
export type { SceneFileEntry, PlayConfig } from './scene-persistence';

// ── cluster 11: disk-watch ──
export { initDiskWatch } from './disk-watch';

// ── cluster 12: asset-selection ──
export {
  setAssetSelection,
  getAssetSelection,
  useAssetSelection,
  onAssetSelectionChange,
} from './asset-selection';
export type { SelectedAsset } from './asset-selection';

// ── cluster 13: mesh-stats ──
export { publishMeshStats, getMeshStats, useMeshStats } from './mesh-stats';
export type { MeshStats } from './mesh-stats';

// ── cluster 14: assets-changed ──
export { broadcastAssetsChanged } from './assets-changed';
