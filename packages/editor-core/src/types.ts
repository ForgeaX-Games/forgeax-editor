// editor-core types — the editor's authoring working state (EditSession) and
// the only legal way to mutate it (EditorCommand). Both human UI and AI produce
// EditorCommands; the applier computes an inverse for free Undo.
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// EntityNode + all authorized component types (TransformData, MeshData, etc.)
// deleted. EditSession is now just {world, registry}. Legacy ID → engine
// handle mapping is internal to document.ts.
export type {
  EntityId,
  EntitySource,
  EditSession,
} from './scene-types';
export type { SceneAsset } from '@forgeax/engine-types';
import type { EntityId, EntitySource } from './scene-types';

// ── Commands ────────────────────────────────────────────────────────────────
// Each command is a plain JSON object = it doubles as an AI tool-call payload.

export type EditorCommand =
  | { kind: 'spawnEntity'; name?: string; parent?: EntityId | null; components?: Record<string, unknown>; source?: EntitySource; /** filled by applier */ _id?: EntityId }
  | { kind: 'destroyEntity'; entity: EntityId }
  | { kind: 'rename'; entity: EntityId; name: string }
  | { kind: 'reparent'; entity: EntityId; parent: EntityId | null }
  | { kind: 'setComponent'; entity: EntityId; component: string; patch: Record<string, unknown> }
  | { kind: 'addComponent'; entity: EntityId; component: string; value: unknown }
  | { kind: 'removeComponent'; entity: EntityId; component: string }
  | { kind: 'setHidden'; entity: EntityId; hidden: boolean }
  | { kind: 'transaction'; label: string; commands: EditorCommand[] };

export interface CommandError {
  code:
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
    | 'UNHIDE_FAILED';
  hint: string;
}

export type ApplyResult =
  | { ok: true; inverse: EditorCommand }
  | { ok: false; error: CommandError };
