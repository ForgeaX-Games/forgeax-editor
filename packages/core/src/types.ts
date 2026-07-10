// editor-core types — the editor's authoring working state (EditSession) and
// the only legal way to mutate it (EditorOp).
// Both human UI and AI produce EditorOps; the applier computes an inverse for
// free Undo. Renamed per plan-strategy D-6 (feat-20260706-editor-op-gateway-…).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// EntityNode + all authorized component types (TransformData, MeshData, etc.)
// deleted. EditSession is now just {world, registry}. Legacy ID → engine
// handle mapping is internal to document.ts.
export type {
  EntityId,
  EntitySource,
  EditSession,
} from './scene/scene-types';
export type { SceneAsset } from '@forgeax/engine-types';
import type { SceneAsset } from '@forgeax/engine-types';
import type { EntityHandle, EntityId, EntitySource } from './scene/scene-types';
import type { SelectedAsset } from './store/asset-selection';

// ── Operations ──────────────────────────────────────────────────────────────
// Each op is a plain JSON object = it doubles as an AI tool-call payload.
// The EditorOp type is the editor's single entry-point for all state mutations
// (plan-strategy §2 D-6). Every op carries enough information for the applier
// to compute an inverse for free Undo.

/** Asset kinds the editor can create from an empty template (Add button).
 *  ⚠️  NOT the engine `Asset['kind']` union (15 kinds) — most kinds are import-only
 *  (mesh/texture/audio/…). This is the editor-side product decision of which
 *  kinds can be blank-created, SSOT in `packages/content-browser/src/creatable-asset-kinds.ts`.
 *
 *  扩展：加一条字面量 + 对应 spec 行 + applier switch case。*/
export type CreatableAssetKind = 'scene';
// 未来扩展示例： 'material' | 'shader' | 'render-pipeline' | 'tileset' | 'prefab'

/** Builtin editor ops — the closed discriminated union of all 25 editor primitives.
 *  Narrowable on `kind` for strong type inference at call sites. Custom ops
 *  registered via registerApplier/defineOp don't need to be added here (AC-27). */
export type BuiltinEditorOp =
  // ── document domain (engine World, SSOT) — produce inverse → undo + ledger ──
  | { kind: 'spawnEntity'; name?: string; parent?: EntityId | null; components?: Record<string, unknown>; source?: EntitySource; /** filled by applier */ _id?: EntityId }
  | { kind: 'destroyEntity'; entity: EntityId }
  | { kind: 'rename'; entity: EntityId; name: string }
  | { kind: 'reparent'; entity: EntityId; parent: EntityId | null }
  | { kind: 'setComponent'; entity: EntityId; component: string; patch: Record<string, unknown> }
  | { kind: 'addComponent'; entity: EntityId; component: string; value: unknown }
  | { kind: 'removeComponent'; entity: EntityId; component: string }
  | { kind: 'setHidden'; entity: EntityId; hidden: boolean }
  // instantiateSceneAsset — re-instantiate a collected SceneAsset POD (from the
  // engine's rootsToSceneAsset) as live world entities, materials round-tripped
  // by GUID. This is the ONE document op both "copy an existing entity" callers
  // project onto: duplicateEntity (Hierarchy Duplicate / Ctrl+D — same parent,
  // "{name} copy") and clipboard paste (root, positional offset). Routing both
  // through the engine scene-asset round-trip fixes the material-loss bug where
  // the old entComponents→spawnComponentData path dropped the source MeshRenderer
  // (BASELINE_NAMES skip + fallback-suppressed), and preserves the child subtree
  // the old single-entity duplicate dropped. `asset` is self-contained so redo
  // replays deterministically (no re-collect). `parent`/`name` retarget the
  // PRIMARY new root; `posOffset` shifts every new root's Transform.pos.
  | { kind: 'instantiateSceneAsset'; asset: SceneAsset; parent?: EntityId | null; name?: string; posOffset?: [number, number, number]; label?: string }
  // duplicateEntity — public convenience document op. Gateway collects `_asset`
  // exactly once from the live source, so redo re-instantiates the same GUID-backed
  // POD even if the original later changes or disappears.
  | { kind: 'duplicateEntity'; entity: EntityId; parent?: EntityId | null; name?: string; posOffset?: [number, number, number]; label?: string; /** Gateway-filled replay snapshot */ _asset?: SceneAsset }
  | { kind: 'transaction'; label: string; commands: EditorOp[] }
  | { kind: 'destroyAsset'; packPath: string; guid: string; /** inverse-of-duplicateAsset: resolves the async clone guid from duplicatedGuidCache */ newGuidCacheKey?: string }
  | { kind: 'restoreAsset'; packPath: string; guid: string; cacheKey?: string }
  | { kind: 'createAsset'; packPath: string; guid: string; assetKind: CreatableAssetKind; name: string; refs?: string[] }
  | { kind: 'renameAsset'; packPath: string; guid: string; newName: string; /** optional UI-known old name; the applier prefers the disk SSOT via renameCacheKey */ oldName?: string; /** inverse resolution key into renamedNameCache */ renameCacheKey?: string }
  | { kind: 'duplicateAsset'; packPath: string; guid: string }
  // ── session domain (editor session state) — no inverse → ledger only (M2) ──
  | { kind: 'setSelection'; id: EntityId | null }
  | { kind: 'toggleSelection'; id: EntityId }
  | { kind: 'setSelectionMany'; ids: EntityId[] }
  | { kind: 'setAssetSelection'; assets: SelectedAsset[]; primary: SelectedAsset | null }
  | { kind: 'setGizmoMode'; mode: 'translate' | 'rotate' | 'scale' }
  | { kind: 'requestFrame' }
  | { kind: 'requestRename'; entity: EntityId }
  | { kind: 'setSceneId'; id: string | null | undefined }
  | { kind: 'switchSceneFile'; id: string }
  | { kind: 'createSceneFile'; id: string; duplicateCurrent: boolean }
  | { kind: 'saveDocToDisk' }
  | { kind: 'loadDocFromDisk' }
  | { kind: 'createDirectory'; parentPath: string; name: string }
  | { kind: 'deleteDirectory'; path: string }
  | { kind: 'setFolderSelection'; paths: string[] }
  | { kind: 'setCBPath'; path: string }
  | { kind: 'cbGoBack' }
  | { kind: 'cbGoForward' }
  // play·stop (plan-strategy §2 D-11): SESSION-domain discrete instantaneous ops.
  // Their real applier (the state machine) lives in edit-runtime (DAG downstream)
  // and is injected via registerSessionApplier at boot; in headless core they are
  // unregistered → dispatch returns UNKNOWN_OP (not silently swallowed). Payload
  // is empty (instantaneous degenerate dispatch — no continuous lifecycle).
  | { kind: 'play' }
  | { kind: 'stop' }
  | { kind: 'setDisplay'; display: 'scene' | 'game' }
  // scan pipeline ops (north-star §6/§8) — SESSION-domain, ledger-only, no undo
  | { kind: 'assetCatalogRefreshed'; added: string[]; removed: string[]; reimported: string[] }
  | { kind: 'assetReimported'; path: string; guid: string; reason: 'content-changed' | 'importer-upgraded' | 'ddc-missing' }
  | { kind: 'assetOrphanDetected'; sourcePath: string; metaPath: string }
  | { kind: 'assetValidationFailed'; diagnostics: import('./scan/scan-diagnostic').ScanDiagnostic[] }
  | { kind: 'requestReimport'; paths: string[] }
  // ── transient domain (transient view state) — no inverse, no ledger (M2) ──
  | { kind: 'setHoverEntity'; id: EntityId | null }
  | { kind: 'setFieldPreview'; id: EntityId | null; key?: string; value?: number }
  ;

/** EditorOp — the open union type for all editor operations.
 *  BuiltinEditorOp preserves discriminated union narrowing for the 24 builtin
 *  kinds. Additional kinds registered via registerApplier/defineOp dispatch through
 *  the `{kind: string}`-shaped open tail without requiring `as EditorOp` casts
 *  (AC-27 — type-layer inversion matching runtime dispatch which has always been
 *  keyed on `kind: string`). */
export type EditorOp = BuiltinEditorOp | { kind: string; [key: string]: unknown };

/** Narrow an EditorOp to its entity-id-bearing shape (spawn ops carry _id).
 *  Used in test helpers to recover the typed `_id` field after the EditorOp
 *  union was opened to accommodate custom ops. */
export type WithEntityId = { _id?: number; [key: string]: unknown };


/**
 * Lifecycle op alias — begin/update/commit/cancel all use the same EditorOp
 * union type. Instantaneous ops = begin=commit degenerate dispatch (no update
 * phase). plan-strategy §2 D-2.
 */
export type EditorOpLifecycle = EditorOp;

// ── Error codes (plan-strategy §2 D-7) ──────────────────────────────────────

export interface CommandError {
  code:
    // ── Existing document-domain codes (NO CHANGE) ──
    | 'NO_SUCH_ENTITY'
    | 'NO_SUCH_COMPONENT'
    | 'COMPONENT_EXISTS'
    | 'INVALID_PARENT'
    | 'EMPTY_TRANSACTION'
    | 'SPAWN_FAILED'
    | 'DESPAWN_FAILED'
    | 'RENAME_FAILED'
    | 'REPARENT_FAILED'
    | 'SET_FAILED'
    | 'ADD_FAILED'
    | 'REMOVE_FAILED'
    | 'HIDE_FAILED'
    | 'UNHIDE_FAILED'
    // instantiateSceneAsset: the engine scene-asset round-trip (collect →
    // registry.instantiateFlat) or a post-instantiate retarget step failed.
    | 'INSTANTIATE_FAILED'
    // Gateway-owned scene-asset collection failures. These are distinct from
    // INSTANTIATE_FAILED so callers know the source read failed before any write.
    | 'NO_REGISTRY'
    | 'WORLD_UNAVAILABLE'
    | 'SCENE_COLLECT_FAILED'
    | 'NO_NAME_COMPONENT'
    | 'PROTECTED_COMPONENT'
    // ── New gateway-layer codes (plan-strategy §2 D-7) ──
    | 'UNKNOWN_OP'
    | 'INVALID_ARGS'
    | 'OP_ID_CONFLICT'
    | 'PLAN_FAILED'
    | 'PLAN_STEP_FAILED'
    | 'UNKNOWN_COMPONENT'
    | 'OP_INTERRUPTED'
    // Asset read surface (Part 4): resolveAsset/describeAsset given a handle that
    // resolves to no asset (slot 0 unset, stale, or not a shared<T> handle).
    | 'ASSET_NOT_FOUND'
    // ── M5 eval channel codes (plan-strategy §2 D-4) ──
    | 'SCOPE_LOCKED'
    | 'SCRIPT_SYNTAX_ERROR'
    | 'SCRIPT_RUNTIME_ERROR'
    // ── feat-20260707-editor-world-fork M2 (plan-strategy D-5) ──
    // Play-mode write gate: a document-domain dispatch was attempted while
    // gateway.mode === 'play'. play data is a read-only simulation view; editing
    // must not write the (frozen) edit world nor the play world (Edit != Play).
    // kebab-case to match the M1 error-shape convention (stale-entity-handle).
    | 'edit-rejected-in-play'
    // ── Scan infrastructure codes (startup scan lock) ──
    | 'scan-in-progress';
  hint: string;
}

export type ApplyResult =
  // `created` — the new entity roots this op produced (spawn: [handle];
  // instantiate/duplicate: the new roots; transaction: all sub-ops' roots
  // flattened). Empty [] for non-creating ops (setComponent/rename/…) so
  // consumers read result.created without an undefined check. This is the ONE
  // out-channel for post-dispatch reads (selection, AI "what did I just make?")
  // — replaces the old in-place cmd._id / cmd._newRoots rewrite (which JSON
  // couldn't carry back over the eval bridge).
  | { ok: true; inverse: EditorOp; created: EntityHandle[] }
  | { ok: false; error: CommandError };
