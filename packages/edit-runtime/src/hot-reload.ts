// hot-reload.ts — edit-mode two-tier hot reload orchestrator (plan-strategy D-8).
//
// When a game-logic script changes on disk, the editor re-imports it and decides
// whether the live world survives or must be rebuilt, using the component schema
// fingerprint judge from editor-core (schemaFingerprint / decideReloadTier):
//
//   • same fingerprint (tuning / system-logic only) → 'world-update':
//       keep the world; re-run the discoverer so the new system descriptors are
//       registered into the edit-mode world (existing entities untouched).
//   • different fingerprint (a component field added/removed/retyped) →
//       'world-rebuild': drop the world and re-instantiate from the SceneAsset
//       (engineSync.forceResync rebuilds via the engine-native instantiate path;
//        A0' world is disposable — OOS-7 edit-mode rebuild, OOS-8 no fine unload).
//
// TRIGGER (w24 spike): `/@fs/` imports do NOT enter Vite's HMR module graph, so
// re-import is NOT driven by import.meta.hot. Instead a file-change signal (the
// server's chokidar file-event over ws://<host>/ws — the same channel the disk
// watcher uses) drives `onScriptChanged`, which re-runs the discoverer (its
// dynamic import is cache-busted) and applies the tier.

import { getRegisteredComponents } from '@forgeax/engine-ecs';
import { schemaFingerprint, decideReloadTier, type ReloadTier } from '@forgeax/editor-core';

/** What the orchestrator needs from its host to apply a reload. */
export interface HotReloadHost {
  /** Re-import + re-register the changed game-logic scripts (the discoverer).
   *  Cache-busted import so the new module source is picked up. */
  rediscover(): Promise<void>;
  /** Force the engine sync to drop + rebuild the rendered world from the
   *  SceneAsset (engineSync.forceResync). */
  rebuildWorld(): void;
}

/** Outcome of one script-change reload (returned for logging / tests). */
export interface HotReloadOutcome {
  tier: ReloadTier;
}

/**
 * Apply one script-change reload: snapshot the component schema fingerprint,
 * re-import the scripts, snapshot again, decide the tier, and act.
 *
 * `world-update`: the rediscover already re-registered the new system
 * descriptors — nothing else to do (entities survive). `world-rebuild`: also
 * tear down + re-instantiate the rendered world.
 */
export async function applyScriptChange(host: HotReloadHost): Promise<HotReloadOutcome> {
  const before = schemaFingerprint(getRegisteredComponents());
  await host.rediscover();
  const after = schemaFingerprint(getRegisteredComponents());
  const tier = decideReloadTier(before, after);
  if (tier === 'world-rebuild') host.rebuildWorld();
  return { tier };
}

/**
 * Subscribe to server file-change events for the game's script dir and run the
 * two-tier reload on each. Returns a disposer. The trigger is the server WS
 * file-event (w24 spike: not Vite HMR). `isScript` filters the events to the
 * game-logic scripts the discoverer owns.
 */
export function initHotReload(
  host: HotReloadHost,
  isScript: (path: string) => boolean,
): () => void {
  if (typeof WebSocket === 'undefined' || typeof location === 'undefined') {
    return () => { /* non-browser — no watcher */ };
  }
  let ws: WebSocket | null = null;
  let disposed = false;
  let backoff = 1000;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (disposed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${location.host}/ws`); }
    catch { return; }
    ws.addEventListener('open', () => { backoff = 1000; });
    ws.addEventListener('message', (ev) => {
      let msg: { type?: string; path?: string; change?: string };
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (msg?.type !== 'file-event') return;
      const path = (msg.path ?? '').replace(/\\/g, '/');
      if (!isScript(path)) return;
      // Debounce a burst of saves (editor write + formatter) into one reload.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void applyScriptChange(host); }, 300);
    });
    ws.addEventListener('close', () => {
      ws = null;
      if (disposed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });
    ws.addEventListener('error', () => { try { ws?.close(); } catch { /* */ } });
  };
  connect();

  return () => {
    disposed = true;
    if (debounce) clearTimeout(debounce);
    try { ws?.close(); } catch { /* */ }
    ws = null;
  };
}
