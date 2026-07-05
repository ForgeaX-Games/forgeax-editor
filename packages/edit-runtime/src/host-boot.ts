// host-boot — the application-level startup strategy for the editor session
// (plan-strategy REPLAN D8; q2 "host entry" boundary — the seed/scene-load/play
// side that stays at the host entry, as opposed to the viewport surface).
//
// WHAT THIS IS
//   D8 physically split the 1652-line main.tsx bootEditor() closure along the q2
//   boundary into two edit-runtime modules that standalone/main.tsx can import:
//     - ViewportComponent.tsx — canvas + createApp + renderer + camera + viewport
//       interaction (the ENGINE SURFACE).
//     - host-boot.ts (this file) — seed / scene-load / physics gate / asset +
//       resolver preload / ▶ Play run-lifecycle / mesh-stats publish / preview-
//       skin / cross-window sync / disk-watch (the APPLICATION SESSION that runs
//       ON TOP of an already-booted world).
//
//   ViewportComponent boots the world, then hands the live { app, world,
//   renderer, viewport, cameraEntity } to initHostSession() here. This is a
//   Pipeline-Isolation seam: everything host-boot needs is in HostSessionContext,
//   nothing implicit. Both standalone (in-process host) and the edit-runtime thin
//   main.tsx entry drive the SAME ViewportComponent → same host-boot, so the two
//   hosts cannot drift (architecture-principles S1 SSOT).
//
// WHY resolveEditPhysics is separate
//   The physics gate (forge.json "physics" -> rapier backend) must run BEFORE
//   createApp (it feeds createApp's `plugins`). So it is exported on its own for
//   ViewportComponent to await pre-boot; the rest of the session tail runs after.
//
// Anchors: plan-strategy S2 D8 (host-boot = seed/scene-load/preload/play), S4 R8
// (edit-runtime independent dev still green after the split), requirements C-1
// (single-world model), AC-06/AC-07 (▶/■ snapshot-restore).

import {
  HANDLE_CUBE,
  HANDLE_SPHERE,
  HANDLE_CYLINDER,
} from '@forgeax/engine-runtime';
import { Entity } from '@forgeax/engine-ecs';
import {
  bus,
  loadDocFromStorage,
  loadDocFromDisk,
  getLoadedSceneRoot,
  rebindLoadedScene,
  setSceneId,
  getSceneId,
  initSceneList,
  initDiskWatch,
  flushPendingSaveBeacon,
  cancelPendingDiskSave,
  setPathResolver,
  getAssetSelection,
  onAssetSelectionChange,
  getSelection,
  onSelectionChange,
  publishMeshStats,
  broadcastAssetsChanged,
} from '@forgeax/editor-core';
import {
  makeMaterialResolver,
  makeMeshResolver,
  entIds,
  entComponent,
  resolveGamePath,
  getApiClient,
} from '@forgeax/editor-core';
import { loadGameProject, FORGE_JSON } from '@forgeax/engine-project';
import {
  onVagMessage,
  allowedParentOrigins,
} from '@forgeax/editor-core/protocol';
import { createRunLifecycle, type RunLifecycle } from './engine/run-lifecycle';
import { setupEditorSkylight } from './engine/skylight';

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
type EditorAppLike = { registerUpdate(fn: (dt: number) => void): void; start(): void };
type ViewportLike = { resetCamera(): void };

export type PhysicsBackend = 'rapier-3d' | 'rapier-2d';

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
  setSceneId(qp.get('scene'));
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
 * The physics gate (plan-strategy D8, was main.tsx bootEditor :287). Reads the
 * active game's forge.json "physics" and returns the rapier backend to pass to
 * createApp's `plugins`, or undefined for a non-physics game (zero rapier WASM
 * cost). A missing/failed read degrades to no-physics (charter S9). MUST be
 * awaited BEFORE createApp — hence exported separately from initHostSession.
 */
export async function resolveEditPhysics(): Promise<PhysicsBackend | undefined> {
  const slug = getSceneId();
  if (!slug || slug === 'default') return undefined;
  try {
    const gp = await loadGameProject(async () => {
      const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(resolveGamePath(FORGE_JSON))}`, { cache: 'no-store' });
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
  if (entIds(bus.doc).length > 0) return;
  // Mirrors the new-game template's scene.json: a lowpoly vignette + a movable
  // Player. A scene-less game (or fresh workspace) opens on this same starter.
  bus.dispatch({ kind: 'spawnEntity', name: 'Level', components: {} });
  const level = (bus.ledger.at(-1) as { _id: number })._id;
  const add = (name: string, components: Record<string, unknown>, source?: { plugin: string; docId: string }) =>
    bus.dispatch({ kind: 'spawnEntity', name, parent: level, components, ...(source ? { source } : {}) });

  add('Ground', { Transform: { posX: 0, posY: -0.1, posZ: 0, scaleX: 24, scaleY: 0.2, scaleZ: 24 }, MeshFilter: { assetHandle: HANDLE_CUBE } });
  add('Sun', { Transform: { posX: 0, posY: 6, posZ: 0 }, DirectionalLight: { colorR: 1, colorG: 0.96, colorB: 0.88, intensity: 3.2, directionX: -0.4, directionY: -1, directionZ: -0.3, castShadow: true } });
  add('TreeTrunk', { Transform: { posX: -4, posY: 0.9, posZ: -3, scaleX: 0.4, scaleY: 1.8, scaleZ: 0.4 }, MeshFilter: { assetHandle: HANDLE_CYLINDER } });
  add('TreeCanopy', { Transform: { posX: -4, posY: 2.4, posZ: -3, scaleX: 1.4, scaleY: 1.4, scaleZ: 1.4 }, MeshFilter: { assetHandle: HANDLE_SPHERE } });
  add('RedBox', { Transform: { posX: 3, posY: 0.5, posZ: -2, scaleX: 1, scaleY: 1, scaleZ: 1 }, MeshFilter: { assetHandle: HANDLE_CUBE } }, { plugin: 'lowpoly', docId: 'crate-01' });
  add('BlueBall', { Transform: { posX: 4.5, posY: 0.8, posZ: 1.5, scaleX: 0.8, scaleY: 0.8, scaleZ: 0.8 }, MeshFilter: { assetHandle: HANDLE_SPHERE } });
  add('YellowPillar', { Transform: { posX: 2, posY: 0.75, posZ: 3.5, scaleX: 0.6, scaleY: 1.5, scaleZ: 0.6 }, MeshFilter: { assetHandle: HANDLE_CYLINDER } });
  add('Player', { Transform: { posX: 0, posY: 0.55, posZ: 0, scaleX: 0.7, scaleY: 1.1, scaleZ: 0.7 }, MeshFilter: { assetHandle: HANDLE_CYLINDER } });
}

/**
 * Everything host-boot needs from the booted viewport, declared explicitly
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
 * Run the application session tail on an already-booted world (plan-strategy D8).
 * Ordered exactly as the original bootEditor: authored-scene load (seed fallback)
 * -> run-lifecycle -> environment skylight -> asset/resolver preload -> mesh-stats
 * publish -> preview-skin -> cross-window sync -> disk-watch -> flush beacons.
 * Returns the ▶/■ pair so ViewportComponent can wire the ViewportChrome actions.
 */
export async function initHostSession(ctx: HostSessionContext): Promise<HostSession> {
  const { app, world, renderer, cameraEntity, viewport, emitBoot, setBootStage, discoverGameCameraFromWorld, applyActiveCamera } = ctx;

  // ── Load the authored scene (was bootEditor :433) ───────────────────────────
  // After the engine World + AssetRegistry are the renderer's and the pack-index
  // is configured (done by ViewportComponent before this call). Load order:
  // on-disk authored scene -> localStorage mirror -> demo seed; seed only when
  // the result is EMPTY. defaultSceneRoot binds to the root loadSceneByGuid
  // instantiated into the LIVE world (▶ snapshot / ■ restore use it).
  let defaultSceneRoot: number | undefined;
  setBootStage('loadDoc');
  await renderer.ready.catch(() => null);
  await loadDocFromDisk().then((ok) => { if (!ok) loadDocFromStorage(); }).catch(() => { loadDocFromStorage(); });
  if (entIds(bus.doc).length === 0) {
    seedDemoScene();
    // The bare seed is a viewport convenience for a scene-less game — do NOT
    // auto-persist it to the game dir. The user's first real edit re-schedules a save.
    cancelPendingDiskSave();
  }
  {
    const loadedRoot = getLoadedSceneRoot();
    if (loadedRoot !== null) defaultSceneRoot = loadedRoot;
  }
  emitBoot(`scene ▸ loaded entities=${entIds(bus.doc).length} root=${defaultSceneRoot ?? 'none'}`);

  // single-realm (feat-20260703): the engine AssetRegistry catalog is populated
  // asynchronously by the scene load above (configurePackIndex + loadByGuid, both
  // gated on renderer.ready). The Assets panel (ContentBrowserV2) mounts and reads
  // registry.listCatalog() BEFORE that completes, so its first read is empty and
  // nothing re-triggers it — the panel stayed blank until a manual page refresh.
  // Fire the existing "assets changed" signal now that the catalog is live so any
  // mounted ContentBrowser re-reads. Under the old iframe arch the editor iframe
  // booted before the panel iframes, so the catalog was ready by panel mount; the
  // single realm boots them concurrently, exposing this ordering.
  broadcastAssetsChanged();

  // ── ▶ Play run-lifecycle (was bootEditor :712) ──────────────────────────────
  let runLifecycle: RunLifecycle | null = null;
  const playSimulation = (): void => { void runLifecycle?.playSimulation(); };
  const stopSimulation = (): void => { emitBoot('scene ▸ stop requested'); runLifecycle?.stopSimulation(); };

  const collectWorldEntityHandles = (): Set<number> => {
    const handles = new Set<number>();
    const graph = world._getGraph();
    for (const arch of graph.archetypes) {
      const selfCol = arch.columns.get(Entity.id)?.get('self');
      if (!selfCol) continue;
      for (let row = 0; row < arch.size; row++) {
        const packed = selfCol.view[row]!;
        if (packed !== 0) handles.add(packed as unknown as number);
      }
    }
    return handles;
  };

  // ── ▶ Play game-module resolver (was bootEditor :723-842) ────────────────────
  let cachedDefaultScene: unknown;
  let cachedProjectRootAbs: string | undefined;
  const getProjectRootAbs = async (): Promise<string> => {
    if (cachedProjectRootAbs !== undefined) return cachedProjectRootAbs;
    const r = await getApiClient().fetch('/api/health', { cache: 'no-store' });
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
  const resolveGameModuleForPlay = async (): Promise<unknown> => {
    const gameFsBase = await resolveGameFsBase();
    const candidates: string[] = [];
    cachedDefaultScene = undefined;
    try {
      const gameForgePath = resolveGamePath(FORGE_JSON);
      const gp = await loadGameProject(async () => {
        const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(gameForgePath)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { content?: string };
        if (!j.content) throw new Error('Empty content');
        return j.content;
      });
      if (gp.ok) {
        const entry = gp.value.entry;
        if (typeof entry === 'string' && entry) candidates.push(entry.replace(/^\.?\//, ''));
        const dsGuid = gp.value.defaultScene;
        if (typeof dsGuid === 'string' && dsGuid.length > 0) {
          const { AssetGuid } = await import('@forgeax/engine-pack/guid');
          const parsed = AssetGuid.parse(dsGuid);
          if (parsed.ok) {
            await renderer.ready.catch(() => null);
            const assetRes = await renderer.assets.loadByGuid(parsed.value);
            if (assetRes.ok) cachedDefaultScene = assetRes.value;
            else console.info('[editor] ▶ Play defaultScene preload skipped (best-effort):', (assetRes.error as { code?: string })?.code);
          }
        }
      }
    } catch (e) {
      console.warn('[editor] ▶ Play forge.json read failed (using entry defaults):', e);
    }
    for (const fallback of ['main.ts', 'src/main.ts']) {
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }
    for (const rel of candidates) {
      const url = `${gameFsBase}/${rel}`;
      try {
        const mod = await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
        if (mod && typeof (mod as { bootstrap?: unknown }).bootstrap === 'function') return mod;
      } catch { /* try next candidate */ }
    }
    throw new Error(`module not found: ${getSceneId()}`);
  };

  runLifecycle = createRunLifecycle({
    world: world as never,
    app: app as never,
    renderer: renderer as never,
    bus: bus as never,
    collectEntityHandles: () => collectWorldEntityHandles(),
    resolveGameModule: resolveGameModuleForPlay,
    getSlug: () => getSceneId() ?? '',
    getDefaultSceneRoot: () => defaultSceneRoot,
    getDefaultScene: () => cachedDefaultScene,
    onAfterBootstrap: () => { discoverGameCameraFromWorld(); applyActiveCamera(); },
    rebindSceneInstance: (newRoot: number) => {
      const bound = rebindLoadedScene(newRoot);
      if (bound !== null) defaultSceneRoot = bound;
      emitBoot(`scene ▸ restored entities=${entIds(bus.doc).length} root=${defaultSceneRoot ?? 'none'}`);
    },
    mountUiRoot: () => {
      // Controlled UI root scoped to the viewport panel, NOT document.body. It is
      // absolutely positioned inside `.ep-viewport-root` (position:relative +
      // overflow:hidden) so the game HUD both shares the canvas-local coordinate
      // space (floatScore uses canvas-local CSS px) and is clipped to the viewport
      // rect. On ■ Stop unmountUiRoot removes this one element, discarding ALL game
      // DOM in a single cut (B) — the HUD can no longer be stranded as a remnant.
      const el = document.createElement('div');
      el.id = 'game-ui-root';
      el.style.cssText = 'position:absolute;inset:0;z-index:5;pointer-events:none;overflow:hidden';
      ctx.viewportContainer.appendChild(el);
      return el;
    },
    unmountUiRoot: (el: HTMLElement) => el.remove(),
  });

  // ── Environment skylight (was bootEditor :959) ──────────────────────────────
  // HDR -> IBL Skylight + visible SkyboxBackground. Uses the shared template HDR
  // (matches what ▶ Play installs via the engine catalog at GUID 81eec382).
  void setupEditorSkylight(
    world as never,
    renderer.assets as never,
    renderer.store as never,
    { hdrUrl: '/preview/shared-assets/template-game-default/sky.hdr' },
  );

  // ── Asset packs + preload resolvers (was bootEditor :550 + :974) ────────────
  // M3: loadGameAssets deleted (plan-strategy S7 M3). The material/mesh resolver
  // seams are dormant post-collapse (MeshFilter now carries a numeric builtin
  // handle) — keep the resolver struct empty so the seam survives for future
  // asset-system rewire.
  const packAssets: Array<{ guid: string; kind: string; name: string; payload: Record<string, unknown>; packPath: string }> = [];
  const preloadedMaterials = new Map<string, unknown>();
  const baseMaterialResolver = makeMaterialResolver(world as never, packAssets);
  // resolveMaterialAsset / resolveMeshAsset are the sync resolvers the
  // instantiator consults; post-collapse these paths are dormant (MeshFilter now
  // carries a numeric builtin handle, not a GUID) but kept intact so a future
  // asset-system rewire has the seam. See the F-4 note below.
  const resolveMaterialAsset = (guid: string): unknown | null =>
    preloadedMaterials.has(guid) ? (preloadedMaterials.get(guid) ?? null) : baseMaterialResolver(guid);
  const preloadedMeshes = new Map<string, unknown>();
  const resolveMeshAsset = makeMeshResolver(world as never, packAssets, preloadedMeshes);
  const preloadedMeshSubmeshCounts = new Map<string, number>();
  const packMeshSubmeshCounts = new Map<string, number>(
    packAssets
      .filter((a) => a.kind === 'mesh')
      .map((a) => {
        const subs = (a.payload as { submeshes?: { length?: number } } | undefined)?.submeshes;
        return [a.guid, typeof subs?.length === 'number' && subs.length > 0 ? subs.length : 1] as const;
      }),
  );
  const resolveMeshSubmeshCount = (guid: string): number | undefined =>
    preloadedMeshSubmeshCounts.get(guid) ?? packMeshSubmeshCounts.get(guid);
  // Touch the resolvers so the intentionally-retained (dormant, post-collapse)
  // seam is not tree-shaken / flagged unused; they re-activate when the asset
  // system can register imported MeshAsset handles (TODO imported-mesh-preload).
  void resolveMaterialAsset;
  void resolveMeshAsset;
  void resolveMeshSubmeshCount;

  // preload imported mesh sub-assets (was bootEditor :974). Dormant post-collapse
  // (MeshFilter{assetHandle} is a builtin, not a GUID) — the loop is a no-op on
  // migrated scenes; kept as the imported-mesh preload seam.
  {
    const failedMeshGuids = new Set<string>();
    const collectMeshGuids = (): Set<string> => {
      const guids = new Set<string>();
      const packMeshGuids = new Set(packAssets.filter((a) => a.kind === 'mesh').map((a) => a.guid));
      for (const id of entIds(bus.doc)) {
        const g = (entComponent(bus.doc, id, 'Mesh') as { meshAsset?: string } | undefined)?.meshAsset;
        if (typeof g === 'string' && g && !packMeshGuids.has(g) && !preloadedMeshes.has(g) && !failedMeshGuids.has(g)) guids.add(g);
      }
      return guids;
    };
    const preloadMeshes = async (): Promise<void> => {
      const guids = collectMeshGuids();
      if (guids.size === 0) return;
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      await Promise.all([...guids].map(async (g) => {
        try {
          const parsed = (AssetGuid as { parse: (s: string) => { ok: boolean; value?: unknown } }).parse(g);
          if (!parsed.ok || parsed.value === undefined) { failedMeshGuids.add(g); console.warn('[editor] mesh preload bad guid:', g); return; }
          const res = await renderer.assets.loadByGuid(parsed.value);
          if (!res.ok) { failedMeshGuids.add(g); console.warn('[editor] mesh preload miss:', g, res.error?.code); return; }
          const handle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('MeshAsset', res.value);
          preloadedMeshes.set(g, handle);
          const subs = (res.value as { submeshes?: { length?: number } } | undefined)?.submeshes;
          if (typeof subs?.length === 'number' && subs.length > 0) preloadedMeshSubmeshCounts.set(g, subs.length);
        } catch (err) {
          failedMeshGuids.add(g);
          console.warn('[editor] mesh preload failed:', g, (err as Error)?.message ?? err);
        }
      }));
    };
    void preloadMeshes();
    bus.subscribe(() => { void preloadMeshes(); });
  }

  // preload ORIGINAL per-submesh materials (was bootEditor :1053). Same dormant
  // seam for Material{submeshMaterials} recovered from DDC/meta.
  {
    const collectMaterialGuids = (): Set<string> => {
      const guids = new Set<string>();
      const packMatGuids = new Set(packAssets.filter((a) => a.kind === 'material').map((a) => a.guid));
      for (const id of entIds(bus.doc)) {
        const subs = (entComponent(bus.doc, id, 'Material') as { submeshMaterials?: string[] } | undefined)?.submeshMaterials;
        if (!Array.isArray(subs)) continue;
        for (const g of subs) {
          if (typeof g === 'string' && g && !packMatGuids.has(g) && !preloadedMaterials.has(g)) guids.add(g);
        }
      }
      return guids;
    };
    const preloadMaterials = async (): Promise<void> => {
      const guids = collectMaterialGuids();
      if (guids.size === 0) return;
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      await Promise.all([...guids].map(async (g) => {
        try {
          const parsed = (AssetGuid as { parse: (s: string) => { ok: boolean; value?: unknown } }).parse(g);
          if (!parsed.ok || parsed.value === undefined) { console.warn('[editor] material preload bad guid:', g); return; }
          const res = await renderer.assets.loadByGuid(parsed.value);
          if (!res.ok) { console.warn('[editor] material preload miss:', g, res.error?.code); return; }
          const handle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('MaterialAsset', res.value);
          preloadedMaterials.set(g, handle);
        } catch (err) {
          console.warn('[editor] material preload failed:', g, (err as Error)?.message ?? err);
        }
      }));
    };
    void preloadMaterials();
    bus.subscribe(() => { void preloadMaterials(); });
  }

  // ── Mesh-stats publish (was bootEditor :1105) ───────────────────────────────
  installMeshStatsPublisher(renderer);

  // M3: single-realm — no cross-window sync needed, engine is in-process.
  // initSync() is deleted (plan-strategy S7 M3, requirements AC-06).

  // ── Preview-skin + animation hook (was bootEditor :1217) ────────────────────
  void installPreviewSkinHook({ world, renderer, viewport });

  // ── Disk-watch + flush beacons (was bootEditor :1368) ───────────────────────
  // Capture each teardown handle so a multi-game host (studio single-realm) can
  // dispose this session on a cross-game switch — otherwise the previous game's
  // disk-watch socket + flush beacons keep firing against the new game's world.
  const stopDiskWatch = initDiskWatch();
  const onPageHide = (): void => flushPendingSaveBeacon();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flushPendingSaveBeacon();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('visibilitychange', onVisibilityChange);
  const disposeVagFlush = onVagMessage(window, {
    allowedOrigins: allowedParentOrigins(),
    handlers: { VAG_EDITOR_FLUSH: () => flushPendingSaveBeacon() },
  });

  const dispose = (): void => {
    // Flush any pending save one last time before tearing the session down so a
    // cross-game switch never drops the previous game's unsaved edits.
    try { flushPendingSaveBeacon(); } catch { /* best effort */ }
    stopDiskWatch();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('visibilitychange', onVisibilityChange);
    if (typeof disposeVagFlush === 'function') disposeVagFlush();
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
      const mesh = entComponent(bus.doc, selId, 'Mesh') as Record<string, unknown> | undefined;
      if (mesh) {
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
  bus.subscribe(() => { void publishForActiveMesh(); });
  void publishForActiveMesh();
}

// ── preview-skin + animation hook (was bootEditor :1217) ──────────────────────
async function installPreviewSkinHook(ctx: { world: WorldLike; renderer: RendererLike; viewport: ViewportLike }): Promise<void> {
  const { world, renderer, viewport } = ctx;
  const slug = getSceneId();
  if (!slug || slug === 'default') return;
  await renderer.ready.catch(() => null);
  try {
    const gameForgePath = resolveGamePath(FORGE_JSON);
    const fetchRead = async (): Promise<string> => {
      const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(gameForgePath)}`, { cache: 'no-store' });
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
    const sceneHandle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('SceneAsset', sceneRes.value);
    const inst = (assets as never as { instantiate: (h: unknown, w: unknown) => { ok: boolean; value?: unknown; error?: unknown } }).instantiate(sceneHandle, world);
    if (!inst.ok) { console.warn('[editor] preview skin instantiate failed:', (inst.error as { code?: string })?.code); return; }
    const skinRoot = inst.value as unknown as { generation: number; index: number };
    const [px, py, pz] = skin.pos ?? [0, 0, 0];
    const s = skin.scale ?? 1;
    (world as never as { set: (e: unknown, c: unknown, d: unknown) => unknown }).set(
      skinRoot, TransformC, { posX: px, posY: py, posZ: pz, scaleX: s, scaleY: s, scaleZ: s, quatX: 0, quatY: 0, quatZ: 0, quatW: 1 },
    );
    const sceneInst = (world as never as { get: (e: unknown, c: unknown) => { ok: boolean; value?: { mapping: unknown[] } } }).get(skinRoot, SceneInstance);
    if (!sceneInst.ok || !sceneInst.value) return;
    let skinEnt: unknown = null;
    for (const ent of sceneInst.value.mapping) {
      if (!ent) continue;
      const r = (world as never as { get: (e: unknown, c: unknown) => { ok: boolean } }).get(ent, Skin);
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
    const clipHandle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('AnimationClip', clipRes.value);
    (world as never as { addComponent: (e: unknown, p: unknown) => unknown }).addComponent(skinEnt, {
      component: AnimationPlayer,
      data: {
        clips: [clipHandle, 0, 0, 0],
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
      const wAny = world as never as {
        get: (e: unknown, c: unknown) => { ok: boolean; value?: { times?: Float32Array; speeds?: Float32Array } };
        set: (e: unknown, c: unknown, d: unknown) => unknown;
      };
      const applyClip = (): void => {
        const c = getClipControl();
        const cur = wAny.get(skinEnt, AnimationPlayer);
        if (!cur.ok || !cur.value) return;
        const speeds = Float32Array.from(cur.value.speeds ?? new Float32Array([1, 1, 1, 1]));
        speeds[0] = c.speed;
        const data: Record<string, unknown> = { paused: c.paused, speeds };
        if (c.applyPhase) {
          const times = Float32Array.from(cur.value.times ?? new Float32Array(4));
          times[0] = Math.max(0, Math.min(1, c.phase)) * clipDurationSec;
          data.times = times;
        }
        wAny.set(skinEnt, AnimationPlayer, data);
      };
      onClipControl(applyClip);
      applyClip();
    } catch (cErr) {
      console.warn('[editor] clip scrubber wiring failed:', (cErr as Error).message ?? cErr);
    }

    try {
      const { onViewRequest } = await import('@forgeax/editor-core');
      const { normalizeSkinTransform } = await import('./engine/preview-skin');
      onViewRequest((cmd) => {
        try {
          if (cmd === 'resetCamera') { viewport.resetCamera(); return; }
          if (cmd === 'recenter') {
            const ok = normalizeSkinTransform(world as never, { skinEntity: skinEnt, skinRoot, targetHeight: 1.9 });
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
