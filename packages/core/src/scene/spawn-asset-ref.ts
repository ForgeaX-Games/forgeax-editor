/**
 * Content Browser → scene spawn (Add to Scene / drag-drop).
 * Single-realm: panels and viewport share the same host window.
 */
import { resolveComponent } from '@forgeax/engine-ecs';
import { walkMaterialPassesOverSharedRefs } from '@forgeax/engine-assets-runtime';
import { gateway, broadcastAssetsChanged, resolveAssetRefToHandle, notifyDocChanged } from '../store/store';
import { instantiateSceneRefUnderWorldDetailed } from '../store/scene-persistence';
import type { SceneInstantiationCleanup, SceneInstantiationError } from '../store/persistence/disk-io';
import { recoverMeshOriginalMaterialGuids, stemName, type DragAssetRef } from '../assets/drag-asset-spawn';
import { planAssetPlacement } from '../assets/asset-placement-plan';
import { registerApplier } from '../io/appliers';
import { syncAnimationSlotColumns, type AnimationSlotSyncIo } from './animation-slot-sync';
import { broadcastAssetsError } from '../store/assets-error-bus';
import { fieldSchema } from './schema';
import { planGroupedArrayPatch } from './array-edit';
import type { EntityHandle } from './scene-types';
import type { AssetChatRef } from '../io/cross-panel-types';
import type { CommandError } from '../types';

function toDragRef(ref: AssetChatRef): DragAssetRef {
  return {
    type: 'asset',
    // AssetChatRef.guid is optional (folder refs carry none); a spawnable
    // DragAssetRef requires a string. Only 'asset' refs reach spawn, so guid is
    // present in practice — default to '' to satisfy the type without changing
    // the prior (any-typed) runtime flow.
    guid: ref.guid ?? '',
    kind: ref.kind,
    name: ref.name,
    path: ref.path,
    payload: ref.payload,
    authoring: ref.authoring,
  };
}

async function spawnReferenceEntity(ref: DragAssetRef): Promise<boolean> {
  const kind = ref.kind ?? '';
  console.info(`[placement-diag] reference.begin ${JSON.stringify({
    guid: ref.guid,
    kind,
    name: ref.name,
    path: ref.path,
    gatewayRev: gateway.rev,
  })}`);

  // feat-20260708 M1 path 1 (plan-strategy D-4, AC-02/AC-04): for a mesh ref,
  // recover the source glTF per-submesh material GUIDs BEFORE building the spawn
  // command, so they ride an EditorPendingMeshMaterials marker (drag-asset-spawn.ts)
  // that the edit-runtime resolver turns into MeshRenderer.materials[]. This REPLACES
  // the old `Material.submeshMaterials` death-write — `Material` was deleted by the
  // world-container collapse, so spawnComponentData dropped it without a trace:
  // recovered materials never reached the world and vanished on reopen/Play
  // (AGENTS.md #2 / AC-04). Best-effort: any recovery miss leaves it single-material.
  const materialGuids = kind === 'mesh' ? await recoverMeshOriginalMaterialGuids(ref) : undefined;
  console.info(`[placement-diag] reference.dependencies ${JSON.stringify({
    guid: ref.guid,
    kind,
    materialGuids: materialGuids ?? [],
  })}`);

  // Phantom-ref guard input: the live catalog GUIDs, when a registry is bound
  // (always in the dev shell; absent in registry-less headless envs where the
  // validation is skipped rather than rejecting every spawn).
  const catalogGuids = gateway.doc.registry !== undefined
    ? gateway.assetCatalog().map((row) => row.guid)
    : undefined;
  const plan = planAssetPlacement(ref, {
    ...(materialGuids ? { materialGuids } : {}),
    ...(catalogGuids !== undefined ? { catalogGuids } : {}),
  });
  console.info(`[placement-diag] reference.plan ${JSON.stringify(plan.ok
    ? {
        ok: true,
        operation: plan.plan.operation,
        componentKeys: plan.plan.operation === 'spawnEntity' ? Object.keys(plan.plan.args.components) : [],
      }
    : { ok: false, code: plan.error.code, hint: plan.error.hint })}`);
  if (!plan.ok) {
    // A phantom-ref rejection (stale Content Browser row: deleted / failed-import
    // source) is TERMINAL — spawning would produce an entity whose mesh/material/
    // texture can never resolve (silent gray card, no retry). Surface the precise
    // reason through the panel error bus instead of falling through to the
    // generic "unsupported kind" broadcast below. All OTHER plan failures keep
    // the prior fall-through (e.g. a scene ref re-plans with a requestId in the
    // scene-mount path; an unsupported kind reaches the bottom refusal).
    if (plan.error.code === 'placement-asset-unknown') {
      console.warn('[spawn-asset] placement rejected (phantom asset ref):', plan.error.hint);
      broadcastAssetsError({ op: 'placeAsset', ...(ref.path ? { path: ref.path } : {}), hint: plan.error.hint });
      return true;
    }
    return false;
  }
  if (plan.plan.operation !== 'spawnEntity') return false;

  const dispatchResult = gateway.dispatch(plan.plan.args);
  console.info(`[placement-diag] reference.dispatch ${JSON.stringify(dispatchResult.ok
    ? {
        ok: true,
        created: dispatchResult.result?.created ?? [],
        gatewayRev: gateway.rev,
      }
    : {
        ok: false,
        code: dispatchResult.error.code,
        hint: dispatchResult.error.hint,
        gatewayRev: gateway.rev,
      })}`);
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.reference', { kind, guid: ref.guid, name: plan.plan.args.name });
  return true;
}

async function readMetaSubAssets(metaPath: string): Promise<Array<{ guid: string; kind: string; name?: string }>> {
  const r = await fetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
  if (!r.ok) return [];
  const meta = JSON.parse(await r.text()) as { subAssets?: Array<{ guid: string; kind: string; name?: string }> };
  return (meta.subAssets ?? []).filter((s) => s?.guid && s?.kind);
}

/** Mesh sub-assets declared in a scene package meta sidecar. */
async function resolveMeshSceneRefs(ref: DragAssetRef): Promise<DragAssetRef[]> {
  const metaPath = ref.path;
  if (typeof metaPath !== 'string' || !/\.meta\.json$/i.test(metaPath)) return [];
  try {
    const subAssets = await readMetaSubAssets(metaPath);
    return subAssets
      .filter((s) => s.kind === 'mesh')
      .map((s, i) => ({
        type: 'asset' as const,
        guid: s.guid,
        kind: 'mesh',
        name: s.name ?? `${ref.name ?? 'mesh'}_${i}`,
        path: metaPath,
        payload: ref.payload,
      }));
  } catch {
    return [];
  }
}

/** Resolve the whole-GLB `kind:'scene'` sub-asset GUID for a scene drag ref.
 *  Prefer the ref's own guid (the Content Browser stamps the scene sub-asset GUID
 *  directly on a kind:'scene' ref); fall back to reading the `.meta.json` sidecar
 *  for its `kind:'scene'` subAsset entry (drag/older refs). Returns null if none. */
async function resolveSceneSubAssetGuid(ref: DragAssetRef): Promise<string | null> {
  if (ref.guid && /^[0-9a-f]{8}-/i.test(ref.guid)) return ref.guid;
  const metaPath = ref.path;
  if (typeof metaPath !== 'string' || !/\.meta\.json$/i.test(metaPath)) return null;
  try {
    const subAssets = await readMetaSubAssets(metaPath);
    return subAssets.find((s) => s.kind === 'scene')?.guid ?? null;
  } catch {
    return null;
  }
}

type SceneMountCleanup =
  | { attempted: false }
  | { attempted: true; ok: true; wrapper: EntityHandle }
  | { attempted: true; ok: false; wrapper: EntityHandle; error: CommandError };

type SceneMountFailure = {
  ok: false;
  failure: SceneInstantiationError;
  cleanup: SceneMountCleanup;
  instantiationCleanup: SceneInstantiationCleanup;
};

/** Add a whole imported GLB/FBX to the scene as a NESTED SceneInstance mount:
 *  spawn a wrapper entity via the gateway (so it is the mount ROOT →
 *  round-trips as one `mounts[]` entry), then instantiate the scene sub-asset
 *  under it via the engine's canonical loadByGuid → instantiate spine
 *  (instantiateSceneRefUnderWorld). This renders the REAL GLB geometry (not a
 *  HANDLE_CUBE placeholder) and survives save → reopen → Play through the
 *  engine's native mount mechanism. A failed async instantiation rolls back
 *  the provisional wrapper through the Gateway before returning its terminal
 *  failure facts — callers MUST NOT fall back to cubes. */
async function spawnGlbSceneAsMount(sceneGuid: string, name: string, requestId: string): Promise<
  { ok: true; wrapper: EntityHandle; root: number }
  | SceneMountFailure
> {
  // Identity-Transform wrapper via the gateway (undoable, marks the doc dirty).
  // The spawn's created channel gives the real engine handle — that handle IS the
  // wrapper identity we parent the nested instance under (no id-to-handle lookup).
  const r = gateway.dispatch({
    kind: 'spawnEntity',
    name,
    components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  });
  const wrapperHandle: EntityHandle | undefined =
    r.ok && r.result ? r.result.created[0] : undefined;
  if (wrapperHandle === undefined) {
    return {
      ok: false,
      failure: {
        code: 'scene-wrapper-spawn-failed',
        hint: 'could not create the SceneInstance wrapper entity',
      },
      cleanup: { attempted: false },
      instantiationCleanup: { attempted: false },
    };
  }
  const instantiated = await instantiateSceneRefUnderWorldDetailed(sceneGuid, wrapperHandle as unknown as number);
  if (!instantiated.ok) {
    let cleanupFacts: SceneMountCleanup;
    try {
      const cleanup = gateway.dispatch({ kind: 'destroyEntity', entity: wrapperHandle }, 'ai');
      cleanupFacts = cleanup.ok
        ? { attempted: true, ok: true, wrapper: wrapperHandle }
        : { attempted: true, ok: false, wrapper: wrapperHandle, error: cleanup.error };
    } catch (error) {
      cleanupFacts = {
        attempted: true,
        ok: false,
        wrapper: wrapperHandle,
        error: {
          code: 'DESPAWN_FAILED',
          hint: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return {
      ok: false,
      failure: instantiated.error,
      cleanup: cleanupFacts,
      instantiationCleanup: instantiated.cleanup,
    };
  }
  const root = instantiated.root;
  notifyDocChanged();
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.scene-mount', { sceneGuid, name, wrapper: wrapperHandle, root });
  return { ok: true, wrapper: wrapperHandle, root };
}

// ── Session applier: addSceneAssetToScene (ledger-only, no undo) ───────────────
// R0-05B request correlation. WHY THIS EXISTS (registry razor +
// invariant 7): a scene sub-asset catalogued by GUID (e.g. just imported via the
// `importAsset` op) had NO front-door path into the live scene — the whole
// "Add to Scene" orchestration (spawnGlbSceneAsMount) lived only in this module's
// UI-called closure, so an AI could NOT do what the human "Add to Scene" button
// does. `instantiateSceneAsset` (document domain, SYNC) takes a pre-collected POD,
// not a catalog GUID, and can't loadByGuid (async) — so it cannot serve this path.
//
// This registers a SESSION op whose completion is returned to the Gateway. The
// Gateway owns the accepted/running/terminal OperationRun; this module owns only
// the canonical mount effect. The wrapper-spawn inside the body is a document op
// (undoable, marks dirty); the nested SceneInstance subtree is the engine's
// by-design derived cache, round-tripping as one mounts[] entry via the wrapper's
// SceneInstance ref.
registerApplier('session', 'addSceneAssetToScene', (op) => {
  const { sceneGuid, name, requestId } = op as { sceneGuid: string; name?: string; requestId: string };
  if (typeof sceneGuid !== 'string' || sceneGuid.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'addSceneAssetToScene requires a non-empty `sceneGuid` (a catalogued scene sub-asset GUID)' } };
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'addSceneAssetToScene requires a non-empty `requestId` for OperationRun correlation' } };
  }
  const label = typeof name === 'string' && name.length > 0 ? name : 'Scene';
  const completion = spawnGlbSceneAsMount(sceneGuid, label, requestId)
    .then((result) => {
      if (result.ok) {
        return { ok: true, result: { requestId, sceneGuid, name: label, wrapper: result.wrapper, root: result.root } };
      }
      const nestedCleanupOk = !result.instantiationCleanup.attempted || result.instantiationCleanup.ok;
      const cleanupRecovered = result.cleanup.attempted && result.cleanup.ok && nestedCleanupOk;
      return {
        ok: false,
        error: {
          code: 'scene-mount-failed',
          hint: result.failure.hint,
          cause: {
            code: result.failure.code,
            hint: result.failure.hint,
            ...(result.failure.detail === undefined ? {} : { details: result.failure.detail }),
          },
          current: {
            requestId,
            sceneGuid,
            name: label,
            failure: result.failure,
            cleanup: result.cleanup,
            instantiationCleanup: result.instantiationCleanup,
          },
          retryable: cleanupRecovered,
          recoveryActions: cleanupRecovered ? [] : ['inspect provisional wrapper and retry cleanup'],
        },
      };
    })
    .catch((e) => {
      const hint = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: {
          code: 'scene-mount-failed',
          hint,
          current: { requestId, sceneGuid, name: label, cleanup: { attempted: false } },
          retryable: false,
          recoveryActions: ['inspect scene mount state before retrying'],
        },
      };
    });
  return { ok: true, completion };
});

// ── Session applier: bindAssetRef (ledger-only, no undo on the resolve; the
// resulting document write IS a document op that undoes) ────────────────────────
// solo round-11 / P5 rendering-authoring convergence. WHY THIS EXISTS (the missing
// front-door projection): `addComponent`/`setComponent` pass their value/patch RAW
// to the engine — no shared<T> GUID->handle resolution — so a catalogued GUID
// written into a shared<T> field (MeshRenderer.materials, Skylight.equirect,
// AnimationPlayer.clips) silently coerces to handle 0. Meshes/materials get resolved
// only via the drag-spawn spawn-marker side-channel (edit-runtime/drag-spawn-
// resolve.ts) — reachable by a drag gesture, NOT by an AI dispatch. This op is the
// general, dispatchable binder: loadByGuid -> allocSharedRef (resolveAssetRefToHandle,
// the same engine spine addSceneAssetToScene uses) -> write the live handle(s) into
// the field via a DOCUMENT setComponent or setSceneOverride (so the bind is
// undoable + round-trips like any owned-entity or mount-member write). One op
// closes the whole shared<T> class.
//
// Request-correlated async (R0-05C): the applier returns the completion promise to
// the Gateway, which owns the accepted/running/terminal OperationRun. Writes onto
// an owned entity or mount member; engine collection folds supported member field
// patches into the parent pack's mounts[].overrides[].
type BindAssetRefRunResult = {
  requestId: string;
  entity: number;
  component: string;
  field: string;
  assetType: string;
  guids: string[];
  resolvedHandles: number[];
  slot?: number;
  valueShape: 'scalar' | 'array' | 'array-slot';
};

type BindAssetRefEffect =
  | { ok: true; result: BindAssetRefRunResult }
  | { ok: false; error: CommandError };

/**
 * The renderer has a bidirectional Skin <-> pbr-skin contract. Keep the same
 * contract at the bind gateway so a human context-menu action and an AI
 * dispatch cannot author a combination that immediately enters the RHI error
 * loop. This is deliberately a pre-write check: a rejected bind must not
 * allocate a document mutation or leave a half-updated field behind.
 */
function hasActiveSkinBinding(entity: number): boolean {
  try {
    const world = gateway.doc.world;
    const skin = resolveComponent('Skin');
    if (!world || !skin) return false;
    const result = world.get(entity as EntityHandle, skin);
    if (!result.ok || !result.value) return false;
    const skeleton = (result.value as { skeleton?: unknown }).skeleton;
    return typeof skeleton === 'number' && skeleton !== 0;
  } catch {
    return false;
  }
}

function firstMaterialShader(handle: number): string | undefined {
  try {
    const world = gateway.doc.world;
    const registry = gateway.doc.registry;
    if (!world || !registry) return undefined;
    const result = walkMaterialPassesOverSharedRefs(world, handle as never, registry);
    if (!result.ok) return undefined;
    return result.value.passes[0]?.program.module;
  } catch {
    return undefined;
  }
}

function validateMaterialBinding(
  requestId: string,
  entity: number,
  component: string,
  field: string,
  assetType: string,
  guids: string[],
  handles: number[],
): CommandError | undefined {
  if (assetType !== 'MaterialAsset' || component !== 'MeshRenderer' || field !== 'materials') {
    return undefined;
  }

  const targetIsSkinned = hasActiveSkinBinding(entity);
  for (let i = 0; i < handles.length; i++) {
    const shader = firstMaterialShader(handles[i] ?? 0);
    if (shader === undefined) continue;
    const materialIsSkinned = shader === 'forgeax::pbr-skin';
    if (materialIsSkinned === targetIsSkinned) continue;
    return {
      code: 'asset-bind-incompatible',
      hint: materialIsSkinned
        ? `material ${guids[i] ?? '<unknown>'} uses forgeax::pbr-skin and requires a target entity with an active Skin.skeleton binding`
        : `material ${guids[i] ?? '<unknown>'} is not forgeax::pbr-skin and cannot be bound to an entity with an active Skin.skeleton binding`,
      current: {
        requestId,
        entity,
        component,
        field,
        assetType,
        guid: guids[i],
        guidIndex: i,
        targetIsSkinned,
        materialShader: shader,
      },
      retryable: false,
      recoveryActions: [
        materialIsSkinned
          ? 'select an entity whose Skin.skeleton is bound, or choose a non-skinned material'
          : 'select a non-skinned entity, or choose a forgeax::pbr-skin material',
      ],
    };
  }
  return undefined;
}

async function bindAssetRefBody(
  requestId: string,
  entity: number,
  component: string,
  field: string,
  assetType: string,
  guids: string[],
  slot: number | undefined,
): Promise<BindAssetRefEffect> {
  // Resolve every GUID to a live handle first; a single miss aborts the whole bind
  // (Fail Fast — never write a partial/zeroed ref).
  const handles: number[] = [];
  for (const g of guids) {
    const resolved = await resolveAssetRefToHandle(g, assetType);
    if (!resolved.ok) {
      return {
        ok: false,
        error: {
          code: 'ASSET_NOT_FOUND',
          hint: `could not resolve catalogued asset GUID ${g} as ${assetType}: ${resolved.error.hint}`,
          current: {
            requestId, entity, component, field, assetType, guid: g,
            guidIndex: handles.length, cause: resolved.error,
          },
          retryable: true,
          recoveryActions: ['refresh the asset catalog and retry the bind'],
        },
      };
    }
    handles.push(resolved.value);
  }

  const compatibilityError = validateMaterialBinding(
    requestId,
    entity,
    component,
    field,
    assetType,
    guids,
    handles,
  );
  if (compatibilityError !== undefined) {
    return { ok: false, error: compatibilityError };
  }

  // Whole-field writes and slot writes both use the component schema's producer-
  // declared parallel-array metadata. One `setComponent` must carry the whole
  // group or the strict document validator correctly rejects a length change as
  // a temporarily desynchronised SoA write (e.g. AnimationPlayer clips/times/
  // weights/speeds).
  const isArrayField = fieldSchema(component, field)?.arrayMeta !== undefined;
  const current = readComponentData(entity, component) ?? {};
  const requestedValue = slot === undefined
    ? (isScalarSharedField(component, field) ? (handles[0] ?? 0) : handles)
    : (handles[0] ?? 0);
  let patch: Record<string, unknown> = { [field]: requestedValue };
  if (isArrayField) {
    const planned = planGroupedArrayPatch({ component, field, value: requestedValue, ...(slot === undefined ? {} : { slot }) }, current);
    if (!planned.ok) {
      return {
        ok: false,
        error: {
          code: 'SET_FAILED',
          hint: planned.hint,
          details: { fieldPath: planned.fieldPath, reason: planned.reason },
          retryable: false,
          recoveryActions: [],
        },
      };
    }
    patch = planned.patch;
  }
  const r = gateway.dispatch({ kind: 'setComponent', entity, component, patch }, 'ai');
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  notifyDocChanged();
  broadcastAssetsChanged();
  console.info('[editor-core] bindAssetRef: bound', { entity, component, field, assetType, count: handles.length, slot });

  if (component === 'AnimationPlayer' && field === 'clips') {
    syncAnimationSlotColumns(ANIMATION_SLOT_SYNC_IO, entity, handles, slot);
  }
  return {
    ok: true,
    result: {
      requestId,
      entity,
      component,
      field,
      assetType,
      guids: [...guids],
      resolvedHandles: [...handles],
      ...(slot === undefined ? {} : { slot }),
      valueShape: slot !== undefined ? 'array-slot' : isScalarSharedField(component, field) ? 'scalar' : 'array',
    },
  };
}

/**
 * Binding clips pads/grows the clips column; the engine's parallel-length
 * contract (animation-player.ts D-5) demands times/weights/speeds match it
 * exactly, else advanceAnimationPlayer rejects the row. The compensating write
 * (pad times=0 / speeds=1, weights=0 then activate the bound slots) lives in
 * scene/animation-slot-sync — pure logic over this injected face, CI-testable
 * without a live world. Routed through the one document door (setComponent) so
 * the sync is undoable + round-trips like the bind itself.
 */
const ANIMATION_SLOT_SYNC_IO: AnimationSlotSyncIo = {
  readField: readComponentField,
  dispatchSetComponent: (entity, component, patch) => {
    gateway.dispatch({ kind: 'setComponent', entity, component, patch }, 'ai');
  },
};

/** Read a component field's live value via the engine reflection primitives (the
 *  same resolveComponent path query-snapshot uses). Returns undefined if the
 *  component/field is absent — the caller defaults sensibly. Kept best-effort:
 *  a read miss must not throw out of the fire-and-forget applier. */
function readComponentField(entity: number, component: string, field: string): unknown {
  return readComponentData(entity, component)?.[field];
}

function readComponentData(entity: number, component: string): Record<string, unknown> | undefined {
  try {
    const w = gateway.doc.world as unknown as { get(e: number, tok: unknown): { ok: boolean; value?: Record<string, unknown> } } | undefined;
    if (!w) return undefined;
    const tok = resolveComponent(component);
    if (!tok) return undefined;
    const r = w.get(entity, tok);
    if (!r.ok || !r.value) return undefined;
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(r.value)) {
      // Normalize typed-array fields to plain arrays so group planning is uniform.
      out[field] = ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Is `component.field` a SCALAR shared<T> (vs an array<shared<T>>)? Derived from
 *  the component's own schema (§2.5 — depend on the value's declared shape, not a
 *  hardcoded field list): a field typed `shared<...>` is scalar, `array<shared<...>>`
 *  is not. Defaults to array-form on an unknown field (the safe multi-slot shape). */
function isScalarSharedField(component: string, field: string): boolean {
  try {
    const tok = resolveComponent(component) as { schema?: Record<string, string> } | undefined;
    const t = tok?.schema?.[field];
    return typeof t === 'string' && t.startsWith('shared<');
  } catch {
    return false;
  }
}

registerApplier('session', 'bindAssetRef', (op) => {
  const { entity, component, field, assetType, guids, slot, requestId } = op as {
    entity: number; component: string; field: string; assetType: string; guids: string[]; slot?: number; requestId: string;
  };
  if (typeof entity !== 'number') return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a numeric `entity` handle' } };
  if (typeof component !== 'string' || component.length === 0) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a `component` name' } };
  if (typeof field !== 'string' || field.length === 0) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a `field` name' } };
  if (typeof assetType !== 'string' || assetType.length === 0) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires an `assetType` tag (e.g. "MaterialAsset")' } };
  if (!Array.isArray(guids) || guids.length === 0 || !guids.every((g) => typeof g === 'string' && g.length > 0)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a non-empty `guids` array of catalogued asset GUID strings' } };
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a non-empty `requestId` for OperationRun correlation' } };
  }
  const completion = bindAssetRefBody(requestId, entity, component, field, assetType, guids, typeof slot === 'number' ? slot : undefined)
    .catch((e): BindAssetRefEffect => ({
      ok: false,
      error: {
        code: 'asset-bind-failed',
        hint: e instanceof Error ? e.message : String(e),
        current: { requestId, entity, component, field, assetType, guids },
        retryable: false,
        recoveryActions: [],
      },
    }));
  return { ok: true, completion };
});

export async function spawnAssetRefToScene(ref: AssetChatRef | DragAssetRef): Promise<void> {
  const drag = 'type' in ref && ref.type === 'asset' ? ref as DragAssetRef : toDragRef(ref as AssetChatRef);
  const kind = drag.kind ?? '';
  console.info('[CB:import] spawn.request', { kind, guid: drag.guid, name: drag.name, path: drag.path });

  if (await spawnReferenceEntity(drag)) return;

  if (kind === 'scene') {
    const label = drag.name ?? stemName(drag);

    // PRIMARY: instantiate the whole-GLB `kind:'scene'` sub-asset as a nested
    // SceneInstance mount — renders the REAL geometry + hierarchy and round-trips
    // through save → reopen → Play via the engine's native mounts[] mechanism
    // (AGENTS.md #1/#2: converge on the engine primitive, no HANDLE_CUBE
    // placeholder, no parallel format). This replaces the old spawnGlbScene path
    // that produced one builtin cube per node.
    const sceneGuid = await resolveSceneSubAssetGuid(drag);
    if (sceneGuid) {
      // Route through the SAME session op an AI dispatches (single door): the op's
      // applier body IS spawnGlbSceneAsMount. The returned requestId independently
      // identifies this accepted/running/terminal OperationRun.
      const requestId = globalThis.crypto.randomUUID();
      const plan = planAssetPlacement({ ...drag, guid: sceneGuid, name: label }, { requestId, sceneGuid });
      if (!plan.ok) {
        console.warn('[spawn-asset] placement plan rejected:', plan.error.code, plan.error.hint);
        broadcastAssetsError({ op: 'placeAsset', ...(drag.path ? { path: drag.path } : {}), hint: plan.error.hint });
        return;
      }
      if (plan.plan.operation !== 'addSceneAssetToScene') {
        const hint = 'placement plan selected a non-scene operation for a scene ref';
        console.warn('[spawn-asset]', hint);
        broadcastAssetsError({ op: 'placeAsset', ...(drag.path ? { path: drag.path } : {}), hint });
        return;
      }
      const r = gateway.dispatch(plan.plan.args);
      if (r.ok) return;
      console.warn('[spawn-asset] addSceneAssetToScene dispatch rejected:', r.error?.code, r.error?.hint);
      broadcastAssetsError({
        op: 'addSceneAssetToScene',
        ...(drag.path ? { path: drag.path } : {}),
        hint: r.error?.hint ?? 'addSceneAssetToScene dispatch rejected',
      });
      return;
    }

    // FALLBACK: a scene package that carries only mesh sub-assets (e.g. some FBX
    // exports) and no `kind:'scene'` sub-asset. Keep the existing single-/multi-
    // mesh reference spawn path for those.
    const meshRefs = await resolveMeshSceneRefs(drag);
    if (meshRefs.length === 1) {
      if (await spawnReferenceEntity(meshRefs[0]!)) return;
    } else if (meshRefs.length > 1) {
      const commands = meshRefs.map((m) => {
        const plan = planAssetPlacement(m);
        return plan.ok && plan.plan.operation === 'spawnEntity' ? plan.plan.args : null;
      }).filter((c): c is NonNullable<typeof c> => c !== null);
      if (commands.length > 0) {
        gateway.dispatch({ kind: 'transaction', label: `Import: ${drag.name ?? 'FBX'}`, commands });
        broadcastAssetsChanged();
        console.info('[CB:import] spawn.scene-meshes', { count: commands.length });
        return;
      }
    }

    const hint = 'No spawnable scene or mesh sub-asset is available in this package.';
    console.warn('[spawn-asset] no spawnable scene/mesh sub-asset in package:', {
      importer: drag.payload?.importer, meshCount: meshRefs.length, metaPath: drag.path,
    });
    broadcastAssetsError({ op: 'placeAsset', ...(drag.path ? { path: drag.path } : {}), hint });
    return;
  }

  const refusal = planAssetPlacement(drag);
  const hint = refusal.ok
    ? `Asset kind '${kind}' did not produce a supported scene placement operation.`
    : refusal.error.hint;
  console.warn('[spawn-asset] unsupported asset kind for Add to Scene:', kind, drag.guid);
  broadcastAssetsError({ op: 'placeAsset', ...(drag.path ? { path: drag.path } : {}), hint });
}

/** Add an asset to the active Scene viewport (context-menu equivalent of dragging
 *  it onto the viewport — D-6). Co-located with spawnAssetRefToScene (which it
 *  wraps) so store need not depend on this module; re-exported from the barrel. */
export function requestAddAssetToScene(ref: AssetChatRef): void {
  console.info('[CB:import] addAssetToScene.direct', { kind: ref.kind, guid: ref.guid, name: ref.name });
  void spawnAssetRefToScene(ref);
}
