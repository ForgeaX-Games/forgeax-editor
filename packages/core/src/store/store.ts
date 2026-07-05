import { useSyncExternalStore } from 'react';
import { isScenePack, stableGuid } from '../scene/scene-pack';
// M5: import engine-native serialize APIs for worldToPack (replaces sessionToPack)
import { rootsToSceneAsset, serializeSceneAssetToPack } from '@forgeax/engine-runtime';
// M4: packToSession removed — scene-load now uses engine-native world.instantiateScene.
import { EditorBus } from '../io/bus';
import type { CommandOrigin, HistoryStep } from '../io/bus';
import { createEditSession } from '../session/document';
import { getInternals } from '../session/edit-session';
import type { EditorCommand, EntityId, EditSession } from '../types';
import {
  entExists,
  entName,
  entLegacyId,
  entComponents,
  entRootHandles,
  entMap,
  entSetNextId,
  entGetNextId,
} from './entity-state';
import type { AssetChatRef, MeshStatsWire } from '../io/cross-panel-types';
import { Name, Transform, ChildOf, Children, SceneInstance } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';

// Engine wire constant for an unspawned SceneInstance.mapping slot (gap left by
// a deleted entity). Kept as a local literal because engine-runtime does not
// re-export it and editor-core deliberately does not import from engine-ecs;
// the value is stable (@forgeax/engine-ecs entity-handle.ts ENTITY_NULL_RAW).
const ENTITY_NULL_RAW = 0xffffffff;
import { EditorHidden } from '../components/EditorHidden';
import { setClipControl, setClipControlForwarder, requestView, setViewRequestForwarder } from '../io/clip-control';
import { loadGameProject, FORGE_JSON, GameProjectError, type GameProject } from '@forgeax/engine-project';
import { getApiClient } from '../io/api-client';
import { findScenePackByGuid } from '../assets/assets';
import { fetchWithTimeout } from '../io/net';
import { resolveGamePath } from '../util/path-resolver';

// App-level singletons. The bus is the authoritative mutable path; selection is
// transient view state (NOT a command) — but selecting is exactly what turns a
// vague "this" into a concrete pointing handle for the AI (deixis).
//
// Ported (trimmed) from the unveil-studio prototype: Edit-only — the Play
// snapshot / runtime-systems half of the prototype store is dropped here because
// in forgeax the *engine itself* runs Play mode (see interface ▶ Play). The Edit
// surface keeps the authored doc static and projects it onto the forgeax world.
export const bus = new EditorBus(createEditSession());

// Selection is a list
// Selection is a list; the LAST element is the "primary" (drives single-target
// panels like Inspector). Multi-select feeds deixis (reference many).
let selectionList: EntityId[] = [];
const selectionListeners = new Set<() => void>();

// Cross-window selection sync via localStorage (works across Tauri WebviewWindow
// processes, where BroadcastChannel can't reach). Persisted per scene; other
// windows pick it up via a `storage` event (see initSync). Guarded so applying a
// remote selection doesn't echo back.
// Dev-only runaway-propagation// Dev-only runaway-propagation net: if selection emits storm within a short
// window it almost always means a cross-window echo loop regressed. Warns once
// per window so it's visible without re-instrumenting. No-op in production.
let _emitWindowStart = 0;
let _emitCount = 0;
let _emitWarned = false;
function emitSelection(): void {
  // editor-core is typechecked with plain tsc (Bun import.meta types, no
  // vite/client), so `import.meta.env` isn't on ImportMeta here — cast locally.
  // At runtime this module is Vite-bundled, where `import.meta.env.DEV` is real.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const now = Date.now();
    if (now - _emitWindowStart > 1000) { _emitWindowStart = now; _emitCount = 0; _emitWarned = false; }
    if (++_emitCount > 32 && !_emitWarned) {
      _emitWarned = true;
      // eslint-disable-next-line no-console
      console.warn(`[sel-sync] runaway selection propagation: ${_emitCount} emits within 1s — likely a cross-window echo loop (see docs/design/editor-cross-window-selection-sync-loop.md)`);
    }
  }
  for (const fn of selectionListeners) fn();
}

export function getSelection(): EntityId | null {
  return selectionList.length ? selectionList[selectionList.length - 1]! : null;
}
export function getSelectionList(): EntityId[] {
  return selectionList;
}
export function isSelected(id: EntityId): boolean {
  return selectionList.includes(id);
}

export function setSelection(id: EntityId | null): void {
  if (id === null) {
    if (selectionList.length === 0) return;
    selectionList = [];
  } else {
    if (selectionList.length === 1 && selectionList[0] === id) return;
    selectionList = [id];
  }
  emitSelection();
}

/** Shift/Ctrl-click semantics: toggle membership, keep last-clicked as primary. */
export function toggleSelection(id: EntityId): void {
  selectionList = selectionList.includes(id) ? selectionList.filter((x) => x !== id) : [...selectionList, id];
  emitSelection();
}

export function setSelectionMany(ids: EntityId[]): void {
  selectionList = [...ids];
  emitSelection();
}

function subscribeSelection(fn: () => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

/** Non-React selection subscription (the viewport gizmo follows the selection). */
export const onSelectionChange = subscribeSelection;

// ── gizmo mode (translate / rotate / scale) — shared by the toolbar + viewport ─
export type GizmoMode = 'translate' | 'rotate' | 'scale';
let gizmoMode: GizmoMode = 'translate';
const gizmoListeners = new Set<() => void>();
export function getGizmoMode(): GizmoMode { return gizmoMode; }
export function setGizmoMode(m: GizmoMode): void {
  if (m === gizmoMode) return;
  gizmoMode = m;
  for (const fn of gizmoListeners) fn();
}
export function onGizmoModeChange(fn: () => void): () => void {
  gizmoListeners.add(fn);
  return () => gizmoListeners.delete(fn);
}
export function useGizmoMode(): GizmoMode {
  return useSyncExternalStore(onGizmoModeChange, getGizmoMode, getGizmoMode);
}

export function useSelection(): EntityId | null {
  return useSyncExternalStore(subscribeSelection, getSelection, getSelection);
}
export function useSelectionList(): EntityId[] {
  return useSyncExternalStore(subscribeSelection, getSelectionList, getSelectionList);
}

// Frame-request signal: "center the viewport on the primary selection" pulse.
// In editor-runtime the forgeax camera consumes this (engine/sync.ts).
const frameListeners = new Set<() => void>();
export function requestFrame(): void {
  for (const fn of frameListeners) fn();
}
export function onFrameRequest(fn: () => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

// Rename-request signal: F2 (or any panel) asks the Hierarchy row for `id` to
// enter inline-rename mode, without that row being globally focusable.
const renameListeners = new Set<(id: EntityId) => void>();
export function requestRename(id: EntityId): void {
  for (const fn of renameListeners) fn(id);
}
export function onRenameRequest(fn: (id: EntityId) => void): () => void {
  renameListeners.add(fn);
  return () => renameListeners.delete(fn);
}

// Hover-highlight signal: a transient "the pointer is over a handle that refers
// to entity N" pulse. The viewport/engine sync rings that marker so a reference
// in text lights up its spatial counterpart.
let hoverId: EntityId | null = null;
const hoverListeners = new Set<() => void>();
export function setHoverEntity(id: EntityId | null): void {
  if (hoverId === id) return;
  hoverId = id;
  for (const fn of hoverListeners) fn();
}
export function getHoverEntity(): EntityId | null {
  return hoverId;
}
export function useHoverEntity(): EntityId | null {
  return useSyncExternalStore(
    (fn) => {
      hoverListeners.add(fn);
      return () => hoverListeners.delete(fn);
    },
    getHoverEntity,
    getHoverEntity,
  );
}

// Transient field-preview signal: while a viewport gizmo is being dragged it
// publishes the live scalar (keyed by a namespaced field id like
// 'Transform.rot.y') so the Inspector tracks it without committing a command.
let fieldPreview: { id: EntityId; key: string; value: number } | null = null;
const fieldListeners = new Set<() => void>();
export function setFieldPreview(id: EntityId | null, key?: string, value?: number): void {
  if (id === null || key === undefined) {
    if (fieldPreview === null) return;
    fieldPreview = null;
  } else {
    const v = value ?? 0;
    if (fieldPreview && fieldPreview.id === id && fieldPreview.key === key && fieldPreview.value === v) return;
    fieldPreview = { id, key, value: v };
  }
  for (const fn of fieldListeners) fn();
}
export function getFieldPreview(): { id: EntityId; key: string; value: number } | null {
  return fieldPreview;
}
export function useFieldPreview(): { id: EntityId; key: string; value: number } | null {
  return useSyncExternalStore(
    (fn) => {
      fieldListeners.add(fn);
      return () => fieldListeners.delete(fn);
    },
    getFieldPreview,
    getFieldPreview,
  );
}

// Reference-request signal: "pin entity N into the ForgeaX chat context". The
// chat panel lives in the parent interface shell (we are an iframe), so we post
// a deixis handle up via the VAG postMessage channel rather than owning ref
// state locally — exactly the "human points → AI gets a concrete handle" path.
export function requestRefEntity(id: EntityId): void {
  // M7 / AC-15: entity name + component keys read from world (SSOT) via
  // entity-state helpers; doc.entities dual-write mirror deleted.
  if (!entExists(bus.doc, id)) return;
  const handle = {
    kind: 'entity' as const,
    id,
    name: entName(bus.doc, id),
    components: Object.keys(entComponents(bus.doc, id)),
  };
  try {
    window.parent?.postMessage({ type: 'VAG_EDITOR_REF', payload: handle }, '*');
  } catch {
    /* cross-origin — non-fatal */
  }
}

/** Pin a COMPONENT from the inspector into the ForgeaX chat — kind='component'. */
export function requestRefComponent(entityId: EntityId, comp: string, value: unknown): void {
  // M7 / AC-15: entity name read from world (SSOT); doc.entities mirror deleted.
  if (!entExists(bus.doc, entityId)) return;
  try {
    window.parent?.postMessage(
      { type: 'VAG_EDITOR_REF', payload: { kind: 'component', entityId, entityName: entName(bus.doc, entityId), comp, value } },
      '*',
    );
  } catch { /* cross-origin — non-fatal */ }
}

/** Pin an ASSET (material/texture/mesh) into the ForgeaX chat as a deixis handle
 * — same channel as requestRefEntity, payload.kind === 'asset'. */
export function requestRefAsset(asset: { guid: string; kind: string; name: string; packPath?: string }): void {
  try {
    window.parent?.postMessage(
      { type: 'VAG_EDITOR_REF', payload: { kind: 'asset', guid: asset.guid, assetKind: asset.kind, name: asset.name, packPath: asset.packPath } },
      '*',
    );
  } catch {
    /* cross-origin — non-fatal */
  }
}

/** Batch-add asset/folder refs into the ForgeaX AI Chat context (M5).
 *  Carries full payload so the AI can reason about asset contents. */
export function requestAddAssetsToChat(refs: AssetChatRef[]): void {
  if (refs.length === 0) return;
  try {
    window.parent?.postMessage(
      { type: 'FORGEAX_ADD_ASSET_TO_CHAT', refs },
      '*',
    );
  } catch {
    /* cross-origin — non-fatal */
  }
}

// requestAddAssetToScene lives in ./spawn-asset-ref (co-located with
// spawnAssetRefToScene it wraps) so store does not depend on spawn-asset-ref —
// keeping the intra-core edge one-directional (spawn-asset-ref → store). It is
// still re-exported from the barrel, so consumers are unaffected.

// Re-render hook: bumps a version on every bus change so panels re-read doc.
let docVersion = 0;
const docListeners = new Set<() => void>();
bus.subscribe(() => {
  docVersion++;
  for (const fn of docListeners) fn();
});
function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}
export function useDocVersion(): number {
  return useSyncExternalStore(subscribeDoc, () => docVersion, () => docVersion);
}

export function dispatch(cmd: EditorCommand): void {
  bus.dispatch(cmd);
}

// ── Scene document persistence (autosave/restore), PER GAME/SCENE ─────────────
// Keyed by the scene slug from `?scene=<slug>` (the active game). Previously a
// single global key meant every game opened the SAME doc — so picking shoot-opt
// showed whatever was last edited (or the demo). Now each game has its own
// persisted editor scene; switching games loads that game's scene, and edits
// save back to it. `setSceneId` must run at boot BEFORE loadDocFromStorage.
const DOC_KEY_PREFIX = 'forgeax:editor:doc:v1';
let currentSceneId = 'default';
function docKey(id: string): string {
  return `${DOC_KEY_PREFIX}:${id}${currentSceneFile ? `:${currentSceneFile}` : ''}`;
}

// ── Editor-only hidden sidecar (plan-strategy §2 D-4) ─────────────────────────
// Hidden entities are editor view-layer state (OOS-6: no Enable/Disable component
// in the engine). They are NOT stored in SceneAsset pack payload — the pack schema's
// additionalProperties:false three-layer validation is the fail-fast guarantee
// (requirements AC-01, AC-10). Instead, hidden ids live in localStorage sidecar
// keys, following the same {sceneId}:{sceneFile} scoping convention as docKey().
const HIDDEN_SIDECAR_KEY_PREFIX = 'forgeax:editor:hidden:v1';
export function buildHiddenKey(sceneId?: string, sceneFile?: string | null): string {
  const sid = sceneId || currentSceneId;
  const sfile = sceneFile !== undefined ? sceneFile : currentSceneFile;
  return sfile
    ? `${HIDDEN_SIDECAR_KEY_PREFIX}:${sid}:${sfile}`
    : `${HIDDEN_SIDECAR_KEY_PREFIX}:${sid}`;
}

export function setSceneId(id: string | null | undefined): void {
  const v = (id ?? '').trim();
  currentSceneId = v || 'default';
}
export function getSceneId(): string { return currentSceneId; }

// ── Multi-scene (level) files per game ────────────────────────────────────────
// A game may declare multiple scene packs in its forge.json:
//   { "scenes": [{ "id": "level1", "name": "Level 1", "pack": "scenes/level1.pack.json" }, …],
//     "defaultScene": "level1" }
// The editor then edits ONE of them at a time (`currentSceneFile`), switchable
// live via the SceneSwitcher UI — the UE "level asset" model.
//
// Scene-as-asset is the canonical model: a scene is a GUID-keyed asset, and
// `forge.json.defaultScene` (a scene GUID) is the engine SSOT for which scene
// ▶ Play boots and ✎ Edit opens. The editor discovers it by resolving that GUID
// to the pack that declares it (findScenePackByGuid, scanning scenes/ + assets/
// + root). The engine's own templates/game-default is now this shape:
// `assets/scene.pack.json` + `forge.json.defaultScene`.
//
// The single top-level `scene.pack.json` mode (currentSceneFile stays null, every
// path/key reduces to the single-scene shape) is retained only as LEGACY COMPAT
// for older games that predate scene-as-asset and carry no defaultScene GUID — it
// is NOT the canonical shape. New/template games go through the defaultScene path.
export interface SceneFileEntry { id: string; name?: string; pack: string }
let currentSceneFile: string | null = null;
let sceneList: SceneFileEntry[] = [];
// The active scene asset's STABLE GUID, captured from disk on load. A scene's
// GUID is its identity (forge.json defaultScene / sibling level packs reference
// it, ▶ Play's catalog resolves it) and must survive edits — moving an entity
// must not mint a new GUID. Saving re-uses this so the pack on disk keeps the
// GUID forge.json points at. Reset on every load attempt; null until known.
let currentSceneGuid: string | null = null;
// The synthetic SceneInstance root handle of the currently loaded scene, kept so
// a disk-watch reload can despawnScene it before re-instantiating (avoids a
// double-spawn). null when no scene is loaded (seed / fresh workspace).
let currentSceneRoot: number | null = null;
/** The synthetic SceneInstance root of the scene loaded into the LIVE editor
 *  world (bus.doc.world) by loadSceneByGuid. run-lifecycle reads this to snapshot
 *  the scene for ▶ Play / ■ Stop (getSceneInstanceState/despawnScene must use a
 *  root in the SAME world the game runs in — NOT openProject's throwaway world).
 *  null when no scene is loaded (seed / fresh workspace). */
export function getLoadedSceneRoot(): number | null { return currentSceneRoot; }
const sceneListListeners = new Set<() => void>();
function emitSceneList(): void { for (const fn of sceneListListeners) fn(); }
function sceneFileStorageKey(): string { return `forgeax:editor:sceneFile:${currentSceneId}`; }

export function getSceneFile(): string | null { return currentSceneFile; }
export function getSceneList(): SceneFileEntry[] { return sceneList; }
export function onSceneListChange(fn: () => void): () => void {
  sceneListListeners.add(fn);
  return () => sceneListListeners.delete(fn);
}
export function useSceneList(): SceneFileEntry[] {
  return useSyncExternalStore(onSceneListChange, getSceneList, getSceneList);
}
export function useSceneFile(): string | null {
  return useSyncExternalStore(onSceneListChange, getSceneFile, getSceneFile);
}

function forgeJsonPath(): string | null {
  return currentSceneId === 'default' ? null : resolveGamePath(FORGE_JSON);
}

/**
 * Read forge.json via the authoritative loadGameProject loader (AC-11).
 * Returns typed GameProject for contract fields (id/name/defaultScene/physics/pointerLock/preview).
 * Returns null if forge.json missing or invalid — callers handle gracefully.
 */
async function readGameProject(): Promise<GameProject | null> {
  const p = forgeJsonPath();
  if (!p) return null;
  try {
    const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    const content = j.content;
    const result = await loadGameProject(async (_path: string) => content);
    if (!result.ok) {
      // forge.json exists but doesn't pass strict validation — log and return null.
      // Most common case: scenes[] present (editor-managed multi-scene, D-5).
      console.warn('[editor-core] loadGameProject failed:', result.error.code, result.error.hint);
      return null;
    }
    return result.value;
  } catch { return null; }
}

/**
 * Read raw forge.json content as Record for editor-local scenes[] access (D-5).
 * Preserved so initSceneList/addScene/switchSceneFile can read/write scenes[]
 * without strict loader rejection. This is the editor's multi-scene management path
 * (OOS-6/step 3) — NOT converged to strict loader.
 */
async function readRawForgeJson(): Promise<Record<string, unknown> | null> {
  const p = forgeJsonPath();
  if (!p) return null;
  try {
    const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    const parsed = JSON.parse(j.content);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function readForgeJson(): Promise<Record<string, unknown> | null> {
  // Legacy alias — delegates to raw reader for scenes[] access (D-5).
  // Contract fields: use readGameProject() for typed access.
  return readRawForgeJson();
}

/** Discover the game's scene manifest. Must run AFTER setSceneId and BEFORE the
 *  first loadDocFromDisk/loadDocFromStorage so paths and storage keys resolve to
 *  the active scene file. Games with neither a scenes/ dir nor a defaultScene
 *  GUID fall back to legacy single-scene mode (top-level scene.pack.json). */
export async function initSceneList(): Promise<void> {
  currentSceneFile = null;
  sceneList = [];
  const fj = await readForgeJson();
  // Scene discovery is DIRECTORY-driven, never forge.json-driven. The
  // engine-project loader's schema is `.strict()`, so an editor-only `scenes[]`
  // field makes loadGameProject FAIL — and ▶ Play reads physics/pointerLock off
  // that same loader (play-runtime AC-11), so a stray `scenes[]` silently
  // disables the game's physics. ubpa's w21 forge.json migration dropped it for
  // exactly this reason. So levels are discovered by scanning scenes/*.pack.json.
  // forge.json is read only for its typed contract fields.
  if (currentSceneId !== 'default') {
    const listPacks = async (root: string): Promise<string[]> => {
      try {
        // optional=1: a game may legitimately lack a probed dir (e.g. no
        // assets/monsters/). The server then returns 200 + empty tree instead
        // of a red 404 in the browser network panel.
        const r = await fetchWithTimeout(`/api/files/tree?root=${encodeURIComponent(resolveGamePath(root))}&optional=1`);
        if (!r.ok) return [];
        const j = (await r.json()) as { tree?: { children?: Array<{ name: string; type: string }> } };
        return (j.tree?.children ?? [])
          .filter((c) => c.type === 'file' && c.name.endsWith('.pack.json'))
          .map((c) => c.name)
          .sort();   // deterministic order → level1 before level2
      } catch { return []; }   // no such dir — fine
    };
    // Levels — scenes/<id>.pack.json. id = file stem, matched 1:1 against the
    // game's LEVELS[].id (the launcher writes play-config.json { level:<id> }).
    for (const name of await listPacks('scenes')) {
      const base = name.slice(0, -'.pack.json'.length);
      sceneList.push({ id: base, name: base, pack: `scenes/${name}` });
    }
    // Fallback for games whose scene pack still lives in assets/ (not scenes/):
    // resolve forge.json `defaultScene` to its pack so ✎ Edit opens the REAL
    // scene instead of seeding a default vignette (which then gets persisted and
    // permanently masks the real scene — the cow-level/hellforge "弹出默认场景"
    // bug). Only when the scenes/ scan above found nothing.
    if (sceneList.length === 0) {
      const defGuid = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
      if (defGuid) {
        const pack = await findScenePackByGuid(currentSceneId, defGuid);
        if (pack) {
          const stem = (pack.split('/').pop() ?? 'main').replace(/\.pack\.json$/, '') || 'main';
          sceneList.push({ id: stem, name: stem, pack });
        }
      }
    }
  }
  if (sceneList.length > 0) {
    // Binding priority — a window edits exactly ONE scene (UE-style):
    //   1. `?sceneFile=<id>` in the URL — the window's own hard binding
    //      (set when an asset/level is opened from the Assets panel; lets
    //      multiple editor windows edit different levels side by side)
    //   2. per-game localStorage — what this game last had open (survives the
    //      Studio Edit iframe being rebuilt without URL params)
    //   3. forge.json defaultScene → first level → legacy single top-level scene
    let urlWant: string | null = null;
    try { urlWant = new URLSearchParams(location.search).get('sceneFile'); } catch { /* non-browser */ }
    let want: string | null = null;
    try { want = localStorage.getItem(sceneFileStorageKey()); } catch { /* unavailable */ }
    const def = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
    // forge.json.defaultScene is a scene GUID (the engine SSOT — the scene ▶ Play
    // boots). Resolve it to the pack that DECLARES that scene asset and prefer
    // that entry, so ✎ Edit opens the SAME scene Play does — not merely the
    // alphabetically-first level. (The old `s.id === def` test never matched:
    // sceneList ids are file stems, `def` is a GUID, so it silently fell through
    // to firstScene and only lined up by luck when the default sorted first.)
    const defPack = def ? await findScenePackByGuid(currentSceneId, def) : null;
    const defId = defPack
      ? (sceneList.find((s) => s.pack === defPack)?.id ?? null)
      : null;
    const firstScene = sceneList[0];
    currentSceneFile =
      (urlWant && sceneList.some((s) => s.id === urlWant)) ? urlWant
      : (want && sceneList.some((s) => s.id === want)) ? want
      : defId ? defId
      : firstScene ? firstScene.id
      : null;  // no scene packs found → legacy: keep editing the single top-level scene
  }
  emitSceneList();
}

/** Open another scene/asset pack IN THIS WINDOW: flush the outgoing scene's
 *  pending save, persist the selection, and navigate to a URL that carries the
 *  binding (`?sceneFile=<id>`) — one editor window edits exactly one scene;
 *  multiple windows can edit different levels side by side (UE model). The
 *  navigation reload also re-enters the proven cold-boot path (the engine-sync
 *  structural-rebuild path currently leaves the renderer black — pre-existing
 *  fullRebuild issue; value-only doc changes still live-patch as before). */
export async function switchSceneFile(id: string): Promise<boolean> {
  if (id === currentSceneFile) return true;
  if (!sceneList.some((s) => s.id === id)) return false;
  flushPendingSaveBeacon();
  try { localStorage.setItem(sceneFileStorageKey(), id); } catch { /* unavailable */ }
  // IN-PLACE switch (no location.reload). Reloading the main window re-creates the
  // WebGPU device, which wedges WKWebView's GPU process (the desktop "切场景就死机").
  // Instead: update the URL via history, repair the per-file sync channel, reload the
  // doc (createEngineSync re-renders the viewport reactively — same world/renderer,
  // no context recreate), and signal the DOM-only panels (no GPU) to re-pair via the
  // per-game control channel. Falls back to a full reload if the in-place path throws.
  try {
    currentSceneFile = id;
    const u = new URL(location.href);
    u.searchParams.set('sceneFile', id);
    try { history.replaceState(history.state, '', u.toString()); } catch { /* SSR/old */ }
    const ok = await loadDocFromDisk();
    if (!ok) loadDocFromStorage();
    // loadDocFromDisk/Storage set bus.doc DIRECTLY and notify React doc listeners,
    // but NOT the bus.subscribe listeners the viewport uses to (re)build the
    // RENDERED scene — so without this the viewport keeps showing the OLD scene
    // (verified: doc updates 64→136 but world stays 67). Fire them via replaceDoc,
    // which also clears the previous scene's undo history (correct for a swap).
    replaceDoc(bus.doc);
    return true;
  } catch (e) {
    console.warn('[sync] in-place scene switch failed — falling back to reload:', e);
    const u = new URL(location.href);
    u.searchParams.set('sceneFile', id);
    location.assign(u.toString());
    return true;
  }
}

// ── Launcher config (UE-style "play this level") ─────────────────────────────
// <game>/play-config.json (host-resolved) — read by the GAME at boot:
//   { mode: 'campaign' }                  → ▶ Play runs main from level 1
//   { mode: 'level', level: '<sceneId>' } → ▶ Play runs just that level
// The editor's PlayLauncher select writes it via /api/files (gitignored,
// per-developer launcher state).
export interface PlayConfig { mode: 'campaign' | 'level'; level?: string; endAfter?: boolean }
function playConfigPath(): string | null {
  return currentSceneId === 'default' ? null : resolveGamePath('play-config.json');
}
export async function readPlayConfig(): Promise<PlayConfig> {
  const p = playConfigPath();
  if (!p) return { mode: 'campaign' };
  try {
    // optional=1: play-config.json is per-developer launcher state that may not
    // exist yet (default = campaign). The flag makes the server return 200
    // { exists:false } instead of 404, so an absent config logs no red error.
    const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(p)}&optional=1`);
    if (r.ok) {
      const j = (await r.json()) as { content?: string };
      if (j.content) {
        const cfg = JSON.parse(j.content) as PlayConfig;
        if (cfg && (cfg.mode === 'campaign' || cfg.mode === 'level')) return cfg;
      }
    }
  } catch { /* missing → campaign */ }
  return { mode: 'campaign' };
}
export async function writePlayConfig(cfg: PlayConfig): Promise<boolean> {
  const p = playConfigPath();
  if (!p) return false;
  try {
    const r = await getApiClient().fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: JSON.stringify(cfg, null, 2) + '\n' }),
    });
    return r.ok;
  } catch { return false; }
}

/** Create a new level under scenes/<slug>.pack.json (empty, or duplicated from
 *  the current doc) and switch to it. Discovery is directory-driven
 *  (see initSceneList) — NOTHING is written to forge.json, whose strict
 *  engine-project schema rejects an editor `scenes[]` field. The display name
 *  is the file stem (`slug`), so the game's LEVELS[].id can match it 1:1. */
export async function createSceneFile(id: string, duplicateCurrent: boolean): Promise<boolean> {
  if (currentSceneId === 'default') return false;
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || sceneList.some((s) => s.id === slug)) return false;
  const sourceDoc = duplicateCurrent ? bus.doc : createEditSession();
  const newPath = resolveGamePath(`scenes/${slug}.pack.json`);
  // A NEW level gets its own stable, path-derived GUID — never the source
  // scene's GUID (duplicate must be a distinct asset) and never an order-derived
  // one (which would drift on the first edit).
  // M5: construct a minimal empty-scene pack directly (sessionToPack deleted).
  // A new empty scene has no entities — the pack is just a skeleton.
  const newSceneGuid = stableGuid('scene|' + newPath);
  const newPack = { schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [{ guid: newSceneGuid, kind: 'scene', payload: { entities: [] }, refs: [] }] };
  const packContent = JSON.stringify(newPack, null, 2) + '\n';
  try {
    const w1 = await getApiClient().fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: newPath, content: packContent }),
    });
    if (!w1.ok) return false;
  } catch { return false; }
  // Persist + navigate this window into the new scene (see switchSceneFile).
  try { localStorage.setItem(sceneFileStorageKey(), slug); } catch { /* unavailable */ }
  const u = new URL(location.href);
  u.searchParams.set('sceneFile', slug);
  location.assign(u.toString());
  return true;
}

/** Rebuild an EditSession's SessionInternals bag around an incoming {world,
 *  registry} so its `asset` getter and internals stay live after a scene swap.
 *
 *  feat-20260701 M7 / AC-15: EditSession is just {world, registry} with the
 *  engine World as the entity SSOT. feat-20260703 (single realm): the cross-
 *  window snapshot/BroadcastChannel revive path is gone — callers always pass a
 *  locally-built doc with a live world. */
function reviveSession(doc: EditSession): EditSession {
  const fresh = createEditSession();
  // Single realm (feat-20260703): every doc reaching here is locally built and
  // carries a live engine World (the cross-window BroadcastChannel snapshot path
  // + dead-world cache were deleted with the sync engine). Reattach the incoming
  // world/registry onto a fresh EditSession so its `asset` getter is restored.
  fresh.world = doc.world;
  if (doc.registry !== undefined && doc.registry !== null) fresh.registry = doc.registry;
  return fresh;
}

export function loadDocFromStorage(): boolean {
  // feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
  // The legacy localStorage doc-mirror stored the EntityNode/doc.entities dual
  // write. With the engine World as the sole entity SSOT, that mirror can no
  // longer rehydrate into a live World (structuredClone of a World POD is inert),
  // so scene state now reloads exclusively from the on-disk pack
  // (loadDocFromDisk → loadWorldFromPack → world.instantiateScene). This
  // localStorage fast-path is retired.
  return false;
}

// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// The per-change localStorage doc-mirror is retired. It stored the deleted
// EntityNode/doc.entities structure; serializing the {world} EditSession yields
// an inert World POD that loadDocFromStorage can no longer rehydrate. Durable
// state lives in the on-disk scene pack (loadDocFromDisk/saveDocToDisk).

// ── Disk persistence: the game's authored scene-asset ────────────────────────
// Design (editor-feature-spec §15): the EditSession is the SSOT, serialized as
// self-describing JSON. We persist it to the GAME's folder so it's git-trackable,
// AI-readable, and the same file ▶ Play can instantiate. Path is host-resolved
// (resolveGamePath) from a game-relative name, e.g. `scene.pack.json` — the
// editor never bakes in where the game lives on disk.
// Reached via the server's /api/files (same-origin through the interface proxy).
// localStorage stays as a fast offline mirror; disk is the durable source.
//
// The durable on-disk format is the engine's NATIVE scene pack (`scene.pack.json`)
// — the editor in-memory EditSession is converted to/from it via
// @forgeax/scene's sessionToPack/packToSession. (Legacy `scene.json` is still READ for
// backward-compat; it is migrated to a pack on the next save.)
function scenePath(): string | null {
  if (currentSceneId === 'default') return null;
  if (currentSceneFile) {
    const entry = sceneList.find((s) => s.id === currentSceneFile);
    if (entry) return resolveGamePath(entry.pack);
  }
  return resolveGamePath('scene.pack.json');
}
/** The scene asset GUID to persist for the active scene. Prefers the GUID we
 *  read from disk (the scene's stable identity, e.g. the one forge.json's
 *  defaultScene points at); for a brand-new scene with no file yet, derives a
 *  STABLE GUID from the scene path (NOT from doc.order, which churns on every
 *  add/delete). Never returns the order-derived fallback for an existing scene —
 *  that drift is exactly what broke ▶ Play resolution after an edit. */
function sceneGuidForSave(): string | undefined {
  if (currentSceneGuid) return currentSceneGuid;
  const p = scenePath();
  return p ? stableGuid('scene|' + p) : undefined;
}

/**
 * Engine-native world→pack serialization (M5 / AC-08).
 * Replaces sessionToPack: uses rootsToSceneAsset + serializeSceneAssetToPack
 * on the live engine World. Returns null if world/registry unavailable or
 * collection/serialization fails.
 */
/** Remove the editor-only `EditorHidden` marker from a collected SceneAsset's
 *  entities so it never lands in the persisted pack (AC-04), while the entities
 *  themselves stay (AC-05). SceneAsset/entities are readonly, so rebuild. */
export function stripEditorHiddenMarker(asset: unknown): unknown {
  const a = asset as { kind: string; entities?: ReadonlyArray<{ localId: unknown; components: Record<string, unknown> }> };
  if (!a || !Array.isArray(a.entities)) return asset;
  return {
    ...a,
    entities: a.entities.map((e) => {
      if (!e.components || !('EditorHidden' in e.components)) return e;
      const { EditorHidden: _drop, ...rest } = e.components;
      return { ...e, components: rest };
    }),
  };
}

function worldToPack(doc: EditSession, sceneGuid?: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = doc.world;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg: any = doc.registry;
  if (!w || !reg) {
    console.warn('[editor-core] worldToPack: world or registry missing');
    return null;
  }
  // Collect ALL root entities (visible AND hidden) so hidden entities survive
  // the round-trip (AC-05: "隐藏一个实体 → save → reopen，实体仍在" — the entity is
  // serialized normally; only its EditorHidden MARKER is stripped so the pack
  // carries no hidden field, AC-04: "pack 序列化不含 hidden 字段"). Filtering the
  // whole hidden entity out (the earlier impl) reproduced exactly the
  // scene-pack.ts:178 data-loss bug AC-05 exists to fix (verify F6 / AGENTS.md #2).
  // Derive roots from the SSOT handle map (World exposes no `rootEntities` field
  // — see entRootHandles).
  const rootHandles: EntityHandle[] = entRootHandles(doc, w);
  // Use engine's rootsToSceneAsset + serializeSceneAssetToPack pipeline.
  const assetR = (rootsToSceneAsset as any)(reg, w, rootHandles);
  if (!assetR.ok) {
    console.warn('[editor-core] worldToPack: rootsToSceneAsset failed:', assetR.error);
    return null;
  }
  // Strip the editor-only EditorHidden marker from every collected entity — it
  // is a registered component so rootsToSceneAsset would otherwise emit it into
  // the pack (AC-04). The entity itself stays (AC-05). SceneAsset is readonly →
  // rebuild entities without the marker.
  const strippedAsset = stripEditorHiddenMarker(assetR.value);
  const packR = (serializeSceneAssetToPack as any)(strippedAsset, sceneGuid);
  if (!packR.ok) {
    console.warn('[editor-core] worldToPack: serializeSceneAssetToPack failed:', packR.error);
    return null;
  }
  return JSON.stringify(packR.value, null, 2) + '\n';
}

/** The exact byte content saveDocToDisk would write for the current doc (used by
 *  the disk watcher to recognise its own echo).
 *
 *  Returns `null` when serialization FAILS (world/registry missing, or the engine
 *  rootsToSceneAsset / serializeSceneAssetToPack pipeline errors — e.g. a spawned
 *  entity carries a component the pack serializer can't persist). Callers MUST
 *  treat null as "do not write": the earlier `?? ''` fallback wrote an EMPTY
 *  string to disk on any serialize failure, silently clobbering the real
 *  scene.pack.json with 0 bytes (the "add City_Sample_512 → scene destroyed" data
 *  loss). A failed save must abort, never overwrite good data (AGENTS.md #2:
 *  authoring data must round-trip or it's a data-loss bug). */
function serializedPack(): string | null {
  return worldToPack(bus.doc, sceneGuidForSave());
}

/** Load the active game's scene from disk (native pack preferred, legacy
 *  scene.json fallback). Returns true if a valid doc was loaded.
 *
 *  M4: scene-load uses engine-native world.instantiateScene instead of the
 *  deleted packToSession projection layer (AC-09). The pack JSON is parsed
 *  into a SceneAsset POD, refs indices resolved to GUID strings, then
 *  allocSharedRef('SceneAsset', ...) + world.instantiateScene materialises
 *  entities directly into the world — no doc.entities intermediate. */
export async function loadDocFromDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  // Forget the previous scene's identity before loading a new one, so a failed
  // load can't make us save under a stale GUID (sceneGuidForSave falls back to a
  // path-derived stable GUID when this stays null).
  currentSceneGuid = null;
  try {
    const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
    if (r.ok) {
      const j = (await r.json()) as { content?: string };
      if (j.content) {
        const parsed = JSON.parse(j.content);
        if (isScenePack(parsed)) {
          // Preserve the scene asset's GUID across edits (its stable identity).
          const sceneAssetEntry = parsed.assets.find((a: { kind?: string; guid?: string }) => a.kind === 'scene') as { guid?: string } | undefined;
          if (sceneAssetEntry?.guid) currentSceneGuid = sceneAssetEntry.guid;
          // Load via the engine's canonical loadByGuid -> instantiate path (the
          // SAME sequence the game's main.ts uses). This resolves refs[] ->
          // GUID -> user-tier handle inside the engine (allocSharedRef mint), so
          // shared refs are live before spawn retains them — the earlier
          // hand-rolled loadWorldFromPack fed GUID STRINGS straight to
          // instantiateScene, which coerced them to 0 and tripped
          // SharedRefReleasedError. It also populates _e2h from the
          // SceneInstance.mapping so entIds() reflects the loaded scene (else the
          // seed() fallback misfires and drops the old vocab).
          if (sceneAssetEntry?.guid) {
            const ok = await loadSceneByGuid(sceneAssetEntry.guid);
            if (ok) {
              docVersion++;
              for (const fn of docListeners) fn();
              return true;
            }
          }
          // GUID missing or engine load failed → fall through to seed.
        }
      }
    }
  } catch { /* fall through to seed */ }
  // feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
  // The legacy pre-native-pack `scene.json` load path (which revived a
  // doc.entities EditSession) is retired — M4 already deleted packToSession, so
  // there is no converter from the flat entities format into the engine World.
  // Only engine-native scene packs (loadWorldFromPack) load; a legacy scene.json
  // is migrated on the next save.
  return false;
}

// ── Scene-load: canonical engine loadByGuid → instantiate (engine SSOT) ─────
//
// The editor loads a scene the SAME way the game's main.ts does — the engine's
// AssetRegistry.loadByGuid<SceneAsset>() (which recursively pulls the scene AND
// its refs[] material/mesh/equirect siblings from the configured pack-index),
// then allocSharedRef + registry.instantiate(). The engine's _resolveSceneGuids
// mints one user-tier shared handle per unique GUID (allocSharedRef) BEFORE the
// spawn retains it, so shared refs are always live. The prior hand-rolled path
// (resolveRefsInComponents → world.instantiateScene with GUID STRINGS still in
// the shared<T> fields) fed non-numeric values into Uint32 columns; `as number`
// is erased at runtime, so retain saw a released/never-alloc'd slot →
// SharedRefReleasedError. AGENTS.md #1: converge on the engine primitive, do not
// re-hand-roll GUID resolution.

/** Tear down the currently loaded scene before a fresh (re)load: despawn the
 *  SceneInstance subtree via the engine primitive and clear the session's
 *  legacy-id↔handle map. No-op when nothing is loaded. */
function teardownCurrentScene(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = (bus.doc as any).world;
  if (w && currentSceneRoot !== null) {
    try { w.despawnScene(currentSceneRoot); } catch { /* best-effort */ }
  }
  currentSceneRoot = null;
  const internals = getInternals(bus.doc);
  internals._e2h.clear();
  internals._h2e.clear();
}

/**
 * Load the game's scene by GUID via the engine's canonical loadByGuid →
 * instantiate pipeline, then populate the session's legacy-id↔handle map
 * (`_e2h`/`_h2e`) from the resulting SceneInstance.mapping so the editor's
 * hierarchy/selection see the loaded entities (and entIds() is non-empty, so the
 * seed() fallback in main.tsx does NOT misfire). Returns true on success.
 */
async function loadSceneByGuid(sceneGuid: string): Promise<boolean> {
  // engine World / AssetRegistry are injected on bus.doc; the engine type shim
  // degrades to namespace (TS2709) so access via any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = (bus.doc as any).world;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg: any = (bus.doc as any).registry;
  if (!w || !reg) return false;
  try {
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    const parsed = AssetGuid.parse(sceneGuid);
    if (!parsed.ok) return false;

    // Clear any previously loaded scene first so a reload doesn't double-spawn
    // and _e2h has no stale entries.
    teardownCurrentScene();

    // loadByGuid pulls the scene + recursively its refs[] into the registry
    // catalog; the returned payload has each handle field resolved to a GUID
    // string. instantiate then mints GUID→handle and spawns every node.
    const loadRes = await reg.loadByGuid(parsed.value);
    if (!loadRes.ok) return false;
    const sceneHandle = w.allocSharedRef('SceneAsset', loadRes.value);
    const instRes = reg.instantiate(sceneHandle, w);
    if (!instRes.ok) return false;
    const root = instRes.value;
    // Populate _e2h/_h2e (+ advance the id allocator) from the freshly
    // instantiated scene root. Shared with the ▶/■ Stop rebind path (SSOT).
    return populateSessionMapFromSceneRoot(w, root as number);
  } catch {
    return false;
  }
}

/**
 * Recover the authored-localId ↔ engine-handle mapping (`_e2h`/`_h2e`) from a
 * freshly instantiated SceneInstance root and register it into the editor
 * session, then advance the id allocator past every loaded localId. Also binds
 * `currentSceneRoot` to `root`.
 *
 * The source of truth is the SceneInstance's `mapping` (Uint32Array indexed by
 * localId → engine-handle raw u32). The synthetic scene root itself is NOT an
 * authored entity, so it is not entered into the map.
 *
 * Shared by two callers (SSOT, AGENTS.md #1 — one resolution path):
 *  - loadSceneByGuid (initial disk load)
 *  - rebindLoadedScene (▶/■ Stop re-instantiate — the scene root changes so the
 *    prior _e2h points at despawned handles and must be rebuilt).
 *
 * Returns true when the root carried a resolvable SceneInstance.mapping.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function populateSessionMapFromSceneRoot(w: any, root: number): boolean {
  const instComp = w.get(root, SceneInstance);
  if (!instComp.ok) return false;
  const mappingArr: ArrayLike<number> = instComp.value.mapping;
  // Clear stale entries first so a rebind onto a new root doesn't leave the
  // pre-Play handles (now despawned) in the map.
  const internals = getInternals(bus.doc);
  internals._e2h.clear();
  internals._h2e.clear();
  currentSceneRoot = root;
  let maxId = -1;
  // mapping[localId] is the engine handle; ENTITY_NULL_RAW (0xffffffff) marks an
  // unspawned slot. Handle 0 IS valid (first spawn: gen=0+idx=0). Skip only the
  // null sentinel + absent slots.
  for (let localId = 0; localId < mappingArr.length; localId += 1) {
    const h = mappingArr[localId];
    if (h === undefined || h === ENTITY_NULL_RAW) continue;
    entMap(bus.doc, localId, h as EntityHandle);
    if (localId > maxId) maxId = localId;
  }
  // Advance the id allocator past every loaded localId so new spawns don't
  // collide with authored ids (never regress below the current allocator).
  const nextFloor = entGetNextId(bus.doc) - 1;
  entSetNextId(bus.doc, Math.max(maxId, nextFloor) + 1);
  return true;
}

/**
 * Rebind the editor session onto a scene root the ▶/■ Stop path just
 * re-instantiated. Stop despawns the played scene and re-instantiates the same
 * SceneAsset, which mints FRESH handles under a NEW synthetic root — the prior
 * `_e2h` now points at despawned handles, so hierarchy/selection/save go dead
 * ("scene not restored"). This rebuilds `_e2h`/`_h2e` + `currentSceneRoot` from
 * the new root and fires the doc listeners so panels re-read.
 *
 * Returns the bound root (so the host can also rebind its defaultSceneRoot), or
 * null if the root had no resolvable SceneInstance (rebind skipped).
 */
export function rebindLoadedScene(newRoot: number): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = (bus.doc as any).world;
  if (!w) return null;
  if (!populateSessionMapFromSceneRoot(w, newRoot)) return null;
  docVersion++;
  for (const fn of docListeners) fn();
  return newRoot;
}

/** Write the active game's scene to disk as a native engine scene pack. This is
 *  the MANUAL save (D-7): the user clicks Save in the toolbar → this runs and,
 *  on success, clears the dirty flag so the dirty indicator turns off. */
export async function saveDocToDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  // Serialize FIRST and bail if it failed — never POST an empty body over a good
  // scene (the 0-byte data-loss bug). Keep _isDirty set so the next save retries.
  const content = serializedPack();
  if (content === null) {
    console.error('[editor-core] saveDocToDisk: serialize failed — aborting write to protect on-disk scene');
    return false;
  }
  try {
    const r = await getApiClient().fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content }),
    });
    if (r.ok) _isDirty = false;
    return r.ok;
  } catch {
    return false;
  }
}

// Manual disk save (requirements-decisions #5; plan-strategy D-7). Every edit
// lands in localStorage immediately (above) and marks the in-memory scene DIRTY.
// The on-disk scene.pack.json is written ONLY when the user clicks Save (the UI
// layer calls saveDocToDisk), NOT on a debounce timer — deliberately deviating
// from the prior 400ms auto-save so authoring edits are not silently persisted.
// `_isDirty` is the dirty-indicator source the toolbar reads (via
// hasPendingDiskSave); it clears on a successful saveDocToDisk / explicit cancel
// / beacon flush.
let _isDirty = false;
bus.subscribe(() => { _isDirty = true; });

/** True while the in-memory scene has unsaved edits (drives the dirty
 *  indicator + the disk-watch "don't clobber my edits" guard). Manual-save
 *  model: this stays true until the user saves (or a flush/cancel clears it). */
export function hasPendingDiskSave(): boolean {
  return _isDirty;
}

/** Clear the dirty flag WITHOUT writing. Used after the editor seeds a default
 *  scene for a genuinely scene-less game: the bare seed must NOT be persisted to
 *  the game dir (that creates a scene.pack.json the user never authored — and,
 *  for a game whose real scene the editor failed to locate, it would permanently
 *  mask it). The seed stays in-memory; the user's first real edit re-marks
 *  dirty. */
export function cancelPendingDiskSave(): void {
  _isDirty = false;
}

// Flush unsaved edits SYNCHRONOUSLY-SAFE, even as the editor iframe is being
// torn down (mode switch edit→play unmounts EditMode → destroys this iframe). A
// normal `await fetch` would be aborted with the iframe; `navigator.sendBeacon`
// is the one write the browser guarantees to deliver during unload/pagehide. The
// server's POST /api/files reads c.req.json(), so a Blob typed application/json
// parses identically to the regular fetch save. Called on pagehide /
// visibilitychange(hidden) and on the VAG_EDITOR_FLUSH postMessage the interface
// sends right before it unmounts the editor — so an in-flight edit is not lost
// when the user flips to Play, even under the manual-save model (D-7).
export function flushPendingSaveBeacon(): void {
  if (!_isDirty) return; // nothing dirty
  const p = scenePath();
  if (!p) return;
  // Serialize BEFORE clearing dirty / sending — if it fails, do NOT beacon an
  // empty body over a good scene (this unload-time path was the silent 0-byte
  // clobber: add City_Sample_512 → dirty → pagehide → beacon empty). Keep dirty
  // set so a later successful save can still persist.
  const content = serializedPack();
  if (content === null) {
    console.error('[editor-core] flushPendingSaveBeacon: serialize failed — skipping beacon to protect on-disk scene');
    return;
  }
  _isDirty = false;
  try {
    const blob = new Blob([JSON.stringify({ path: p, content })], { type: 'application/json' });
    const ok = navigator.sendBeacon('/api/files', blob);
    // sendBeacon can refuse (queue full / too large); fall back to a keepalive
    // fetch which also survives teardown for small bodies.
    if (!ok) void getApiClient().fetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: blob, keepalive: true });
  } catch {
    // last resort — best-effort async save (may be aborted on teardown)
    void saveDocToDisk();
  }
}

// ── Disk watch: live-reload the scene when an EXTERNAL writer (an AI agent
//    editing scene.json on disk) changes the active game's scene.json ──────────
// The server already broadcasts chokidar file-events over ws://<host>/ws (the
// same channel ▶ Play's PreviewMode uses to hot-reload). The editor never
// subscribed, so agent edits required a manual refresh. We subscribe here and,
// on an external scene.json change, re-fetch + replaceDoc() (which fires the bus
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
      const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { content?: string };
      if (!j.content) return;
      const parsed = JSON.parse(j.content);
      if (isScenePack(parsed)) {
        // CANONICAL compare FIRST: normalise the incoming pack against our live
        // world's serialization. If identical, this is our own save echo — skip
        // (no teardown/reload). Comparing before the reload also avoids a
        // needless despawn+reinstantiate on every self-save.
        const currentPack = worldToPack(bus.doc, currentSceneGuid ?? undefined);
        if (currentPack && JSON.stringify(parsed) === currentPack) return;
        // Genuine external edit → reload via the engine-native loadByGuid path
        // (loadSceneByGuid tears down the current scene + repopulates _e2h).
        const sceneEntry = parsed.assets.find((a: { kind?: string; guid?: string }) => a.kind === 'scene') as { guid?: string } | undefined;
        if (!sceneEntry?.guid) return;
        if (sceneEntry.guid) currentSceneGuid = sceneEntry.guid;
        const ok = await loadSceneByGuid(sceneEntry.guid);
        if (!ok) return;
        docVersion++;
        for (const fn of docListeners) fn();
        _isDirty = false;
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
      if (_isDirty) return;                        // user has unsaved edits → don't clobber
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

/** Replace the entire authored document (scene load/import). Resets selection
 * and undo history since old inverses no longer apply to the new doc. */
export function replaceDoc(doc: EditSession): void {
  // reviveSession rebuilds the SessionInternals bag around the incoming
  // {world, registry} so downstream `bus.doc.asset` reads stay live (w34); it's
  // idempotent on an already-live locally-built session.
  bus.replaceDoc(reviveSession(doc));
  selectionList = [];
  emitSelection();
  docVersion++;
  for (const fn of docListeners) fn();
}

export function clearDocStorage(): void {
  try {
    localStorage.removeItem(docKey(currentSceneId));
  } catch {
    /* noop */
  }
}

// ── Asset selection (cross-panel: Content Browser → Material panel) ──────────
// Lightweight pub/sub for the currently-selected pack asset. When a user clicks
// an asset card in the Content Browser, other panels (Material, future Preview)
// can react by displaying its properties.

export interface SelectedAsset {
  guid: string;
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  packPath: string;
}

let selectedAsset: SelectedAsset | null = null;
const assetSelListeners = new Set<() => void>();
function emitAssetSel(): void { for (const fn of assetSelListeners) fn(); }

export function setAssetSelection(asset: SelectedAsset | null): void {
  if (selectedAsset?.guid === asset?.guid) return;
  selectedAsset = asset;
  emitAssetSel();

}
export function getAssetSelection(): SelectedAsset | null { return selectedAsset; }
function subscribeAssetSel(fn: () => void): () => void {
  assetSelListeners.add(fn);
  return () => assetSelListeners.delete(fn);
}
export function useAssetSelection(): SelectedAsset | null {
  return useSyncExternalStore(subscribeAssetSel, getAssetSelection, getAssetSelection);
}
/** Non-React subscription to asset-selection changes (used by the MAIN window in
 *  main.tsx to load the selected mesh and publish its stats). Returns unsubscribe. */
export function onAssetSelectionChange(fn: () => void): () => void {
  return subscribeAssetSel(fn);
}

// ── Mesh stats (cross-panel: MAIN window loads mesh → Mesh panel) ─────────────
// meta.json mesh sub-assets carry NO geometry in their Content Browser payload
// (see editor-core/assets.ts loadMetaAssets). Only the MAIN window holds the
// engine asset registry, so it loads the selected mesh via loadByGuid, derives
// geometry-free stats, and publishes them here; the Mesh panel (a registry-less
// iframe) renders them. Mirrors the asset-selection channel above.
// Design: docs/design/editor-mesh-panel.md §4.3.

export type MeshStats = MeshStatsWire;

let selectedMeshStats: MeshStats | null = null;
const meshStatsListeners = new Set<() => void>();
function emitMeshStats(): void { for (const fn of meshStatsListeners) fn(); }

/** MAIN window: publish derived stats for the currently-selected mesh (broadcasts
 *  to popouts/panels). Pass null to clear. */
export function publishMeshStats(stats: MeshStats | null): void {
  selectedMeshStats = stats;
  emitMeshStats();

}
export function getMeshStats(): MeshStats | null { return selectedMeshStats; }
function subscribeMeshStats(fn: () => void): () => void {
  meshStatsListeners.add(fn);
  return () => meshStatsListeners.delete(fn);
}
/** Panel hook: the latest published mesh stats (check `.guid` against the
 *  selected asset before rendering — a stale entry may linger during a switch). */
export function useMeshStats(): MeshStats | null {
  return useSyncExternalStore(subscribeMeshStats, getMeshStats, getMeshStats);
}

/** Notify in-process panels that the asset file list changed.
 *  M3: single-realm — panels are in-process React components. */
export function broadcastAssetsChanged(): void {
  try { window.postMessage({ type: 'VAG_ASSETS_CHANGED' }, '*'); } catch { /* */ }
}
