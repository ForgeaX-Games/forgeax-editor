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

/**
 * Machine-readable failure stage for a writeback, so callers can branch
 * programmatically instead of string-matching `error`. Mirrors the structured
 * `.code` pattern from editor-core's discoverer-errors.ts (charter P3).
 *
 *   'collect-failed'   — collectSceneAsset / serializeSceneAssetToPack threw.
 *   'serialize-failed' — reserved: JSON.stringify of the pack threw.
 *   'write-failed'     — POST /api/files returned non-ok or fetch rejected.
 */
export type WritebackErrorCode =
  | 'collect-failed'
  | 'serialize-failed'
  | 'write-failed';

export interface WritebackResult {
  ok: boolean;
  /** machine-readable failure stage when ok===false (branch on this, not `error`). */
  code?: WritebackErrorCode;
  /** structured human/AI-readable reason when ok===false (for the toolbar / log). */
  error?: string;
  /**
   * Non-fatal advisories surfaced even when ok===true. Populated e.g. when
   * `handleToGuid` was omitted, so raw handle integers pass through and the
   * written pack may be unloadable elsewhere (the failure is no longer silent).
   */
  warnings?: string[];
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
  const warnings: string[] = [];
  // Visible advisory: without the handle->GUID reverse index the collector keeps
  // raw handle integers for shared<T> fields (MeshFilter.assetHandle /
  // MeshRenderer.materials), producing a pack that is unloadable elsewhere. Make
  // that non-silent rather than letting it pass through quietly (charter P3).
  if (!handleToGuid || handleToGuid.size === 0) {
    const msg =
      'writebackInstance: handleToGuid missing/empty — raw handle integers will ' +
      'pass through for shared<T> fields; the written pack may be unloadable.';
    warnings.push(msg);
    console.warn(msg);
  }

  let json: string;
  try {
    const asset = collectSceneAsset(world, target.instanceRoot, handleToGuid);
    const pack = serializeSceneAssetToPack(asset, target.sceneGuid);
    json = JSON.stringify(pack, null, 2) + '\n';
  } catch (err) {
    return {
      ok: false,
      code: 'collect-failed',
      error: `collect/serialize failed: ${(err as Error)?.message ?? String(err)}`,
      warnings,
    };
  }
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target.packPath, content: json }),
    });
    return r.ok
      ? { ok: true, warnings }
      : { ok: false, code: 'write-failed', error: `POST /api/files -> ${r.status}`, warnings };
  } catch (err) {
    return {
      ok: false,
      code: 'write-failed',
      error: `disk write failed: ${(err as Error)?.message ?? String(err)}`,
      warnings,
    };
  }
}
