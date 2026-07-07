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
import type { EntityId, EntitySource } from './scene/scene-types';

// ── Operations ──────────────────────────────────────────────────────────────
// Each op is a plain JSON object = it doubles as an AI tool-call payload.
// The EditorOp type is the editor's single entry-point for all state mutations
// (plan-strategy §2 D-6). Every op carries enough information for the applier
// to compute an inverse for free Undo.

export type EditorOp =
  // ── document domain (engine World, SSOT) — produce inverse → undo + ledger ──
  | { kind: 'spawnEntity'; name?: string; parent?: EntityId | null; components?: Record<string, unknown>; source?: EntitySource; /** filled by applier */ _id?: EntityId }
  | { kind: 'destroyEntity'; entity: EntityId }
  | { kind: 'rename'; entity: EntityId; name: string }
  | { kind: 'reparent'; entity: EntityId; parent: EntityId | null }
  | { kind: 'setComponent'; entity: EntityId; component: string; patch: Record<string, unknown> }
  | { kind: 'addComponent'; entity: EntityId; component: string; value: unknown }
  | { kind: 'removeComponent'; entity: EntityId; component: string }
  | { kind: 'setHidden'; entity: EntityId; hidden: boolean }
  | { kind: 'transaction'; label: string; commands: EditorOp[] }
  // ── session domain (editor session state) — no inverse → ledger only (M2) ──
  // Collected store operations that mutate session state: selection / gizmo-mode
  // / frame-request / rename-request / scene-persistence. The DOMAIN is decided
  // structurally by which applier table registers the kind (plan-strategy §2
  // D-1), not by this union — the union just gives each op a typed JSON payload
  // so human UI and AI produce identical tool-call shapes (requirements AC-02).
  | { kind: 'setSelection'; id: EntityId | null }
  | { kind: 'toggleSelection'; id: EntityId }
  | { kind: 'setSelectionMany'; ids: EntityId[] }
  | { kind: 'setGizmoMode'; mode: 'translate' | 'rotate' | 'scale' }
  | { kind: 'requestFrame' }
  | { kind: 'requestRename'; entity: EntityId }
  | { kind: 'setSceneId'; id: string | null | undefined }
  | { kind: 'switchSceneFile'; id: string }
  | { kind: 'createSceneFile'; id: string; duplicateCurrent: boolean }
  | { kind: 'saveDocToDisk' }
  | { kind: 'loadDocFromDisk' }
  | { kind: 'createDirectory'; parentPath: string; name: string }
  // play·stop (plan-strategy §2 D-11): SESSION-domain discrete instantaneous ops.
  // Their real applier (the state machine) lives in edit-runtime (DAG downstream)
  // and is injected via registerSessionApplier at boot; in headless core they are
  // unregistered → dispatch returns UNKNOWN_OP (not silently swallowed). Payload
  // is empty (instantaneous degenerate dispatch — no continuous lifecycle).
  | { kind: 'play' }
  | { kind: 'stop' }
  // ── transient domain (transient view state) — no inverse, no ledger (M2) ──
  // Goes through the same single gateway door but leaves no trace (AC-03).
  | { kind: 'setHoverEntity'; id: EntityId | null }
  | { kind: 'setFieldPreview'; id: EntityId | null; key?: string; value?: number }
  | { kind: 'setAssetSelection'; asset: unknown };


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
    // ── New gateway-layer codes (plan-strategy §2 D-7) ──
    | 'UNKNOWN_OP'
    | 'INVALID_ARGS'
    | 'OP_ID_CONFLICT'
    | 'PLAN_FAILED'
    | 'OP_INTERRUPTED';
  hint: string;
}

export type ApplyResult =
  | { ok: true; inverse: EditorOp }
  | { ok: false; error: CommandError };
