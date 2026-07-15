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
  // createMaterial (solo round-12 / P5 rendering-authoring): AUTHOR a new PBR
  // MaterialAsset from params — the create-a-look counterpart to bindAssetRef's
  // bind-an-existing-look. Cataloged (unlike createAsset) so an AI discovers it via
  // listOps(). The applier builds the POD via the engine's Materials.standard()
  // builder and writes it to the pack; the caller then binds the same guid onto a
  // mesh's MeshRenderer.materials via bindAssetRef.
  {
    id: 'createMaterial', domain: 'document',
    argsSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Caller-minted asset GUID (crypto.randomUUID() — 36-char RFC-4122 dash form). REUSE this same guid for the follow-up bindAssetRef; the op cannot return a minted guid (the dispatch result carries only entity handles).' },
        name: { type: 'string', description: 'Human-readable material name shown in the asset catalog.' },
        baseColor: { type: 'array', items: { type: 'number' }, description: 'PBR base color as [r,g,b,a], each 0..1 (a = opacity).' },
        metallic: { type: 'number', description: 'PBR metallic 0..1 (default 0 = dielectric).' },
        roughness: { type: 'number', description: 'PBR roughness 0..1 (default 0.5).' },
        baseColorTexture: { type: 'string', description: 'Optional TextureAsset GUID to set as baseColorTexture. Stored as refs[] index in pack (engine disk format).' },
        packPath: { type: 'string', description: 'Optional target pack path; defaults to the active game scene.pack.json (the same pack the scene saves into). An AI over the eval bridge normally omits this.' },
        refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['guid', 'name', 'baseColor'],
    },
    title: 'Create Material',
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
  // importAsset (Invariant 7 convergence): session-domain, ledger-only. Cataloged
  // so AI can self-discover it via gateway.listOps() (registry razor — the human
  // drag-drop capability is now equally AI-reachable). destPath is an on-disk
  // (game-relative OK) source; the applier uploads-then-cooks through the assetIO gate.
  { id: 'importAsset', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        destPath: { type: 'string', description: 'On-disk source path (game-relative accepted); the source must already be on disk unless skipUpload is false with bytes supplied by a UI caller.' },
        sourceName: { type: 'string', description: 'Optional basename override; defaults to the last path segment. Drives importer selection + cook meta.source.' },
        skipUpload: { type: 'boolean', description: 'Bytes already on disk — do not re-upload (default true for dispatched ops; the UI path uploads via the assetIO gate before dispatch).' },
      },
      required: ['destPath'],
    },
    title: 'Import Asset',
  },
  // addSceneAssetToScene (solo round-6 / skinning-pillar convergence): session-
  // domain, ledger-only, fire-and-forget async. Cataloged so AI self-discovers it
  // via gateway.listOps() (registry razor — the human "Add to Scene" capability is
  // now equally AI-reachable). Instantiates a catalogued scene sub-asset (by GUID,
  // e.g. just imported) into the live scene as a nested SceneInstance mount — the
  // missing last leg of the import→place chain (importAsset gets it INTO the
  // catalog; this gets it INTO the scene).
  { id: 'addSceneAssetToScene', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        sceneGuid: { type: 'string', description: 'A catalogued scene sub-asset GUID (from gateway.assetCatalog(), kind:"scene"). For a just-imported GLB/FBX, the whole-file scene sub-asset — this instantiates its real geometry + hierarchy (incl. Skin+Skeleton joints for a rigged asset), not a placeholder. NOTE: it does NOT create an AnimationPlayer — which clip plays is authoring intent, not baked by the gltf cook; you would author AnimationPlayer + bind an animation-clip yourself (a leg that is currently limited — see the gateway skill "Animate a skinned asset" note).' },
        name: { type: 'string', description: 'Optional name for the wrapper root entity; defaults to "Scene". The wrapper is the mount ROOT and round-trips as one mounts[] entry.' },
      },
      required: ['sceneGuid'],
    },
    title: 'Add Scene Asset to Scene',
  },
  // bindAssetRef (solo round-11 / P5 rendering-authoring): session-domain, ledger-
  // only, fire-and-forget async. Cataloged so AI self-discovers it via listOps().
  // The missing front-door binder for shared<T> component fields: addComponent/
  // setComponent pass value RAW (no GUID->handle resolution), so a GUID in a
  // shared<T> field silently becomes handle 0. This op resolves each GUID
  // (loadByGuid -> allocSharedRef) and writes the live handle(s) into the field via
  // a document setComponent (undoable, round-trips). One op for the whole class:
  // materials / equirect / animation-clips.
  { id: 'bindAssetRef', domain: 'session',
    argsSchema: {
      type: 'object',
      properties: {
        entity: { type: 'number', description: 'Target entity handle (an OWNED entity; a shared<T> field on a mount MEMBER needs the escalated engine mount-override round-trip, not this op).' },
        component: { type: 'string', description: 'Component carrying the shared<T> field, e.g. "MeshRenderer", "Skylight", "AnimationPlayer". Must already be present on the entity (this patches it).' },
        field: { type: 'string', description: 'The shared<T> field to bind, e.g. "materials", "equirect", "clips". Discover its type via gateway.describeComponent(component).' },
        assetType: { type: 'string', description: 'Engine asset-union tag for allocSharedRef, e.g. "MaterialAsset", "EquirectAsset", "AnimationClip". Must match the field\'s shared<T> target type.' },
        guids: { type: 'array', items: { type: 'string' }, description: 'Catalogued asset GUID(s) (from gateway.assetCatalog()). For an array<shared<T>> field, one GUID per slot (unless `slot` is given). For a scalar shared<T> field, a single-element array.' },
        slot: { type: 'number', description: 'For an array<shared<T>> field, write only this slot index (leaving other slots intact). Omit to write the whole array from `guids`.' },
      },
      required: ['entity', 'component', 'field', 'assetType', 'guids'],
    },
    title: 'Bind Asset Ref (resolve GUID -> shared<T> handle)',
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
];

for (const op of builtinOps) {
  registerBuiltinOp(op);
}