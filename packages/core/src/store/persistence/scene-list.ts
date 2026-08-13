// store/persistence/scene-list — the multi-scene (level) management cluster: the
// per-game scene manifest discovery (initSceneList), the in-place scene switch
// (doSwitchSceneFile), the read getters/hooks, and the sceneList change-listener
// registry. The UE "level asset" model: a window edits exactly ONE scene at a
// time (`ctx.currentSceneFile`), switchable live via the SceneSwitcher UI.
//
// M2 (w7): a `createSceneList(deps)` DI factory. Its state edge is deps.ctx (the
// manifest + current-file live on the shared handle); its side-effect edges — the
// network read (deps.fetchWithTimeout), the host path resolver, and the
// cross-cluster save/discard/load/replace operations (deps.savePendingScene /
// deps.clearPendingScene / loadDocFromDisk / loadDocFromStorage / replaceDoc,
// wired by the composition root from the disk-io + storage units) — all arrive
// THROUGH deps, so a headless
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
import type { SceneReadModel } from '../../io/scene-read-model';
import type { CommandOrigin } from '../../io/gateway-history';
import type { SceneSwitchDirtyPolicy } from '../../types';
import type { AssetIOFacade } from '../../io/asset-io-facade';
import { broadcastAssetsChanged } from '../assets-changed';

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
  /** Platform fetch used for the forge.json write boundary. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Host path resolver — game-relative name -> absolute /api path. */
  readonly resolveGamePath: (rel: string) => string;
  /** Asset/pack read-write gate used by scene deletion and its ref guard. */
  readonly assetIO: Pick<AssetIOFacade, 'readPack' | 'deleteSourceFile' | 'verifySourceFileAbsent'>;
  /** Persist the outgoing scene through the canonical Gateway save run. */
  readonly savePendingScene: (origin: CommandOrigin) => Promise<boolean>;
  /** Clear dirty without writing when the caller explicitly chooses discard. */
  readonly clearPendingScene: () => void;
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
  getSceneReadModel(): SceneReadModel;
  getLoadedSceneEntities(): number[];
  onSceneListChange(fn: () => void): () => void;
  /** Invalidate the read model after an owner performs an atomic rollback. */
  notifySceneListChanged(): void;
  setDefaultScene(sceneGuid: string, requestId: string): Promise<SetDefaultSceneEffect>;
  deleteScene(sceneGuid: string, requestId: string): Promise<DeleteSceneEffect>;
  useSceneList(): SceneFileEntry[];
  useSceneFile(): string | null;
  useSceneReadModel(): SceneReadModel;
  initSceneList(): Promise<void>;
  doSwitchSceneFile(id: string, dirtyPolicy?: SceneSwitchDirtyPolicy, origin?: CommandOrigin): Promise<boolean>;
  activateNewScene(entry: SceneFileEntry): void;
}

export type SetDefaultSceneEffect =
  | {
      ok: true;
      result: {
        requestId: string;
        sceneGuid: string;
        sceneId: string;
        previousSceneGuid: string | null;
        changed: boolean;
      };
    }
  | {
      ok: false;
      error: {
        code: 'scene-default-invalid' | 'scene-default-read-failed' | 'scene-default-write-failed' | 'scene-default-verify-failed';
        hint: string;
        current?: unknown;
        retryable?: boolean;
        recoveryActions?: readonly string[];
      };
    };

export interface SceneDeleteReference {
  readonly sceneId: string;
  readonly sceneGuid: string | null;
  readonly pack: string;
  readonly assetGuid: string;
  readonly assetKind: string;
}

export interface SceneDeleteImpact {
  readonly sceneId: string;
  readonly sceneGuid: string;
  readonly pack: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly referencedBy: readonly SceneDeleteReference[];
}

export type DeleteSceneEffect =
  | {
      ok: true;
      result: {
        requestId: string;
        sceneId: string;
        sceneGuid: string;
        pack: string;
        impact: SceneDeleteImpact;
        currentScene: { id: string; guid: string | null } | null;
        defaultScene: { id: string; guid: string | null } | null;
      };
    }
  | {
      ok: false;
      error: {
        code: 'scene-delete-invalid' | 'scene-delete-guarded' | 'scene-delete-read-failed' | 'scene-delete-write-failed' | 'scene-delete-verify-failed';
        hint: string;
        current?: unknown;
        retryable?: boolean;
        recoveryActions?: readonly string[];
      };
    };

export function createSceneList(deps: SceneListDeps): SceneList {
  const { ctx, gateway } = deps;
  const sceneListListeners = new Set<() => void>();
  let cachedReadModel: SceneReadModel | null = null;
  function emitSceneList(): void {
    cachedReadModel = null;
    for (const fn of sceneListListeners) fn();
  }
  function sceneFileStorageKey(): string { return `forgeax:editor:sceneFile:${ctx.currentSceneId}`; }

  function getSceneId(): string { return ctx.currentSceneId; }
  function getSceneFile(): string | null { return ctx.currentSceneFile; }
  function getSceneList(): SceneFileEntry[] { return ctx.sceneList; }
  function getSceneReadModel(): SceneReadModel {
    if (cachedReadModel !== null) return cachedReadModel;
    const currentEntry = ctx.sceneList.find((entry) => entry.id === ctx.currentSceneFile)
      ?? (ctx.currentSceneGuid === null
        ? undefined
        : ctx.sceneList.find((entry) => entry.guid === ctx.currentSceneGuid));
    const defaultEntry = ctx.defaultSceneGuid === null
      ? undefined
      : ctx.sceneList.find((entry) => entry.guid === ctx.defaultSceneGuid);
    const scenes = ctx.sceneList.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      pack: entry.pack,
      guid: entry.guid ?? null,
      isCurrent: currentEntry === entry,
      isDefault: entry.guid !== undefined && entry.guid === ctx.defaultSceneGuid,
    }));
    cachedReadModel = {
      gameId: ctx.currentSceneId === 'default' ? null : ctx.currentSceneId,
      currentScene: currentEntry === undefined
        ? null
        : { id: currentEntry.id, guid: currentEntry.guid ?? null },
      defaultScene: ctx.defaultSceneGuid === null
        ? null
        : { id: defaultEntry?.id ?? null, guid: ctx.defaultSceneGuid },
      scenes,
    };
    return cachedReadModel;
  }
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
  function useSceneReadModel(): SceneReadModel {
    return useSyncExternalStore(onSceneListChange, getSceneReadModel, getSceneReadModel);
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

  /** Persist the canonical project default by stable scene GUID. Preserve the
   * raw object because forge.json may carry fields outside the strict engine
   * project schema; publish the in-memory read model only after read-back. */
  async function setDefaultScene(sceneGuid: string, requestId: string): Promise<SetDefaultSceneEffect> {
    if (ctx.currentSceneId === 'default') {
      return {
        ok: false,
        error: {
          code: 'scene-default-invalid',
          hint: 'setDefaultScene requires an active game scene manifest, not the default legacy slot.',
          current: { requestId, sceneGuid },
          retryable: false,
          recoveryActions: ['editor.discover'],
        },
      };
    }
    const target = ctx.sceneList.find((entry) => entry.guid === sceneGuid);
    if (target?.guid === undefined) {
      return {
        ok: false,
        error: {
          code: 'scene-default-invalid',
          hint: `scene GUID "${sceneGuid}" is not present in the active scene manifest.`,
          current: { requestId, sceneGuid, sceneIds: ctx.sceneList.map((entry) => entry.id) },
          retryable: false,
          recoveryActions: ['editor.scene.discover'],
        },
      };
    }
    const path = forgeJsonPath();
    if (path === null) {
      return {
        ok: false,
        error: {
          code: 'scene-default-invalid',
          hint: 'The active game has no forge.json path for a default scene.',
          current: { requestId, sceneGuid },
          retryable: false,
          recoveryActions: ['editor.discover'],
        },
      };
    }

    const raw = await readRawForgeJson();
    if (raw === null) {
      return {
        ok: false,
        error: {
          code: 'scene-default-read-failed',
          hint: `Could not read ${FORGE_JSON} before setting the default scene.`,
          current: { requestId, sceneGuid, path, phase: 'read' },
          retryable: true,
          recoveryActions: ['operation.retry'],
        },
      };
    }
    const previousSceneGuid = typeof raw.defaultScene === 'string' ? raw.defaultScene : null;
    const next = { ...raw, defaultScene: sceneGuid };
    if (previousSceneGuid !== sceneGuid) {
      try {
        const response = await deps.fetch('/api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, content: JSON.stringify(next, null, 2) + '\n' }),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: 'scene-default-write-failed',
              hint: `Could not write ${FORGE_JSON} (HTTP ${response.status}).`,
              current: { requestId, sceneGuid, previousSceneGuid, path, phase: 'write' },
              retryable: true,
              recoveryActions: ['operation.retry'],
            },
          };
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'scene-default-write-failed',
            hint: `Could not write ${FORGE_JSON}: ${error instanceof Error ? error.message : String(error)}`,
            current: { requestId, sceneGuid, previousSceneGuid, path, phase: 'write' },
            retryable: true,
            recoveryActions: ['operation.retry'],
          },
        };
      }

      const verified = await readRawForgeJson();
      if (verified?.defaultScene !== sceneGuid) {
        return {
          ok: false,
          error: {
            code: 'scene-default-verify-failed',
            hint: `The ${FORGE_JSON} write did not read back the requested default scene GUID.`,
            current: { requestId, sceneGuid, previousSceneGuid, path, phase: 'verify', verifiedDefaultScene: verified?.defaultScene ?? null },
            retryable: true,
            recoveryActions: ['operation.retry', 'editor.scene.inspect'],
          },
        };
      }
    }

    ctx.defaultSceneGuid = sceneGuid;
    emitSceneList();
    return { ok: true, result: { requestId, sceneGuid, sceneId: target.id, previousSceneGuid, changed: previousSceneGuid !== sceneGuid } };
  }

  async function deleteScene(sceneGuid: string, requestId: string): Promise<DeleteSceneEffect> {
    if (ctx.currentSceneId === 'default') {
      return {
        ok: false,
        error: {
          code: 'scene-delete-invalid',
          hint: 'deleteScene requires an active game scene manifest, not the default legacy slot.',
          current: { requestId, sceneGuid },
          retryable: false,
          recoveryActions: ['editor.discover'],
        },
      };
    }
    const target = ctx.sceneList.find((entry) => entry.guid === sceneGuid);
    if (target?.guid === undefined) {
      return {
        ok: false,
        error: {
          code: 'scene-delete-invalid',
          hint: `scene GUID "${sceneGuid}" is not present in the active scene manifest.`,
          current: { requestId, sceneGuid, sceneIds: ctx.sceneList.map((entry) => entry.id) },
          retryable: false,
          recoveryActions: ['editor.scene.discover'],
        },
      };
    }

    const currentEntry = ctx.sceneList.find((entry) => entry.id === ctx.currentSceneFile)
      ?? (ctx.currentSceneGuid === null ? undefined : ctx.sceneList.find((entry) => entry.guid === ctx.currentSceneGuid));
    const defaultEntry = ctx.defaultSceneGuid === null
      ? undefined
      : ctx.sceneList.find((entry) => entry.guid === ctx.defaultSceneGuid);
    const baseImpact: SceneDeleteImpact = {
      sceneId: target.id,
      sceneGuid,
      pack: target.pack,
      isCurrent: currentEntry === target,
      isDefault: defaultEntry === target,
      referencedBy: [],
    };
    if (baseImpact.isCurrent || baseImpact.isDefault) {
      const reason = baseImpact.isCurrent && baseImpact.isDefault
        ? 'current and default'
        : baseImpact.isCurrent ? 'current' : 'default';
      return {
        ok: false,
        error: {
          code: 'scene-delete-guarded',
          hint: `Scene "${target.name ?? target.id}" cannot be deleted because it is the ${reason} scene.`,
          current: { requestId, impact: baseImpact },
          retryable: false,
          recoveryActions: baseImpact.isCurrent ? ['scene.switch', 'scene.delete.retry'] : ['scene.set-default', 'scene.delete.retry'],
        },
      };
    }

    let targetPack: Awaited<ReturnType<SceneListDeps['assetIO']['readPack']>>;
    try {
      targetPack = await deps.assetIO.readPack(deps.resolveGamePath(target.pack));
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'scene-delete-read-failed',
          hint: `Could not read scene pack "${target.pack}" before deletion: ${error instanceof Error ? error.message : String(error)}`,
          current: { requestId, impact: baseImpact, phase: 'read-target' },
          retryable: true,
          recoveryActions: ['operation.retry'],
        },
      };
    }
    if (targetPack === null || !targetPack.assets.some((asset) => asset.guid === sceneGuid && asset.kind === 'scene')) {
      return {
        ok: false,
        error: {
          code: 'scene-delete-read-failed',
          hint: `Scene pack "${target.pack}" no longer contains scene GUID "${sceneGuid}".`,
          current: { requestId, impact: baseImpact, phase: 'read-target' },
          retryable: false,
          recoveryActions: ['editor.scene.discover'],
        },
      };
    }

    const referencedBy: SceneDeleteReference[] = [];
    for (const entry of ctx.sceneList) {
      if (entry === target || entry.guid === undefined) continue;
      let pack: Awaited<ReturnType<SceneListDeps['assetIO']['readPack']>>;
      try {
        pack = await deps.assetIO.readPack(deps.resolveGamePath(entry.pack));
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'scene-delete-read-failed',
            hint: `Could not inspect scene references in "${entry.pack}": ${error instanceof Error ? error.message : String(error)}`,
            current: { requestId, impact: baseImpact, phase: 'read-references', referrerPack: entry.pack },
            retryable: true,
            recoveryActions: ['operation.retry'],
          },
        };
      }
      if (pack === null) {
        return {
          ok: false,
          error: {
            code: 'scene-delete-read-failed',
            hint: `Could not inspect scene references in "${entry.pack}".`,
            current: { requestId, impact: baseImpact, phase: 'read-references', referrerPack: entry.pack },
            retryable: true,
            recoveryActions: ['operation.retry'],
          },
        };
      }
      for (const asset of pack.assets) {
        if (asset.refs.includes(sceneGuid)) {
          referencedBy.push({
            sceneId: entry.id,
            sceneGuid: entry.guid,
            pack: entry.pack,
            assetGuid: asset.guid,
            assetKind: asset.kind,
          });
        }
      }
    }
    const impact: SceneDeleteImpact = { ...baseImpact, referencedBy };
    if (referencedBy.length > 0) {
      return {
        ok: false,
        error: {
          code: 'scene-delete-guarded',
          hint: `Scene "${target.name ?? target.id}" is referenced by ${referencedBy.length} scene asset${referencedBy.length === 1 ? '' : 's'} and cannot be deleted silently.`,
          current: { requestId, impact },
          retryable: false,
          recoveryActions: ['scene.reference.inspect', 'scene.delete.retry'],
        },
      };
    }

    const resolvedPath = deps.resolveGamePath(target.pack);
    const deleted = await deps.assetIO.deleteSourceFile(resolvedPath);
    if (!deleted.ok) {
      return {
        ok: false,
        error: {
          code: 'scene-delete-write-failed',
          hint: deleted.error.hint,
          current: { requestId, impact, phase: 'delete-file', path: resolvedPath },
          retryable: deleted.error.retryable ?? true,
          recoveryActions: deleted.error.recoveryActions ?? ['operation.retry'],
        },
      };
    }
    const verified = await deps.assetIO.verifySourceFileAbsent(resolvedPath);
    if (!verified.ok || !verified.absent) {
      return {
        ok: false,
        error: {
          code: 'scene-delete-verify-failed',
          hint: !verified.ok ? verified.error.hint : `Scene pack "${target.pack}" still exists after deletion.`,
          current: { requestId, impact, phase: 'verify-file', path: resolvedPath, absent: verified.ok ? verified.absent : null },
          retryable: true,
          recoveryActions: ['operation.retry', 'editor.scene.inspect'],
        },
      };
    }

    const listIndex = ctx.sceneList.indexOf(target);
    if (listIndex >= 0) ctx.sceneList.splice(listIndex, 1);
    emitSceneList();
    broadcastAssetsChanged('pack-changed', 'local-op');
    return {
      ok: true,
      result: {
        requestId,
        sceneId: target.id,
        sceneGuid,
        pack: target.pack,
        impact,
        currentScene: currentEntry === undefined ? null : { id: currentEntry.id, guid: currentEntry.guid ?? null },
        defaultScene: defaultEntry === undefined ? null : { id: defaultEntry.id, guid: defaultEntry.guid ?? null },
      },
    };
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
    ctx.defaultSceneGuid = null;
    const fj = await readForgeJson();
    ctx.defaultSceneGuid = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
    if (ctx.currentSceneId !== 'default') {
      // A2: scene discovery is kind-driven — scan all packs under the game dir and
      // filter by `kind === 'scene'`.
      const scenePacks = await findAllScenePacks(ctx.currentSceneId);
      // Assign atomically + dedupe by scene GUID. Concurrent init (Strict Mode /
      // remount) or a tree walk that returns the same pack under two path spellings
      // must not leave duplicate GUIDs — Launcher keys rows by guid.
      const next: SceneFileEntry[] = [];
      const seenGuid = new Set<string>();
      for (const { pack, guid } of scenePacks.sort((a, b) => a.pack.localeCompare(b.pack))) {
        if (seenGuid.has(guid)) continue;
        seenGuid.add(guid);
        const stem = (pack.split('/').pop() ?? 'main').replace(/\.pack\.json$/, '') || 'main';
        next.push({ id: stem, name: stem, pack, guid });
      }
      ctx.sceneList = next;
      // Fallback: resolve forge.json `defaultScene` GUID when no scene packs found.
      if (ctx.sceneList.length === 0) {
        const defGuid = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
        if (defGuid) {
          const pack = await findScenePackByGuid(ctx.currentSceneId, defGuid);
          if (pack) {
            const stem = (pack.split('/').pop() ?? 'main').replace(/\.pack\.json$/, '') || 'main';
            ctx.sceneList.push({ id: stem, name: stem, pack, guid: defGuid });
          }
        }
      }
    }
    if (ctx.sceneList.length > 0) {
      // Binding priority — a window edits exactly ONE scene (UE-style):
      //   1. per-game localStorage — what this game last had open
      //   2. forge.json defaultScene GUID — the game's canonical scene
      //   3. (NOTHING) — no alphabetical fallback
      let want: string | null = null;
      try { want = localStorage.getItem(sceneFileStorageKey()); } catch { /* unavailable */ }
      const def = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
      // forge.json.defaultScene is a scene GUID. The completed manifest scan
      // above already records the pack that DECLARES that GUID, so resolve the
      // binding from that in-memory manifest instead of issuing a second
      // network scan. Besides removing redundant I/O, this closes a reopen
      // race where the second read could fail after discovery had succeeded and
      // incorrectly leave an otherwise authoritative default scene unbound.
      const defId = def
        ? (ctx.sceneList.find((s) => s.guid === def)?.id ?? null)
        : null;
      // NO alphabetical `firstScene` fallback (#98): binding must come from an
      // EXPLICIT, authoritative signal (per-game localStorage / defaultScene GUID).
      // `kind:"scene"` packs are discovered by kind alone — with no marker
      // separating an authored MAIN scene from a runtime PREFAB (e.g. shoot-opt's
      // enemy ships under assets/enemies/*.pack.json, instantiated via
      // assets.instantiate). Auto-binding the alphabetically-first pack loaded an
      // enemy prefab AS the editable scene, and the first dirty-flush then
      // serialized the live world back over that prefab file, corrupting it. When
      // nothing binds, stay null (legacy/seed path) and tell the author how to
      // pick a scene.
      ctx.currentSceneFile =
        (want && ctx.sceneList.some((s) => s.id === want)) ? want
        : defId ? defId
        : null;
      if (ctx.currentSceneFile === null) {
        console.warn(
          `[editor-core] ${ctx.sceneList.length} scene pack(s) found but none bound for edit: `
          + `set forge.json "defaultScene" to a scene GUID, or open a scene from the Assets panel. `
          + `Not auto-opening one — an unmarked pack may be a runtime prefab, `
          + `and editing+saving it would overwrite the authored asset.`,
        );
      }
    }
    emitSceneList();
  }

  /** Open another scene/asset pack IN THIS WINDOW: apply an explicit dirty
   *  policy, persist the selection in localStorage, and switch in-place
   *  (no location.reload — reloading recreates the WebGPU device, wedging
   *  WKWebView's GPU process). No URL round-trip: the binding lives in
   *  localStorage and the in-memory ctx; on next boot, initSceneList reads
   *  localStorage to restore it. Falls back to a clean reload if in-place fails. */
  async function doSwitchSceneFile(
    id: string,
    dirtyPolicy?: SceneSwitchDirtyPolicy,
    origin: CommandOrigin = 'human',
  ): Promise<boolean> {
    if (id === ctx.currentSceneFile) return true;
    if (!ctx.sceneList.some((s) => s.id === id)) return false;
    if (ctx.isDirty) {
      if (dirtyPolicy === 'save') {
        if (!(await deps.savePendingScene(origin))) return false;
      } else if (dirtyPolicy === 'discard') {
        deps.clearPendingScene();
      } else {
        return false;
      }
    }
    const previousSceneFile = ctx.currentSceneFile;
    const previousSceneGuid = ctx.currentSceneGuid;
    const previousSceneEntities = ctx.currentSceneEntities.slice();
    const previousInlineAssetFloor = ctx.loadedInlineAssetFloor;
    const previousInlineAssets = ctx.loadedInlineAssets;
    const previousEntityFloor = ctx.loadedEntityFloor;
    try { localStorage.setItem(sceneFileStorageKey(), id); } catch { /* unavailable */ }
    try {
      ctx.currentSceneFile = id;
      // Internal call → the impl, not the dispatching wrapper (no nested dispatch).
      const loadedFromDisk = await deps.loadDocFromDisk();
      const loaded = loadedFromDisk || deps.loadDocFromStorage();
      if (!loaded) {
        // `loadSceneByGuid` resolves bytes before tearing down the old authored
        // tree, so a failed load can safely restore the previous identity and
        // let the Gateway publish a terminal failure instead of a false success.
        ctx.currentSceneFile = previousSceneFile;
        ctx.currentSceneGuid = previousSceneGuid;
        ctx.currentSceneEntities = previousSceneEntities;
        ctx.loadedInlineAssetFloor = previousInlineAssetFloor;
        ctx.loadedInlineAssets = previousInlineAssets;
        ctx.loadedEntityFloor = previousEntityFloor;
        try {
          if (previousSceneFile === null) localStorage.removeItem(sceneFileStorageKey());
          else localStorage.setItem(sceneFileStorageKey(), previousSceneFile);
        } catch { /* unavailable */ }
        emitSceneList();
        return false;
      }
      // loadDocFromDisk/Storage set gateway.doc DIRECTLY and notify React doc
      // listeners, but NOT the gateway.subscribe listeners the viewport uses to
      // (re)build the RENDERED scene — fire them via replaceDoc, which also clears
      // the previous scene's undo history (correct for a swap).
      deps.replaceDoc(gateway.doc);
      emitSceneList();
      return true;
    } catch (e) {
      console.warn('[sync] in-place scene switch failed — falling back to reload:', e);
      location.reload();
      return true;
    }
  }

  /** Publish a pack that was already validated, written, and instantiated. */
  function activateNewScene(entry: SceneFileEntry): void {
    ctx.sceneList.push(entry);
    ctx.currentSceneFile = entry.id;
    try { localStorage.setItem(sceneFileStorageKey(), entry.id); } catch { /* unavailable */ }
    emitSceneList();
  }

  // readGameProject is retained for the contract-typed forge.json path (AC-11);
  // reference it so the extraction keeps the symbol available without a caller yet.
  void readGameProject;

  return {
    getSceneId,
    getSceneFile,
    getSceneList,
    getSceneReadModel,
    getLoadedSceneEntities,
    onSceneListChange,
    notifySceneListChanged: emitSceneList,
    setDefaultScene,
    deleteScene,
    useSceneList,
    useSceneFile,
    useSceneReadModel,
    initSceneList,
    doSwitchSceneFile,
    activateNewScene,
  };
}
