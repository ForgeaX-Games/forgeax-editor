// host-boot — the application-level startup strategy for the editor session
// (plan-strategy REPLAN D8; q2 "host entry" boundary — the seed/scene-load/play
// side that stays at the host entry, as opposed to the viewport surface).
//
// WHAT THIS IS (post-M4 shape)
//   D8 physically split the 1652-line main.tsx bootEditor() closure along the q2
//   boundary into two edit-runtime modules that standalone/main.tsx can import:
//     - ViewportComponent.tsx — canvas + createApp + renderer + camera + viewport
//       interaction (the ENGINE SURFACE).
//     - host-boot.ts (this file) — the pre-boot session config + the COMPOSITION
//       ROOT for the application session tail.
//
//   M4 (plan-strategy §2 D-4) then extracted the high-side-effect session tail
//   (resolveEditPhysics physics gate + initHostSession boot ordering + preview-
//   skin) into a DI factory viewport/host-session.ts (`createHostSession(deps)`,
//   the run-lifecycle `create<Thing>(deps)` pattern). This file is now the thin
//   COMPOSITION ROOT: it (a) keeps configureHostSession (URL-param pre-boot
//   config, no network) and (b) builds ONE createHostSession with the REAL core
//   singletons + the real arrow-wrapped fetch + a real window/VAG beacon-listener
//   installer, then re-exports the two entry points so ViewportComponent's import
//   surface is unchanged (consumers zero-change). The heavy, network-touching,
//   world-mutating logic is now headless-testable through the injected deps
//   (host-boot-di.test.ts) — the coverage #88's real-Play net could not reach.
//
//   ViewportComponent boots the world, then hands the live { app, world,
//   renderer, viewport, cameraEntity } to initHostSession() here. This is a
//   Pipeline-Isolation seam: everything host-session needs is in HostSessionContext
//   + HostSessionDeps, nothing implicit. Both standalone (in-process host) and the
//   edit-runtime thin main.tsx entry drive the SAME ViewportComponent → same
//   host-boot, so the two hosts cannot drift (architecture-principles S1 SSOT).
//
// WHY resolveEditPhysics is separate
//   The physics gate (forge.json "physics" -> rapier backend) must run BEFORE
//   createApp (it feeds createApp's `plugins`). So it is exposed on its own for
//   ViewportComponent to await pre-boot; the rest of the session tail runs after.
//
// D-2 fetch-as-dep (R-P1): the session tail's 4 fetch call sites moved into
// host-session.ts as `deps.fetch`. This file injects the REAL arrow-wrapped
// platform fetch (OOS-5).
// Every read is injected via deps.fetch.
//
// Anchors: plan-strategy S2 D8 (host-boot = seed/scene-load/preload/play) + D-4
// (M4 host-boot DI split), S4 R8 (edit-runtime independent dev still green after
// the split), requirements C-1 (single-world model), AC-02 (DI factory headless-
// testable), AC-05 (boot regression), AC-06/AC-07 (▶/■ snapshot-restore).

import {
  gateway,
  loadDocFromStorage,
  loadDocFromDisk,
  getLoadedSceneEntities,
  getSceneId,
  initSceneList,
  initDiskWatch,
  flushPendingSaveBeacon,
  hasPendingDiskSave,
  setPathResolver,
  getAssetSelection,
  onAssetSelectionChange,
  getSelection,
  onSelectionChange,
  broadcastAssetsChanged,
  worldEntityHandles,
  resolveGamePath,
  scanAssetsIntegrity,
  repairAssets,
} from '@forgeax/editor-core';
import { installAssetHmrBridge } from '@forgeax/editor-core/assets/asset-hmr-bridge';
import {
  createHostSession,
  type HostSessionContext,
  type HostSession,
  type PhysicsBackend,
} from './viewport/host-session';

export type { HostSessionContext, HostSession, PhysicsBackend };

/**
 * The active game a host wants the engine to boot. The host is the single source
 * of truth for "which game" — CLI `--game` (editor standalone), the server's
 * active-slug (studio) — and passes it here EXPLICITLY. `slug` is the scene/game
 * pointer (null / 'default' = no game, opens on an empty scene); `gameRoot`
 * is the host's game->disk layout root (editor-core is layout-agnostic and never
 * infers it). Both are plain values, not URL params: pre-single-realm this config
 * was smuggled through `location.search` because the editor ran in an iframe the
 * host could only address by URL; the single realm removed that iframe, so hosts
 * now pass the values directly (no self-write-then-read-back URL round-trip that
 * could drift from the host's real intent).
 */
export interface HostGameSession {
  /** Scene/game pointer. null or 'default' = no on-disk game (empty scene). */
  readonly slug: string | null;
  /** Host game->disk layout root. Required when slug names a real game. */
  readonly gameRoot?: string;
  /**
   * Host-owned catalog URL for this game. An absolute dev URL deliberately
   * selects the play engine's asset origin; a packaged host supplies its
   * same-origin URL. The engine only consumes this catalog boundary.
   */
  readonly packIndexUrl?: string;
  /** Host-selected initial SceneAsset GUID. Omitted = forge.json defaultScene. */
  readonly selectedSceneGuid?: string;
}

/**
 * Configure the editor session BEFORE the engine boots (plan-strategy D8). Binds
 * the active scene id + the game->disk path resolver from the host-supplied
 * {@link HostGameSession}, then discovers the multi-scene manifest. SHARED by
 * every host (editor standalone, edit-runtime dev entry, studio) so the hosts
 * can't drift (architecture-principles S1 SSOT). FAIL FAST (charter S5): a real
 * slug with no gameRoot throws — the host owns the layout convention, never
 * edit-runtime.
 *
 * Idempotent-safe to await once per document; call before ViewportComponent mounts.
 */
export async function configureHostSession(session: HostGameSession = { slug: null }): Promise<void> {
  const slug = (session.slug ?? '').trim();
  // M3 (AC-03): setSceneId is a session op — dispatch through the one gateway door.
  gateway.dispatch({ kind: 'setSceneId', id: session.slug });
  const gameRoot = session.gameRoot;
  if (slug && slug !== 'default' && (gameRoot === undefined || gameRoot === null)) {
    throw new Error(
      `[host-boot] no gameRoot supplied for scene="${slug}". The host owns the ` +
      `game->disk layout and must pass gameRoot; editor-core is layout-agnostic.`,
    );
  }
  const root = gameRoot ?? '';
  setPathResolver((rel) => (rel ? `${root}/${rel}` : root));
  // Discover the game's multi-scene manifest (forge.json `scenes`) BEFORE any doc
  // load so paths/storage keys resolve to the active scene file (UE level model).
  await initSceneList();

  // ── Startup asset integrity scan (dev-plan §4.3) ──────────────────────────
  // Detect "half-imported" source files (e.g. .fbx on disk without .meta.json)
  // and auto-repair them by re-running the import pipeline. Runs AFTER
  // initSceneList (path resolver is ready) and BEFORE the viewport boots
  // (so pluginPack picks up the newly created sidecars). Non-fatal: scan/repair
  // failures are logged but never block boot.
  if (slug && slug !== 'default') {
    try {
      const scanResult = await scanAssetsIntegrity();
      if (scanResult.needsMeta.length > 0) {
        console.info('[host-boot] integrity scan found', scanResult.needsMeta.length,
          'source files without sidecars — starting auto-repair');
        const report = await repairAssets(scanResult);
        console.info('[host-boot] integrity repair complete:', {
          repaired: report.repaired.length,
          failed: report.failed.length,
          elapsedMs: Math.round(report.elapsedMs),
        });
        // Give pluginPack's debounced watcher time to pick up the new sidecars
        // before the viewport boots and tries to loadByGuid.
        if (report.repaired.length > 0) {
          await new Promise<void>(r => setTimeout(r, 300));
        }
      } else {
        console.info('[host-boot] integrity scan: all source files have sidecars ✓');
      }
    } catch (err) {
      console.warn('[host-boot] integrity scan/repair failed (non-fatal):', err);
    }
  }

  // The pack plugin's runtime contract is a sidecar-change notification.
  // Asset refresh and cache invalidation stay in the editor PanelBridge path.
  installAssetHmrBridge();
}

/**
 * Install unload-time save-beacon listeners. Native pagehide + visibilitychange
 * are the complete single-realm lifecycle boundary. Kept here (rather than
 * host-session) so the session tail stays headless.
 */
function installSaveBeaconListeners(flush: () => void): () => void {
  const onPageHide = (): void => flush();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('visibilitychange', onVisibilityChange);
  return (): void => {
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

// ── The composition root: ONE createHostSession with the REAL singletons ───────
// Every dep is the production carrier — the real gateway, the real same-origin
// fetch (D-2 injection point; arrow-wrapped platform fetch, OOS-5), the real core
// persistence/selection singletons, and the real window/VAG beacon installer. The
// headless test (host-boot-di.test.ts) builds a PARALLEL createHostSession with
// fakes for all of these, so this one line is the only place the real edges bind.
const hostSession = createHostSession({
  fetch: (path, init) => fetch(path, init),
  gateway: gateway as never,
  getSceneId,
  resolveGamePath,
  loadDocFromDisk,
  loadDocFromStorage,
  getLoadedSceneEntities,
  hasPendingDiskSave,
  flushPendingSaveBeacon,
  initDiskWatch,
  broadcastAssetsChanged,
  worldEntityHandles: (world) => worldEntityHandles(world as never),
  getSelection,
  getAssetSelection,
  onSelectionChange,
  onAssetSelectionChange,
  installSaveBeaconListeners,
});

/**
 * The physics gate — reads forge.json "physics" → rapier backend (or undefined).
 * MUST be awaited BEFORE createApp (feeds its `plugins`). Composed over the real
 * fetch here; see host-session.ts for the body.
 */
export const resolveEditPhysics = hostSession.resolveEditPhysics;

/**
 * Run the application session tail on an already-booted world. Returns the ▶/■ +
 * dispose triple ViewportComponent wires to the ViewportChrome actions. Composed
 * over the real singletons here; see host-session.ts for the boot ordering body.
 */
export const initHostSession = hostSession.initHostSession;
