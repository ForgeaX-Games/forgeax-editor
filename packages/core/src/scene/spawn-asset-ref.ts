/**
 * Content Browser → scene spawn (Add to Scene / drag-drop).
 * Single-realm: panels and viewport share the same host window.
 */
import { gateway, broadcastAssetsChanged, instantiateSceneRefUnderWorld, notifyDocChanged } from '../store/store';
import { apiFetch } from '../io/api-client';
import { buildSpawnEntityFromDragRef, stemName, type DragAssetRef } from '../assets/drag-asset-spawn';
import { resolveMeshOriginalMaterials } from './mesh-original-materials';
import { entHandle } from '../store/entity-state';
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
  const entity = buildSpawnEntityFromDragRef(ref);
  if (!entity) return false;

  if (kind === 'mesh') {
    try {
      const readRaw = async (p: string): Promise<Response | null> => {
        try {
          const r = await apiFetch(`/api/files/raw?path=${encodeURIComponent(p)}`);
          return r.ok ? r : null;
        } catch {
          return null;
        }
      };
      const subs = await resolveMeshOriginalMaterials(
        { guid: ref.guid, path: ref.path, payload: ref.payload },
        {
          fetchText: async (p) => { const r = await readRaw(p); return r ? r.text() : null; },
          fetchBytes: async (p) => { const r = await readRaw(p); return r ? r.arrayBuffer() : null; },
        },
      );
      if (subs && subs.length > 0) {
        const mat = (entity.components.Material ?? (entity.components.Material = {})) as Record<string, unknown>;
        mat.submeshMaterials = subs;
      }
    } catch (err) {
      console.warn('[spawn-asset] original-material recovery failed:', (err as Error)?.message ?? err);
    }
  }

  gateway.dispatch({ kind: 'spawnEntity', name: entity.name, components: entity.components });
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.reference', { kind, guid: ref.guid, name: entity.name });
  return true;
}

async function readMetaSubAssets(metaPath: string): Promise<Array<{ guid: string; kind: string; name?: string }>> {
  const r = await apiFetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
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
 *  spawn an `_e2h`-tracked wrapper entity via the gateway (so it is the mount ROOT →
 *  round-trips as one `mounts[]` entry), then instantiate the scene sub-asset
 *  under it via the engine's canonical loadByGuid → instantiate spine
 *  (instantiateSceneRefUnderWorld). This renders the REAL GLB geometry (not a
 *  HANDLE_CUBE placeholder) and survives save → reopen → Play through the
 *  engine's native mount mechanism. Returns true on success. On failure the
 *  wrapper is left in place (harmless empty node) and we return false — callers
 *  MUST NOT fall back to cubes. */
async function spawnGlbSceneAsMount(sceneGuid: string, name: string): Promise<boolean> {
  // Identity-Transform wrapper via the gateway (undoable, marks the doc dirty, and
  // gives us a real _e2h handle to parent the nested instance under).
  const cmd = {
    kind: 'spawnEntity' as const,
    name,
    components: { Transform: { posX: 0, posY: 0, posZ: 0, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  } as { kind: 'spawnEntity'; name: string; components: Record<string, unknown>; _id?: number };
  gateway.dispatch(cmd);
  const wrapperId = cmd._id;
  const wrapperHandle = wrapperId !== undefined ? entHandle(gateway.doc, wrapperId) : undefined;
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
  console.info('[CB:import] spawn.scene-mount', { sceneGuid, name, wrapperId, root });
  return true;
}

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
      if (await spawnGlbSceneAsMount(sceneGuid, label)) return;
      // Mount failed (e.g. GUID not yet in the catalog) — do NOT fall back to
      // cubes. Warn and stop; a page-reload after import makes the GUID
      // resolvable, and re-adding then succeeds.
      console.warn('[spawn-asset] GLB scene mount failed — aborting Add to Scene (no cube fallback):', { sceneGuid, label });
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
