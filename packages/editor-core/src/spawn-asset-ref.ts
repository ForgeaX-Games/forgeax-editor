/**
 * Content Browser → scene spawn (Add to Scene / drag-drop).
 * Runs on the MAIN viewport bus — ep:* panel iframes forward via BroadcastChannel.
 */
import { bus, broadcastAssetsChanged } from '@forgeax/editor-shared';
import { getApiClient } from './api-client';
import { buildSpawnEntityFromDragRef, type DragAssetRef } from './drag-asset-spawn';
import { resolveMeshOriginalMaterials } from './mesh-original-materials';
import type { AssetChatRef } from './sync-channel';

function toDragRef(ref: AssetChatRef): DragAssetRef {
  return {
    type: 'asset',
    guid: ref.guid,
    kind: ref.kind,
    name: ref.name,
    path: ref.path,
    payload: ref.payload,
  };
}

function stemName(ref: DragAssetRef): string {
  const raw = ref.name?.trim() || ref.guid.slice(0, 8);
  return raw.replace(/[^\w.-]+/g, '_').slice(0, 48) || 'Asset';
}

async function spawnReferenceEntity(ref: DragAssetRef): Promise<boolean> {
  const kind = ref.kind ?? '';
  const entity = buildSpawnEntityFromDragRef(ref);
  if (!entity) return false;

  if (kind === 'mesh') {
    try {
      const api = getApiClient();
      const readRaw = async (p: string): Promise<Response | null> => {
        try {
          const r = await api.fetch(`/api/files/raw?path=${encodeURIComponent(p)}`);
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

  bus.dispatch({ kind: 'spawnEntity', name: entity.name, components: entity.components });
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.reference', { kind, guid: ref.guid, name: entity.name });
  return true;
}

async function readMetaSubAssets(metaPath: string): Promise<Array<{ guid: string; kind: string; name?: string }>> {
  const r = await getApiClient().fetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
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

async function spawnGlbScene(path: string, name: string): Promise<void> {
  const sceneRes = await getApiClient().fetch('/api/assets/import-scene', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, mode: 'reference' }),
  });
  const sceneJ = await sceneRes.json() as {
    mode?: string;
    entity?: { name: string; components: Record<string, unknown> };
    doc?: { order: number[]; entities: Record<number, { name: string; parent?: number | null; components: Record<string, unknown> }> };
    error?: string;
  };
  if (!sceneRes.ok) {
    console.warn('[spawn-asset] import-scene failed:', sceneJ.error ?? sceneRes.status);
    return;
  }
  if (sceneJ.mode === 'full' && sceneJ.doc) {
    const doc = sceneJ.doc;
    const cmds = doc.order.map((id) => {
      const ent = doc.entities[id]!;
      return {
        kind: 'spawnEntity' as const,
        name: ent.name,
        parent: ent.parent ?? undefined,
        components: ent.components,
      };
    });
    bus.dispatch({ kind: 'transaction', label: `Import: ${name}`, commands: cmds });
  } else if (sceneJ.entity) {
    bus.dispatch({ kind: 'spawnEntity', name: sceneJ.entity.name, components: sceneJ.entity.components });
  } else {
    console.warn('[spawn-asset] import-scene returned no entity/doc');
    return;
  }
  broadcastAssetsChanged();
  console.info('[CB:import] spawn.scene', { path, name });
}

export async function spawnAssetRefToScene(ref: AssetChatRef | DragAssetRef): Promise<void> {
  const drag = 'type' in ref && ref.type === 'asset' ? ref as DragAssetRef : toDragRef(ref as AssetChatRef);
  const kind = drag.kind ?? '';
  console.info('[CB:import] spawn.request', { kind, guid: drag.guid, name: drag.name, path: drag.path });

  if (await spawnReferenceEntity(drag)) return;

  if (kind === 'scene') {
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
        bus.dispatch({ kind: 'transaction', label: `Import: ${drag.name ?? 'FBX'}`, commands });
        broadcastAssetsChanged();
        console.info('[CB:import] spawn.scene-meshes', { count: commands.length });
        return;
      }
    }

    const metaPath = drag.path;
    const src = typeof metaPath === 'string' && /\.meta\.json$/i.test(metaPath)
      ? metaPath.replace(/\.meta\.json$/i, '')
      : ((drag.payload?.source as string | undefined) ?? metaPath);
    const label = drag.name ?? stemName(drag);

    if (typeof src === 'string' && /\.(glb|gltf)$/i.test(src)) {
      await spawnGlbScene(src, label);
      return;
    }

    console.warn(
      '[spawn-asset] no spawnable mesh in scene package — select a mesh sub-asset, or complete Phase 2.5 DDC:',
      { importer: drag.payload?.importer, meshCount: meshRefs.length, metaPath },
    );
    return;
  }

  console.warn('[spawn-asset] unsupported asset kind for Add to Scene:', kind, drag.guid);
}
