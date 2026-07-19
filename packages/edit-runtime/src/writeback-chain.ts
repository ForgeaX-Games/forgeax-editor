// writeback-chain.ts — Save → SceneAsset POD → pack JSON → disk (plan-strategy
// D-1, consuming the engine forest collector).
//
// The durable writeback for a MATERIALISED scene instance is the direct chain
//   rootsToSceneAsset(registry, world, [root]) // engine M5: live world → POD
//   → serializeSceneAssetToPack(asset, guid)    // engine M5: POD → pack JSON
//   → POST /api/files                           // write the pack to disk
// addressing a SINGLE instance's source SceneAsset by its pack path + stable
// GUID (NOT a whole-world dump). This replaces the editor-local
// sessionToPack codec on the save path for a live instance (the codec stays for
// seeding new scenes; AC-14).
//
// NOTE (runtime dependency): rootsToSceneAsset / serializeSceneAssetToPack are
// engine exports of @forgeax/engine-runtime. They land in the editor's
// resolved engine package when the engine submodule is bumped to the
// commit that carries packages/runtime/src/collect-scene-asset.ts.

import { EditorHidden } from '@forgeax/editor-core';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '@forgeax/engine-runtime';

/** Minimal engine surface the chain reads — the live world + the synthetic root
 *  entity carrying the instance's `SceneInstance` component. The body only hands
 *  `world` to rootsToSceneAsset and reads through a local `as unknown as {get}`
 *  cast, so any object (incl. the engine `World` class instance) qualifies — a
 *  bare `[k: string]: unknown` index signature would REJECT a class instance
 *  under strict typing, which is why the World-typed callers tripped TS2345. */
type WorldLike = object;

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
 *   'collect-failed'   — rootsToSceneAsset / serializeSceneAssetToPack failed.
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
   * `registry` was omitted, so raw handle integers pass through and the
   * written pack may be unloadable elsewhere (the failure is no longer silent).
   */
  warnings?: string[];
}

/**
 * Collect a live scene instance into a SceneAsset POD, serialize it to the
 * engine-native pack JSON, and write it to disk via the server's /api/files.
 *
 * Engine resolves entity/shared references internally via AssetRegistry;
 * no external handleToGuid table is needed (engine M5 D-1/D-3/D-7).
 */
export async function writebackInstance(
  world: WorldLike,
  target: WritebackTarget,
  registry?: unknown,
): Promise<WritebackResult> {
  const warnings: string[] = [];
  // Visible advisory: without the AssetRegistry the collector cannot resolve
  // shared<> field GUIDs, producing a pack that is unloadable elsewhere. Make
  // that non-silent rather than letting it pass through quietly (charter P3).
  if (!registry) {
    const msg =
      'writebackInstance: registry missing — AssetRegistry required for ' +
      'rootsToSceneAsset GUID reverse lookup (engine M5 D-3); the written pack ' +
      'may be unloadable.';
    warnings.push(msg);
    console.warn(msg);
  }

  let json: string;
  try {
    // M5/m5-impl-hidden-exclude (AC-04/AC-05): filter EditorHidden roots before
    // collecting. Hidden entities (EditorHidden component present) are excluded
    // from the roots array so the collector skips them and their subtrees.
    // The entity stays in the world (survives save-reopen — plan-strategy D-7).
    const w = world as unknown as { get: (e: number, c: unknown) => { ok: boolean } };
    if (w.get(target.instanceRoot, EditorHidden).ok) {
      // The only root is hidden — produce an empty scene (no entities to collect).
      const emptyPack = serializeSceneAssetToPack(
        { kind: 'scene' as const, entities: [] },
        target.sceneGuid,
      );
      json = (emptyPack.ok && (emptyPack as { ok: boolean; value: unknown }).value !== undefined)
        ? JSON.stringify((emptyPack as { ok: boolean; value: unknown }).value, null, 2) + '\n'
        : '{"schemaVersion":"1.0.0","kind":"internal-text-package","assets":[]}';
    } else {
      // M5: rootsToSceneAsset replaces collectSceneAsset — forest entry with
      // engine-native entity-ref/shared-ref resolution (D-3/D-7).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assetR = (rootsToSceneAsset as any)(registry, world, [target.instanceRoot]);
      if (!assetR.ok) {
        const errCode = (assetR.error as { code?: string })?.code ?? 'unknown';
        const msg = (assetR.error as { message?: string })?.message ?? String(assetR.error);
        const hint = (assetR.error as { hint?: string })?.hint ?? '';
        return {
          ok: false,
          code: 'collect-failed',
          error: `rootsToSceneAsset failed [${errCode}]: ${msg}${hint ? ` (hint: ${hint})` : ''}`,
          warnings,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const packR = (serializeSceneAssetToPack as any)(assetR.value, target.sceneGuid);
      if (!packR.ok) {
        const errCode = (packR.error as { code?: string })?.code ?? 'unknown';
        const msg = (packR.error as { message?: string })?.message ?? String(packR.error);
        return {
          ok: false,
          code: 'collect-failed',
          error: `serializeSceneAssetToPack failed [${errCode}]: ${msg}`,
          warnings,
        };
      }
      json = JSON.stringify(packR.value, null, 2) + '\n';
    }
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
