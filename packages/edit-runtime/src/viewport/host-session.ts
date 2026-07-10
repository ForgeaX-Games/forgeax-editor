// viewport/host-session — the DI unit for the editor's APPLICATION SESSION that
// runs ON TOP of an already-booted world: the physics gate (resolveEditPhysics),
// the boot-timing tail (initHostSession: seed / scene-load / run-lifecycle /
// asset-signal / mesh-stats / preview-skin / disk-watch), and the preview-skin
// hook.
//
// WHY THIS IS A `create<Thing>(deps)` FACTORY (M4 / AC-02 / plan-strategy §2 D-4)
//   host-boot.ts used to hold this logic as free functions that read module-level
//   singletons directly (gateway / fetch / getSceneId / loadDocFromDisk / ...)
//   and touched the DOM (window / VAG listeners). That made the ~234-line boot
//   ordering — the single highest-side-effect path in the editor — impossible to
//   drive in a unit: no browser, no network, no engine world. M4 extracts it into
//   `createHostSession(deps)` (the run-lifecycle `create<Thing>(deps)` pattern):
//   every edge that reaches OUTSIDE the module arrives THROUGH `deps`, so a reader
//   sees the whole dependency surface in the factory signature and a headless test
//   injects a fake for every one (AC-02). host-boot.ts is now the composition
//   root: it builds ONE createHostSession with the real singletons + a real
//   window/VAG beacon-listener installer and re-exports the two entry points, so
//   ViewportComponent's import surface is unchanged (consumers zero-change).
//
// D-2 fetch-as-dep (the R-P1 seam): `fetch` was previously imported from
// io/api-client.ts (now deleted); now it is injected via `deps.fetch`. This is a STRUCTURAL
// by plan-strategy §2 D-2) — the transport body is the platform fetch
// (OOS-5). The injected value is arrow-wrapped in production, so
// every network read goes through deps.fetch, never a raw hardcoded call.
//
// OOS-1 (zero behavior change): every body here is the verbatim logic previously
// in host-boot.ts initHostSession / resolveEditPhysics / installPreviewSkinHook /
// installMeshStatsPublisher / seedDemoScene; the only edits are singleton reads
// re-pointed at `deps` and the window/VAG beacon wiring lifted behind
// deps.installSaveBeaconListeners (so the boot tail is DOM-free and headless).
// The load order is preserved EXACTLY: loadDoc → seed-when-empty (+ cancel save) →
// broadcastAssetsChanged → run-lifecycle → drag-spawn resolver → mesh-stats →
// preview-skin → disk-watch + beacon listeners.
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (DI factory, headless-injectable, no singleton read) + AC-05
//     (high side-effect boot path regression) + AC-07 (bidirectional anchors) +
//     AC-08 (edit-runtime host-boot LOC drop); plan-strategy §2 D-2 (fetch via
//     deps) + D-4 (host-boot DI) + §8 naming (create<Thing> / <Thing>Deps).
//   (backward) extracted from host-boot.ts (REPLAN D8 split of main.tsx bootEditor
//     into ViewportComponent + host-boot), with the ▶/■ run-lifecycle seam from
//     historical feat feat-20260707-editor-world-fork-ssot-level-load-play-activeworld.

// engine #650 (Tier-2 decomposition) moved builtin mesh handles into
// @forgeax/engine-assets-runtime.
import {
  HANDLE_CUBE,
  HANDLE_SPHERE,
  HANDLE_CYLINDER,
} from '@forgeax/engine-assets-runtime';
import { toShared } from '@forgeax/engine-ecs';
import { attachBrowserInputBackend, INPUT_BACKEND_KEY } from '@forgeax/engine-input';
import { loadGameProject, FORGE_JSON } from '@forgeax/engine-project';
import { entComponent, publishMeshStats } from '@forgeax/editor-core';
import type { EngineFacade, EntityHandle, SelectedAsset } from '@forgeax/editor-core';
import { createRunLifecycle, type RunLifecycle } from './run-lifecycle';
import { assemblePlayWorld, type PlayAssembly } from './play-assemble';
import { installDragSpawnMeshResolver } from './drag-spawn-resolve';

// ── loose engine handles (the original bootEditor uses `as never` casts because
// the ECS/renderer types evolve independently; we keep the same discipline). ──
type WorldLike = {
  spawn(...componentDatas: unknown[]): { unwrap(): number };
  _getGraph: () => { archetypes: { columns: Map<number, Map<string, { view: Uint32Array }>>; size: number }[] };
};
type RendererLike = {
  ready: Promise<unknown>;
  assets: { loadByGuid: (guid: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> };
  store: unknown;
};
// The editor App: registerUpdate/start (edit boot) + pause/resume (▶/■ drive the
// editWorld freeze/thaw, D-2). dispose-shielded play uses stop() on the PLAY app,
// never on this one.
type EditorAppLike = {
  registerUpdate(fn: (dt: number) => void): void;
  start(): void;
  pause(): { ok: boolean; error?: unknown };
  resume(): { ok: boolean; error?: unknown };
};
type ViewportLike = { resetCamera(): void };

export type PhysicsBackend = 'rapier-3d' | 'rapier-2d';

/**
 * Everything host-session needs from the booted viewport, declared explicitly
 * (Pipeline Isolation — no implicit context). ViewportComponent assembles this
 * after createApp + createViewport succeed.
 */
export interface HostSessionContext {
  /** Unwrapped App (app.value) — the live edit frame loop. */
  readonly app: EditorAppLike;
  /** The single edit world (createApp's world). */
  readonly world: WorldLike;
  /** The renderer (assets + ready + store). */
  readonly renderer: RendererLike;
  /** The editor orbit camera entity id (viewport-owned). */
  readonly cameraEntity: number;
  /** The live viewport (for preview-skin resetCamera). */
  readonly viewport: ViewportLike;
  /**
   * The viewport panel's DOM container (`.ep-viewport-root`, position:relative +
   * overflow:hidden). ▶ Play's controlled UI root (`#game-ui-root`) mounts INSIDE
   * this element so the game HUD is both (a) discarded whole on ■ Stop and (b)
   * clipped to the viewport rect with a canvas-local coordinate space. Mounting
   * it on document.body instead (the old fallback) is what let the HUD escape the
   * viewport AND survive Stop as a remnant.
   */
  readonly viewportContainer: HTMLElement;
  /** Boot breadcrumb emitter (shared with the viewport watchdog). */
  readonly emitBoot: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Boot-stage setter (shared with the viewport watchdog). */
  readonly setBootStage: (s: string) => void;
  /** Re-discover the game camera on the live world (AC-12 hard cut). */
  readonly discoverGameCameraFromWorld: () => void;
  /** Re-apply the derived active camera to the engine. */
  readonly applyActiveCamera: () => void;
  /**
   * The shared canvas (M2 play-assemble). ▶ Play attaches a fresh input backend
   * to THIS canvas for the play world, and detaches it on ■ Stop — the single
   * host-owned renderer already targets this canvas (D-1), so play draws here too.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * Physics backend resolved from the game's forge.json (resolveEditPhysics), or
   * undefined for a non-physics game. Threaded through so the play assembly's
   * plugin set mirrors the edit assembly (D-7).
   */
  readonly physics: PhysicsBackend | undefined;
}

export interface HostSession {
  /** ▶ Play — snapshot doc + bootstrap the game on the edit world. */
  playSimulation(): void;
  /** ■ Stop — freeze + restore the pre-▶ snapshot. */
  stopSimulation(): void;
  /**
   * Tear down the session's global side effects (disk-watch socket, flush
   * beacons, VAG flush handler), flushing any pending save first. A multi-game
   * host calls this on a cross-game switch before disposing the engine; a
   * single-game host (standalone) never calls it (teardown = page navigation).
   */
  dispose(): void;
}

/**
 * The single-pointer gateway surface host-session needs — a structural mirror of
 * EditGateway (the same DI shape run-lifecycle's RunGateway uses, plus the boot
 * tail's ledger/subscribe/engineFacade reads). Headless tests supply a fake with
 * an inert world; production passes the real gateway singleton.
 */
export interface HostGateway {
  /** The live active world (edit world, or play world during ▶). Read by the
   *  seed/scene-load emptiness probe + the mesh-stats publisher. */
  readonly activeWorld: unknown;
  /** The command ledger — seedDemoScene reads `.at(-1)._id` after each spawn. */
  readonly ledger: ReadonlyArray<unknown>;
  /** The single authoritative mutable path (seed spawns + setSceneId). */
  dispatch(op: unknown): { ok: boolean };
  /** Subscribe to doc changes (mesh-stats republish trigger). */
  subscribe(fn: () => void): () => void;
  /** The one core-minted controlled write proxy for boot-side world writes. */
  engineFacade(): EngineFacade;
  /** ▶ Play — switch the active-world pointer to the play world (run-lifecycle). */
  enterPlay(playWorld: unknown): void;
  /** ■ Stop — switch the active-world pointer back to the edit world. */
  exitPlay(): void;
}

/**
 * Everything createHostSession needs, declared explicitly (Pipeline Isolation).
 * No implicit module globals — the headless test supplies a fake gateway + fake
 * fetch + fake core singletons + a no-op beacon-listener installer, so the
 * whole boot tail runs without a browser, a network, or a real engine world.
 */
export interface HostSessionDeps {
  /** The injected fetch (D-2 / R-P1). Production = arrow-wrapped platform fetch;
   *  headless test = a fake that records calls and never hits the network. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** The gateway single-pointer surface (active world + dispatch + engineFacade). */
  readonly gateway: HostGateway;
  /** The active scene slug (`?scene=`), read by the physics gate + preview-skin. */
  readonly getSceneId: () => string;
  /** The host game→disk path resolver (`gameRoot`-bound). */
  readonly resolveGamePath: (rel: string) => string;
  /** Load the authored scene from disk (session op). false → try storage. */
  readonly loadDocFromDisk: () => Promise<boolean>;
  /** Load the authored scene from the localStorage mirror. */
  readonly loadDocFromStorage: () => boolean;
  /** Top-level entity handles of the last-loaded (flat) scene. */
  readonly getLoadedSceneEntities: () => number[];
  /** Clear the dirty flag WITHOUT writing (bare seed must not auto-persist). */
  readonly cancelPendingDiskSave: () => void;
  /** True while the in-memory scene has unsaved edits (play-uses-last-saved hint). */
  readonly hasPendingDiskSave: () => boolean;
  /** Flush any pending save immediately (unload beacon + session dispose). */
  readonly flushPendingSaveBeacon: () => void;
  /** Start the disk-watch socket; returns the stopper for cross-game teardown. */
  readonly initDiskWatch: () => () => void;
  /** Signal mounted ContentBrowsers to re-read the now-live asset catalog. */
  readonly broadcastAssetsChanged: () => void;
  /** Entity handles present in the given world (seed emptiness probe). */
  readonly worldEntityHandles: (world: unknown) => EntityHandle[];
  /** The selected entity handle (mesh-stats active-mesh derivation), or null. */
  readonly getSelection: () => EntityHandle | null;
  /** The selected asset (mesh-stats active-mesh derivation), or null. */
  readonly getAssetSelection: () => SelectedAsset | null;
  /** Subscribe to entity-selection changes (mesh-stats republish trigger). */
  readonly onSelectionChange: (fn: () => void) => () => void;
  /** Subscribe to asset-selection changes (mesh-stats republish trigger). */
  readonly onAssetSelectionChange: (fn: () => void) => () => void;
  /**
   * Install the unload-time save-beacon listeners (window pagehide/visibilitychange
   * + the VAG_EDITOR_FLUSH handler), each calling the provided flush fn. Returns a
   * dispose that removes them all. This is the ONE DOM/VAG boundary of the boot
   * tail — lifted behind deps so the tail is headless (production wires window;
   * the test injects a no-op recorder).
   */
  readonly installSaveBeaconListeners: (flush: () => void) => () => void;
}

/**
 * Build the editor's application session over an already-booted world. See the
 * file header for the full model. Returns the pre-boot physics gate + the boot
 * tail runner; ViewportComponent awaits resolveEditPhysics BEFORE createApp, then
 * calls initHostSession with the live viewport context.
 */
export function createHostSession(deps: HostSessionDeps): {
  resolveEditPhysics: () => Promise<PhysicsBackend | undefined>;
  initHostSession: (ctx: HostSessionContext) => Promise<HostSession>;
} {
  const {
    gateway,
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
    worldEntityHandles,
    getSelection,
    getAssetSelection,
    onSelectionChange,
    onAssetSelectionChange,
    installSaveBeaconListeners,
  } = deps;

  /**
   * The physics gate (plan-strategy D8, was main.tsx bootEditor :287). Reads the
   * active game's forge.json "physics" and returns the rapier backend to pass to
   * createApp's `plugins`, or undefined for a non-physics game (zero rapier WASM
   * cost). A missing/failed read degrades to no-physics (charter S9). MUST be
   * awaited BEFORE createApp — hence exposed separately from initHostSession.
   */
  async function resolveEditPhysics(): Promise<PhysicsBackend | undefined> {
    const slug = getSceneId();
    if (!slug || slug === 'default') return undefined;
    try {
      const gp = await loadGameProject(async () => {
        const r = await deps.fetch(`/api/files?path=${encodeURIComponent(resolveGamePath(FORGE_JSON))}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { content?: string };
        if (!j.content) throw new Error('Empty content');
        return j.content;
      });
      if (gp.ok) {
        const p = gp.value.physics;
        let backend: PhysicsBackend | undefined;
        if (p === '3d' || p === true || p === 'rapier-3d') backend = 'rapier-3d';
        else if (p === '2d' || p === 'rapier-2d') backend = 'rapier-2d';
        console.log(`[editor] physics gate: forge.physics=${JSON.stringify(p)} -> ${backend ?? 'none'}`);
        return backend;
      }
      console.warn('[editor] physics gate: loadGameProject not ok:', (gp.error as { code?: string })?.code ?? gp.error);
    } catch (e) {
      console.warn('[editor] physics gate: forge.json read failed (no physics):', e);
    }
    return undefined;
  }

  // ── seed / restore the authored document (was bootEditor :199) ────────────────
  // A small demo scene so the editor opens with something to edit + render. These
  // are ordinary commands -> they land in the ledger and are undoable.
  function seedDemoScene(): void {
    if (worldEntityHandles(gateway.activeWorld).length > 0) return;
    // Mirrors the new-game template's scene.json: a lowpoly vignette + a movable
    // Player. A scene-less game (or fresh workspace) opens on this same starter.
    gateway.dispatch({ kind: 'spawnEntity', name: 'Level', components: {} });
    const level = (gateway.ledger.at(-1) as { _id: number })._id;
    const add = (name: string, components: Record<string, unknown>, source?: { plugin: string; docId: string }) =>
      gateway.dispatch({ kind: 'spawnEntity', name, parent: level, components, ...(source ? { source } : {}) });

    add('Ground', { Transform: { pos: [0, -0.1, 0], scale: [24, 0.2, 24] }, MeshFilter: { assetHandle: HANDLE_CUBE } });
    add('Sun', { Transform: { pos: [0, 6, 0] }, DirectionalLight: { color: [1, 0.96, 0.88], intensity: 3.2, direction: [-0.4, -1, -0.3], castShadow: true } });
    add('TreeTrunk', { Transform: { pos: [-4, 0.9, -3], scale: [0.4, 1.8, 0.4] }, MeshFilter: { assetHandle: HANDLE_CYLINDER } });
    add('TreeCanopy', { Transform: { pos: [-4, 2.4, -3], scale: [1.4, 1.4, 1.4] }, MeshFilter: { assetHandle: HANDLE_SPHERE } });
    add('RedBox', { Transform: { pos: [3, 0.5, -2], scale: [1, 1, 1] }, MeshFilter: { assetHandle: HANDLE_CUBE } }, { plugin: 'lowpoly', docId: 'crate-01' });
    add('BlueBall', { Transform: { pos: [4.5, 0.8, 1.5], scale: [0.8, 0.8, 0.8] }, MeshFilter: { assetHandle: HANDLE_SPHERE } });
    add('YellowPillar', { Transform: { pos: [2, 0.75, 3.5], scale: [0.6, 1.5, 0.6] }, MeshFilter: { assetHandle: HANDLE_CYLINDER } });
    add('Player', { Transform: { pos: [0, 0.55, 0], scale: [0.7, 1.1, 0.7] }, MeshFilter: { assetHandle: HANDLE_CYLINDER } });
  }

  /**
   * Run the application session tail on an already-booted world (plan-strategy D8).
   * Ordered exactly as the original bootEditor: authored-scene load (seed fallback)
   * -> run-lifecycle -> environment skylight -> asset/resolver preload -> mesh-stats
   * publish -> preview-skin -> cross-window sync -> disk-watch -> flush beacons.
   * Returns the ▶/■ pair so ViewportComponent can wire the ViewportChrome actions.
   */
  async function initHostSession(ctx: HostSessionContext): Promise<HostSession> {
    const { app, world, renderer, viewport, emitBoot, setBootStage, discoverGameCameraFromWorld, applyActiveCamera } = ctx;

    // M3 t16 (plan-strategy §2 D-2 / D-11, research F-3): obtain the single
    // core-minted EngineFacade AFTER ViewportComponent injected the world
    // (gateway.doc.world = world). This is the controlled write proxy the boot
    // scaffolding hands to skylight (async IBL handle casting), drag-spawn (mesh
    // handle minting), and preview-skin (root normalize + clip writes) — every
    // boot-side world write now goes through the same gate the executor gives
    // appliers via ctx.engine.
    const engine = gateway.engineFacade();

    // ── Load the authored scene (was bootEditor :433) ───────────────────────────
    // After the engine World + AssetRegistry are the renderer's and the pack-index
    // is configured (done by ViewportComponent before this call). Load order:
    // on-disk authored scene -> localStorage mirror -> demo seed; seed only when
    // the result is EMPTY. The opened scene is FLAT (loadSceneByGuid ->
    // reg.instantiateFlat): no synthetic wrapper root. Play/Stop re-instantiate
    // the saved scene into a separate fresh playWorld (run-lifecycle), so the edit
    // world's loaded entities are never used for a ▶ snapshot / ■ restore.
    setBootStage('loadDoc');
    await renderer.ready.catch(() => null);
    await loadDocFromDisk().then((ok) => { if (!ok) loadDocFromStorage(); }).catch(() => { loadDocFromStorage(); });
    if (worldEntityHandles(gateway.activeWorld).length === 0) {
      seedDemoScene();
      // The bare seed is a viewport convenience for a scene-less game — do NOT
      // auto-persist it to the game dir. The user's first real edit re-schedules a save.
      cancelPendingDiskSave();
    }
    emitBoot(`scene ▸ loaded entities=${worldEntityHandles(gateway.activeWorld).length} roots=${getLoadedSceneEntities().length}`);

    // single-realm (feat-20260703): the engine AssetRegistry catalog is populated
    // asynchronously by the scene load above (configurePackIndex + loadByGuid, both
    // gated on renderer.ready). The Assets panel (ContentBrowser) mounts and reads
    // registry.listCatalog() BEFORE that completes, so its first read is empty and
    // nothing re-triggers it — the panel stayed blank until a manual page refresh.
    // Fire the existing "assets changed" signal now that the catalog is live so any
    // mounted ContentBrowser re-reads. Under the old iframe arch the editor iframe
    // booted before the panel iframes, so the catalog was ready by panel mount; the
    // single realm boots them concurrently, exposing this ordering.
    broadcastAssetsChanged();

    // ── ▶ Play / ■ Stop run-lifecycle (M2 rewrite — play=level-load, stop=drop) ──
    // play forks a FRESH world assembled from the disk defaultScene; the edit world
    // is frozen (editorApp.pause) and never touched (AC-04/06/07). host-boot's job
    // here is to build the play-assemble dependency closures (defaultScene load /
    // bootstrap resolve / input attach) and wire them into createRunLifecycle.
    let runLifecycle: RunLifecycle | null = null;
    const playSimulation = (): void => { void runLifecycle?.playSimulation(); };
    const stopSimulation = (): void => { emitBoot('scene ▸ stop requested'); runLifecycle?.stopSimulation(); };

    // ── forge.json → game fs base (bootstrap module URL resolution) ──────────────
    let cachedProjectRootAbs: string | undefined;
    const getProjectRootAbs = async (): Promise<string> => {
      if (cachedProjectRootAbs !== undefined) return cachedProjectRootAbs;
      const r = await deps.fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) throw new Error(`/api/health HTTP ${r.status}`);
      const j = (await r.json()) as { projectRootAbs?: string };
      if (!j.projectRootAbs) throw new Error('/api/health missing projectRootAbs');
      cachedProjectRootAbs = j.projectRootAbs;
      return cachedProjectRootAbs;
    };
    const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const resolveGameFsBase = async (): Promise<string> => {
      const toFsUrl = (abs: string) => {
        const norm = abs.replace(/\\/g, '/');
        return `${BASE}/@fs${norm.startsWith('/') ? '' : '/'}${norm}`;
      };
      if (typeof __FORGEAX_GAME_DIR_ABS__ === 'string' && __FORGEAX_GAME_DIR_ABS__) {
        return toFsUrl(__FORGEAX_GAME_DIR_ABS__);
      }
      const rootAbs = await getProjectRootAbs();
      const gameRoot = new URLSearchParams(location.search).get('gameRoot') ?? '';
      const fsBase = toFsUrl(rootAbs);
      return gameRoot ? `${fsBase}/${gameRoot}` : fsBase;
    };

    // Read forge.json once per ▶ Play so defaultScene + entry are consistent (both
    // come from the same GameProject read). Returns { entry?, defaultSceneGuid? }.
    const readForgeForPlay = async (): Promise<{ entry?: string; defaultSceneGuid?: string }> => {
      try {
        const gameForgePath = resolveGamePath(FORGE_JSON);
        const gp = await loadGameProject(async () => {
          const r = await deps.fetch(`/api/files?path=${encodeURIComponent(gameForgePath)}`, { cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = (await r.json()) as { content?: string };
          if (!j.content) throw new Error('Empty content');
          return j.content;
        });
        if (!gp.ok) return {};
        const out: { entry?: string; defaultSceneGuid?: string } = {};
        const entry = gp.value.entry;
        if (typeof entry === 'string' && entry) out.entry = entry.replace(/^\.?\//, '');
        const ds = gp.value.defaultScene;
        if (typeof ds === 'string' && ds.length > 0) out.defaultSceneGuid = ds;
        return out;
      } catch (e) {
        console.warn('[editor] ▶ Play forge.json read failed:', e);
        return {};
      }
    };

    // play-assemble dep: load the SceneAsset for the forge.json defaultScene GUID.
    // Pure read path (loadByGuid) — sidesteps the collect-side fidelity hazards
    // (research Finding 2). Null when the game declares no defaultScene.
    const loadDefaultScene = async (): Promise<unknown> => {
      const forge = await readForgeForPlay();
      if (!forge.defaultSceneGuid) return null;
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = AssetGuid.parse(forge.defaultSceneGuid);
      if (!parsed.ok) return null;
      await renderer.ready.catch(() => null);
      const assetRes = await renderer.assets.loadByGuid(parsed.value);
      if (!assetRes.ok) {
        console.info('[editor] ▶ Play defaultScene load skipped:', (assetRes.error as { code?: string })?.code);
        return null;
      }
      return assetRes.value;
    };

    // play-assemble dep: resolve + validate the game bootstrap module. Same entry
    // candidates as the old original-in-place path; returns null when no module has
    // a bootstrap export (graceful — play renders the scene with no game logic).
    const resolveBootstrap = async (): Promise<((w: unknown, c?: unknown) => void | Promise<void>) | null> => {
      const forge = await readForgeForPlay();
      const gameFsBase = await resolveGameFsBase();
      const candidates: string[] = [];
      if (forge.entry) candidates.push(forge.entry);
      for (const fallback of ['main.ts', 'src/main.ts']) {
        if (!candidates.includes(fallback)) candidates.push(fallback);
      }
      for (const rel of candidates) {
        const url = `${gameFsBase}/${rel}`;
        try {
          const mod = await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
          const bootstrap = (mod as { bootstrap?: unknown }).bootstrap;
          if (typeof bootstrap === 'function') {
            return bootstrap as (w: unknown, c?: unknown) => void | Promise<void>;
          }
        } catch { /* try next candidate */ }
      }
      console.warn(`[editor] ▶ Play bootstrap module not found for ${getSceneId()}`);
      return null;
    };

    // play-assemble dep: attach a fresh input backend to the SHARED canvas for the
    // play world + pre-inject the INPUT_BACKEND_KEY resource BEFORE createApp runs
    // plugins (engine D-3). Returns the detach callback the lifecycle calls on ■ Stop.
    const attachPlayInput = (playWorld: unknown): (() => void) | undefined => {
      const handle = attachBrowserInputBackend(ctx.canvas);
      (playWorld as { insertResource(k: string, v: unknown): void }).insertResource(INPUT_BACKEND_KEY, handle.backend);
      return () => { try { handle(); } catch { /* already detached */ } };
    };

    runLifecycle = createRunLifecycle({
      editorApp: app,
      gateway,
      assemble: (): Promise<{ ok: true; value: PlayAssembly } | { ok: false; error: unknown }> =>
        assemblePlayWorld({
          renderer: renderer as never,
          loadDefaultScene,
          resolveBootstrap,
          attachInput: attachPlayInput,
          // ▶ Play mounts #game-ui-root inside the viewport container as ctx.uiRoot
          // and removes it on ■ Stop (play-assemble detach()). Threaded here so the
          // game HUD is clipped to the viewport and can never survive a stop.
          viewportContainer: ctx.viewportContainer,
          ...(ctx.physics ? { physics: ctx.physics } : {}),
        }),
      onAfterPlay: () => { discoverGameCameraFromWorld(); applyActiveCamera(); },
      onDirtyPlayHint: () => {
        // D-10: play re-instantiates the last-SAVED scene from disk; unsaved
        // in-memory edits are not reflected. Surface a structured hint (no auto-save
        // — keep "save" an explicit user action).
        if (hasPendingDiskSave()) {
          emitBoot('play ▸ play-uses-last-saved-scene (unsaved edits not reflected)', 'warn');
        }
      },
    });

    // ── Environment skylight ─────────────────────────────────────────────────────
    // Skylight is now authored scene data, declared in the scene pack and loaded
    // via loadByGuid (engine record pass handles IBL precompute lazily). The editor
    // no longer creates its own skylight — it reads the one from the pack.
    // See: forgeax-engine-harness/feedbacks/2026-07-08-skylight-equirect-blocks-scene-switch-serialize.md

    // ── Drag-spawn mesh GUID bridge (feat-20260705 M3, plan-strategy §D-3/D-4/D-9) ─
    // Content Browser mesh drops spawn with MeshFilter.assetHandle=0 + a command-
    // level EditorPendingMeshAsset{guid} marker (core/assets/drag-asset-spawn.ts).
    // This resolver subscribes to the gateway, parses the guid, loadByGuid ->
    // allocSharedRef('MeshAsset') and patches the real handle back over the gateway
    // (AC-10/AC-11). The former post-collapse preload seams (the mesh/material
    // pre-resolve loops + their sync resolvers) are deleted (AC-13) — this is
    // their live successor.
    installDragSpawnMeshResolver(gateway as never, engine, renderer as never);

    // ── Mesh-stats publish (was bootEditor :1105) ───────────────────────────────
    installMeshStatsPublisher(renderer);

    // M3: single-realm — no cross-window sync needed, engine is in-process.
    // initSync() is deleted (plan-strategy S7 M3, requirements AC-06).

    // ── Preview-skin + animation hook (was bootEditor :1217) ────────────────────
    void installPreviewSkinHook({ world, engine, renderer, viewport });

    // ── Disk-watch + flush beacons (was bootEditor :1368) ───────────────────────
    // Capture each teardown handle so a multi-game host (studio single-realm) can
    // dispose this session on a cross-game switch — otherwise the previous game's
    // disk-watch socket + flush beacons keep firing against the new game's world.
    // The window pagehide/visibilitychange + VAG_EDITOR_FLUSH wiring is lifted
    // behind deps.installSaveBeaconListeners (the boot tail's one DOM boundary), so
    // this path is headless-testable; the flush target is deps.flushPendingSaveBeacon.
    const stopDiskWatch = initDiskWatch();
    const disposeSaveBeacons = installSaveBeaconListeners(() => flushPendingSaveBeacon());

    const dispose = (): void => {
      // Flush any pending save one last time before tearing the session down so a
      // cross-game switch never drops the previous game's unsaved edits.
      try { flushPendingSaveBeacon(); } catch { /* best effort */ }
      stopDiskWatch();
      disposeSaveBeacons();
    };

    return { playSimulation, stopSimulation, dispose };
  }

  // ── mesh-stats publisher (was bootEditor :1105) ───────────────────────────────
  function installMeshStatsPublisher(renderer: RendererLike): void {
    const primCount = (topology: string, indexCount: number, vertexCount: number): number => {
      const n = indexCount > 0 ? indexCount : vertexCount;
      switch (topology) {
        case 'triangle-list': return Math.floor(n / 3);
        case 'triangle-strip': return Math.max(0, n - 2);
        case 'line-list': return Math.floor(n / 2);
        case 'line-strip': return Math.max(0, n - 1);
        case 'point-list': return n;
        default: return Math.floor(n / 3);
      }
    };
    const emptyStats = (guid: string, error: string) =>
      ({ guid, vertexCount: 0, primitiveCount: 0, indexFormat: 'none' as const, submeshes: [], attributes: [], error });
    const activeMeshGuid = (): string | null => {
      const selId = getSelection();
      if (selId !== null) {
        const meshR = entComponent(gateway.activeWorld as never, selId, 'Mesh');
        if (meshR.ok) {
          const mesh = meshR.value;
          const g = typeof mesh.meshAsset === 'string' ? mesh.meshAsset : '';
          return g.length > 0 ? g : null;
        }
      }
      const a = getAssetSelection();
      return a?.kind === 'mesh' ? a.guid : null;
    };
    let lastGuid: string | null = null;
    const publishForActiveMesh = async (): Promise<void> => {
      const guid = activeMeshGuid();
      if (guid === lastGuid) return;
      lastGuid = guid;
      if (guid === null) { publishMeshStats(null); return; }
      try {
        const { AssetGuid } = await import('@forgeax/engine-pack/guid');
        const parsed = (AssetGuid as { parse: (s: string) => { ok: boolean; value?: unknown } }).parse(guid);
        if (!parsed.ok || parsed.value === undefined) { publishMeshStats(emptyStats(guid, 'bad guid')); return; }
        const res = await renderer.assets.loadByGuid(parsed.value);
        if (activeMeshGuid() !== guid) return;
        if (!res.ok || res.value === undefined) { publishMeshStats(emptyStats(guid, res.error?.code ?? 'load miss')); return; }
        const mesh = res.value as {
          vertices?: { byteLength?: number };
          indices?: unknown;
          attributes?: Record<string, unknown>;
          aabb?: { length: number; [i: number]: number };
          submeshes?: readonly { topology: string; indexCount: number; vertexCount: number }[];
        };
        const indices = mesh.indices;
        const indexFormat: 'u16' | 'u32' | 'none' =
          indices instanceof Uint32Array ? 'u32' : indices instanceof Uint16Array ? 'u16' : 'none';
        const subs = (mesh.submeshes ?? []).map((s) => ({
          topology: s.topology, indexCount: s.indexCount, vertexCount: s.vertexCount,
          primitiveCount: primCount(s.topology, s.indexCount, s.vertexCount),
        }));
        const ab = mesh.aabb;
        const aabb = ab && ab.length === 6 ? [0, 1, 2, 3, 4, 5].map((i) => ab[i] ?? 0) : undefined;
        const vBytes = typeof mesh.vertices?.byteLength === 'number' ? mesh.vertices.byteLength : 0;
        const iBytes = indices instanceof Uint16Array || indices instanceof Uint32Array ? indices.byteLength : 0;
        const byteSize = vBytes + iBytes;
        publishMeshStats({
          guid,
          vertexCount: subs.reduce((a, s) => a + s.vertexCount, 0),
          primitiveCount: subs.reduce((a, s) => a + s.primitiveCount, 0),
          indexFormat,
          submeshes: subs,
          ...(aabb ? { aabb } : {}),
          ...(byteSize > 0 ? { byteSize } : {}),
          attributes: mesh.attributes ? Object.keys(mesh.attributes) : [],
        });
      } catch (err) {
        publishMeshStats(emptyStats(guid, (err as Error)?.message ?? 'load failed'));
      }
    };
    onAssetSelectionChange(() => { void publishForActiveMesh(); });
    onSelectionChange(() => { void publishForActiveMesh(); });
    gateway.subscribe(() => { void publishForActiveMesh(); });
    void publishForActiveMesh();
  }

  // ── preview-skin + animation hook (was bootEditor :1217) ──────────────────────
  async function installPreviewSkinHook(ctx: { world: WorldLike; engine: EngineFacade; renderer: RendererLike; viewport: ViewportLike }): Promise<void> {
    const { world, engine, renderer, viewport } = ctx;
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    await renderer.ready.catch(() => null);
    try {
      const gameForgePath = resolveGamePath(FORGE_JSON);
      const fetchRead = async (): Promise<string> => {
        const r = await deps.fetch(`/api/files?path=${encodeURIComponent(gameForgePath)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { content?: string };
        if (!j.content) throw new Error('Empty content');
        return j.content;
      };
      const gpResult = await loadGameProject(fetchRead);
      if (!gpResult.ok) return;
      const skin = gpResult.value.preview?.skin;
      if (!skin?.sceneGuid) return;
      const { AnimationPlayer, Skin, SceneInstance, Transform: TransformC } = await import('@forgeax/engine-runtime');
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const assets = renderer.assets;
      const sceneGid = AssetGuid.parse(skin.sceneGuid);
      if (!sceneGid.ok) return;
      const sceneRes = await assets.loadByGuid(sceneGid.value);
      if (!sceneRes.ok) { console.warn('[editor] preview skin scene load failed:', (sceneRes.error as { code?: string })?.code); return; }
      if (getSceneId() !== slug) return;
      // M3 t20 (S4 / AC-05): preview-skin engine writes/reads go through the injected
      // EngineFacade (ctx.engine proxy) — allocSharedRef handle-cast + Transform
      // normalize + AnimationPlayer addComponent are all trace-visible now. The one
      // exception is assets.instantiate(handle, world): that is a RENDERER-registry
      // call whose second arg is the engine World the scene instantiates into (not a
      // mutator on the facade surface) — it keeps the raw world handle.
      const eid = (h: unknown): EntityHandle => h as EntityHandle;
      const sceneHandle = engine.allocSharedRef('SceneAsset', sceneRes.value);
      const inst = (assets as never as { instantiate: (h: unknown, w: unknown) => { ok: boolean; value?: unknown; error?: unknown } }).instantiate(sceneHandle, world);
      if (!inst.ok) { console.warn('[editor] preview skin instantiate failed:', (inst.error as { code?: string })?.code); return; }
      const skinRoot = inst.value as unknown as { generation: number; index: number };
      const [px, py, pz] = skin.pos ?? [0, 0, 0];
      const s = skin.scale ?? 1;
      engine.set(eid(skinRoot), TransformC, { pos: [px, py, pz], scale: [s, s, s], quat: [0, 0, 0, 1] });
      const sceneInst = engine.get(eid(skinRoot), SceneInstance) as { ok: boolean; value?: { mapping: unknown[] } };
      if (!sceneInst.ok || !sceneInst.value) return;
      let skinEnt: unknown = null;
      for (const ent of sceneInst.value.mapping) {
        if (!ent) continue;
        const r = engine.get(eid(ent), Skin);
        if (r.ok) { skinEnt = ent; break; }
      }
      if (!skinEnt) return;
      const defaultName = skin.clipDefault ?? 'idle';
      const clipGuids = skin.clipGuids ?? [];
      if (clipGuids.length === 0) return;
      const firstGid = AssetGuid.parse(clipGuids[0]!);
      if (!firstGid.ok) return;
      const clipRes = await assets.loadByGuid(firstGid.value);
      if (!clipRes.ok) { console.warn('[editor] preview skin clip load failed:', (clipRes.error as { code?: string })?.code); return; }
      if (getSceneId() !== slug) return;
      const clipHandle = engine.allocSharedRef('AnimationClip', clipRes.value);
      engine.addComponent(eid(skinEnt), {
        component: AnimationPlayer,
        data: {
          // clips is array<shared<AnimationClip>,4>; slots 1-3 are the engine's
          // NULL-handle sentinel (raw 0) — brand them so the strict input type
          // (readonly Handle<'AnimationClip','shared'>[]) accepts the mixed row.
          clips: [clipHandle, toShared<'AnimationClip'>(0), toShared<'AnimationClip'>(0), toShared<'AnimationClip'>(0)],
          times: new Float32Array([0, 0, 0, 0]),
          weights: new Float32Array([1, 0, 0, 0]),
          speeds: new Float32Array([1, 1, 1, 1]),
          paused: false,
          looping: true,
        },
      });
      const clipDurationSec = Math.max(0.001, Number((clipRes.value as { duration?: number }).duration) || 1);
      console.log(`[editor] preview skin loaded for ${slug} (default clip via guid ${clipGuids[0]!.slice(0, 8)}, ${defaultName})`);

      try {
        const { onClipControl, getClipControl } = await import('@forgeax/editor-core');
        const applyClip = (): void => {
          const c = getClipControl();
          const cur = engine.get(eid(skinEnt), AnimationPlayer) as { ok: boolean; value?: { times?: Float32Array; speeds?: Float32Array } };
          if (!cur.ok || !cur.value) return;
          const speeds = Float32Array.from(cur.value.speeds ?? new Float32Array([1, 1, 1, 1]));
          speeds[0] = c.speed;
          const data: Record<string, unknown> = { paused: c.paused, speeds };
          if (c.applyPhase) {
            const times = Float32Array.from(cur.value.times ?? new Float32Array(4));
            times[0] = Math.max(0, Math.min(1, c.phase)) * clipDurationSec;
            data.times = times;
          }
          engine.set(eid(skinEnt), AnimationPlayer, data);
        };
        onClipControl(applyClip);
        applyClip();
      } catch (cErr) {
        console.warn('[editor] clip scrubber wiring failed:', (cErr as Error).message ?? cErr);
      }

      try {
        const { onViewRequest } = await import('@forgeax/editor-core');
        const { normalizeSkinTransform } = await import('./preview-skin');
        onViewRequest((cmd) => {
          try {
            if (cmd === 'resetCamera') { viewport.resetCamera(); return; }
            if (cmd === 'recenter') {
              const ok = normalizeSkinTransform(engine, { skinEntity: skinEnt, skinRoot, targetHeight: 1.9 });
              if (ok) viewport.resetCamera();
            }
          } catch (e) { console.warn('[editor] view intent failed:', (e as Error).message ?? e); }
        });
      } catch (vErr) {
        console.warn('[editor] view-intent wiring failed:', (vErr as Error).message ?? vErr);
      }
    } catch (err) {
      console.warn('[editor] preview skin hook failed:', (err as Error).message ?? err);
    }
  }

  return { resolveEditPhysics, initHostSession };
}
