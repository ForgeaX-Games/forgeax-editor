// editor-core types — the editor's authoring working state (EditSession) and
// the only legal way to mutate it (EditorOp).
// Both human UI and AI produce EditorOps; the applier computes an inverse for
// free Undo. EditSession is {world, registry}; entity state lives in the
// engine World (single SSOT).
export type {
  EntityId,
  EntitySource,
  EditSession,
} from './scene/scene-types';
export type { SceneAsset } from '@forgeax/engine-types';
import type { SceneAsset } from '@forgeax/engine-types';
import type { VisibilityState } from '@forgeax/engine-render';
import type { CommandErrorContext, ErrorSubjectRef } from '@forgeax/editor-product';
import type { EntityHandle, EntityId, EntitySource } from './scene/scene-types';
import type { SelectedAsset } from './store/asset-selection';
import type { AssetSourceMutationScope } from '@forgeax/editor-product';

// ── Operations ──────────────────────────────────────────────────────────────
// Each op is a plain JSON object = it doubles as an AI tool-call payload.
// The EditorOp type is the editor's single entry-point for all state mutations
// (plan-strategy §2 D-6). Every op carries enough information for the applier
// to compute an inverse for free Undo.

/** Asset kinds the editor can create from an empty template (Add button).
 *  Warning: NOT the engine `Asset['kind']` union (15 kinds) — most kinds are import-only
 *  (mesh/texture/audio/…). This is the editor-side product decision of which
 *  kinds can be blank-created, SSOT in `packages/content-browser/src/creatable-asset-kinds.ts`.
 *
 *  To extend: add one literal, its spec row, and the applier switch case. */
export type CreatableAssetKind = 'scene' | 'material' | 'material-instance' | 'particle-effect' | 'input-map';
// Future examples: 'shader' | 'render-pipeline' | 'tileset' | 'prefab'

/** Builtin editor ops — the closed discriminated union of all 25 editor primitives.
 *  Narrowable on `kind` for strong type inference at call sites. Custom ops
 *  registered via registerApplier/defineOp don't need to be added here (AC-27). */
export type BuiltinEditorOp =
  // ── document domain (engine World, SSOT) — produce inverse → undo + ledger ──
  | { kind: 'spawnEntity'; name?: string; parent?: EntityId | null; components?: Record<string, unknown>; source?: EntitySource; /** filled by applier */ _id?: EntityId }
  | { kind: 'destroyEntity'; entity: EntityId;
    /** Gateway-filled scene-asset snapshot for material-preserving undo (GUID round-trip). */
    _asset?: SceneAsset;
    /** Parent handle of the root entity at destroy time (undo restores hierarchy). */
    _parent?: EntityId | null;
    /** Name of the root entity at destroy time (undo restores display name). */
    _name?: string }
  | { kind: 'rename'; entity: EntityId; name: string }
  | { kind: 'reparent'; entity: EntityId; parent: EntityId | null }
  | {
    kind: 'hierarchyGesture';
    action: 'reparent' | 'delete' | 'visibility' | 'group' | 'ungroup' | 'duplicate';
    entities: EntityId[];
    parent?: EntityId | null;
    state?: VisibilityState;
  }
  | { kind: 'setComponent'; entity: EntityId; component: string; patch: Record<string, unknown> }
  | { kind: 'setSceneOverride'; root: EntityId; member: EntityId; component: string; field: string; value: unknown; /** Gateway-filled prior state for undo. */ _beforeHadOverride?: boolean; _beforeOverride?: unknown }
  | { kind: 'removeSceneOverride'; root: EntityId; member: EntityId; component: string; field: string }
  | { kind: 'addComponent'; entity: EntityId; component: string; value: unknown }
  | { kind: 'removeComponent'; entity: EntityId; component: string }
  | { kind: 'setVisibility'; entity: EntityId; state: VisibilityState }
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
  | { kind: 'applyVisualQualityPreset'; preset: 'draft' | 'balanced' | 'cinematic' }
  | { kind: 'transaction'; label: string; commands: EditorOp[] }
  | { kind: 'destroyAsset'; guid: string; /** internal IO location derived by Gateway or the producing inverse */ _resolvedPackPath?: string; /** inverse-of-duplicateAsset: resolves the async clone guid from duplicatedGuidCache */ newGuidCacheKey?: string }
  | { kind: 'restoreAsset'; guid: string; _resolvedPackPath: string; cacheKey?: string }
  | { kind: 'createAsset'; packPath: string; guid: string; assetKind: CreatableAssetKind; name: string; refs?: string[] }
  // createMaterial (solo round-12 / P5 rendering-authoring): mint a NEW PBR
  // MaterialAsset from params (sRGB baseColor; linear metallic/roughness) into a pack, so an AI
  // can AUTHOR a look — not just BIND an existing catalogued GUID (bindAssetRef,
  // round-11). DOCUMENT-domain like createAsset (undoable, inverse=destroyAsset),
  // but param-driven (createAsset builds only blank payloads) and CATALOGUED (AI-
  // discoverable — the wart createAsset never fixed). The POD is built by the
  // engine's canonical Materials.standard() builder (§2.5 — no hand-rolled passes).
  // `guid` is caller-minted (the dispatch contract has no channel to return one;
  // the caller reuses the same guid for the follow-up bindAssetRef). `packPath`
  // optional — defaults to the active game's scene.pack.json in the applier.
  | { kind: 'createMaterial'; guid: string; name: string; baseColor: [number, number, number, number]; metallic?: number; roughness?: number; baseColorTexture?: string; alphaCutoff?: number; packPath?: string; refs?: string[] }
  | { kind: 'writeUi'; guid: string; name: string; html: string; css: string; sourcePath?: string; packPath?: string }
  | { kind: 'restoreWrittenAsset'; packPath: string; guid: string; cacheKey: string }
  | { kind: 'renameAsset'; packPath: string; guid: string; newName: string; /** optional UI-known old name; the applier prefers the disk SSOT via renameCacheKey */ oldName?: string; /** inverse resolution key into renamedNameCache */ renameCacheKey?: string }
  | { kind: 'duplicateAsset'; packPath: string; guid: string }
  // updateMaterialParams (material-editor M1): update an existing MaterialAsset's
  // values in-place. Authored colors default to sRGB and remain numerically
  // unchanged on disk. DOCUMENT-domain (undoable — inverse carries old patch).
  // Shallow-merges paramPatch into the asset's values; writes the new entry
  // through ctx.assetIO then invalidates the registry cache for hot viewport reload.
  // Gateway fills _oldPatch / _oldRefs / _oldEntry synchronously from the catalog.
  | { kind: 'updateMaterialParams'; packPath: string; guid: string; paramPatch: Record<string, unknown>; textureGuids?: Record<string, string | null>; _oldPatch?: Record<string, unknown>; _oldRefs?: string[]; _oldEntry?: unknown }
  // createMaterialInstance (MI editor M1/A3): mint a Material Instance that
  // references a parent Material (or MI). DOCUMENT-domain; inverse=destroyAsset.
  // Caller mints `guid`. Overrides use {enabled,value} (UE-style); runtime
  // rendering resolves via material-instance-resolve → MaterialAsset values.
  | { kind: 'createMaterialInstance'; guid: string; name: string; parentGuid: string; overrides?: Record<string, { enabled: boolean; value?: unknown }>; physMaterial?: string; lightmass?: { castShadowsAsMasked?: boolean; emissiveBoost?: number; diffuseBoost?: number; exportResolutionScale?: number }; packPath?: string }
  // saveMaterialInstance: replace the whole MI payload (staging flush). Gateway
  // fills `_oldEntry` for undo.
  | { kind: 'saveMaterialInstance'; packPath: string; guid: string; payload: Record<string, unknown>; _oldEntry?: unknown }
  | { kind: 'createInputMap'; guid: string; name: string; actions?: readonly { action: string; bindings: readonly unknown[]; deadzone?: number }[]; packPath?: string }
  | { kind: 'saveInputMap'; packPath: string; guid: string; payload: Record<string, unknown>; _oldEntry?: unknown }
  | { kind: 'setMaterialInstanceParent'; packPath: string; guid: string; parentGuid: string; _oldEntry?: unknown; _catalogEntries?: unknown[] }
  | { kind: 'setMaterialInstanceOverride'; packPath: string; guid: string; paramKey: string; enabled: boolean; value?: unknown; bucket?: 'overrides' | 'propertyOverrides'; _oldEntry?: unknown }
  | { kind: 'setMaterialInstanceLightmass'; packPath: string; guid: string; lightmassPatch: { castShadowsAsMasked?: boolean; emissiveBoost?: number; diffuseBoost?: number; exportResolutionScale?: number }; _oldEntry?: unknown }
  // ── session domain (editor session state) — no inverse → ledger only (M2) ──
  | { kind: 'setSelection'; id: EntityId | null }
  | { kind: 'toggleSelection'; id: EntityId }
  | { kind: 'setSelectionMany'; ids: EntityId[] }
  | { kind: 'setAssetSelection'; assets: SelectedAsset[]; primary: SelectedAsset | null }
  | { kind: 'assignAssetToEntity'; entity: EntityId; asset: { guid: string; kind: string; name: string }; requestId: string }
  | { kind: 'openAssetEditor'; asset: SelectedAsset }
  | { kind: 'setGizmoMode'; mode: 'translate' | 'rotate' | 'scale' }
  | { kind: 'setGizmoPivot'; pivot: 'center' | 'lastSelected' }
  | { kind: 'requestFrame' }
  | { kind: 'cameraSetProjection'; projection: 'perspective' | 'orthographic' }
  | { kind: 'cameraToggleProjection' }
  // cameraSetView: UE-style view preset — a projection + axis-aligned orientation
  // pair. Axis views imply orthographic; 'perspective' restores the perspective
  // projection keeping the current orbit direction (pitch re-clamped to the
  // perspective range). A free orthographic camera (V toggle) is NOT a preset —
  // it derives the 'orthographic' label, never a settable value.
  | { kind: 'cameraSetView'; view: 'perspective' | 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' }
  | { kind: 'cameraAdjustFov'; delta: number }
  | { kind: 'cameraZoom'; delta: number }
  | { kind: 'cameraBookmark'; action: 'save' | 'recall' | 'clear'; slot: number }
  // Viewport interaction preferences (mouse/wheel/fly sensitivity + view-scale
  // defaults). Editor chrome session state — the applier + reactive store live
  // in core (store/viewport-preferences.ts, gizmo-pivot pattern); partial patch,
  // every field optional, values clamped by the applier (fail-closed normalize).
  | { kind: 'setViewportPreferences'; patch: {
      mouseSensitivity?: number;
      invertY?: boolean;
      wheelDirection?: 1 | -1;
      wheelSpeedScalar?: number;
      flyBoostMultiplier?: number;
      flySpeed?: number;
      fov?: number;
      projection?: 'perspective' | 'orthographic';
    } }
  // captureFrame is a request-correlated session operation. The actual RHI
  // recorder lives in edit-runtime/engine; the gateway owns the invocation
  // door and the OperationRun result channel.
  | { kind: 'captureFrame'; frames?: number; requestId: string; retryOfRequestId?: string }
  // captureCpuProfile is the bounded Engine-owned CPU observation operation;
  // the Editor only provides the Gateway/applier projection.
  | { kind: 'captureCpuProfile'; frames?: number; eventLimit?: number; requestId: string; retryOfRequestId?: string }
  // Session-only VFX preview control. The runtime owner replays the selected
  // live player at the next fixed-tick boundary; authored scene data is unchanged.
  | { kind: 'replayParticleEffect'; entity: EntityId }
  | { kind: 'requestRename'; entity: EntityId }
  | { kind: 'setSceneId'; id: string | null | undefined }
  // switchSceneFile is request-correlated: scene loading is asynchronous and
  // callers must read the Gateway-owned terminal result instead of treating the
  // dispatch acceptance as a successful scene change.
  | { kind: 'switchSceneFile'; id: string; dirtyPolicy?: SceneSwitchDirtyPolicy; requestId: string; retryOfRequestId?: string }
  | { kind: 'previewImportedScene'; guid: string; sourceKey: string; sourcePath?: string; revision: string; requestId: string }
  | { kind: 'asset.preflight'; guid: string; scope: AssetSourceMutationScope; requestId: string }
  | { kind: 'previewAssetSourceMutation'; guid: string; scope: AssetSourceMutationScope; expectedRevision: string; requestId: string }
  | { kind: 'saveAssetSourceOverride'; guid: string; scope: AssetSourceMutationScope; expectedRevision: string; override: Record<string, unknown>; requestId: string; retryOfRequestId?: string }
  | { kind: 'discardSourceOverridesAndReimport'; guid: string; scope: AssetSourceMutationScope; expectedRevision: string; confirmationToken: string; requestId: string; retryOfRequestId?: string }
  | {
    kind: 'promoteImportedScene';
    importedGuid: string;
    sourceKey: string;
    revision: string;
    targetPackPath: string;
    targetName: string;
    contentPolicy: 'effective-base' | 'current-session';
    discardSourceChanges?: boolean;
    requestId: string;
  }
  | { kind: 'createSceneFile'; id: string; duplicateCurrent: boolean; requestId: string; retryOfRequestId?: string }
  | { kind: 'setDefaultScene'; sceneGuid: string; requestId: string; retryOfRequestId?: string }
  | { kind: 'deleteScene'; sceneGuid: string; requestId: string; retryOfRequestId?: string }
  | { kind: 'saveDocToDisk'; requestId?: string; retryOfRequestId?: string }
  | { kind: 'loadDocFromDisk' }
  | { kind: 'createDirectory'; parentPath: string; name: string }
  | { kind: 'deleteDirectory'; path: string }
  // renameDirectory / renameSourceFile: filesystem rename through the asset IO
  // write gate. `path` is game-relative; `newName` is the target basename only
  // (not a full path). Session-domain, no undo.
  | { kind: 'renameDirectory'; path: string; newName: string }
  | { kind: 'renameSourceFile'; path: string; newName: string }
  | { kind: 'revealInFileManager'; path: string }
  // deleteSourceFile (editor data-operation-view convergence M1): delete one
  // game-relative source file through the asset IO write gate. Dispatch is
  // synchronous acceptance; callers poll the terminal status by requestId.
  | { kind: 'deleteSourceFile'; path: string; requestId: string }
  // importAsset (Invariant 7 convergence): Runtime receives optional source bytes,
  // writes them through assetIO, then imports the same path. Path-only AI/startup
  // callers keep skipUpload=true. UI CSS is a bounded companion of one UI import,
  // not an independently authored asset.
  | {
    kind: 'importAsset';
    destPath: string;
    sourceName?: string;
    base64?: string;
    companionSources?: readonly { destPath: string; base64: string }[];
    skipUpload?: boolean;
    requestId: string;
  }
  // Catalog reconciliation is a read-only recovery projection. It invokes the
  // existing replica seam and therefore never enters the authored ledger.
  | { kind: 'catalog.reconcile'; requestId: string; retryOfRequestId?: string }
  // Reimport uses the existing source metadata as the producer-owned identity
  // and settings input; missing metadata is a structured terminal failure.
  | { kind: 'reimportAsset'; guid: string; scope: AssetSourceMutationScope; expectedRevision: string; requestId: string; retryOfRequestId?: string }
  // addSceneAssetToScene (R0-05B): a catalogued scene sub-asset is placed by GUID.
  // SESSION-domain, ledger-only, request-correlated async — requestId is the
  // independent Gateway OperationRun identity, so concurrent mounts do not race
  // over a latest-only phase/error slot. The nested SceneInstance subtree is the
  // engine's derived cache; the wrapper's SceneInstance ref is the authored fact
  // that round-trips as one mounts[] entry. If async instantiation fails, the
  // provisional wrapper is rolled back through destroyEntity and terminal
  // error.current.cleanup reports the cleanup facts.
  | { kind: 'addSceneAssetToScene'; sceneGuid: string; name?: string; requestId: string }
  // bindAssetRef (R0-05C): resolve catalogued GUIDs to live shared<T> handles and
  // write them into a component field. SESSION-domain, ledger-only, async; the
  // caller-minted requestId identifies the terminal Gateway OperationRun. The
  // nested setComponent remains the authored undoable write. `slot` targets one
  // array element; omit it to write the whole field from `guids`.
  | { kind: 'bindAssetRef'; entity: EntityHandle; component: string; field: string; assetType: string; guids: string[]; slot?: number; requestId: string }
  // setAnimationPreview (animation-preview M1): drive an entity's AnimationPlayer
  // playback transport for Inspector preview. SESSION-domain, ledger-only, no undo
  // — preview is session state, not authored intent. The applier snapshots the
  // reflection-declared runtimeFields before the first preview write; the
  // save/play/selection-change boundaries restore them so a preview never
  // pollutes the saved document. Transport field names come from the component's
  // reflected playback contract (meta.animation; editor overlay interim).
  | { kind: 'setAnimationPreview'; entity: EntityId; playing?: boolean; speed?: number; phase?: number }
  | { kind: 'setFolderSelection'; paths?: string[]; items?: { path: string; kind: 'dir' | 'file' }[] }
  | { kind: 'setCBPath'; path: string }
  | { kind: 'cbGoBack' }
  | { kind: 'cbGoForward' }
  // play·stop (plan-strategy §2 D-11): SESSION-domain discrete instantaneous ops.
  // Their real applier (the state machine) lives in edit-runtime (DAG downstream)
  // and is injected via registerSessionApplier at boot; in headless core they are
  // unregistered → dispatch returns UNKNOWN_OP (not silently swallowed). The
  // optional policy keeps direct runtime callers on the historical Last Saved
  // default; UI and AI callers should provide it explicitly.
  | { kind: 'play'; dirtyPolicy?: PlayDirtyPolicy }
  | { kind: 'stop' }
  | { kind: 'setDisplay'; display: 'scene' | 'game' }
  // scan pipeline ops (north-star §6/§8) — SESSION-domain, ledger-only, no undo
  | { kind: 'assetCatalogRefreshed'; added: string[]; removed: string[]; reimported: string[] }
  | { kind: 'assetReimported'; path: string; guid: string; reason: 'content-changed' | 'importer-upgraded' | 'ddc-missing' }
  | { kind: 'assetOrphanDetected'; sourcePath: string; metaPath: string }
  | { kind: 'assetValidationFailed'; diagnostics: import('./scan/scan-diagnostic').ScanDiagnostic[] }
  | { kind: 'requestReimport'; paths: string[] }
  // validateGameProject is a host-owned session operation. The producer
  // validator remains scripts/game-validation.mjs; the host supplies its
  // project access and the Gateway owns only the correlated run/result door.
  | { kind: 'validateGameProject'; requestId: string; maxBytes?: number; maxEntities?: number; retryOfRequestId?: string }
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

/** What Play does when the authored scene has unsaved in-memory edits. */
export type PlayDirtyPolicy = 'last-saved' | 'save-then-play' | 'cancel';

/** What a scene switch does when the outgoing authored scene is dirty. */
export type SceneSwitchDirtyPolicy = 'save' | 'discard' | 'cancel';

// ── Error codes (plan-strategy §2 D-7) ──────────────────────────────────────

export type SourceAuthoringPhase = 'entry' | 'cas' | 'cook' | 'validation' | 'publication' | 'gap';

export interface SourceAuthoringSubjectRef extends ErrorSubjectRef {
  readonly kind: 'asset-source';
  readonly guid: string;
  readonly sourceKey?: string;
}

export interface CommandError extends CommandErrorContext {
  /** Operation-specific structured validation details (for example fieldPath). */
  readonly details?: unknown;
  readonly phase?: SourceAuthoringPhase;
  readonly runId?: string;
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
    | 'editor-document-not-found'
    | 'editor-document-protected'
    // Accepted async source-file deletion failed at the filesystem boundary.
    | 'SOURCE_FILE_DELETE_FAILED'
    | 'SOURCE_FILE_VERIFY_FAILED'
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
    | 'edit-rejected-in-imported-preview'
    | 'save-rejected-in-imported-preview'
    | 'preview-rejected-dirty'
    | 'mount-member-operation-unsupported'
    | 'engine-source-authoring-unavailable'
    | 'asset-source-key-missing'
    | 'asset-source-key-unknown'
    | 'asset-source-key-ambiguous'
    | 'asset-meta-revision-conflict'
    | 'asset-confirmation-required'
    | 'asset-confirmation-expired'
    | 'asset-confirmation-mismatch'
    | 'asset-validation-failed'
    | 'asset-cook-failed'
    | 'asset-publish-observation-timeout'
    | 'asset-catalog-subscription-gap'
    | 'asset-operation-failed'
    | 'asset-operation-cas-committed'
    | 'run-cancelled-before-cas'
    | 'promote-capability-unavailable'
    | 'promote-session-mismatch'
    | 'promote-current-session-unavailable'
    | 'promote-dirty-confirmation-required'
    | 'promote-target-invalid'
    | 'promote-target-collision'
    | 'promote-guid-allocation-failed'
    | 'promote-serialization-failed'
    | 'promote-write-failed'
    | 'promote-activation-failed'
    // ── Scan infrastructure codes (startup scan lock) ──
    | 'scan-in-progress'
    // ── solo round-8 #3: ▶ Play async-assembly failure ──
    // playSimulation()'s assemble() degraded back to edit (bad scene / createApp
    // error). Surfaced through gateway.failPlayAttempt so playPhase reads 'failed'
    // + lastPlayError carries this — instead of dispatch({kind:'play'}) returning
    // {ok:true} while play silently never started (the round-3/5 misdiagnosis trap).
    | 'play-assemble-failed'
    // Play was requested with save-then-play, but the canonical Gateway save
    // did not reach a succeeded terminal run.
    | 'play-save-failed'
    // Play was explicitly cancelled because the authored scene was dirty.
    | 'play-cancelled-dirty'
    // Scene switching must not silently flush authored edits. Callers either
    // choose save/discard explicitly or branch on this structured refusal.
    | 'scene-switch-invalid'
    | 'scene-switch-load-failed'
    | 'scene-switch-dirty'
    | 'scene-switch-cancelled'
    // R0-02C: create/duplicate is one request-correlated run spanning file
    // write, scene-list publication, and in-place navigation.
    | 'scene-create-invalid'
    | 'scene-create-serialize-failed'
    | 'scene-create-write-failed'
    | 'scene-create-navigate-failed'
    | 'scene-create-rollback-failed'
    // R0-02D: forge.json.defaultScene write and read-back verification.
    | 'scene-default-invalid'
    | 'scene-default-read-failed'
    | 'scene-default-write-failed'
    | 'scene-default-verify-failed'
    | 'scene-delete-invalid'
    | 'scene-delete-guarded'
    | 'scene-delete-read-failed'
    | 'scene-delete-write-failed'
    | 'scene-delete-verify-failed'
    // ── solo round-28: async scene-mount failure ──
    // addSceneAssetToScene loads + instantiates a catalogued SceneAsset in a
    // detached session continuation. Its accepted dispatch must still expose the
    // terminal outcome through the same gateway read surface — never console-only.
    | 'scene-mount-failed'
    | 'scene-preview-failed'
    // ── Async shared-ref binding failure (R0-05C) ──
    | 'asset-bind-failed'
    // Asset/material binding was rejected before the document write because
    // the target's skin state and the material's first-pass shader disagree.
    | 'asset-bind-incompatible'
    // Asset import executor failures (stable terminal taxonomy).
    | 'IMPORT_UNSUPPORTED_FORMAT'
    | 'IMPORT_SOURCE_BYTES_MISSING'
    | 'IMPORT_UPLOAD_FAILED'
    | 'IMPORT_SOURCE_READ_FAILED'
    | 'IMPORT_COOK_FAILED'
    | 'IMPORT_SIDECAR_WRITE_FAILED'
    | 'IMPORT_COOK_TRIGGER_FAILED'
    | 'IMPORT_NETWORK_ERROR'
    | 'IMPORT_EXECUTION_FAILED'
    // ── Play-only game projection codes ──
    // A game owns these action/read closures. The editor Gateway exposes only
    // discovery + invocation while a fresh play world is live; it never imports
    // game state tokens or reaches into a game World directly.
    | 'game-projection-unavailable'
    // R2-04: the host-installed project validator provider is unavailable or
    // returned an envelope the Gateway cannot safely project.
    | 'project-validation-unavailable'
    | 'project-validation-invalid-result'
    | 'game-projection-id-conflict'
    | 'unknown-game-projection'
    | 'game-action-failed'
    | 'game-read-failed'
    // OperationRun save adopter (M1): structured lifecycle/control failures.
    | 'save-already-running'
    | 'operation-request-id-conflict'
    | 'operation-not-retryable'
    | 'asset-operation-cas-committed'
    | 'run-cancelled-before-cas'
    | 'asset-cook-failed'
    | 'run-not-cancellable'
    | 'run-not-found'
    | 'run-expired'
    | 'operation-failed'
    // RHI debug capture is an optional edit-runtime capability. These errors
    // keep a missing recorder / failed upload visible through the gateway
    // instead of leaking a raw promise rejection to the caller.
    | 'rhi-debug-unavailable'
    | 'rhi-capture-failed'
    // Engine-owned bounded CPU profile capture. The Editor preserves the
    // profiler's unavailable/busy/validation facts without owning its schema.
    | 'profiler-unavailable'
    | 'profiler-busy'
    | 'profile-capture-timeout'
    | 'profile-capture-missing'
    | 'profile-capture-invalid'
    | 'profile-capture-empty'
    | 'profile-capture-failed'
    // Engine-owned VFX Runtime Host control lease failures. Preserve these
    // codes through Gateway dispatch so callers can reacquire after a Runtime
    // generation change instead of parsing an INVALID_ARGS hint.
    | 'vfx-host-control-world-detached'
    | 'vfx-host-control-stale-generation'
    | 'vfx-host-control-runtime-unavailable'
    | 'vfx-host-control-player-unavailable'
    // Asset-editor page navigation is a host-installed seam (the app-shell page
    // extension). A host without it must refuse openAssetEditor structurally,
    // never by leaking the seam's rejection as an unhandled promise.
    | 'page-navigation-unavailable'
    // Save persistence effect failures (M2): stable codes for data-protecting
    // refusal and canonical commit outcomes. Callers branch on these fields,
    // never on console/message text.
    | 'save-serialization-failed'
    | 'save-pack-validation-failed'
    | 'save-inline-assets-missing'
    | 'save-entities-missing'
    | 'save-write-failed'
    | 'save-unexpected-failure';
  hint: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly current?: unknown;
  readonly subjectRef?: ErrorSubjectRef | SourceAuthoringSubjectRef;
  readonly retryable?: boolean;
  readonly recoveryActions?: readonly string[];
}

export type ApplyResult =
  // `created` — the new entity roots this op produced (spawn: [handle];
  // instantiate/duplicate: the new roots; transaction: all sub-ops' roots
  // flattened). Empty [] for non-creating ops (setComponent/rename/…) so
  // consumers read result.created without an undefined check. This is the ONE
  // out-channel for post-dispatch reads (selection, AI "what did I just make?").
  | { ok: true; inverse: EditorOp; created: EntityHandle[] }
  | { ok: false; error: CommandError };
