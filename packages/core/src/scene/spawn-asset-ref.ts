/**
 * Content Browser → scene spawn (Add to Scene / drag-drop).
 * Single-realm: panels and viewport share the same host window.
 */
import { gateway, broadcastAssetsChanged, instantiateSceneRefUnderWorld, notifyDocChanged } from '../store/store';
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

/** Add a whole imported GLB/FBX to the scene as a NESTED SceneInstance mount:
 *  spawn a wrapper entity via the gateway (so it is the mount ROOT →
 *  round-trips as one `mounts[]` entry), then instantiate the scene sub-asset
 *  under it via the engine's canonical loadByGuid → instantiate spine
 *  (instantiateSceneRefUnderWorld). This renders the REAL GLB geometry (not a
 *  HANDLE_CUBE placeholder) and survives save → reopen → Play through the
 *  engine's native mount mechanism. Returns true on success. On failure the
 *  wrapper is left in place (harmless empty node) and we return false — callers
 *  MUST NOT fall back to cubes. */
async function spawnGlbSceneAsMount(sceneGuid: string, name: string): Promise<boolean> {
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
    console.warn('[spawn-asset] could not resolve wrapper handle for GLB mount');
    return false;
  }
  const root = await instantiateSceneRefUnderWorld(sceneGuid, wrapperHandle as unknown as number);
  if (root === null) {
    console.warn('[spawn-asset] GLB scene instantiate failed — NOT falling back to cubes:', { sceneGuid, name });
    return false;
  }
  notifyDocChanged();
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.scene-mount', { sceneGuid, name, wrapper: wrapperHandle, root });
  return true;
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
  void spawnGlbSceneAsMount(sceneGuid, label).catch((e) =>
    console.warn('[editor-core] addSceneAssetToScene failed:', e),
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
