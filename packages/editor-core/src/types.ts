// editor-core types — the single authoritative mutable shape (SceneDocument)
// and the only legal way to mutate it (EditorCommand). Both human UI and AI
// produce EditorCommands; the applier computes an inverse for free Undo.
//
// The SceneDocument data model now lives in @forgeax/scene (the SSOT shared with
// games + the engine host, so ▶ Play instantiates the very file ✎ Edit authors).
// We re-export it here so existing editor imports (`../core/types`) keep working;
// EditorCommand below stays editor-local (it's the authoring/undo surface).
export type {
  EntityId,
  EntitySource,
  EntityNode,
  SceneDocument,
} from './scene-types';
import type { EntityId, EntitySource } from './scene-types';

// Re-export scene types so editor-core consumers (instantiate.ts, scene-pack.ts)
// import from ./types without knowing about the scene-types split.
export type {
  TransformData,
  MeshData,
  MeshKind,
  MaterialData,
  LightData,
  LightType,
  ColliderData,
  ColliderShape,
  Collider,
} from './scene-types';

// ── Commands ────────────────────────────────────────────────────────────────
// Each command is a plain JSON object → it doubles as an AI tool-call payload.

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
    | 'EMPTY_TRANSACTION';
  hint: string;
}

export type ApplyResult =
  | { ok: true; inverse: EditorCommand }
  | { ok: false; error: CommandError };
