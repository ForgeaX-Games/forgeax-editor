// editor-core types — the single authoritative mutable shape (SceneDocument)
// and the only legal way to mutate it (EditorCommand). Both human UI and AI
// produce EditorCommands; the applier computes an inverse for free Undo.
//
// Ported verbatim from the unveil-studio prototype (apps/studio/src/core) — the
// data model + command bus are engine-agnostic, so they carry over unchanged.
// The forgeax engine sync layer (src/engine/sync.ts) projects this doc onto a
// real forgeax world for WYSIWYG rendering.

export type EntityId = number;

/** Provenance for the three-state data model: which Workbench source produced
 * this instance. Enables "编辑源" round-trip back to the originating plugin. */
export interface EntitySource {
  plugin: string;
  docId: string;
}

export interface EntityNode {
  id: EntityId;
  name: string;
  parent: EntityId | null;
  components: Record<string, unknown>;
  source?: EntitySource;
  /** editor-only: hidden entities are not drawn in the viewport (authoring aid). */
  hidden?: boolean;
}

export interface SceneDocument {
  version: string;
  nextId: EntityId;
  entities: Record<EntityId, EntityNode>;
  /** root-level order + per-parent child order is derived from `parent`; kept simple here. */
  order: EntityId[];
}

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
