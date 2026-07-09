// store/persistence/scene-list — the multi-scene (level) management cluster: the
// per-game scene manifest discovery (initSceneList), the in-place scene switch
// (doSwitchSceneFile), the read getters/hooks, and the sceneList change-listener
// registry. The UE "level asset" model: a window edits exactly ONE scene at a
// time (`ctx.currentSceneFile`), switchable live via the SceneSwitcher UI.
//
// M2 (w7): a `createSceneList(deps)` DI factory. Its state edge is deps.ctx (the
// manifest + current-file live on the shared handle); its side-effect edges — the
// network read (deps.fetchWithTimeout), the host path resolver, and the
// cross-cluster save/load/replace operations (deps.flushPendingSaveBeacon /
// loadDocFromDisk / loadDocFromStorage / replaceDoc, wired by the composition
// root from the disk-io + storage units) — all arrive THROUGH deps, so a headless
// test drives init + switch with fakes (AC-02). Scene discovery via
// findAllScenePacks / findScenePackByGuid is a pure editor-assets call reached
// only on the non-default path; the default-slug guard short-circuits before any
// network, which the headless test exercises.
//
// D-8 (fan_in avoidance): lands under store/persistence/, NOT re-exported from the
// core index.ts top-level barrel — only scene-persistence.ts composes + forwards
// it (plan-strategy §2 D-8 / R-4).
//
// OOS-1 (zero behavior change): initSceneList / doSwitchSceneFile / getters are
// verbatim from scene-persistence.ts; the only edits re-point ctx / net /
// resolveGamePath / cross-cluster calls at deps. The in-place switch (no
// location.reload — reloading recreates the WebGPU device, wedging WKWebView's GPU
// process) and its reload fallback are preserved exactly.
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (headless-injectable, no singleton read) + AC-08 (core
//     max_file_loc drop) + AC-07; plan-strategy §7 M2 (scene-list/switch cluster
//     split) + §2 D-8 (subdir landing) + D-5 (scenes[] raw forge.json read).
//   (backward) extracted from store/scene-persistence.ts (this loop's target),
//     itself split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose.
import { useSyncExternalStore } from 'react';
import { loadGameProject, FORGE_JSON, type GameProject } from '@forgeax/engine-project';
import { findScenePackByGuid, findAllScenePacks } from '../../assets/assets';
import type { ScenePersistenceContext, SceneFileEntry } from '../scene-persistence';
import type { PersistenceGateway } from './disk-io';

/** All createSceneList needs, declared explicitly (Pipeline Isolation). The
 *  cross-cluster save/load/replace ops are wired by the composition root from the
 *  disk-io + storage units, so scene-list never imports them directly (keeps the
 *  DAG one-directional: scene-list depends on disk-io/storage, never the reverse). */
export interface SceneListDeps {
  readonly ctx: ScenePersistenceContext;
  /** The gateway (live doc for the in-place switch's replaceDoc target). */
  readonly gateway: PersistenceGateway;
  /** Timeout-guarded fetch for the forge.json read (io/net.ts). Injected so a
   *  headless test drives discovery without a server. */
  readonly fetchWithTimeout: (url: string, ms?: number) => Promise<Response>;
  /** Host path resolver — game-relative name -> absolute /api path. */
  readonly resolveGamePath: (rel: string) => string;
  /** Flush the outgoing scene's pending save before a switch (disk-io unit). */
  readonly flushPendingSaveBeacon: () => void;
  /** Load the active scene from disk — the impl, not the dispatch wrapper (no
   *  nested dispatch during an in-place switch) (disk-io unit). */
  readonly loadDocFromDisk: () => Promise<boolean>;
  /** The retired localStorage doc mirror (storage unit) — always false. */
  readonly loadDocFromStorage: () => boolean;
  /** Replace the whole authoring doc after a switch (disk-io unit). */
  readonly replaceDoc: (doc: import('../../types').EditSession) => void;
}

/** The multi-scene management surface. */
export interface SceneList {
  getSceneId(): string;
  getSceneFile(): string | null;
  getSceneList(): SceneFileEntry[];
  getLoadedSceneEntities(): number[];
  onSceneListChange(fn: () => void): () => void;
  useSceneList(): SceneFileEntry[];
  useSceneFile(): string | null;
  initSceneList(): Promise<void>;
  doSwitchSceneFile(id: string): Promise<boolean>;
}

export function createSceneList(deps: SceneListDeps): SceneList {
  const { ctx, gateway } = deps;
  const sceneListListeners = new Set<() => void>();
  function emitSceneList(): void { for (const fn of sceneListListeners) fn(); }
  function sceneFileStorageKey(): string { return `forgeax:editor:sceneFile:${ctx.currentSceneId}`; }

  function getSceneId(): string { return ctx.currentSceneId; }
  function getSceneFile(): string | null { return ctx.currentSceneFile; }
  function getSceneList(): SceneFileEntry[] { return ctx.sceneList; }
  function getLoadedSceneEntities(): number[] { return ctx.currentSceneEntities.slice(); }
  function onSceneListChange(fn: () => void): () => void {
    sceneListListeners.add(fn);
    return () => sceneListListeners.delete(fn);
  }
  function useSceneList(): SceneFileEntry[] {
    return useSyncExternalStore(onSceneListChange, getSceneList, getSceneList);
  }
  function useSceneFile(): string | null {
    return useSyncExternalStore(onSceneListChange, getSceneFile, getSceneFile);
  }

  function forgeJsonPath(): string | null {
    return ctx.currentSceneId === 'default' ? null : deps.resolveGamePath(FORGE_JSON);
  }

  /** Read forge.json via the authoritative loadGameProject loader (AC-11). Returns
   *  typed GameProject for contract fields; null if missing/invalid. Kept for the
   *  contract-typed path even though initSceneList currently reads raw scenes[]. */
  async function readGameProject(): Promise<GameProject | null> {
    const p = forgeJsonPath();
    if (!p) return null;
    try {
      const r = await deps.fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { content?: string };
      if (!j.content) return null;
      const content = j.content;
      const result = await loadGameProject(async (_path: string) => content);
      if (!result.ok) {
        console.warn('[editor-core] loadGameProject failed:', result.error.code, result.error.hint);
        return null;
      }
      return result.value;
    } catch { return null; }
  }

  /** Read raw forge.json content as Record for editor-local scenes[] access (D-5).
   *  Preserved so initSceneList can read scenes[] without strict loader rejection. */
  async function readRawForgeJson(): Promise<Record<string, unknown> | null> {
    const p = forgeJsonPath();
    if (!p) return null;
    try {
      const r = await deps.fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { content?: string };
      if (!j.content) return null;
      const parsed = JSON.parse(j.content);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }

  async function readForgeJson(): Promise<Record<string, unknown> | null> {
    // Legacy alias — delegates to the raw reader for scenes[] access (D-5).
    return readRawForgeJson();
  }

  /** Discover the game's scene manifest. Must run AFTER setSceneId and BEFORE the
   *  first loadDocFromDisk. Games without any `kind:'scene'` packs or defaultScene
   *  GUID fall back to legacy single-scene mode. */
  async function initSceneList(): Promise<void> {
    ctx.currentSceneFile = null;
    ctx.sceneList = [];
    const fj = await readForgeJson();
    if (ctx.currentSceneId !== 'default') {
      // A2: scene discovery is kind-driven — scan all packs under the game dir and
      // filter by `kind === 'scene'`.
      const scenePacks = await findAllScenePacks(ctx.currentSceneId);
      for (const { pack } of scenePacks.sort((a, b) => a.pack.localeCompare(b.pack))) {
        const stem = (pack.split('/').pop() ?? 'main').replace(/\.pack\.json$/, '') || 'main';
        ctx.sceneList.push({ id: stem, name: stem, pack });
      }
      // Fallback: resolve forge.json `defaultScene` GUID when no scene packs found.
      if (ctx.sceneList.length === 0) {
        const defGuid = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
        if (defGuid) {
          const pack = await findScenePackByGuid(ctx.currentSceneId, defGuid);
          if (pack) {
            const stem = (pack.split('/').pop() ?? 'main').replace(/\.pack\.json$/, '') || 'main';
            ctx.sceneList.push({ id: stem, name: stem, pack });
          }
        }
      }
    }
    if (ctx.sceneList.length > 0) {
      // Binding priority — a window edits exactly ONE scene (UE-style):
      //   1. `?sceneFile=<id>` in the URL — the window's own hard binding
      //   2. per-game localStorage — what this game last had open
      //   3. forge.json defaultScene GUID → (NOTHING) — no alphabetical fallback
      let urlWant: string | null = null;
      try { urlWant = new URLSearchParams(location.search).get('sceneFile'); } catch { /* non-browser */ }
      let want: string | null = null;
      try { want = localStorage.getItem(sceneFileStorageKey()); } catch { /* unavailable */ }
      const def = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
      // forge.json.defaultScene is a scene GUID; resolve it to the pack that
      // DECLARES that scene asset and prefer that entry, so ✎ Edit opens the SAME
      // scene ▶ Play boots (not merely the alphabetically-first level).
      const defPack = def ? await findScenePackByGuid(ctx.currentSceneId, def) : null;
      const defId = defPack
        ? (ctx.sceneList.find((s) => s.pack === defPack)?.id ?? null)
        : null;
      // NO alphabetical `firstScene` fallback (#98): binding must come from an
      // EXPLICIT, authoritative signal (URL ?sceneFile= / per-game localStorage /
      // defaultScene GUID). `kind:"scene"` packs are discovered by kind alone —
      // with no marker separating an authored MAIN scene from a runtime PREFAB
      // (e.g. shoot-opt's enemy ships under assets/enemies/*.pack.json,
      // instantiated via assets.instantiate). Auto-binding the alphabetically-first
      // pack loaded an enemy prefab AS the editable scene, and the first
      // dirty-flush then serialized the live world back over that prefab file,
      // corrupting it. When nothing binds, stay null (legacy/seed path) and tell
      // the author how to pick a scene.
      ctx.currentSceneFile =
        (urlWant && ctx.sceneList.some((s) => s.id === urlWant)) ? urlWant
        : (want && ctx.sceneList.some((s) => s.id === want)) ? want
        : defId ? defId
        : null;
      if (ctx.currentSceneFile === null) {
        console.warn(
          `[editor-core] ${ctx.sceneList.length} scene pack(s) found but none bound for edit: `
          + `set forge.json "defaultScene" to a scene GUID, or open a scene from the Assets panel `
          + `(?sceneFile=<id>). Not auto-opening one — an unmarked pack may be a runtime prefab, `
          + `and editing+saving it would overwrite the authored asset.`,
        );
      }
    }
    emitSceneList();
  }

  /** Open another scene/asset pack IN THIS WINDOW: flush the outgoing scene's
   *  pending save, persist the selection, and switch in-place (no location.reload
   *  — reloading recreates the WebGPU device, wedging WKWebView's GPU process).
   *  Falls back to a full reload if the in-place path throws. */
  async function doSwitchSceneFile(id: string): Promise<boolean> {
    if (id === ctx.currentSceneFile) return true;
    if (!ctx.sceneList.some((s) => s.id === id)) return false;
    deps.flushPendingSaveBeacon();
    try { localStorage.setItem(sceneFileStorageKey(), id); } catch { /* unavailable */ }
    try {
      ctx.currentSceneFile = id;
      const u = new URL(location.href);
      u.searchParams.set('sceneFile', id);
      try { history.replaceState(history.state, '', u.toString()); } catch { /* SSR/old */ }
      // Internal call → the impl, not the dispatching wrapper (no nested dispatch).
      const ok = await deps.loadDocFromDisk();
      if (!ok) deps.loadDocFromStorage();
      // loadDocFromDisk/Storage set gateway.doc DIRECTLY and notify React doc
      // listeners, but NOT the gateway.subscribe listeners the viewport uses to
      // (re)build the RENDERED scene — fire them via replaceDoc, which also clears
      // the previous scene's undo history (correct for a swap).
      deps.replaceDoc(gateway.doc);
      return true;
    } catch (e) {
      console.warn('[sync] in-place scene switch failed — falling back to reload:', e);
      const u = new URL(location.href);
      u.searchParams.set('sceneFile', id);
      location.assign(u.toString());
      return true;
    }
  }

  // readGameProject is retained for the contract-typed forge.json path (AC-11);
  // reference it so the extraction keeps the symbol available without a caller yet.
  void readGameProject;

  return {
    getSceneId,
    getSceneFile,
    getSceneList,
    getLoadedSceneEntities,
    onSceneListChange,
    useSceneList,
    useSceneFile,
    initSceneList,
    doSwitchSceneFile,
  };
}
