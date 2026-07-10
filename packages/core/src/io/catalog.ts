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
  /**
   * Human/AI-readable semantic note for a field, surfaced verbatim through
   * gateway.listOps() so a caller learns non-obvious contracts by SELF-INTROSPECTION
   * rather than from a runtime error (charter P1/F1 progressive disclosure). The
   * validator (io/args-schema.ts) ignores it — it is documentation, not a
   * constraint. Example: the selection ops' entity id is a WORLD-BOUND handle
   * (feat-20260709 world split); this field says so at the id property.
   */
  description?: string;
}

// ── OpDescriptor (listOps return shape) ────────────────────────────────────

export interface OpDescriptor {
  readonly id: string;
  readonly domain: 'document' | 'session' | 'transient';
  readonly argsSchema: ArgsSchema | null;
  readonly source: 'builtin' | 'defined';
  readonly title?: string;
  /** Marks a legacy/syntactic alias of a canonical op (e.g. setAssetSelectionOne
   *  is the single-asset sugar form of setAssetSelection). AI listOps shows both
   *  but flags sugar so callers learn the one canonical shape. */
  readonly sugar?: boolean;
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
  /** Marks a legacy/syntactic alias of a canonical op (e.g. setAssetSelectionOne
   *  is the single-asset sugar form of setAssetSelection). AI listOps shows both
   *  but flags sugar so callers learn the one canonical shape. */
  sugar?: boolean;
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
  {
    id: 'destroyAsset', domain: 'document',
    argsSchema: {
      type: 'object',
      // newGuidCacheKey is inverse-only (set when destroyAsset is the inverse of
      // duplicateAsset) — optional, so direct destroyAsset callers omit it.
      properties: { packPath: { type: 'string' }, guid: { type: 'string' }, newGuidCacheKey: { type: 'string' } },
      required: ['packPath', 'guid'],
    },
    title: 'Destroy Asset',
  },
  {
    id: 'restoreAsset', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        cacheKey: { type: 'string' },
      },
      required: ['packPath', 'guid'],
    },
    title: 'Restore Asset',
  },
  {
    id: 'renameAsset', domain: 'document',
    argsSchema: {
      type: 'object',
      // oldName / renameCacheKey are inverse-plumbing — optional. Callers (human
      // UI + AI) pass only packPath/guid/newName; the applier discovers the old
      // name from the pack (SSOT) for the inverse (AI need not know it).
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        newName: { type: 'string' },
        oldName: { type: 'string' },
        renameCacheKey: { type: 'string' },
      },
      required: ['packPath', 'guid', 'newName'],
    },
    title: 'Rename Asset',
  },
  {
    id: 'duplicateAsset', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: { packPath: { type: 'string' }, guid: { type: 'string' } },
      required: ['packPath', 'guid'],
    },
    title: 'Duplicate Asset',
  },

  // ══ session domain (11 consolidated + play/stop) ════════════════════════
  // ── selection ops: the entity id is a WORLD-BOUND handle ─────────────────────
  // feat-20260709-editor-world-partition: after the editorWorld/sceneWorld split
  // the selection store no longer holds a bare EntityHandle — every selected id is
  // minted into a world-bound HandlePair (worldRef + epoch) against the CURRENT
  // sceneWorld binding (store/selection.ts, store/handle-pair.ts). The id you pass
  // here belongs to the ACTIVE scene world; a scene reload bumps the world epoch
  // and batch-invalidates every prior selection (revalidateSelection, AC-05). The
  // `.description` below states this at the id property so an AI reading listOps()
  // learns the world-bound contract + the reload self-rescue by INTROSPECTION, not
  // from a runtime stale-entity-handle error (charter P1/F1).
  { id: 'setSelection', domain: 'session',
    // id is nullable: setSelection({id:null}) is the documented "clear selection"
    // signal (store/selection.ts applySetSelection). required so a missing id is
    // still rejected (F-4), but null passes.
    argsSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          nullable: true,
          description:
            'entity handle in the ACTIVE scene world (world-bound: minted into a HandlePair with worldRef+epoch). A scene reload invalidates prior selections; re-query then re-select for a fresh handle. null clears the selection.',
        },
      },
      required: ['id'],
    },
    title: 'Set Selection',
  },
  { id: 'toggleSelection', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description:
            'entity handle in the ACTIVE scene world (world-bound: minted into a HandlePair with worldRef+epoch). A scene reload invalidates prior selections; re-query then re-select for a fresh handle.',
        },
      },
      required: ['id'],
    },
    title: 'Toggle Selection',
  },
  { id: 'setSelectionMany', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: {
            type: 'number',
            description:
              'entity handle in the ACTIVE scene world (world-bound: minted into a HandlePair with worldRef+epoch). A scene reload invalidates prior selections; re-query then re-select for fresh handles.',
          },
        },
      },
      required: ['ids'],
    },
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
  // CB navigation (feat-20260708-cb-nav-session-op-convergence M1):
  // setCBPath/cbGoBack/cbGoForward are session-domain ops (ledger-only, no undo).
  // argsSchema enables AI self-discovery via gateway.listOps() (plan-strategy §8.1 P1).
  { id: 'setCBPath', domain: 'session',
    argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    title: 'Set Content Browser Path',
  },
  { id: 'cbGoBack', domain: 'session', argsSchema: null, title: 'Go Back' },
  { id: 'cbGoForward', domain: 'session', argsSchema: null, title: 'Go Forward' },

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
  { id: 'setAssetSelection', domain: 'session',
    // Base op: one op carries the whole multi-select set (AC-B2 / T0-5). assets is
    // the selection set, primary drives single-target panels (Material).
    argsSchema: {
      type: 'object',
      properties: {
        assets: { type: 'array', items: { type: 'object' } },
        primary: { type: 'object', nullable: true },
      },
      required: ['assets', 'primary'],
    },
    title: 'Set Asset Selection',
  },
  { id: 'setAssetSelectionOne', domain: 'session', sugar: true,
    // Legacy single-asset sugar form — forwards to setAssetSelection (AC-B2).
    argsSchema: {
      type: 'object',
      properties: { asset: { type: 'object', nullable: true } },
      required: ['asset'],
    },
    title: 'Set Asset Selection (single, sugar)',
  },
  { id: 'setDisplay', domain: 'session',
    // Viewport display toggle (scene⇄game) — north-star §6/§8, symmetric to play/stop
    // (T0-9 / G-6). Advances to the ledger, not to undo.
    argsSchema: {
      type: 'object',
      properties: { display: { type: 'string', enum: ['scene', 'game'] } },
      required: ['display'],
    },
    title: 'Set Viewport Display',
  },
];

for (const op of builtinOps) {
  registerBuiltinOp(op);
}