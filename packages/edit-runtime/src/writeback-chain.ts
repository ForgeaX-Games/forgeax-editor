// writeback-chain.ts — Save → SceneAsset POD → pack JSON → disk (plan-strategy
// D-1, consuming the engine M2 collector).
//
// The durable writeback for a MATERIALISED scene instance is the direct chain
//   collectSceneAsset(world, instanceRoot)   // engine M2 w11: live world → POD
//   → serializeSceneAssetToPack(asset, guid) // engine M2 w12: POD → pack JSON
//   → POST /api/files                          // write the pack to disk
// addressing a SINGLE instance's source SceneAsset by its pack path + stable
// GUID (NOT a whole-world dump). This replaces the editor-local
// sessionToPack codec on the save path for a live instance (the codec stays for
// seeding new scenes; AC-14).
//
// NOTE (runtime dependency): collectSceneAsset / serializeSceneAssetToPack are
// engine M2 exports of @forgeax/engine-runtime. They land in the editor's
// resolved engine package when the editor's engine submodule is bumped to the
// commit that carries packages/runtime/src/collect-scene-asset.ts (top-level
// engine HEAD already has it). Until that bump, this chain typechecks (engine
// surface is shimmed) but the named exports resolve at runtime only post-bump.

import { collectSceneAsset, serializeSceneAssetToPack } from '@forgeax/engine-runtime';

/** Minimal engine surface the chain reads — the live world + the synthetic root
 *  entity carrying the instance's `SceneInstance` component. */
interface WorldLike {
  [k: string]: unknown;
}

export interface WritebackTarget {
  /** Project-relative pack path the instance was loaded from (the write target). */
  packPath: string;
  /** The source SceneAsset's stable GUID (preserved across edits). */
  sceneGuid: string;
  /** Synthetic-root entity carrying the materialised instance's SceneInstance. */
  instanceRoot: number;
}

export interface WritebackResult {
  ok: boolean;
  /** structured reason when ok===false (for the toolbar / log). */
  error?: string;
}

/**
 * Collect a live scene instance into a SceneAsset POD, serialize it to the
 * engine-native pack JSON, and write it to disk via the server's /api/files.
 *
 * `handleToGuid` is the optional handle→GUID reverse index the collector uses to
 * resolve `shared<T>` fields (MeshFilter.assetHandle / MeshRenderer.materials)
 * back to GUID strings; absent → raw handle integers are kept (engine M2 D-1).
 */
export async function writebackInstance(
  world: WorldLike,
  target: WritebackTarget,
  handleToGuid?: Map<number, string>,
): Promise<WritebackResult> {
  let json: string;
  try {
    const asset = collectSceneAsset(world, target.instanceRoot, handleToGuid);
    const pack = serializeSceneAssetToPack(asset, target.sceneGuid);
    json = JSON.stringify(pack, null, 2) + '\n';
  } catch (err) {
    return { ok: false, error: `collect/serialize failed: ${(err as Error)?.message ?? String(err)}` };
  }
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target.packPath, content: json }),
    });
    return r.ok ? { ok: true } : { ok: false, error: `POST /api/files -> ${r.status}` };
  } catch (err) {
    return { ok: false, error: `disk write failed: ${(err as Error)?.message ?? String(err)}` };
  }
}
