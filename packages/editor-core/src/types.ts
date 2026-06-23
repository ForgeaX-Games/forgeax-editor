// editor-core types — the editor's authoring working state (EditSession, which
// carries the engine SceneAsset POD projection plus the editor-local ID layer)
// and the only legal way to mutate it (EditorCommand). Both human UI and AI
// produce EditorCommands; the applier computes an inverse for free Undo.
//
// The editor authors into an EditSession; the engine `SceneAsset` POD it
// projects is the SSOT shared with games + the engine host (so ▶ Play
// instantiates the very pack ✎ Edit authors). We re-export EditSession +
// SceneAsset here so existing editor imports (`../core/types`) keep working;
// EditorCommand below stays editor-local (it's the authoring/undo surface).
export type {
  EntityId,
  EntitySource,
  EntityNode,
  EditSession,
} from './scene-types';
export type { SceneAsset } from '@forgeax/engine-types';
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
