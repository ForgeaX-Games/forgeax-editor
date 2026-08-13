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

import type {
  AssetRegistry,
  CatalogReconcileError as EngineCatalogReconcileError,
  CatalogReplicaSnapshot,
} from '@forgeax/engine-assets-runtime';
import type { CommandError, EditorOp } from '../types';

// ── ArgsSchema (D-3 lightweight JSON-Schema subset) ────────────────────────

export interface ArgsSchema {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  properties?: Record<string, ArgsSchema>;
  required?: string[];
  enum?: unknown[];
  items?: ArgsSchema;
  /** Mutually exclusive object variants for machine-validatable unions. */
  oneOf?: ArgsSchema[];
  /** Reject fields outside the declared object properties when false. */
  additionalProperties?: boolean;
  /** Public reference to a producer-owned schema; this is projection metadata. */
  $ref?: string;
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

  // ── content-validation fields (2026-07-23 args-schema-pattern follow-up) ──
  /**
   * Regex applied when `type === 'string'`. Accepts a DELIBERATELY narrow
   * subset (see io/args-schema.ts `_compilePattern`): character classes,
   * anchors (^ / $), quantifiers `+` `*` `?` on chars or bounded classes,
   * and `{n,m}` bounded quantifiers. Rejects lookbehind / backreferences /
   * group+quantifier patterns that can catastrophically backtrack (ReDoS
   * defense). Pair with `patternHint` so failures surface as human-readable
   * text; the raw regex is NEVER echoed to the caller.
   */
  pattern?: string;
  /**
   * Human/AI-readable explanation shown when `pattern` fails. Preferred over
   * the terse default "does not match required pattern"; both AI listOps()
   * consumers and end-user toasts render this verbatim. Use imperative voice
   * describing what a legal value looks like.
   */
  patternHint?: string;
  /** Inclusive `.length` lower bound; only checked when `type === 'string'`. */
  minLength?: number;
  /** Inclusive `.length` upper bound; only checked when `type === 'string'`. */
  maxLength?: number;
  /** Inclusive numeric lower bound; only checked when `type === 'number'`. */
  minimum?: number;
  /** Inclusive numeric upper bound; only checked when `type === 'number'`. */
  maximum?: number;
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
  /** OperationRun lifecycle metadata projected by the owning Gateway. */
  readonly operationRun?: OperationRunDescriptor;
  /** Product execution barrier derived from the operation's owning descriptor. */
  readonly completion?: {
    readonly kind: 'asset-visible' | 'asset-write';
    readonly guidField: string;
  };
  /** Whether the operation discards authored source overrides. */
  readonly destructive?: boolean;
  /** Canonical machine-readable recovery actions for the operation. */
  readonly recoveryActions?: readonly string[];
}

export type GatewayOpAvailability =
  | { readonly available: true }
  | {
    readonly available: false;
    readonly code: 'applier-unavailable';
    readonly reason: string;
    readonly resolution?: string;
  };

/** Gateway-owned live projection: static contract plus current executor fact. */
export interface GatewayOpDescriptor extends Omit<OpDescriptor, 'source'> {
  readonly source: OpDescriptor['source'] | 'registered';
  readonly availability: GatewayOpAvailability;
}

export interface GatewayOpSnapshot {
  readonly revision: number;
  readonly ops: readonly GatewayOpDescriptor[];
}

export interface OperationRunDescriptor {
  /** Statuses visible before the canonical effect has published a terminal fact. */
  readonly acceptedStatuses: readonly ('accepted' | 'running')[];
  /** The only statuses that may be treated as completed by a consumer. */
  readonly terminalStatuses: readonly ('succeeded' | 'failed' | 'cancelled')[];
  /** Gateway-owned read methods; these are projections, not a second run owner. */
  readonly read: {
    readonly get: string;
    readonly wait: string;
    readonly subscribe: string;
  };
  readonly retry: { readonly requiresNewRequestId: boolean };
  /** Terminal-only retention keeps active runs queryable until completion. */
  readonly retention: { readonly kind: 'terminal-only'; readonly maxTerminalRuns: number };
  readonly cancellable: boolean;
}

/** Read-only result projected from the existing Catalog replica reconcile seam. */
export interface CatalogReconcileResult {
  readonly revision: number;
  readonly stale: boolean;
  readonly diagnostics: readonly unknown[];
}

/** Public Engine surface required by the canonical Gateway recovery operation. */
export type CatalogReconcileProvider = () => CatalogReconcileResult | Promise<CatalogReconcileResult>;
export type EngineCatalogReconcileProvider = Pick<
  AssetRegistry,
  'catalogSnapshot' | 'reconcileCatalog'
>;

function projectCatalogSnapshot(snapshot: CatalogReplicaSnapshot): CatalogReconcileResult {
  return {
    revision: snapshot.version,
    stale: snapshot.stale,
    diagnostics: snapshot.diagnostics,
  };
}

function catalogReconcileFailure(
  error: EngineCatalogReconcileError,
  snapshot: CatalogReplicaSnapshot | undefined,
): CommandError {
  return {
    code: 'asset-catalog-subscription-gap',
    phase: 'gap',
    owner: 'engine',
    category: 'resource',
    operationId: 'catalog.reconcile',
    cause: {
      code: error.code,
      owner: 'engine',
      hint: error.hint,
      ...(error.detail === undefined ? {} : { details: error.detail }),
    },
    hint: error.hint,
    expected: error.expected,
    current: snapshot === undefined
      ? { revision: 0, stale: true, diagnostics: [] }
      : projectCatalogSnapshot(snapshot),
    retryable: true,
    recoveryActions: ['run.retry', 'catalog.reconcile', 'run.get', 'run.wait'],
  };
}

/** Build the Core provider from the Engine's public typed Result surface. */
export function createCatalogReconcileProvider(
  provider: EngineCatalogReconcileProvider,
): CatalogReconcileProvider {
  return async () => {
    const result = await provider.reconcileCatalog();
    if (!result.ok) throw catalogReconcileFailure(result.error, provider.catalogSnapshot());
    return projectCatalogSnapshot(result.value);
  };
}

// ── Plan function type (defineOp) ──────────────────────────────────────────

export type PlanFn = (query: unknown, args: unknown) => EditorOp[];

// ── Internal catalog Map ────────────────────────────────────────────────────

const _catalog = new Map<string, OpDescriptor>();

/**
 * Shared public run schema for source operations: accepted/running are not
 * completion; only the three terminal statuses are safe to act on.
 */
function sourceOperationRun(cancellable = true): OperationRunDescriptor {
  return {
    acceptedStatuses: ['accepted', 'running'],
    terminalStatuses: ['succeeded', 'failed', 'cancelled'],
    read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
    retry: { requiresNewRequestId: true },
    retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
    cancellable,
  };
}

const sourceRecoveryActions = ['asset.preflight', 'run.get', 'run.wait', 'run.retry', 'catalog.reconcile'] as const;

/**
 * Canonical source mutation schema. `guid` + `scope.sourceKey` identify the
 * producer output, `expectedRevision` guards Meta CAS, and discard alone adds
 * the impact-bound confirmation token. No path or compatibility alias belongs
 * in this schema.
 */
function sourceScopeArgs(): ArgsSchema {
  return {
    type: 'object',
    properties: {
      sourceKey: { type: 'string', minLength: 1, description: 'One producer-issued source key.' },
      all: { type: 'boolean', description: 'Explicitly select every source output; omission is not equivalent to all.' },
    },
    oneOf: [
      {
        type: 'object',
        properties: {
          sourceKey: { type: 'string', minLength: 1, description: 'One producer-issued source key.' },
        },
        required: ['sourceKey'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          all: { type: 'boolean', enum: [true], description: 'Explicitly select every source output.' },
        },
        required: ['all'],
        additionalProperties: false,
      },
    ],
  };
}

function sourceMutationArgs(includeConfirmationToken = false, includeOverride = false): ArgsSchema {
  return {
    type: 'object',
    properties: {
      guid: { type: 'string', minLength: 1, description: 'Stable imported output GUID; never infer identity from a path or output index.' },
      scope: sourceScopeArgs(),
      expectedRevision: { type: 'string', minLength: 1, description: 'Meta revision observed by preflight; retry after a revision conflict.' },
      ...(includeOverride ? {
        override: {
          type: 'object',
          $ref: 'asset.preflight.result.source.sourceOverrideDescriptors[].payloadSchema',
          description: 'Producer-owned override payload for the selected sourceKey; validate against its catalog descriptor schema.',
        },
      } : {}),
      requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      ...(includeConfirmationToken ? {
        confirmationToken: { type: 'string', minLength: 1, description: 'Discard confirmation returned by source preflight and bound to its impact set.' },
      } : {}),
    },
    required: ['guid', 'scope', 'expectedRevision', ...(includeOverride ? ['override'] : []), 'requestId'],
  };
}

function sourcePreflightArgs(): ArgsSchema {
  return {
    type: 'object',
    properties: {
      guid: { type: 'string', minLength: 1, description: 'Stable imported output GUID used to read the owning Meta source fact.' },
      scope: sourceScopeArgs(),
      requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    },
    required: ['guid', 'scope', 'requestId'],
  };
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerBuiltinOp(op: Readonly<Omit<OpDescriptor, 'source'>>): void {
  _catalog.set(op.id, { ...op, source: 'builtin' as const });
}

/** Register a defineOp-cast op into the catalog (source='defined'). */
export function registerDefinedOp(op: Readonly<Omit<OpDescriptor, 'source'>>): void {
  _catalog.set(op.id, { ...op, source: 'defined' as const });
}

// ── listOps ─────────────────────────────────────────────────────────────────

/**
 * Return a detached public descriptor. The catalog is an SSOT, while callers
 * are allowed to inspect the returned readonly shape without being able to
 * mutate nested args/run metadata (including through matcher libraries).
 */
function snapshotOp(op: OpDescriptor): OpDescriptor {
  return structuredClone(op);
}

export function listOps(): readonly OpDescriptor[] {
  return Array.from(_catalog.values(), snapshotOp);
}

export function hasOp(id: string): boolean {
  return _catalog.has(id);
}

export function getOp(id: string): OpDescriptor | undefined {
  const op = _catalog.get(id);
  return op === undefined ? undefined : snapshotOp(op);
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
  operationRun?: OperationRunDescriptor;
  completion?: {
    readonly kind: 'asset-visible' | 'asset-write';
    readonly guidField: string;
  };
  destructive?: boolean;
  recoveryActions?: readonly string[];
}> = [
  // ══ document domain (9 primitives) ══════════════════════════════════════
  {
    id: 'spawnEntity', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        // parent is EntityId | null (types.ts) — null / omit spawns a root. Must
        // be `nullable` or the now-enforced door-validation (solo round-14) would
        // wrongly reject `spawnEntity{parent:null}`, a real caller shape.
        parent: { type: 'number', nullable: true, description: 'parent handle (ChildOf); omit/null spawns a root. Inside a `transaction`, may be a NEGATIVE forward-reference placeholder — see `_id` below.' },
        components: { type: 'object' },
        source: { type: 'string' },
        // FORWARD-REFERENCE placeholder for use INSIDE a `transaction` (solo round-23):
        // give a spawn a NEGATIVE `_id` (e.g. -1), then a LATER sub-op in the same
        // commands array references that same negative value as its `parent` (or any
        // handle field like `entity`) to attach to this not-yet-created entity. The
        // transaction's alias map resolves the placeholder to the real handle at apply
        // time (document.ts `toEntity`). A non-negative `_id` is a concrete handle from a
        // prior apply (redo/inverse) and is NOT for authoring. Do NOT use `parent: 0` (a
        // batch INDEX) — 0 is a real handle → `INVALID_PARENT`. Outside a transaction,
        // read the created handle from `dispatch(...).result.created[]` instead.
        _id: { type: 'number', description: 'transaction-only NEGATIVE forward-reference id (e.g. -1); a later sub-op references it as `parent`/`entity` to point at this spawn before its real handle exists. See the note above; use dispatch().result.created[] outside a transaction.' },
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
        // parent is EntityId | null (types.ts) — null reparents to root. Must be
        // `nullable` or the now-enforced door-validation (solo round-14) would
        // wrongly reject `reparent{parent:null}` (reparent-to-root / ungroup).
        parent: { type: 'number', nullable: true },
      },
      required: ['entity'],
    },
    title: 'Reparent',
  },
  {
    id: 'hierarchyGesture', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reparent', 'delete', 'visibility', 'group', 'ungroup', 'duplicate'] },
        entities: { type: 'array', items: { type: 'number' } },
        parent: { type: 'number', nullable: true },
        state: { type: 'string', enum: ['inherited', 'hidden', 'visible'] },
      },
      required: ['action', 'entities'],
    },
    title: 'Apply Hierarchy Gesture',
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
    id: 'setSceneOverride', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        root: { type: 'number', description: 'SceneInstance synthetic root handle; obtain it from gateway.sceneInstanceReadModel(root) or sceneInstanceForMember(member).' },
        member: { type: 'number', description: 'Live member handle belonging to root. Entity identity is the engine handle, not a localId.' },
        component: { type: 'string', description: 'Existing member component name, discovered with gateway.describeComponent().' },
        field: { type: 'string', description: 'One field to override. Component add/remove, reparent, and entity-reference edits remain fail-closed in v1.' },
        value: { description: 'New field value; the engine schema validates it and records the override in the instance state.' },
      },
      required: ['root', 'member', 'component', 'field', 'value'],
    },
    title: 'Set Scene Instance Override',
  },
  {
    id: 'removeSceneOverride', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        root: { type: 'number', description: 'SceneInstance synthetic root handle.' },
        member: { type: 'number', description: 'Live member handle belonging to root.' },
        component: { type: 'string' },
        field: { type: 'string', description: 'Field whose instance override should be reverted to the source value.' },
      },
      required: ['root', 'member', 'component', 'field'],
    },
    title: 'Revert Scene Instance Override',
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
    id: 'setVisibility', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number' },
        state: { type: 'string', enum: ['inherited', 'hidden', 'visible'] },
      },
      required: ['entity', 'state'],
    },
    title: 'Set Visibility',
  },
  {
    id: 'instantiateSceneAsset', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        asset: {
          type: 'object',
          description:
            'a collected SceneAsset POD. Obtain it through gateway.collectSceneAsset(entity); materials are GUID strings, so it is time/scene-safe. For ordinary copies dispatch duplicateEntity instead of importing engine internals.',
        },
        parent: { type: 'number', nullable: true, description: 'retarget the PRIMARY new root under this parent handle (ChildOf); omit/null keeps it a root.' },
        name: { type: 'string', description: 'rename the PRIMARY new root (e.g. "{name} copy").' },
        posOffset: { type: 'array', items: { type: 'number' }, description: '[dx,dy,dz] added to every new root Transform.pos (paste offset).' },
        label: { type: 'string' },
      },
      required: ['asset'],
    },
    title: 'Instantiate Scene Asset',
  },
  {
    id: 'duplicateEntity', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'number',
          description: 'source entity handle in the active edit world; Gateway collects its full subtree before writing.',
        },
        parent: {
          type: 'number',
          nullable: true,
          description: 'optional parent override for the primary copied root; omit to retain the source parent.',
        },
        name: { type: 'string', description: 'optional primary-root name; omit for "{source name} copy".' },
        posOffset: { type: 'array', items: { type: 'number' }, description: '[dx,dy,dz] added to every new root Transform.pos.' },
        label: { type: 'string' },
      },
      required: ['entity'],
    },
    title: 'Duplicate Entity',
  },
  {
    id: 'applyVisualQualityPreset', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['draft', 'balanced', 'cinematic'],
          description: 'Composes quality fields on existing Camera/light shadow components. It does not change artistic color, direction, or intensity values.',
        },
      },
      required: ['preset'],
    },
    title: 'Apply Visual Quality Preset',
  },
  {
    id: 'transaction', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'single undo/ledger label for the whole batch (e.g. "bulk-spawn x500"); the transaction is atomic — all sub-ops apply or none, and it collapses to ONE undo entry.',
        },
        commands: {
          type: 'array',
          description: 'array of EditorOp payloads applied in order as ONE synchronous batch — a single emit → a single full-world repaint. This is the O(N) BULK-AUTHORING path for building a scene at scale: prefer it over a per-op `for (…) await gateway.dispatch(spawnEntity)` loop, which is O(N²) because each await yields the event loop and forces a full-world repaint per op (measured: 500 spawns = ~200s awaited-loop vs ~0.9s transaction). FORWARD-REFERENCES (spawn a root then parent children under it in the same batch): give the root `spawnEntity` a NEGATIVE `_id` (e.g. -1), then set each child spawn\'s `parent` to that same negative value — the alias map resolves it to the root\'s real handle at apply time. This works for any handle field (`parent`, `entity`), not just parent. Do NOT use `parent: 0` as a batch index — 0 is a real handle and fails `INVALID_PARENT`. The whole batch\'s created roots are returned as `dispatch(...).result.created[]` (created[0] = the first spawn).',
        },
      },
      required: ['label', 'commands'],
    },
    title: 'Transaction',
  },
  {
    id: 'destroyAsset', domain: 'document',
    completion: { kind: 'asset-write', guidField: 'guid' },
    argsSchema: {
      type: 'object',
      // Pack location is derived from the active game's catalog. Internal undo
      // commands carry a resolved path outside this public schema.
      properties: { guid: { type: 'string', description: 'Asset GUID in the active game catalog.' } },
      required: ['guid'],
    },
    title: 'Destroy Asset',
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
  // createMaterial (solo round-12 / P5 rendering-authoring): AUTHOR a new PBR
  // MaterialAsset from params — the create-a-look counterpart to bindAssetRef's
  // bind-an-existing-look. Cataloged (unlike createAsset) so an AI discovers it via
  // listOps(). The applier builds the POD via the engine's Materials.standard()
  // builder and writes it to the pack; the caller then binds the same guid onto a
  // mesh's MeshRenderer.materials via bindAssetRef.
  {
    id: 'createMaterial', domain: 'document',
    completion: { kind: 'asset-visible', guidField: 'guid' },
    argsSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Caller-minted asset GUID (crypto.randomUUID() — 36-char RFC-4122 dash form). REUSE this same guid for the follow-up bindAssetRef; the op cannot return a minted guid (the dispatch result carries only entity handles).' },
        name: { type: 'string', description: 'Human-readable material name shown in the asset catalog.' },
        baseColor: { type: 'array', items: { type: 'number' }, description: 'PBR base color authored in sRGB as [r,g,b,a], each 0..1 (a = linear opacity). Values are stored unchanged; render extraction converts RGB to linear.' },
        metallic: { type: 'number', description: 'PBR metallic 0..1 (default 0 = dielectric).' },
        roughness: { type: 'number', description: 'PBR roughness 0..1 (default 0.5).' },
        baseColorTexture: { type: 'string', description: 'Optional TextureAsset GUID to set as baseColorTexture. Must be in the LIVE asset catalog (INVALID_ARGS otherwise) — a phantom GUID can never resolve at render. Stored as refs[] index in pack (engine disk format).' },
        alphaCutoff: { type: 'number', description: 'Optional alpha-cutoff 0..1 (UE-Masked equivalent): baseColorTexture alpha below the cutoff is discarded. Omit for a fully opaque material.' },
        packPath: { type: 'string', description: 'Optional game-relative or catalog-provided canonical target pack path. Defaults to assets/materials.pack.json, whose writer is independent from scene persistence. The host resolves either form exactly once; an AI normally omits this.' },
        refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['guid', 'name', 'baseColor'],
    },
    title: 'Create Material',
  },
  {
    id: 'writeUi', domain: 'document',
    completion: { kind: 'asset-visible', guidField: 'guid' },
    argsSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Stable caller-minted RFC 4122 asset GUID. The first write creates it; later writes replace that same asset.' },
        name: { type: 'string', description: 'Human-readable UI asset name shown in the asset catalog.' },
        html: { type: 'string', description: 'Declarative UiAsset markup. Dynamic values and event behavior remain game-code responsibilities.' },
        css: { type: 'string', description: 'Styles scoped to the UiAsset ShadowRoot.' },
        sourcePath: { type: 'string', description: 'Optional game-relative authoring source path used in structured validation diagnostics.' },
        packPath: { type: 'string', description: 'Optional game-relative target pack path. Defaults to assets/ui.pack.json.' },
      },
      required: ['guid', 'name', 'html', 'css'],
    },
    title: 'Write UI Asset',
  },
  // updateMaterialParams (material-editor M1): update an existing MaterialAsset's
  // values. Document-domain (undoable). The sole "edit material params" op —
  // human and AI share one command (north-star §4). Gateway pre-fills _old* fields
  // from the catalog so the applier constructs the inverse without async reads.
  {
    id: 'updateMaterialParams', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string', description: '.pack.json or .meta.json path containing the material asset. Accepts either a game-relative path or the canonical path projected by the asset catalog; the host resolves it exactly once.' },
        guid: { type: 'string', description: 'Material asset GUID to update.' },
        paramPatch: {
          type: 'object',
          description: 'Shallow merge into MaterialAsset.values. Color values such as baseColor are sRGB by default and are stored unchanged; alpha and non-color values are linear data. Keys should come from the shader\'s paramSchema. undefined deletes the key. Example: {"baseColor":[1,0,0,1],"metallic":0.2,"roughness":0.4}',
        },
        textureGuids: {
          type: 'object',
          description: 'Texture params as GUID strings; applier encodes to pack refs[] indices. null clears the texture. Example: {"baseColorTexture":"a1b2…"}',
        },
      },
      required: ['packPath', 'guid', 'paramPatch'],
    },
    title: 'Update Material Params',
  },
  {
    id: 'createMaterialInstance', domain: 'document',
    completion: { kind: 'asset-visible', guidField: 'guid' },
    argsSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Caller-minted RFC 4122 asset GUID. Reuse for openAssetEditor after create.' },
        name: { type: 'string', description: 'Human-readable Material Instance name (UE-style default prefix MI_).' },
        parentGuid: { type: 'string', description: 'Parent Material or Material Instance GUID.' },
        overrides: { type: 'object', description: 'Optional initial overrides map: { [paramKey]: { enabled, value } }.' },
        physMaterial: { type: 'string', description: 'Optional Physical Material GUID (editor-stored).' },
        lightmass: { type: 'object', description: 'Optional Lightmass settings patch.' },
        packPath: { type: 'string', description: 'Optional game-relative pack path. Defaults to assets/materials.pack.json.' },
      },
      required: ['guid', 'name', 'parentGuid'],
    },
    title: 'Create Material Instance',
  },
  {
    id: 'saveMaterialInstance', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        payload: { type: 'object', description: 'Full material-instance payload to persist (staging flush).' },
      },
      required: ['packPath', 'guid', 'payload'],
    },
    title: 'Save Material Instance',
  },
  {
    id: 'createInputMap', domain: 'document',
    completion: { kind: 'asset-visible', guidField: 'guid' },
    argsSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Caller-minted RFC 4122 asset GUID.' },
        name: { type: 'string', description: 'Human-readable Input Map name (default prefix IM_).' },
        actions: { type: 'array', description: 'Optional initial ActionConfig[] rows.' },
        packPath: { type: 'string', description: 'Optional game-relative pack path. Defaults to assets/input.pack.json.' },
      },
      required: ['guid', 'name'],
    },
    title: 'Create Input Map',
  },
  {
    id: 'saveInputMap', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        payload: { type: 'object', description: 'Full input-map payload to persist (staging flush).' },
      },
      required: ['packPath', 'guid', 'payload'],
    },
    title: 'Save Input Map',
  },
  {
    id: 'setMaterialInstanceParent', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        parentGuid: { type: 'string', description: 'New parent GUID. Rejected if it would create a cycle.' },
      },
      required: ['packPath', 'guid', 'parentGuid'],
    },
    title: 'Set Material Instance Parent',
  },
  {
    id: 'setMaterialInstanceOverride', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        paramKey: { type: 'string' },
        enabled: { type: 'boolean' },
        value: { description: 'Override value when enabled (optional when disabling).' },
        bucket: { type: 'string', description: 'overrides (default) or propertyOverrides.' },
      },
      required: ['packPath', 'guid', 'paramKey', 'enabled'],
    },
    title: 'Set Material Instance Override',
  },
  {
    id: 'setMaterialInstanceLightmass', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        packPath: { type: 'string' },
        guid: { type: 'string' },
        lightmassPatch: { type: 'object' },
      },
      required: ['packPath', 'guid', 'lightmassPatch'],
    },
    title: 'Set Material Instance Lightmass',
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
  { id: 'setGizmoPivot', domain: 'session',
    argsSchema: { type: 'object', properties: { pivot: { type: 'string', enum: ['center', 'lastSelected'] } }, required: ['pivot'] },
    title: 'Set Gizmo Pivot',
  },
  { id: 'requestFrame', domain: 'session', argsSchema: null, title: 'Request Frame' },
  { id: 'captureFrame', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        frames: { type: 'number', minimum: 1, maximum: 8, description: 'Number of consecutive frames to record. Defaults to 1.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id used to read the captured tape result.' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Optional failed capture run being retried; the new requestId remains the public identity of the new attempt.' },
      },
      required: ['requestId'],
    },
    title: 'Capture RHI Frame',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'captureCpuProfile', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        frames: { type: 'number', minimum: 1, maximum: 8, description: 'Number of consecutive Engine frames to record. Defaults to 2.' },
        eventLimit: { type: 'number', minimum: 1, maximum: 4096, description: 'Maximum phase records retained by the Engine profiler. Defaults to 512.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id used to read the Engine-validated ProfileCapture result.' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Optional failed CPU profile run being retried; the new requestId remains the public identity of the new attempt.' },
      },
      required: ['requestId'],
    },
    title: 'Capture CPU Profile',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'replayParticleEffect', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'number',
          description: 'Live ParticleEffectPlayer entity in the active Edit or Play world. Re-query after Play/Stop.',
        },
      },
      required: ['entity'],
    },
    title: 'Replay Particle Effect',
  },
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
    argsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        dirtyPolicy: {
          type: 'string',
          enum: ['save', 'discard', 'cancel'],
          description: 'When the outgoing scene has unsaved edits: save before switching, discard the in-memory edits, or cancel without switching. Omit only when the scene is clean; dirty omission returns scene-switch-dirty.',
        },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for the accepted/running/terminal scene-switch OperationRun.' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Optional failed scene-switch run being retried; the new requestId remains the public identity of the new attempt.' },
      },
      required: ['id', 'requestId'],
    },
    title: 'Switch Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'previewImportedScene', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', minLength: 1, description: 'Imported scene output GUID resolved through loadByGuid.' },
        sourceKey: { type: 'string', minLength: 1, description: 'Catalog/workspace source identity; never inferred from a file suffix.' },
        sourcePath: { type: 'string' },
        revision: { type: 'string' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted OperationRun identity for preview load completion.' },
      },
      required: ['guid', 'sourceKey', 'revision', 'requestId'],
    },
    title: 'Preview Imported Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'promoteImportedScene', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        importedGuid: { type: 'string', minLength: 1, description: 'Imported scene GUID currently active in the authoring session.' },
        sourceKey: { type: 'string', minLength: 1, description: 'Producer-issued imported output identity. Must match the active session.' },
        revision: { type: 'string', minLength: 1, description: 'Effective imported revision. Must match the active session.' },
        targetPackPath: { type: 'string', minLength: 1, description: 'Explicit game-relative authored .pack.json target. Never inferred from the source path.' },
        targetName: { type: 'string', minLength: 1, description: 'Explicit authored scene name stored on the new pack entry.' },
        contentPolicy: { type: 'string', enum: ['effective-base', 'current-session'], description: 'effective-base promotes the immutable preview; current-session fails closed until Engine source authoring is available.' },
        discardSourceChanges: { type: 'boolean', description: 'Reserved compatibility field; no source-edit session exists with the current Engine.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      },
      required: ['importedGuid', 'sourceKey', 'revision', 'targetPackPath', 'targetName', 'contentPolicy', 'requestId'],
    },
    title: 'Promote Imported Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'createSceneFile', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'New scene slug. The persisted file is assets/scenes/<slug>.pack.json.' },
        duplicateCurrent: { type: 'boolean', description: 'When true, serialize the currently loaded scene into the new pack with a new scene GUID; when false, create a canonical empty scene.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for this accepted/running/terminal OperationRun. Use getOperationRun(), waitOperationRun(), or subscribeOperationRun() with the same id.' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Optional failed create/duplicate run being retried; the new requestId remains the public identity of the new attempt.' },
      },
      required: ['id', 'duplicateCurrent', 'requestId'],
    },
    title: 'Create or Duplicate Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  {
    id: 'setDefaultScene', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        sceneGuid: { type: 'string', minLength: 1, description: 'Stable GUID of a scene asset in the active scene manifest. This writes forge.json.defaultScene; it is not a scene id or pack path.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for this accepted/running/terminal OperationRun. Use getOperationRun(), waitOperationRun(), or subscribeOperationRun() with the same id.' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Optional failed default-scene run being retried; the new requestId remains the public identity of the new attempt.' },
      },
      required: ['sceneGuid', 'requestId'],
    },
    title: 'Set Default Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  {
    id: 'deleteScene', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        sceneGuid: { type: 'string', minLength: 1, description: 'Stable GUID of a scene asset in the active scene manifest. Current, default, and referenced scenes return a terminal scene-delete-guarded error with impact details.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for this accepted/running/terminal OperationRun. Use getOperationRun(), waitOperationRun(), or subscribeOperationRun() with the same id.' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Optional failed delete-scene run being retried; the new requestId remains the public identity of the new attempt.' },
      },
      required: ['sceneGuid', 'requestId'],
    },
    title: 'Delete Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  {
    id: 'saveDocToDisk', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          minLength: 1,
          maxLength: 128,
          description: 'Caller-minted request identity. Read the same save run with getOperationRun/waitOperationRun; accepted is not persisted.',
        },
        retryOfRequestId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          minLength: 1,
          maxLength: 128,
          description: 'Optional failed requestId being retried; the new requestId remains the public identity of the new attempt.',
        },
      },
      required: ['requestId'],
    },
    title: 'Save to Disk',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'loadDocFromDisk', domain: 'session', argsSchema: null, title: 'Load from Disk' },
  {
    id: 'play', domain: 'session', title: 'Play',
    argsSchema: {
      type: 'object',
      properties: {
        dirtyPolicy: {
          type: 'string',
          enum: ['last-saved', 'save-then-play', 'cancel'],
          description: 'When unsaved edits exist: use the last saved scene, save through Gateway then play, or cancel.',
        },
      },
    },
  },
  { id: 'stop', domain: 'session', argsSchema: null, title: 'Stop' },
  // ── camera navigation session ops (feat-2026-07-16 UE5 nav) ────────────────
  // Camera navigation is session-domain (ledger-only, no undo). The appliers live in
  // edit-runtime/viewport.ts (createViewport() → registerSessionApplier) because
  // they close over the orbit/fly state + the editorEngine facade; in headless
  // core (no edit-runtime boot) a cameraX dispatch returns UNKNOWN_OP, matching
  // requestFrame's headless behavior. Cataloged here for AI self-introspection
  // via gateway.listOps() (charter §8.1 P1). See TASK 4 in
  // todos/2026-07-16-editor-camera-ue5-navigation-controls.md.
  { id: 'cameraOrbit', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        target: { type: 'array', items: { type: 'number' }, description: 'Orbit target [x,y,z] (world). Camera orbits AROUND this point.' },
        yaw: { type: 'number', description: 'Yaw (radians) around world +Y; unbounded (full rotation).' },
        pitch: { type: 'number', description: 'Pitch (radians) around camera right; clamped to ~[-1.5, 1.5] (near ±86°).' },
        dist: { type: 'number', description: 'Distance from target to camera; clamped to [2, 300].' },
        pos: { type: 'array', items: { type: 'number' }, description: 'Optional absolute camera position [x,y,z]; if provided, target is derived as pos + fwd*dist (T6b).' },
      },
    },
    title: 'Orbit camera',
  },
  { id: 'cameraFly', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        pos: { type: 'array', items: { type: 'number' }, description: 'Camera position [x,y,z] at the end of the fly gesture.' },
        yaw: { type: 'number', description: 'Yaw (radians) — engine convention: qCam = yaw·Y × pitch·X, fwd = qCam·[0,0,-1].' },
        pitch: { type: 'number', description: 'Pitch (radians); clamped to ~[-1.5, 1.5].' },
      },
    },
    title: 'Fly camera to position',
  },
  { id: 'cameraTeleport', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        pos: { type: 'array', items: { type: 'number' }, description: 'Absolute camera position [x,y,z].' },
        yaw: { type: 'number', description: 'Yaw (radians).' },
        pitch: { type: 'number', description: 'Pitch (radians); clamped to ~[-1.5, 1.5].' },
      },
      required: ['pos'],
    },
    title: 'Teleport camera to position',
  },
  { id: 'cameraLookAt', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        pos: { type: 'array', items: { type: 'number' }, description: 'Camera position [x,y,z].' },
        lookAt: { type: 'array', items: { type: 'number' }, description: 'World point the camera should look at; yaw/pitch derived from (lookAt - pos).' },
      },
      required: ['pos', 'lookAt'],
    },
    title: 'Move camera and look at target',
  },
  { id: 'cameraSetProjection', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        projection: { type: 'string', enum: ['perspective', 'orthographic'] },
      },
      required: ['projection'],
    },
    title: 'Set camera projection',
  },
  { id: 'cameraToggleProjection', domain: 'session', argsSchema: null, title: 'Toggle camera projection' },
  { id: 'cameraSetView', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['perspective', 'top', 'bottom', 'left', 'right', 'front', 'back'],
          description: 'UE-style view preset. Axis views switch to an orthographic camera looking straight down that axis (top=+Y down, front=+Z toward -Z, right=+X toward -X, and their opposites), keeping the current orbit target and view scale. "perspective" restores the perspective projection keeping the current view direction.',
        },
      },
      required: ['view'],
    },
    title: 'Set viewport view preset',
  },
  { id: 'cameraAdjustFov', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: { delta: { type: 'number', description: 'Positive zooms in; negative zooms out.' } },
      required: ['delta'],
    },
    title: 'Adjust camera view scale',
  },
  { id: 'cameraZoom', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: { delta: { type: 'number', description: 'Positive zooms in; negative zooms out.' } },
      required: ['delta'],
    },
    title: 'Zoom camera',
  },
  { id: 'cameraBookmark', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'recall', 'clear'] },
        slot: { type: 'number', minimum: 1, maximum: 9 },
      },
      required: ['action', 'slot'],
    },
    title: 'Camera bookmark',
  },
  // Viewport interaction preferences — session domain, ledger-only. The
  // gridVisible field defaults to true and remains Edit chrome state. The
  // nested patch schema is the machine-readable contract exposed by listOps;
  // unknown keys return INVALID_ARGS with a field-path hint, while numeric
  // ranges are clamped by normalizeViewportPreferences in the applier.
  { id: 'setViewportPreferences', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: 'Partial viewport-preferences patch; every field optional. Numbers are clamped to their valid range by the applier.',
          additionalProperties: false,
          properties: {
            gridVisible: { type: 'boolean', description: 'Show the infinite grid in the Edit viewport; defaults to true and is session-only.' },
            mouseSensitivity: { type: 'number', description: 'Mouse delta multiplier for orbit/pan/dolly/fly-look (0.05–5).' },
            invertY: { type: 'boolean', description: 'Reverse vertical mouse look.' },
            wheelDirection: { type: 'number', enum: [1, -1], description: 'Wheel direction multiplier; 1 is the editor default.' },
            wheelSpeedScalar: { type: 'number', description: 'Wheel-speed steps per notch while flying (0.1–4).' },
            flyBoostMultiplier: { type: 'number', description: 'Temporary Shift-held flight multiplier (1–8).' },
            flySpeed: { type: 'number', description: 'Fly-mode move speed.' },
            fov: { type: 'number', description: 'Perspective view scale (absolute set).' },
            projection: { type: 'string', enum: ['perspective', 'orthographic'] },
          },
        },
      },
      required: ['patch'],
    },
    title: 'Set Viewport Preferences',
  },
  // CB navigation (feat-20260708-cb-nav-session-op-convergence M1):
  // setCBPath/cbGoBack/cbGoForward are session-domain ops (ledger-only, no undo).
  // argsSchema enables AI self-discovery via gateway.listOps() (plan-strategy §8.1 P1).
  { id: 'setCBPath', domain: 'session',
    argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    title: 'Set Content Browser Path',
  },
  { id: 'cbGoBack', domain: 'session', argsSchema: null, title: 'Go Back' },
  { id: 'cbGoForward', domain: 'session', argsSchema: null, title: 'Go Forward' },
  // importAsset (R0-04A lifecycle convergence): session-domain, ledger-only. Cataloged
  // so AI can self-discover it via gateway.listOps() (registry razor — the human
  // drag-drop capability is now equally AI-reachable). destPath is an on-disk
  // (game-relative OK) source; the applier uploads-then-cooks through the assetIO gate.
  { id: 'importAsset', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        destPath: { type: 'string', minLength: 1, description: 'On-disk source path (game-relative accepted); the source must already be on disk unless skipUpload is false with bytes supplied by a UI caller.' },
        sourceName: { type: 'string', description: 'Optional basename override; defaults to the last path segment. Drives importer selection + cook meta.source.' },
        base64: { type: 'string', minLength: 1, description: 'Ephemeral source bytes for a human-selected file. Runtime uploads them through assetIO before import.' },
        companionSources: {
          type: 'array',
          description: 'Optional bounded companion source for a compound import, currently the matching .ui.css file.',
          items: {
            type: 'object',
            properties: {
              destPath: { type: 'string', minLength: 1 },
              base64: { type: 'string', minLength: 1 },
            },
            required: ['destPath', 'base64'],
            additionalProperties: false,
          },
        },
        skipUpload: { type: 'boolean', description: 'Bytes already on disk — do not re-upload (default true for path-only callers).' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for the accepted/running/terminal OperationRun.' },
      },
      required: ['destPath', 'requestId'],
    },
    title: 'Import Asset',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed', 'cancelled'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: true,
    },
  },
  {
    id: 'catalog.reconcile', domain: 'transient',
    argsSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
        retryOfRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      },
      required: ['requestId'],
    },
    title: 'Reconcile Asset Catalog',
    operationRun: sourceOperationRun(false),
    recoveryActions: ['run.retry', 'catalog.reconcile', 'run.get', 'run.wait'],
  },
  {
    id: 'asset.preflight', domain: 'transient',
    argsSchema: sourcePreflightArgs(),
    title: 'Read Asset Source Preflight',
    operationRun: sourceOperationRun(false),
    destructive: false,
    recoveryActions: ['catalog.reconcile', 'run.get', 'run.wait'],
  },
  { id: 'reimportAsset', domain: 'session',
    argsSchema: sourceMutationArgs(),
    title: 'Reimport Asset',
    operationRun: sourceOperationRun(),
    destructive: false,
    recoveryActions: [...sourceRecoveryActions],
  },
  { id: 'previewAssetSourceMutation', domain: 'session',
    argsSchema: sourceMutationArgs(),
    title: 'Preview Asset Source Mutation',
    operationRun: sourceOperationRun(),
    destructive: false,
    recoveryActions: [...sourceRecoveryActions],
  },
  { id: 'saveAssetSourceOverride', domain: 'session',
    argsSchema: sourceMutationArgs(false, true),
    title: 'Save Asset Source Override',
    operationRun: sourceOperationRun(),
    destructive: false,
    recoveryActions: [...sourceRecoveryActions],
  },
  { id: 'discardSourceOverridesAndReimport', domain: 'session',
    argsSchema: sourceMutationArgs(true),
    title: 'Discard Source Overrides and Reimport',
    operationRun: sourceOperationRun(),
    destructive: true,
    recoveryActions: [...sourceRecoveryActions],
  },
  { id: 'deleteSourceFile', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Game-relative source path, e.g. assets/Fox.glb.' },
        requestId: { type: 'string', description: 'Caller-minted correlation id used to poll sourceFileDeleteStatus().' },
      },
      required: ['path', 'requestId'],
    },
    title: 'Delete Source File',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  // ── filesystem folder + source-file ops (2026-07-23 assets-folder-name-validation) ──
  // Registered here so gateway.listOps() shows them to AI (registry razor: same
  // capability, same descriptor, AI-reachable by construction). Two layers of
  // name validation, both non-negotiable:
  //   1) gateway-entry: this schema's `pattern` + `minLength`/`maxLength` (added
  //      by follow-up PR-B; catches char-class + length before the applier is
  //      even entered — an AI listOps() consumer learns the rules by machine).
  //   2) applier SSOT: session/asset-basename.ts validateAssetBasename()
  //      catches the SEMANTIC rules a regex can't express (Windows reserved
  //      names / trailing "." or space / "." / ".." / trim). Belt+suspenders:
  //      the pattern is a strict subset of the SSOT, and the applier remains
  //      the ONLY code that mutates the disk (north-star §9 — the write gate).
  { id: 'createDirectory', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        parentPath: { type: 'string', description: 'Game-relative parent directory (e.g. "assets", "assets/textures"). Empty string defaults to "assets".' },
        name: {
          type: 'string',
          pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+$',
          patternHint:
            'folder name contains an illegal character (not allowed: \\ / : * ? " < > | or control chars)',
          minLength: 1,
          maxLength: 255,
          description: 'New folder BASENAME only (single path segment). Additional applier-side rules: rejects "." / ".." / Windows reserved (CON/PRN/AUX/NUL/COM1-9/LPT1-9) / trailing space or period. Full SSOT: session/asset-basename.ts validateAssetBasename().',
        },
      },
      required: ['parentPath', 'name'],
    },
    title: 'Create Directory',
  },
  { id: 'deleteDirectory', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        // path is on-disk-visible (may point at a pre-existing dir authored by
        // an older build), so we do NOT enforce a BASENAME pattern here — the
        // applier's checkPathNotJailbreak() catches only "..", NUL, and "\\"
        // to prevent traversal / smuggling. See asset-basename.ts.
        path: { type: 'string', minLength: 1, description: 'Game-relative directory path to delete recursively (e.g. "assets/textures"). Must not contain ".." segments, NUL bytes, or "\\" separators. The basename is intentionally NOT validated — this is the escape hatch for cleaning up folders that predate name validation.' },
      },
      required: ['path'],
    },
    title: 'Delete Directory',
  },
  { id: 'renameDirectory', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Game-relative existing directory path (same jailbreak rules as deleteDirectory.path).' },
        newName: {
          type: 'string',
          pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+$',
          patternHint:
            'folder name contains an illegal character (not allowed: \\ / : * ? " < > | or control chars)',
          minLength: 1,
          maxLength: 255,
          description: 'New BASENAME for the directory (same content rules as createDirectory.name).',
        },
      },
      required: ['path', 'newName'],
    },
    title: 'Rename Directory',
  },
  { id: 'renameSourceFile', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Game-relative existing source file path (e.g. "assets/Fox.glb").' },
        newName: {
          type: 'string',
          pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+$',
          patternHint:
            'file name contains an illegal character (not allowed: \\ / : * ? " < > | or control chars)',
          minLength: 1,
          maxLength: 255,
          description: 'New BASENAME WITH extension (same content rules as createDirectory.name).',
        },
      },
      required: ['path', 'newName'],
    },
    title: 'Rename Source File',
  },
  { id: 'revealInFileManager', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Game-relative file or directory path to reveal in the OS file manager.' },
      },
      required: ['path'],
    },
    title: 'Reveal in File Manager',
  },
  // addSceneAssetToScene (R0-05B): session-domain, ledger-only, request-correlated
  // async. The caller-minted requestId is the public identity of this one mount;
  // concurrent placements therefore expose independent OperationRuns instead of
  // racing over a singleton latest-only phase. Cataloged so AI self-discovers the
  // same human "Add to Scene" capability via gateway.listOps().
  { id: 'addSceneAssetToScene', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        sceneGuid: { type: 'string', description: 'A catalogued scene sub-asset GUID (from gateway.assetCatalog(), kind:"scene"). For a just-imported GLB/FBX, the whole-file scene sub-asset — this instantiates its real geometry + hierarchy (incl. Skin+Skeleton joints for a rigged asset), not a placeholder. NOTE: it does NOT create an AnimationPlayer — which clip plays is authoring intent, not baked by the gltf cook; you would author AnimationPlayer + bind an animation-clip yourself (a leg that is currently limited — see the gateway skill "Animate a skinned asset" note).' },
        name: { type: 'string', description: 'Optional name for the wrapper root entity; defaults to "Scene". The wrapper is the mount ROOT and round-trips as one mounts[] entry.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for this accepted/running/terminal OperationRun. Use getOperationRun(), waitOperationRun(), or subscribeOperationRun() with the same id.' },
      },
      required: ['sceneGuid', 'requestId'],
    },
    title: 'Add Scene Asset to Scene',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  // bindAssetRef (R0-05C): session-domain, ledger-only, request-correlated async.
  // Cataloged so AI self-discovers the same human binder via listOps().
  // The async front-door binder for shared<T> component fields. Component ops
  // also resolve already-catalogued GUIDs synchronously; this op can load first.
  // (loadByGuid -> allocSharedRef) and writes the live handle(s) into the field via
  // a document setComponent (undoable, round-trips). One op for the whole class:
  // materials / equirect / animation-clips.
  { id: 'bindAssetRef', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number', description: 'Target entity handle. Owned entities and mount members are supported; mount-member shared refs fold into mounts[].overrides[] on save.' },
        component: { type: 'string', description: 'Component carrying the shared<T> field, e.g. "MeshRenderer", "Skylight", "AnimationPlayer". Must already be present on the entity (this patches it).' },
        field: { type: 'string', description: 'The shared<T> field to bind, e.g. "materials", "equirect", "clips". Discover its type via gateway.describeComponent(component).' },
        assetType: { type: 'string', description: 'Producer-owned engine asset-union tag for allocSharedRef. For ParticleEffectPlayer.effect and every other shared<T> field, read the field token with gateway.describeComponent(component), then query gateway.assetCatalog({ compatibleWith: assetType }) for candidate GUIDs.' },
        guids: { type: 'array', items: { type: 'string' }, description: 'Catalogued asset GUID(s) from the producer-compatible asset query. For an array<shared<T>> field, one GUID per slot (unless `slot` is given). For a scalar shared<T> field, a single-element array.' },
        slot: { type: 'number', description: 'For an array<shared<T>> field, write only this slot index (leaving other slots intact). Omit to write the whole array from `guids`.' },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Caller-minted correlation id for this accepted/running/terminal OperationRun. Use getOperationRun(), waitOperationRun(), or subscribeOperationRun() with the same id.' },
      },
      required: ['entity', 'component', 'field', 'assetType', 'guids', 'requestId'],
    },
    title: 'Bind Asset Ref (resolve GUID -> shared<T> handle)',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  { id: 'assignAssetToEntity', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number', description: 'Target edit-world EntityHandle.' },
        asset: {
          type: 'object',
          properties: {
            guid: { type: 'string' },
            kind: { type: 'string', enum: ['material', 'mesh', 'texture', 'image'] },
            name: { type: 'string' },
          },
          required: ['guid', 'kind', 'name'],
        },
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      },
      required: ['entity', 'asset', 'requestId'],
    },
    title: 'Assign Asset To Entity',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
  // setAnimationPreview (animation-preview M1): the Inspector preview transport
  // for AnimationPlayer. SESSION-domain, ledger-only, no undo — preview is
  // session state, not authored intent. Cataloged so an AI drives the SAME
  // preview the human transport bar drives (registry razor). The applier reads
  // the component's reflected playback contract (meta.animation transport field
  // names) and snapshots the declared runtimeFields before the first preview
  // write; save/play/selection-change boundaries restore them, so a preview
  // never pollutes the saved scene.
  { id: 'setAnimationPreview', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number', description: 'Entity handle carrying AnimationPlayer in the active edit world. The first preview write snapshots the runtimeFields; leaving the selection / saving / playing restores the authored values.' },
        playing: { type: 'boolean', description: 'true resumes playback (paused=false); false pauses. At least one of playing/speed/phase is required per dispatch.' },
        speed: { type: 'number', minimum: 0, maximum: 10, description: 'Playback speed multiplier written to the primary clip slot (transport clipIndex). 0 freezes the slot.' },
        phase: { type: 'number', minimum: 0, maximum: 1, description: 'Normalized scrub position 0..1, converted to seconds via the bound clip duration. Fails fast (ASSET_NOT_FOUND) when no clip is bound to the primary slot.' },
      },
      required: ['entity'],
    },
    title: 'Preview Animation Playback',
  },

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
  { id: 'openAssetEditor', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: { asset: { type: 'object' } },
      required: ['asset'],
    },
    title: 'Open Asset Editor',
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
  // ── scan pipeline ops (session domain, ledger-only, no undo) ──────────
  { id: 'assetCatalogRefreshed', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        added: { type: 'array', items: { type: 'string' } },
        removed: { type: 'array', items: { type: 'string' } },
        reimported: { type: 'array', items: { type: 'string' } },
      },
      required: ['added', 'removed', 'reimported'],
    },
    title: 'Asset Catalog Refreshed',
  },
  { id: 'assetReimported', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        guid: { type: 'string' },
        reason: { type: 'string', enum: ['content-changed', 'importer-upgraded', 'ddc-missing'] },
      },
      required: ['path', 'guid', 'reason'],
    },
    title: 'Asset Reimported',
  },
  { id: 'assetOrphanDetected', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: { sourcePath: { type: 'string' }, metaPath: { type: 'string' } },
      required: ['sourcePath', 'metaPath'],
    },
    title: 'Asset Orphan Detected',
  },
  { id: 'assetValidationFailed', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: { diagnostics: { type: 'array' } },
      required: ['diagnostics'],
    },
    title: 'Asset Validation Failed',
  },
  { id: 'requestReimport', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
    title: 'Request Reimport',
  },
  { id: 'validateGameProject', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string', minLength: 1, maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          description: 'Caller-minted correlation id for the accepted/running/terminal project validation run.',
        },
        maxBytes: { type: 'number', minimum: 0, description: 'Optional producer validator build-byte budget override.' },
        maxEntities: { type: 'number', minimum: 0, description: 'Optional producer validator entity budget override.' },
        retryOfRequestId: {
          type: 'string', minLength: 1, maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          description: 'Optional failed validation run being retried with this new requestId.',
        },
      },
      required: ['requestId'],
    },
    title: 'Validate Game Project',
    operationRun: {
      acceptedStatuses: ['accepted', 'running'],
      terminalStatuses: ['succeeded', 'failed'],
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
      retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
      cancellable: false,
    },
  },
];

for (const op of builtinOps) {
  registerBuiltinOp(op);
}
