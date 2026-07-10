// store/disk-watch — live-reload the scene when an EXTERNAL writer (an AI agent
// editing scene.json on disk) changes the active game's scene file.
//
// State: none at module scope — the ws socket / timers / backoff live inside the
// initDiskWatch closure. Consumer: the single-realm studio host calls
// initDiskWatch() and later the returned stopper on cross-game teardown.
//
// D-6 (plan-strategy §2 D-2/D-6): disk-watch depends on scene-persistence
// file-private symbols. It READS worldToPack / scenePath and CALLS loadSceneByGuid;
// its two reverse-writes (currentSceneGuid, isDirty) plus their paired reads now go
// through the SHARED `ctx` handle (ScenePersistenceContext) it imports directly —
// ctx.currentSceneGuid / ctx.isDirty for reads, ctx.setCurrentSceneGuid / ctx.setDirty
// for writes. M1 (D-2) converged scene-persistence's 7 module-level `let`s onto that
// one object, so these are ordinary field writes on a handle both modules hold — the
// pre-M1 `_setCurrentSceneGuid` / `_setDirty` setter pair (the ESM read-only-live-
// binding workaround for `export let`) is gone. It signals a doc reload via the
// public notifyDocChanged().
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-01 (no module-level mutable singleton — this file's `let` grep
//     stays 0) + AC-07 (bidirectional anchors); plan-strategy §2 D-2 (disk-watch
//     consumes the same ctx) + §2 D-6 (internal seams).
//   (backward) split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose (cluster 11,
//     store.ts:1161-1248).
//   requirements AC-09: pure structural migration; the only body edits are the
//     ctx-handle seam routings, each behaviorally identical to the originals.
import { gateway } from './gateway';
import { notifyDocChanged } from './doc-version';
import {
  worldToPack,
  scenePath,
  loadSceneByGuid,
  ctx,
} from './scene-persistence';
import { isScenePack } from '../scene/scene-pack';

// ── Disk watch: live-reload the scene when an EXTERNAL writer (an AI agent
//    editing scene.json on disk) changes the active game's scene.json ──────────
// The server already broadcasts chokidar file-events over ws://<host>/ws (the
// same channel ▶ Play's PreviewMode uses to hot-reload). The editor never
// subscribed, so agent edits required a manual refresh. We subscribe here and,
// on an external scene.json change, re-fetch + replaceDoc() (which fires the gateway
// → engine resync + React, so the 3D viewport rebuilds live).
//
// Guards: (1) skip the echo of our own save (content-compare, see below);
// (2) skip while we have unsaved local edits pending (_isDirty) so an agent
// write never clobbers what the user is mid-editing.
/**
 * Watch the active game's scene file for external edits and hot-reload the live
 * world. Returns a stopper that closes the socket, cancels the pending reload +
 * reconnect timers, and halts the backoff loop — the single-realm studio host
 * calls it on a cross-game teardown (resetEditRealm) so a stale watcher for the
 * previous game can't fire against the new game's world. Idempotent.
 */
export function initDiskWatch(): () => void {
  let ws: WebSocket | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let backoff = 1000;

  // feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
  // applyExternal (which called replaceDoc with a revived .entities session for
  // the legacy scene.json disk-watch path) is deleted along with that path. The
  // engine-native pack reload below clears _isDirty inline after
  // loadWorldFromPack.

  const reloadFromDisk = async (): Promise<void> => {
    const p = scenePath();
    if (!p) return;
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { content?: string };
      if (!j.content) return;
      const parsed = JSON.parse(j.content);
      if (isScenePack(parsed)) {
        // CANONICAL compare FIRST: normalise the incoming pack against our live
        // world's serialization. If identical, this is our own save echo — skip
        // (no teardown/reload). Comparing before the reload also avoids a
        // needless despawn+reinstantiate on every self-save.
        const currentPack = worldToPack(gateway.doc, ctx.currentSceneGuid ?? undefined);
        if (currentPack && JSON.stringify(parsed) === currentPack) return;
        // Genuine external edit → reload via the engine-native loadByGuid path
        // (loadSceneByGuid despawns the current scene and re-instantiates it; the
        // instantiate return handles are the identity — no map to repopulate).
        const sceneEntry = parsed.assets.find((a: { kind?: string; guid?: string }) => a.kind === 'scene') as { guid?: string } | undefined;
        if (!sceneEntry?.guid) return;
        if (sceneEntry.guid) ctx.setCurrentSceneGuid(sceneEntry.guid);
        const ok = await loadSceneByGuid(sceneEntry.guid);
        if (!ok) return;
        notifyDocChanged();
        ctx.setDirty(false);
        return;
      }
      // feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
      // Only engine-native scene packs (handled above via loadWorldFromPack)
      // reload live. A non-pack legacy scene.json can no longer be revived into
      // the World (packToSession deleted in M4), so external edits to that
      // format are ignored until the next in-editor save migrates it.
    } catch { /* server unreachable / parse error → keep current doc */ }
  };

  const connect = (): void => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${location.host}/ws`); }
    catch { return; }
    ws.addEventListener('open', () => { backoff = 1000; });
    ws.addEventListener('message', (ev) => {
      let msg: { type?: string; path?: string; change?: string };
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (msg?.type !== 'file-event') return;
      const path = (msg.path ?? '').replace(/\\/g, '/');
      if (path !== scenePath()) return;          // only THIS game's scene.json
      if (msg.change === 'unlink') return;
      if (ctx.isDirty) return;                     // user has unsaved edits → don't clobber
      // The reload itself content-compares against the current doc, so our own
      // save echo is a no-op (identical content) — no rebuild, no loop.
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void reloadFromDisk(); }, 400);
    });
    const retry = (): void => {
      ws = null;
      if (stopped) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => { try { ws?.close(); } catch { /* */ } });
  };
  connect();

  return () => {
    stopped = true;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const sock = ws;
    ws = null;
    if (sock) { try { sock.onclose = null; sock.close(); } catch { /* already gone */ } }
  };
}
