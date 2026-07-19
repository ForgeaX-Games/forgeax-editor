// store/scene-persistence — the COMPOSITION ROOT for the game's authored-scene
// persistence. It owns the ONE mutable state handle (ScenePersistenceContext),
// wires the four persistence DI units, holds the async session-op capture-promise
// seam + the eval-time dirty subscription, and re-exports the composed surface so
// the store.ts barrel + disk-watch consumers stay unchanged.
//
// State: all mutable persistence state lives on ONE explicit handle,
// `ScenePersistenceContext` (see createScenePersistenceContext below), reached via
// the module-single `ctx` const — the 7 formerly scattered module-level `let`
// singletons (currentSceneId / currentSceneFile / sceneList / currentSceneGuid /
// currentSceneEntities / asyncOpResult / isDirty) are its fields. A reader holds one
// concept ("the persistence context"), not seven globals (charter F1 / AC-01: no
// module-level mutable singleton for persistence state).
//
// M2 DI decomposition (w6/w7): the four responsibility clusters are extracted
// into `create<Thing>(deps)` factories under ./persistence/ (run-lifecycle form):
//   - disk-io.ts     — high side-effect: disk load/save, world<->pack, scene-load,
//                      save beacon (createDiskIo).
//   - scene-list.ts  — multi-scene manifest discovery + in-place switch
//                      (createSceneList).
//   - play-config.ts — launcher <game>/play-config.json read/write
//                      (createPlayConfig) — the clean fetch-injection proof.
//   - storage.ts     — localStorage doc-key / hidden sidecar / retired mirror
//                      (createStorage).
// This root builds ONE of each with the real gateway / fetch / fetchWithTimeout
// / resolveGamePath and re-exports their surfaces, so a headless test drives each
// factory directly with fakes (AC-02, see __tests__/persistence-*.test.ts) while
// consumers see the same barrel. fetch moved from a module import to
// `deps.fetch` (D-2 / R-P1 structural injection); the transport body is the
// platform fetch (OOS-5). The async-op capture-promise seam
// (runAsyncOp / registerAsyncSessionOp / dispatchAsyncSessionOp, on
// ctx.asyncOpResult) stays HERE so the one dispatch slot lives in one place; the
// factories only produce the raw async impls this root registers + wraps.
//
// R3 (plan-strategy §4 / research F-4): the top-level `gateway.subscribe(...)` that
// sets `ctx.isDirty = true` is an EVAL-TIME side effect and MUST stay a top-level
// statement — NOT lazified — or dirty tracking breaks.
//
// D-6 internal seams (plan-strategy §2, @internal-store): disk-watch depends on
// scene-persistence file-private symbols. worldToPack / scenePath /
// loadSceneByGuid (the composed diskIo's functions, re-exported verbatim) + the
// `ctx` handle are exported for disk-watch to READ ctx.currentSceneGuid /
// ctx.isDirty; disk-watch WRITES them through the cohesive ctx.setCurrentSceneGuid
// / ctx.setDirty methods on that SAME live handle. These seams DO NOT enter the
// store.ts facade or the barrel.
//
// D-8 (fan_in avoidance): the extracted DI units live under store/persistence/ and
// are NOT re-exported from core's index.ts top-level barrel — only this root
// (already in the store barrel) forwards them, so index.ts fan_in (42) does not
// rebound (plan-strategy §2 D-8 / R-4).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-01 (7 singletons -> one explicit context, grep 0) + AC-02
//     (headless-injectable DI units) + AC-08 (core max_file_loc drop) + AC-07
//     (bidirectional anchors); plan-strategy §2 D-2 (ScenePersistenceContext) + D-3
//     (create<Thing>(deps), fetch via deps) + D-6 (internal seams) + D-8 (subdir
//     landing) + §8 naming (<Thing>Context / create<Thing> / <Thing>Deps).
//   (backward) split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose (store.ts
//     1344 -> 14 files; scene-persistence.ts 1032 = the debt this loop retires;
//     git-log-verified creation commit 1ceb6b3 / release snapshot 96364b2).
//   plan-strategy §2 D-7: buildHiddenKey / clearDocStorage are dead exports (†)
//     kept verbatim; stripEditorHiddenMarker is test-consumed.
//   research F-4 / R3: gateway.subscribe kept top-level.
//   requirements AC-09: pure structural migration — every read/write is
//     behaviorally identical (OOS-1 zero behavior change).
import { gateway } from './gateway';
import { sessionAppliers } from '../io/appliers';
import { notifyDocChanged } from './doc-version';
import { createEditSession } from '../session/document';
import { registerActiveScenePackResolver } from '../session/pack-ops';
import { stableGuid } from '../scene/scene-pack';
import { fetchWithTimeout } from '../io/net';
import { resolveGamePath } from '../util/path-resolver';
import { createDiskIo } from './persistence/disk-io';
import { createSceneList } from './persistence/scene-list';
import { createPlayConfig } from './persistence/play-config';
import { createStorage } from './persistence/storage';
import type { EditorOp } from '../types';
import type { EntityHandle } from '../scene/scene-types';

// ── ScenePersistenceContext: the one mutable persistence-state handle (D-2) ────
// The 7 formerly module-level `let` singletons collapse into ONE object with
// cohesive read/write methods for the cross-module (disk-watch) write points.
// A single `const ctx = createScenePersistenceContext()` is the module's whole
// mutable persistence surface — every unit reads/writes `ctx.<field>` via deps.ctx.
// disk-watch imports the SAME `ctx` and calls ctx.setDirty / ctx.setCurrentSceneGuid,
// so its two reverse-writes land on the shared live handle (not a snapshot) —
// the semantic equal of the deleted _setDirty / _setCurrentSceneGuid setters
// (plan-strategy §2 D-2 / D-6; §8 naming: <Thing>Context; AC-01).
export interface ScenePersistenceContext {
  /** Active game slug from `?scene=<slug>` ('default' before setSceneId at boot). */
  currentSceneId: string;
  /** The one level this window edits (UE "level asset" model); null = legacy
   *  single top-level scene.pack.json mode. */
  currentSceneFile: string | null;
  /** Discovered scene manifest for the active game (multi-scene / level list). */
  sceneList: SceneFileEntry[];
  /** The active scene asset's STABLE GUID, captured from disk on load. A scene's
   *  GUID is its identity (forge.json defaultScene / sibling level packs reference
   *  it, Play's catalog resolves it) and must survive edits — moving an entity
   *  must not mint a new GUID. Saving re-uses this so the pack on disk keeps the
   *  GUID forge.json points at. Reset on every load attempt; null until known.
   *  @internal-store — disk-watch READS this to content-compare a self-save echo
   *  and WRITES it via setCurrentSceneGuid (D-6 seam). */
  currentSceneGuid: string | null;
  /** Top-level entity handles of the currently loaded scene. Opening a scene
   *  materialises it FLAT (loadSceneByGuid -> reg.instantiateFlat): no synthetic
   *  wrapper root, so there is no single handle to track — we hold the set of the
   *  scene's top-level entities instead, so a disk-watch reload can despawn them
   *  before re-instantiating (avoids a double-spawn). Empty when no scene is
   *  loaded (seed / fresh workspace). */
  currentSceneEntities: EntityHandle[];
  /** Module-scoped slot carrying an async session-op's in-flight promise from the
   *  applier back to the public setter within one synchronous dispatch (M2 D-1). */
  asyncOpResult: Promise<boolean> | null;
  /** True while the in-memory scene has unsaved edits (dirty indicator + the
   *  disk-watch "don't clobber my edits" guard). @internal-store — disk-watch
   *  READS this and WRITES it via setDirty after an external reload (D-6 seam). */
  isDirty: boolean;
  /** Inline-asset floor captured from the on-disk pack at LOAD time. The save
   *  guard (both the awaited doSaveDocToDisk path and the sync unload-time beacon)
   *  refuses to write a pack with FEWER inline (material/texture/…) assets than the
   *  scene was loaded with — defeating the data-loss loop where a strip lowers the
   *  on-disk count so a naive count-vs-disk guard lets 0 >= 0 pass forever (and the
   *  beacon path had no guard at all). Anchored to the LOAD baseline (not the
   *  current on-disk file); the beacon reads it synchronously (no disk await during
   *  pagehide). null = no scene loaded yet (guard is a no-op, e.g. first-ever save). */
  loadedInlineAssetFloor: number | null;
  /** Full inline asset entry bodies captured from the on-disk pack at LOAD time.
   *  worldToPack merges any of these that are missing from the live refs[] walk
   *  (orphan materials no longer attached to any entity) so a save cannot drop
   *  authored pack data the safety floor also protects. null = no scene loaded. */
  loadedInlineAssets: LoadedInlineSnapshot[] | null;
  /** Entity count from the on-disk scene pack at load time. Used by the
   *  entity-drop safety net to refuse saves that would overwrite a scene with
   *  entities using an empty-entity pack (e.g. after a failed reload). null = no
   *  scene loaded yet (first-time saves proceed). */
  loadedEntityFloor: number | null;
  /** Cohesive dirty write — disk-watch's reverse-write seam (== deleted _setDirty). */
  setDirty(v: boolean): void;
  /** Cohesive scene-GUID write — disk-watch's reverse-write seam
   *  (== deleted _setCurrentSceneGuid). */
  setCurrentSceneGuid(guid: string): void;
}

/** One non-scene asset entry snapshotted from a pack at load (orphan-merge input). */
export interface LoadedInlineSnapshot {
  guid: string;
  kind: string;
  payload: unknown;
  refs: unknown[];
}

/** Build the single persistence-state handle. Field initial values are the exact
 *  historical `let` initializers (OOS-1 zero behavior change). */
export function createScenePersistenceContext(): ScenePersistenceContext {
  return {
    currentSceneId: 'default',
    currentSceneFile: null,
    sceneList: [],
    currentSceneGuid: null,
    currentSceneEntities: [],
    asyncOpResult: null,
    isDirty: false,
    loadedInlineAssetFloor: null,
    loadedInlineAssets: null,
    loadedEntityFloor: null,
    setDirty(v: boolean): void { this.isDirty = v; },
    setCurrentSceneGuid(guid: string): void { this.currentSceneGuid = guid; },
  };
}

/** @internal-store — the module-single persistence context. Exported so disk-watch
 *  reaches the SAME live handle; NOT re-exported through the store.ts facade/barrel. */
export const ctx = createScenePersistenceContext();

/** A game's scene-manifest entry (one scene pack plus its stable asset identity). */
export interface SceneFileEntry { id: string; name?: string; pack: string; guid?: string }

// ── Compose the four persistence DI units (D-3) ───────────────────────────────
// ONE of each factory with the real gateway / fetch / fetchWithTimeout /
// resolveGamePath. The DAG is one-directional: disk-io + storage are leaves
// (state via ctx + injected net), scene-list depends on them (via wired deps),
// and this root wires + re-exports all four. disk-watch consumes worldToPack /
// scenePath / loadSceneByGuid off diskIo (re-exported below).
const diskIo = createDiskIo({
  ctx,
  gateway,
  fetch: (path, init) => fetch(path, init),
  fetchWithTimeout,
  resolveGamePath,
  notifyDocChanged,
  saveDocToDiskViaDispatch: () => { void saveDocToDisk(); },
});

const storage = createStorage({ ctx });

const playConfig = createPlayConfig({ ctx, fetch: (path, init) => fetch(path, init), resolveGamePath });

const sceneList = createSceneList({
  ctx,
  gateway,
  fetchWithTimeout,
  resolveGamePath,
  flushPendingSaveBeacon: () => diskIo.flushPendingSaveBeacon(),
  loadDocFromDisk: () => diskIo.doLoadDocFromDisk(),
  loadDocFromStorage: () => storage.loadDocFromStorage(),
  replaceDoc: (doc) => diskIo.replaceDoc(doc),
});

// ── Session applier: setSceneId (M2 D-1) ──────────────────────────────────────
// setSceneId body, registered into the session table. M3 t22 (S10 / AC-21/22):
// the write-side sugar was deleted — callers dispatch gateway.dispatch({ kind:
// 'setSceneId', id }) directly. Read-side (getSceneId) stays.
function applySetSceneId(op: EditorOp): { ok: true } {
  const v = ((op as { id: string | null | undefined }).id ?? '').trim();
  ctx.currentSceneId = v || 'default';
  return { ok: true };
}
sessionAppliers.set('setSceneId', applySetSceneId);

// ── scene-list / switch cluster surface (createSceneList) ──────────────────────
export const getSceneId = sceneList.getSceneId;
export const getLoadedSceneEntities = sceneList.getLoadedSceneEntities;
export const getSceneFile = sceneList.getSceneFile;
export const getSceneList = sceneList.getSceneList;
export const onSceneListChange = sceneList.onSceneListChange;
export const useSceneList = sceneList.useSceneList;
export const useSceneFile = sceneList.useSceneFile;
export const initSceneList = sceneList.initSceneList;

// Session op (M2 D-1): switchSceneFile carries an id payload, so its applier
// reads the id off the op before running the async impl (capture-promise seam).
sessionAppliers.set('switchSceneFile', (op) => {
  runAsyncOp(() => sceneList.doSwitchSceneFile((op as { id: string }).id));
  return { ok: true };
});
export function switchSceneFile(id: string): Promise<boolean> {
  return dispatchAsyncSessionOp({ kind: 'switchSceneFile', id });
}

// ── play-config cluster surface (createPlayConfig) ────────────────────────────
export type { PlayConfig } from './persistence/play-config';
export const readPlayConfig = playConfig.readPlayConfig;
export const writePlayConfig = playConfig.writePlayConfig;

// ── createSceneFile: a new level pack + navigate (root glue) ───────────────────
// Not a pure state-cluster op (it writes a new pack via fetch then navigates),
// so it stays wired at the root next to the async-op seam it dispatches through.
/** Create a new level under assets/scenes/<slug>.pack.json (empty, or duplicated
 *  from the current doc) and switch to it. NOTHING is written to forge.json. The
 *  display name is the file stem (`slug`), so the game's LEVELS[].id can match it
 *  1:1. */
async function doCreateSceneFile(id: string, duplicateCurrent: boolean): Promise<boolean> {
  if (ctx.currentSceneId === 'default') return false;
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || ctx.sceneList.some((s) => s.id === slug)) return false;
  const sourceDoc = duplicateCurrent ? gateway.doc : createEditSession();
  void sourceDoc; // reserved for a future duplicate-content path (historical signature parity)
  const newPath = resolveGamePath(`assets/scenes/${slug}.pack.json`);
  // A NEW level gets its own stable, path-derived GUID — never the source scene's
  // GUID and never an order-derived one (which would drift on the first edit).
  const newSceneGuid = stableGuid('scene|' + newPath);
  const newPack = { schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [{ guid: newSceneGuid, kind: 'scene', payload: { entities: [] }, refs: [] }] };
  const packContent = JSON.stringify(newPack, null, 2) + '\n';
  try {
    const w1 = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: newPath, content: packContent }),
    });
    if (!w1.ok) return false;
  } catch { return false; }
  // Persist + navigate this window into the new scene in-place — no full
  // page reload. Add the new pack to the sceneList so doSwitchSceneFile sees it.
  const newPackPath = `assets/scenes/${slug}.pack.json`;
  ctx.sceneList.push({ id: slug, name: slug, pack: newPackPath, guid: newSceneGuid });
  try { localStorage.setItem(`forgeax:editor:sceneFile:${ctx.currentSceneId}`, slug); } catch { /* unavailable */ }
  await sceneList.doSwitchSceneFile(slug);
  return true;
}
// Session op (M2 D-1): createSceneFile carries id + duplicateCurrent payload.
sessionAppliers.set('createSceneFile', (op) => {
  const o = op as { id: string; duplicateCurrent: boolean };
  runAsyncOp(() => doCreateSceneFile(o.id, o.duplicateCurrent));
  return { ok: true };
});
export function createSceneFile(id: string, duplicateCurrent: boolean): Promise<boolean> {
  return dispatchAsyncSessionOp({ kind: 'createSceneFile', id, duplicateCurrent });
}

// ── storage cluster surface (createStorage) ───────────────────────────────────
export const buildHiddenKey = storage.buildHiddenKey;
export const loadDocFromStorage = storage.loadDocFromStorage;
export const clearDocStorage = storage.clearDocStorage;

// ── High-side-effect surface: re-export the composed diskIo unit (D-3/D-6) ─────
// disk-watch imports worldToPack / scenePath / loadSceneByGuid + ctx from HERE;
// the store.ts barrel forwards flushPendingSaveBeacon / replaceDoc /
// instantiateSceneRefUnderWorld / stripEditorHiddenMarker / inlineAssetCount.
/** @internal-store — disk-watch READS this (D-6 seam). Not in facade/barrel. */
export const scenePath = diskIo.scenePath;
// Feed the active-scene-pack resolver seam so the createMaterial document applier
// (session/pack-ops) can default a new material into the active scene's real pack
// without a static import cycle (pack-ops <- ... <- scene-persistence). One-way:
// scene-persistence imports pack-ops (already, for its appliers), never the reverse.
registerActiveScenePackResolver(() => diskIo.scenePath());
/** @internal-store — disk-watch READS this to serialize for the echo compare. */
export const worldToPack = diskIo.worldToPack;
/** @internal-store — disk-watch CALLS this to reload on a genuine external edit. */
export const loadSceneByGuid = diskIo.loadSceneByGuid;
export const instantiateSceneRefUnderWorld = diskIo.instantiateSceneRefUnderWorld;
/** @internal-store — the bindAssetRef session applier CALLS this to resolve a
 *  catalogued asset GUID to a live shared<T> handle before writing it. */
export const resolveAssetRefToHandle = diskIo.resolveAssetRefToHandle;
export const flushPendingSaveBeacon = diskIo.flushPendingSaveBeacon;
export const replaceDoc = diskIo.replaceDoc;
export const stripEditorHiddenMarker = diskIo.stripEditorHiddenMarker;
export const inlineAssetCount = diskIo.inlineAssetCount;
// Pure load-floor strip guard (#101) — no deps, so re-exported straight from
// disk-io rather than composed onto the diskIo instance. store.ts forwards it.
export { wouldDropInlineAssets, wouldDropAllEntities, mergeLoadedInlineOrphans } from './persistence/disk-io';

// ── Disk load / save session ops (session-domain, ledger only, no undo) ────────
registerAsyncSessionOp('loadDocFromDisk', diskIo.doLoadDocFromDisk);
/** Load the game's authored scene from disk (session op). Internal callers
 *  (switchSceneFile) use diskIo.doLoadDocFromDisk directly to avoid a nested
 *  dispatch; this exported wrapper is the human/AI entry point (m2-w8). */
export function loadDocFromDisk(): Promise<boolean> {
  return dispatchAsyncSessionOp({ kind: 'loadDocFromDisk' });
}

registerAsyncSessionOp('saveDocToDisk', diskIo.doSaveDocToDisk);
export function saveDocToDisk(): Promise<boolean> {
  return dispatchAsyncSessionOp({ kind: 'saveDocToDisk' });
}

// ── Async session-op collection seam (M2 D-1, m2-w8) ──────────────────────────
// dispatch() is sync but save/load/switch/create are async. The applier runs the
// impl and stashes the in-flight promise; the public setter dispatches (ledger +
// AI trigger) then returns the stashed promise. The slot is ctx.asyncOpResult
// (ScenePersistenceContext) — one handle, no scattered `let`. This seam stays in
// the composition root so the one dispatch slot lives in one place.
/** Run an async op impl and stash its promise for the setter to return. Attaches
 *  a no-op rejection handler so a RAW dispatch (AI fire-and-forget / headless) does
 *  not surface an unhandled rejection; the setter's caller still awaits the same
 *  promise and sees the real result. */
function runAsyncOp(impl: () => Promise<boolean>): void {
  const pr = impl();
  pr.catch(() => {});
  ctx.asyncOpResult = pr;
}
function registerAsyncSessionOp(kind: string, impl: () => Promise<boolean>): void {
  sessionAppliers.set(kind, () => { runAsyncOp(impl); return { ok: true }; });
}
function dispatchAsyncSessionOp(op: EditorOp): Promise<boolean> {
  ctx.asyncOpResult = Promise.resolve(false);
  const r = gateway.dispatch(op);
  if (!r.ok) return Promise.resolve(false);
  return ctx.asyncOpResult ?? Promise.resolve(false);
}

// ── Dirty flag: the toolbar's save-indicator source ───────────────────────────
// Manual disk save (requirements-decisions #5; plan-strategy D-7). Every edit
// marks the in-memory scene DIRTY; the on-disk scene.pack.json is written ONLY
// when the user clicks Save (the UI calls saveDocToDisk), NOT on a debounce timer.
// `ctx.isDirty` is the dirty-indicator source the toolbar reads (via
// hasPendingDiskSave); it clears on a successful save / explicit cancel / beacon
// flush. R3: this top-level gateway.subscribe is an EVAL-TIME side effect and MUST
// stay top-level (do NOT lazify) or dirty tracking breaks.
gateway.subscribe(() => { ctx.isDirty = true; });

/** True while the in-memory scene has unsaved edits (drives the dirty indicator +
 *  the disk-watch "don't clobber my edits" guard). */
export function hasPendingDiskSave(): boolean {
  return ctx.isDirty;
}

/** Clear the dirty flag WITHOUT writing. Used after the editor seeds a default
 *  scene for a genuinely scene-less game: the bare seed must NOT be persisted. */
export function cancelPendingDiskSave(): void {
  ctx.isDirty = false;
}

// ── D-6 internal seams (M1 D-2): disk-watch's cross-module writes land on the
//    shared `ctx` handle via its cohesive ctx.setDirty / ctx.setCurrentSceneGuid
//    methods (see ScenePersistenceContext at the top of this file). ─────────────
