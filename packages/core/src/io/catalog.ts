// io/catalog.ts — operation catalog: registration + listOps + defineOp (M4)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Registers all builtin ops (document 9 + session + transient) and
// defineOp-cast ops into a single Map. listOps() returns a readonly
// snapshot — the SSOT for AI self-introspection and the command palette.
//
// Anchors:
//   plan-strategy §2 D-3: registerBuiltinOp + listOps + ArgsSchema
//   requirements AC-04: listOps single self-describing
//   plan-strategy §2.5: io/catalog.ts (new file)
//   plan-strategy §2 D-4: defineOp transaction wrapper

import type { EditorOp } from '../types';

// ── ArgsSchema (D-3 lightweight JSON-Schema subset) ────────────────────────

export interface ArgsSchema {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  properties?: Record<string, ArgsSchema>;
  required?: string[];
  enum?: unknown[];
  items?: ArgsSchema;
  /**
   * When true, `null` is an accepted value regardless of `type` (F-4). Several
   * session/transient ops use `null` as a documented "clear" signal —
   * setSelection/setHoverEntity/setFieldPreview id:null clears the selection /
   * hover, setSceneId id:null resets the scene. Marking those fields nullable
   * lets the gateway entry validator (io/args-schema.ts) accept the clear signal
   * while still rejecting the wrong-type / missing-required cases.
   */
  nullable?: boolean;
}

// ── OpDescriptor (listOps return shape) ────────────────────────────────────

export interface OpDescriptor {
  readonly id: string;
  readonly domain: 'document' | 'session' | 'transient';
  readonly argsSchema: ArgsSchema | null;
  readonly source: 'builtin' | 'defined';
  readonly title?: string;
}

// ── Plan function type (defineOp) ──────────────────────────────────────────

export type PlanFn = (query: unknown, args: unknown) => EditorOp[];

// ── Internal catalog Map ────────────────────────────────────────────────────

const _catalog = new Map<string, OpDescriptor>();

// ── Registration ────────────────────────────────────────────────────────────

export function registerBuiltinOp(op: Readonly<Omit<OpDescriptor, 'source'>>): void {
  _catalog.set(op.id, { ...op, source: 'builtin' as const });
}

/** Register a defineOp-cast op into the catalog (source='defined'). */
export function registerDefinedOp(op: Readonly<Omit<OpDescriptor, 'source'>>): void {
  _catalog.set(op.id, { ...op, source: 'defined' as const });
}

// ── listOps ─────────────────────────────────────────────────────────────────

export function listOps(): readonly OpDescriptor[] {
  return Array.from(_catalog.values());
}

export function hasOp(id: string): boolean {
  return _catalog.has(id);
}

export function getOp(id: string): OpDescriptor | undefined {
  return _catalog.get(id);
}

// ── Builtin catalog seeding ─────────────────────────────────────────────────
// Registered at module eval time — SSOT for ALL editor operations.
// Each entry's argsSchema mirrors the EditorOp discriminated union in types.ts.
// Ops with no meaningful args payload have argsSchema = null.

const builtinOps: ReadonlyArray<{
  id: string;
  domain: 'document' | 'session' | 'transient';
  argsSchema: ArgsSchema | null;
  title?: string;
}> = [
  // ══ document domain (9 primitives) ══════════════════════════════════════
  {
    id: 'spawnEntity', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parent: { type: 'number' },
        components: { type: 'object' },
        source: { type: 'string' },
      },
    },
    title: 'Spawn Entity',
  },
  {
    id: 'destroyEntity', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: { entity: { type: 'number' } },
      required: ['entity'],
    },
    title: 'Destroy Entity',
  },
  {
    id: 'rename', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        name: { type: 'string' },
      },
      required: ['entity', 'name'],
    },
    title: 'Rename',
  },
  {
    id: 'reparent', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        parent: { type: 'number' },
      },
      required: ['entity'],
    },
    title: 'Reparent',
  },
  {
    id: 'setComponent', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        component: { type: 'string' },
        patch: { type: 'object' },
      },
      required: ['entity', 'component', 'patch'],
    },
    title: 'Set Component',
  },
  {
    id: 'addComponent', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        component: { type: 'string' },
        value: {},
      },
      required: ['entity', 'component'],
    },
    title: 'Add Component',
  },
  {
    id: 'removeComponent', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        component: { type: 'string' },
      },
      required: ['entity', 'component'],
    },
    title: 'Remove Component',
  },
  {
    id: 'setHidden', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        hidden: { type: 'boolean' },
      },
      required: ['entity', 'hidden'],
    },
    title: 'Set Hidden',
  },
  {
    id: 'transaction', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        commands: { type: 'array' },
      },
      required: ['label', 'commands'],
    },
    title: 'Transaction',
  },

  // ══ session domain (11 consolidated + play/stop) ════════════════════════
  { id: 'setSelection', domain: 'session',
    // id is nullable: setSelection({id:null}) is the documented "clear selection"
    // signal (store/selection.ts applySetSelection). required so a missing id is
    // still rejected (F-4), but null passes.
    argsSchema: { type: 'object', properties: { id: { type: 'number', nullable: true } }, required: ['id'] },
    title: 'Set Selection',
  },
  { id: 'toggleSelection', domain: 'session',
    argsSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    title: 'Toggle Selection',
  },
  { id: 'setSelectionMany', domain: 'session',
    argsSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
    title: 'Select Many',
  },
  { id: 'setGizmoMode', domain: 'session',
    argsSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['translate', 'rotate', 'scale'] } }, required: ['mode'] },
    title: 'Set Gizmo Mode',
  },
  { id: 'requestFrame', domain: 'session', argsSchema: null, title: 'Request Frame' },
  { id: 'requestRename', domain: 'session',
    argsSchema: { type: 'object', properties: { entity: { type: 'number' } }, required: ['entity'] },
    title: 'Request Rename',
  },
  { id: 'setSceneId', domain: 'session',
    // id is optional + nullable: host-boot dispatches setSceneId({ id: queryParam })
    // where the param may be null/undefined to reset the scene (types.ts:
    // id: string | null | undefined).
    argsSchema: { type: 'object', properties: { id: { type: 'string', nullable: true } } },
    title: 'Set Scene Id',
  },
  { id: 'switchSceneFile', domain: 'session',
    argsSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    title: 'Switch Scene',
  },
  { id: 'createSceneFile', domain: 'session',
    argsSchema: { type: 'object', properties: { id: { type: 'string' }, duplicateCurrent: { type: 'boolean' } }, required: ['id'] },
    title: 'Create Scene',
  },
  { id: 'saveDocToDisk', domain: 'session', argsSchema: null, title: 'Save to Disk' },
  { id: 'loadDocFromDisk', domain: 'session', argsSchema: null, title: 'Load from Disk' },
  { id: 'play', domain: 'session', argsSchema: null, title: 'Play' },
  { id: 'stop', domain: 'session', argsSchema: null, title: 'Stop' },

  // ══ transient domain (3 consolidated) ═══════════════════════════════════
  { id: 'setHoverEntity', domain: 'transient',
    // id nullable: setHoverEntity({id:null}) clears the hover (store/hover.ts).
    argsSchema: { type: 'object', properties: { id: { type: 'number', nullable: true } }, required: ['id'] },
    title: 'Set Hover Entity',
  },
  { id: 'setFieldPreview', domain: 'transient',
    // id nullable + key/value optional: setFieldPreview({id:null}) clears the
    // preview (store/field-preview.ts).
    argsSchema: { type: 'object', properties: { id: { type: 'number', nullable: true }, key: { type: 'string' }, value: { type: 'number' } } },
    title: 'Set Field Preview',
  },
  { id: 'setAssetSelection', domain: 'transient',
    argsSchema: { type: 'object', properties: { asset: {} }, required: ['asset'] },
    title: 'Set Asset Selection',
  },
];

for (const op of builtinOps) {
  registerBuiltinOp(op);
}