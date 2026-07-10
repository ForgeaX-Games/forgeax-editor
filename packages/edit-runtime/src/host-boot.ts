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
  cancelPendingDiskSave,
  hasPendingDiskSave,
  setPathResolver,
  getAssetSelection,
  onAssetSelectionChange,
  getSelection,
  onSelectionChange,
  broadcastAssetsChanged,
  worldEntityHandles,
  resolveGamePath,
} from '@forgeax/editor-core';
import {
  onVagMessage,
  allowedParentOrigins,
} from '@forgeax/editor-core/protocol';
import {
  createHostSession,
  type HostSessionContext,
  type HostSession,
  type PhysicsBackend,
} from './viewport/host-session';

export type { HostSessionContext, HostSession, PhysicsBackend };

/**
 * Configure the editor session from URL params BEFORE the engine boots
 * (plan-strategy D8; was main.tsx module-top-level in the pre-M2 iframe entry).
 * Binds the active scene id (`?scene=<slug>`) + the game->disk path resolver
 * (`?gameRoot=`), then discovers the multi-scene manifest. In the single-realm
 * host this MUST run in the host window (there is no edit-runtime iframe to run
 * it), and it is SHARED by edit-runtime's thin main.tsx so the two hosts can't
 * drift. FAIL FAST (charter S5): a real slug with no injected gameRoot throws —
 * the host owns the layout convention, never edit-runtime.
 *
 * Idempotent-safe to await once per document; call before ViewportComponent mounts.
 */
export async function configureHostSession(): Promise<void> {
  const qp = new URLSearchParams(location.search);
  // M3 (AC-03): setSceneId is a session op — dispatch through the one gateway door.
  gateway.dispatch({ kind: 'setSceneId', id: qp.get('scene') });
  const slug = (qp.get('scene') ?? '').trim();
  const injectedRoot = qp.get('gameRoot');
  if (slug && slug !== 'default' && injectedRoot === null) {
    throw new Error(
      `[host-boot] no ?gameRoot= injected for scene="${slug}". The host owns the ` +
      `game->disk layout and must pass gameRoot; editor-core is layout-agnostic.`,
    );
  }
  const gameRoot = injectedRoot ?? '';
  setPathResolver((rel) => (rel ? `${gameRoot}/${rel}` : gameRoot));
  // Discover the game's multi-scene manifest (forge.json `scenes`) BEFORE any doc
  // load so paths/storage keys resolve to the active scene file (UE level model).
  await initSceneList();
}

/**
 * Install the unload-time save-beacon listeners (the boot tail's one DOM/VAG
 * boundary, lifted out of host-session so the tail is headless — plan-strategy
 * §2 D-4 / AC-02). Wires window pagehide + visibilitychange + the VAG_EDITOR_FLUSH
 * handler, each calling `flush`; returns a dispose that removes all three. Was
 * inline in the pre-M4 initHostSession.
 */
function installSaveBeaconListeners(flush: () => void): () => void {
  const onPageHide = (): void => flush();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('visibilitychange', onVisibilityChange);
  const disposeVagFlush = onVagMessage(window, {
    allowedOrigins: allowedParentOrigins(),
    handlers: { VAG_EDITOR_FLUSH: () => flush() },
  });
  return (): void => {
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('visibilitychange', onVisibilityChange);
    if (typeof disposeVagFlush === 'function') disposeVagFlush();
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
  cancelPendingDiskSave,
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
