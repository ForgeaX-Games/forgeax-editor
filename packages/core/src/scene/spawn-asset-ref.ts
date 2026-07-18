/**
 * Content Browser → scene spawn (Add to Scene / drag-drop).
 * Single-realm: panels and viewport share the same host window.
 */
import { resolveComponent } from '@forgeax/engine-ecs';
import { gateway, broadcastAssetsChanged, instantiateSceneRefUnderWorld, resolveAssetRefToHandle, notifyDocChanged } from '../store/store';
import { buildSpawnEntityFromDragRef, recoverMeshOriginalMaterialGuids, stemName, type DragAssetRef } from '../assets/drag-asset-spawn';
import { sessionAppliers } from '../io/appliers';
import type { EntityHandle } from './scene-types';
import type { AssetChatRef } from '../io/cross-panel-types';

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
  };
}

async function spawnReferenceEntity(ref: DragAssetRef): Promise<boolean> {
  const kind = ref.kind ?? '';

  // feat-20260708 M1 path 1 (plan-strategy D-4, AC-02/AC-04): for a mesh ref,
  // recover the source glTF per-submesh material GUIDs BEFORE building the spawn
  // command, so they ride an EditorPendingMeshMaterials marker (drag-asset-spawn.ts)
  // that the edit-runtime resolver turns into MeshRenderer.materials[]. This REPLACES
  // the old `Material.submeshMaterials` death-write — `Material` was deleted by the
  // world-container collapse, so spawnComponentData dropped it without a trace:
  // recovered materials never reached the world and vanished on reopen/Play
  // (AGENTS.md #2 / AC-04). Best-effort: any recovery miss leaves it single-material.
  const materialGuids = kind === 'mesh' ? await recoverMeshOriginalMaterialGuids(ref) : undefined;

  const entity = buildSpawnEntityFromDragRef(ref, materialGuids ? { materialGuids } : undefined);
  if (!entity) return false;

  gateway.dispatch({ kind: 'spawnEntity', name: entity.name, components: entity.components });
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.reference', { kind, guid: ref.guid, name: entity.name });
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

/**
 * After a SceneInstance mount, find entities that carry Skin but lack
 * AnimationPlayer and add a default AnimationPlayer to each. This lets
 * the user immediately bind animation clips without needing to know which
 * entity inside the mount subtree is the skinned mesh. The collect fold
 * (`foldMountOverrides`) captures the runtime-added component as a
 * MountOverride automatically on save.
 */
function autoAddAnimationPlayerToSkinEntities(sceneInstanceRoot: number): void {
  try {
    const w = gateway.doc.world as unknown as {
      getSceneInstanceState(root: unknown): { ok: boolean; value?: { entityToLocalId: Map<unknown, unknown> } };
      get(entity: unknown, token: unknown): { ok: boolean; value?: unknown };
      addComponent(entity: unknown, data: { component: unknown; data: unknown }): { ok: boolean };
    };
    if (!w) return;

    const skinToken = resolveComponent('Skin');
    const animToken = resolveComponent('AnimationPlayer');
    if (!skinToken || !animToken) return;

    const stateRes = w.getSceneInstanceState(sceneInstanceRoot);
    if (!stateRes.ok || !stateRes.value) return;

    for (const member of stateRes.value.entityToLocalId.keys()) {
      const hasSkin = w.get(member, skinToken);
      if (!hasSkin.ok) continue;
      const hasAnim = w.get(member, animToken);
      if (hasAnim.ok) continue;

      const r = w.addComponent(member, {
        component: animToken,
        data: {
          weights: new Float32Array([1, 0, 0, 0]),
          speeds: new Float32Array([1, 1, 1, 1]),
          paused: false,
          looping: true,
        },
      });
      if (r.ok) {
        console.info('[spawn-asset] auto-added AnimationPlayer to Skin entity', member);
      }
    }
  } catch (e) {
    console.warn('[spawn-asset] autoAddAnimationPlayerToSkinEntities failed:', e);
  }
}

/** Add a whole imported GLB/FBX to the scene as a NESTED SceneInstance mount:
 *  spawn a wrapper entity via the gateway (so it is the mount ROOT →
 *  round-trips as one `mounts[]` entry), then instantiate the scene sub-asset
 *  under it via the engine's canonical loadByGuid → instantiate spine
 *  (instantiateSceneRefUnderWorld). This renders the REAL GLB geometry (not a
 *  HANDLE_CUBE placeholder) and survives save → reopen → Play through the
 *  engine's native mount mechanism. Returns true on success. On failure the
 *  wrapper is left in place (harmless empty node) and we return false — callers
 *  MUST NOT fall back to cubes. */
async function spawnGlbSceneAsMount(sceneGuid: string, name: string): Promise<
  { ok: true; wrapper: EntityHandle; root: number }
  | { ok: false; hint: string }
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
    return { ok: false, hint: 'could not create the SceneInstance wrapper entity' };
  }
  const root = await instantiateSceneRefUnderWorld(sceneGuid, wrapperHandle as unknown as number);
  if (root === null) {
    return {
      ok: false,
      hint: `could not load or instantiate scene asset ${sceneGuid}; the empty wrapper remains and can be undone`,
    };
  }
  autoAddAnimationPlayerToSkinEntities(root as unknown as number);
  notifyDocChanged();
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.scene-mount', { sceneGuid, name, wrapper: wrapperHandle, root });
  return { ok: true, wrapper: wrapperHandle, root };
}

// ── Session applier: addSceneAssetToScene (ledger-only, no undo) ───────────────
// solo round-6 / skinning-pillar convergence. WHY THIS EXISTS (registry razor +
// invariant 7): a scene sub-asset catalogued by GUID (e.g. just imported via the
// `importAsset` op) had NO front-door path into the live scene — the whole
// "Add to Scene" orchestration (spawnGlbSceneAsMount) lived only in this module's
// UI-called closure, so an AI could NOT do what the human "Add to Scene" button
// does. `instantiateSceneAsset` (document domain, SYNC) takes a pre-collected POD,
// not a catalog GUID, and can't loadByGuid (async) — so it cannot serve this path.
//
// This registers a SESSION op that IS spawnGlbSceneAsMount, mirroring importAsset's
// fire-and-forget shape (applier returns synchronously; the async body completes in
// a detached promise, broadcastAssetsChanged() on completion). Now the human UI
// (spawnAssetRefToScene, below) and any AI dispatch the SAME op → the SAME body →
// one door, human + AI equal peers. The wrapper-spawn inside the body is a document
// op (undoable, marks dirty); the nested SceneInstance subtree is the engine's
// by-design derived cache (AGENTS.md invariant 7 escape hatch), round-tripping as
// one mounts[] entry via the wrapper's SceneInstance ref.
sessionAppliers.set('addSceneAssetToScene', (op) => {
  const { sceneGuid, name } = op as { sceneGuid: string; name?: string };
  if (typeof sceneGuid !== 'string' || sceneGuid.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'addSceneAssetToScene requires a non-empty `sceneGuid` (a catalogued scene sub-asset GUID)' } };
  }
  const label = typeof name === 'string' && name.length > 0 ? name : 'Scene';
  gateway.beginSceneMountAttempt();
  void spawnGlbSceneAsMount(sceneGuid, label)
    .then((result) => {
      if (result.ok) {
        gateway.completeSceneMountAttempt();
        return;
      }
      gateway.failSceneMountAttempt({ code: 'scene-mount-failed', hint: result.hint });
    })
    .catch((e) => {
      const hint = e instanceof Error ? e.message : String(e);
      gateway.failSceneMountAttempt({ code: 'scene-mount-failed', hint });
    });
  return { ok: true };
});

// ── Session applier: bindAssetRef (ledger-only, no undo on the resolve; the
// resulting setComponent IS a document op that undoes) ─────────────────────────
// solo round-11 / P5 rendering-authoring convergence. WHY THIS EXISTS (the missing
// front-door projection): `addComponent`/`setComponent` pass their value/patch RAW
// to the engine — no shared<T> GUID->handle resolution — so a catalogued GUID
// written into a shared<T> field (MeshRenderer.materials, Skylight.equirect,
// AnimationPlayer.clips) silently coerces to handle 0. Meshes/materials get resolved
// only via the drag-spawn spawn-marker side-channel (edit-runtime/drag-spawn-
// resolve.ts) — reachable by a drag gesture, NOT by an AI dispatch. This op is the
// general, dispatchable binder: loadByGuid -> allocSharedRef (resolveAssetRefToHandle,
// the same engine spine addSceneAssetToScene uses) -> write the live handle(s) into
// the field via a DOCUMENT setComponent (so the bind is undoable + round-trips like
// any owned-entity component write). One op closes the whole shared<T> class.
//
// Fire-and-forget async (mirrors addSceneAssetToScene): the applier returns
// synchronously; resolution + the setComponent dispatch complete in a detached
// promise. Writes onto an OWNED entity; a shared<T> field on a mount MEMBER needs
// the escalated engine mount-override round-trip (P6 ENGINE-FINDING), not this op.
async function bindAssetRefBody(
  entity: number,
  component: string,
  field: string,
  assetType: string,
  guids: string[],
  slot: number | undefined,
): Promise<void> {
  // Resolve every GUID to a live handle first; a single miss aborts the whole bind
  // (Fail Fast — never write a partial/zeroed ref).
  const handles: number[] = [];
  for (const g of guids) {
    const h = await resolveAssetRefToHandle(g, assetType);
    if (h === null) {
      console.warn('[editor-core] bindAssetRef: could not resolve guid — bind aborted', { guid: g, assetType });
      return;
    }
    handles.push(h);
  }

  // Compute the field value. `slot` targets one element of an array<shared<T>> field
  // (preserving the other slots); otherwise write the whole field. A scalar
  // shared<T> field takes handles[0]; an array field takes the handle list.
  let value: number | number[];
  if (slot !== undefined) {
    // Read the current array to preserve untouched slots. resolveComponent +
    // world.get is the SSOT read (same primitive query-snapshot uses); fall back to
    // a fresh array if the component/field is absent.
    const cur = readComponentField(entity, component, field);
    const arr = Array.isArray(cur) ? [...(cur as number[])] : [];
    while (arr.length <= slot) arr.push(0);
    arr[slot] = handles[0] ?? 0;
    value = arr;
  } else {
    // Whole-field write. A scalar shared<T> field (e.g. Skylight.equirect) gets a
    // single handle; an array field (materials/clips) gets the list.
    value = isScalarSharedField(component, field) ? (handles[0] ?? 0) : handles;
  }

  const r = gateway.dispatch({ kind: 'setComponent', entity, component, patch: { [field]: value } }, 'ai');
  if (!r.ok) {
    console.warn('[editor-core] bindAssetRef: setComponent rejected', r.error?.code, r.error?.hint);
    return;
  }
  notifyDocChanged();
  broadcastAssetsChanged();
  console.info('[editor-core] bindAssetRef: bound', { entity, component, field, assetType, count: handles.length, slot });

  if (component === 'AnimationPlayer' && field === 'clips') {
    autoActivateWeightsForBoundClips(entity, handles, slot);
  }
}

/**
 * When clips are bound to AnimationPlayer, auto-activate the corresponding
 * weight slots so the animation plays immediately. Without this, weights
 * default to [0,0,0,0] and the engine skips every slot.
 */
function autoActivateWeightsForBoundClips(entity: number, handles: number[], slot: number | undefined): void {
  try {
    const raw = readComponentField(entity, 'AnimationPlayer', 'weights');
    const weights = Array.isArray(raw) ? [...raw] as number[]
      : raw instanceof Float32Array ? Array.from(raw) : [0, 0, 0, 0];

    let changed = false;
    if (slot !== undefined) {
      if (weights[slot] === 0) { weights[slot] = 1; changed = true; }
    } else {
      for (let i = 0; i < handles.length; i++) {
        if (handles[i] !== 0 && (weights[i] ?? 0) === 0) { weights[i] = 1; changed = true; }
      }
    }
    if (!changed) return;

    gateway.dispatch({ kind: 'setComponent', entity, component: 'AnimationPlayer', patch: { weights } }, 'ai');
  } catch {
    // best-effort; never block the bind
  }
}

/** Read a component field's live value via the engine reflection primitives (the
 *  same resolveComponent path query-snapshot uses). Returns undefined if the
 *  component/field is absent — the caller defaults sensibly. Kept best-effort:
 *  a read miss must not throw out of the fire-and-forget applier. */
function readComponentField(entity: number, component: string, field: string): unknown {
  try {
    const w = gateway.doc.world as unknown as { get(e: number, tok: unknown): { ok: boolean; value?: Record<string, unknown> } } | undefined;
    if (!w) return undefined;
    const tok = resolveComponent(component);
    if (!tok) return undefined;
    const r = w.get(entity, tok);
    if (!r.ok || !r.value) return undefined;
    const v = r.value[field];
    // Normalize a typed-array field to a plain number[] so slot-splice is uniform.
    return ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v;
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

sessionAppliers.set('bindAssetRef', (op) => {
  const { entity, component, field, assetType, guids, slot } = op as {
    entity: number; component: string; field: string; assetType: string; guids: string[]; slot?: number;
  };
  if (typeof entity !== 'number') return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a numeric `entity` handle' } };
  if (typeof component !== 'string' || component.length === 0) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a `component` name' } };
  if (typeof field !== 'string' || field.length === 0) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a `field` name' } };
  if (typeof assetType !== 'string' || assetType.length === 0) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires an `assetType` tag (e.g. "MaterialAsset")' } };
  if (!Array.isArray(guids) || guids.length === 0 || !guids.every((g) => typeof g === 'string' && g.length > 0)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'bindAssetRef requires a non-empty `guids` array of catalogued asset GUID strings' } };
  }
  void bindAssetRefBody(entity, component, field, assetType, guids, typeof slot === 'number' ? slot : undefined).catch((e) =>
    console.warn('[editor-core] bindAssetRef failed:', e),
  );
  return { ok: true };
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
      // applier body IS spawnGlbSceneAsMount. dispatch() returns synchronously
      // ({ok:true}) while the mount completes in the applier's detached promise
      // (fire-and-forget async session-op contract). On a mount failure the body
      // warns + leaves the wrapper (no cube fallback); a post-import page-reload
      // makes the GUID resolvable and re-adding then succeeds.
      const r = gateway.dispatch({ kind: 'addSceneAssetToScene', sceneGuid, name: label });
      if (r.ok) return;
      console.warn('[spawn-asset] addSceneAssetToScene dispatch rejected:', r.error?.code, r.error?.hint);
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
        const entity = buildSpawnEntityFromDragRef(m);
        if (!entity) return null;
        return { kind: 'spawnEntity' as const, name: entity.name, components: entity.components };
      }).filter((c): c is NonNullable<typeof c> => c !== null);
      if (commands.length > 0) {
        gateway.dispatch({ kind: 'transaction', label: `Import: ${drag.name ?? 'FBX'}`, commands });
        broadcastAssetsChanged();
        console.info('[CB:import] spawn.scene-meshes', { count: commands.length });
        return;
      }
    }

    console.warn(
      '[spawn-asset] no spawnable scene/mesh sub-asset in package:',
      { importer: drag.payload?.importer, meshCount: meshRefs.length, metaPath: drag.path },
    );
    return;
  }

  console.warn('[spawn-asset] unsupported asset kind for Add to Scene:', kind, drag.guid);
}

/** Add an asset to the active Scene viewport (context-menu equivalent of dragging
 *  it onto the viewport — D-6). Co-located with spawnAssetRefToScene (which it
 *  wraps) so store need not depend on this module; re-exported from the barrel. */
export function requestAddAssetToScene(ref: AssetChatRef): void {
  console.info('[CB:import] addAssetToScene.direct', { kind: ref.kind, guid: ref.guid, name: ref.name });
  void spawnAssetRefToScene(ref);
}
