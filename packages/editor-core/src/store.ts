import { useSyncExternalStore } from 'react';
import { docToPack, packToDoc, isScenePack } from './scene-pack';
import { EditorBus } from './bus';
import type { CommandOrigin, HistoryStep } from './bus';
import { createDocument } from './document';
import type { EditorCommand, EntityId, SceneDocument } from './types';
import {
  getPopoutPanel,
  openSyncChannel,
  type EditorSnapshot,
  type EditorSyncMsg,
  type PopoutGeom,
  type SyncPanelId,
} from './sync-channel';
import { loadGameProject, FORGE_JSON, GameProjectError, type GameProject } from '@forgeax/engine-project';

// App-level singletons. The bus is the authoritative mutable path; selection is
// transient view state (NOT a command) — but selecting is exactly what turns a
// vague "this" into a concrete pointing handle for the AI (deixis).
//
// Ported (trimmed) from the unveil-studio prototype: Edit-only — the Play
// snapshot / runtime-systems half of the prototype store is dropped here because
// in forgeax the *engine itself* runs Play mode (see interface ▶ Play). The Edit
// surface keeps the authored doc static and projects it onto the forgeax world.
export const bus = new EditorBus(createDocument());

// ── Cross-window sync (design §0.2.2 Pop-out) ────────────────────────────────
// `?panel=<id>` marks a popped-out OS window that renders a SINGLE panel and
// mirrors the main window's bus over a same-origin BroadcastChannel. In the main
// window IS_POPOUT is false and the channel is used to broadcast snapshots +
// receive forwarded edits. Channel is opened lazily by initSync() (after the
// scene id is known) so the name keys per game.
export const IS_POPOUT = getPopoutPanel() !== null;
let syncChannel: BroadcastChannel | null = null;
let applyingSnapshot = false; // guard: applying a remote snapshot must not re-emit upstream
function postSync(msg: EditorSyncMsg): void {
  syncChannel?.postMessage(msg);
}

// Selection is a list; the LAST element is the "primary" (drives single-target
// panels like Inspector). Multi-select feeds deixis (reference many).
let selectionList: EntityId[] = [];
const selectionListeners = new Set<() => void>();

// Cross-window selection sync via localStorage (works across Tauri WebviewWindow
// processes, where BroadcastChannel can't reach). Persisted per scene; other
// windows pick it up via a `storage` event (see initSync). Guarded so applying a
// remote selection doesn't echo back.
let applyingExternalSel = false;
function selKey(): string { return `forgeax:editor:sel:${currentSceneId}`; }
function persistSelection(): void {
  if (applyingExternalSel || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(selKey(), JSON.stringify(selectionList)); } catch { /* quota */ }
}
function emitSelection(): void {
  for (const fn of selectionListeners) fn();
  persistSelection();
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
  syncSelectionUpstream();
}

/** Shift/Ctrl-click semantics: toggle membership, keep last-clicked as primary. */
export function toggleSelection(id: EntityId): void {
  selectionList = selectionList.includes(id) ? selectionList.filter((x) => x !== id) : [...selectionList, id];
  emitSelection();
  syncSelectionUpstream();
}

export function setSelectionMany(ids: EntityId[]): void {
  selectionList = [...ids];
  emitSelection();
  syncSelectionUpstream();
}

// A popout forwards selection to the main window (the authority); the main window
// echoes it back inside its snapshot. Suppressed while applying a snapshot.
function syncSelectionUpstream(): void {
  if (IS_POPOUT && !applyingSnapshot) postSync({ t: 'selection', ids: selectionList });
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
  if (IS_POPOUT && !applyingSnapshot) postSync({ t: 'gizmo', mode: m });
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
  // A popout has no viewport — ask the main window's camera to frame instead.
  if (IS_POPOUT) { postSync({ t: 'frame' }); return; }
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

// Animation scrub-preview signal: the Timeline publishes a sampled clip (channel→
// value) for an entity while scrubbing/playing; the viewport applies it to that
// entity's world Transform live (no doc churn) and resyncs from the doc when it
// clears. Main-window only (the viewport lives there); a popped-out Timeline still
// authors keys via the bus, it just can't drive the main viewport's live preview.
let animPreview: { id: EntityId; values: Record<string, number> } | null = null;
const animPreviewListeners = new Set<() => void>();
export function setAnimPreview(id: EntityId | null, values?: Record<string, number>): void {
  if (id === null) { if (!animPreview) return; animPreview = null; }
  else animPreview = { id, values: values ?? {} };
  for (const fn of animPreviewListeners) fn();
}
export function getAnimPreview(): { id: EntityId; values: Record<string, number> } | null {
  return animPreview;
}
export function onAnimPreview(fn: () => void): () => void {
  animPreviewListeners.add(fn);
  return () => animPreviewListeners.delete(fn);
}

// Reference-request signal: "pin entity N into the ForgeaX chat context". The
// chat panel lives in the parent interface shell (we are an iframe), so we post
// a deixis handle up via the VAG postMessage channel rather than owning ref
// state locally — exactly the "human points → AI gets a concrete handle" path.
export function requestRefEntity(id: EntityId): void {
  // From a popout, route to the main editor window — only IT is an iframe whose
  // parent is the interface shell that owns the ForgeaX chat.
  if (IS_POPOUT) { postSync({ t: 'refEntity', id }); return; }
  const node = bus.doc.entities[id];
  if (!node) return;
  const handle = {
    kind: 'entity' as const,
    id,
    name: node.name,
    components: Object.keys(node.components),
    ...(node.source ? { source: node.source } : {}),
  };
  try {
    window.parent?.postMessage({ type: 'VAG_EDITOR_REF', payload: handle }, '*');
  } catch {
    /* cross-origin — non-fatal */
  }
}

/** Pin a COMPONENT from the inspector into the ForgeaX chat — kind='component'. */
export function requestRefComponent(entityId: EntityId, comp: string, value: unknown): void {
  const node = bus.doc.entities[entityId];
  if (!node) return;
  try {
    window.parent?.postMessage(
      { type: 'VAG_EDITOR_REF', payload: { kind: 'component', entityId, entityName: node.name, comp, value } },
      '*',
    );
  } catch { /* cross-origin — non-fatal */ }
}

/** Pin an ASSET (material/texture/mesh) into the ForgeaX chat as a deixis handle
 * — same channel as requestRefEntity, payload.kind === 'asset'. */
export function requestRefAsset(asset: { guid: string; kind: string; name: string; packPath?: string }): void {
  if (IS_POPOUT) { postSync({ t: 'refAsset', asset }); return; }
  try {
    window.parent?.postMessage(
      { type: 'VAG_EDITOR_REF', payload: { kind: 'asset', guid: asset.guid, assetKind: asset.kind, name: asset.name, packPath: asset.packPath } },
      '*',
    );
  } catch {
    /* cross-origin — non-fatal */
  }
}

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
  // In a popout the bus is a read-only mirror: forward the command to the main
  // window (the authority), which applies it and broadcasts the new snapshot
  // back. We ids-allocated in ops.ts off the synced bus.doc.nextId, so they line
  // up with the main doc at dispatch time.
  if (IS_POPOUT) { postSync({ t: 'cmd', cmd, origin: 'human' }); return; }
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
// live via the SceneSwitcher UI — the UE "level asset" model. Games without a
// `scenes` manifest keep the legacy single `scene.pack.json` (currentSceneFile
// stays null and every path/key reduces to the historical shape).
export interface SceneFileEntry { id: string; name?: string; pack: string; group?: 'scene' | 'asset' }
let currentSceneFile: string | null = null;
let sceneList: SceneFileEntry[] = [];
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
  return currentSceneId === 'default' ? null : `.forgeax/games/${currentSceneId}/${FORGE_JSON}`;
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
    const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    const content = j.content;
    const result = await loadGameProject(async (_path) => content);
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
    const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
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
 *  the active scene file. Games without a manifest stay in legacy mode.
 *  Also lists assets/monsters/*.pack.json as the monster/character asset group — standalone
 *  prefab-style packs the editor opens exactly like a scene (UE asset editor). */
export async function initSceneList(): Promise<void> {
  currentSceneFile = null;
  sceneList = [];
  const fj = await readForgeJson();
  const scenes = fj?.scenes;
  if (Array.isArray(scenes)) {
    sceneList = scenes
      .filter((s): s is SceneFileEntry =>
        !!s && typeof s === 'object' && typeof (s as SceneFileEntry).id === 'string' && typeof (s as SceneFileEntry).pack === 'string')
      .map((s) => ({ ...s, group: 'scene' as const }));
  }
  // Monster/character asset packs — independent of the scenes manifest. Listed
  // for path resolution; the Assets panel is their UI entry (UE content-browser
  // style), the SceneSwitcher dropdown shows levels only.
  if (currentSceneId !== 'default') {
    for (const [dir, prefix] of [['monsters', 'monster'], ['characters', 'character']] as const) {
      try {
        const r = await fetch(`/api/files/tree?root=${encodeURIComponent(`.forgeax/games/${currentSceneId}/assets/${dir}`)}`);
        if (r.ok) {
          const j = (await r.json()) as { tree?: { children?: Array<{ name: string; type: string }> } };
          for (const c of j.tree?.children ?? []) {
            if (c.type !== 'file' || !c.name.endsWith('.pack.json')) continue;
            const base = c.name.slice(0, -'.pack.json'.length);
            sceneList.push({ id: `${prefix}:${base}`, name: base, pack: `assets/${dir}/${c.name}`, group: 'asset' });
          }
        }
      } catch { /* no such dir — fine */ }
    }
  }
  if (sceneList.length > 0) {
    // Binding priority — a window edits exactly ONE scene (UE-style):
    //   1. `?sceneFile=<id>` in the URL — the window's own hard binding
    //      (set when an asset/level is opened from the Assets panel; lets
    //      multiple editor windows edit different levels side by side)
    //   2. per-game localStorage — what this game last had open (survives the
    //      Studio Edit iframe being rebuilt without URL params)
    //   3. forge.json defaultScene → first level → legacy single scene
    let urlWant: string | null = null;
    try { urlWant = new URLSearchParams(location.search).get('sceneFile'); } catch { /* non-browser */ }
    let want: string | null = null;
    try { want = localStorage.getItem(sceneFileStorageKey()); } catch { /* unavailable */ }
    const def = typeof fj?.defaultScene === 'string' ? fj.defaultScene : null;
    const firstScene = sceneList.find((s) => s.group !== 'asset');
    currentSceneFile =
      (urlWant && sceneList.some((s) => s.id === urlWant)) ? urlWant
      : (want && sceneList.some((s) => s.id === want)) ? want
      : (def && sceneList.some((s) => s.id === def)) ? def
      : firstScene ? firstScene.id
      : null;  // only asset packs exist → keep editing the legacy single scene
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
  // Tell this instance's scene-scoped panels (Hierarchy/Inspector/… mirroring
  // over the old channel) to follow: they reload, re-read the persisted scene
  // file and re-pair on the NEW per-scene channel.
  if (!IS_POPOUT) postSync({ t: 'sceneChanged', id });
  const u = new URL(location.href);
  u.searchParams.set('sceneFile', id);
  location.assign(u.toString());
  return true;
}

/** Open a scene/asset pack from ANY editor surface. Panel iframes (ep:*) can't
 *  reload the main viewport themselves — they forward an `openScene` over the
 *  BroadcastChannel; the main window persists + reloads (and the panels follow
 *  via the post-reload snapshot). This is the Assets-panel double-click path. */
export function requestOpenScene(id: string): void {
  if (IS_POPOUT) { postSync({ t: 'openScene', id }); return; }
  void switchSceneFile(id);
}

// ── Launcher config (UE-style "play this level") ─────────────────────────────
// .forgeax/games/<slug>/play-config.json — read by the GAME at boot:
//   { mode: 'campaign' }                  → ▶ Play runs main from level 1
//   { mode: 'level', level: '<sceneId>' } → ▶ Play runs just that level
// The editor's PlayLauncher select writes it via /api/files (gitignored,
// per-developer launcher state).
export interface PlayConfig { mode: 'campaign' | 'level'; level?: string; endAfter?: boolean }
function playConfigPath(): string | null {
  return currentSceneId === 'default' ? null : `.forgeax/games/${currentSceneId}/play-config.json`;
}
export async function readPlayConfig(): Promise<PlayConfig> {
  const p = playConfigPath();
  if (!p) return { mode: 'campaign' };
  try {
    const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
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
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: JSON.stringify(cfg, null, 2) + '\n' }),
    });
    return r.ok;
  } catch { return false; }
}

/** Create a new scene file (empty, or duplicated from the current doc), register
 *  it in forge.json's `scenes` manifest, and switch to it. A legacy single-scene
 *  game is migrated on first use: its existing scene.pack.json is listed as the
 *  `main` entry, new scenes land in scenes/<id>.pack.json. */
export async function createSceneFile(id: string, name: string, duplicateCurrent: boolean): Promise<boolean> {
  const fp = forgeJsonPath();
  if (!fp) return false;
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || sceneList.some((s) => s.id === slug)) return false;
  const fj = (await readForgeJson()) ?? {};
  let scenes = Array.isArray(fj.scenes) ? [...(fj.scenes as SceneFileEntry[])] : [];
  if (scenes.length === 0) {
    // Legacy migration: keep the existing single scene where it is, list it.
    scenes = [{ id: 'main', name: 'Main Scene', pack: 'scene.pack.json' }];
  }
  const entry: SceneFileEntry = { id: slug, name: name || slug, pack: `scenes/${slug}.pack.json` };
  scenes.push(entry);
  fj.scenes = scenes;
  if (typeof fj.defaultScene !== 'string') fj.defaultScene = scenes[0]!.id;
  const sourceDoc = duplicateCurrent ? bus.doc : createDocument();
  const packContent = JSON.stringify(docToPack(sourceDoc), null, 2) + '\n';
  try {
    const w1 = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `.forgeax/games/${currentSceneId}/${entry.pack}`, content: packContent }),
    });
    if (!w1.ok) return false;
    const w2 = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: fp, content: JSON.stringify(fj, null, 2) + '\n' }),
    });
    if (!w2.ok) return false;
  } catch { return false; }
  // Persist + navigate this window into the new scene (see switchSceneFile).
  try { localStorage.setItem(sceneFileStorageKey(), slug); } catch { /* unavailable */ }
  const u = new URL(location.href);
  u.searchParams.set('sceneFile', slug);
  location.assign(u.toString());
  return true;
}

export function loadDocFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(docKey(currentSceneId));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entities) {
      bus.doc = parsed;
      docVersion++;
      for (const fn of docListeners) fn();
      return true;
    }
  } catch {
    /* corrupt → ignore, fall back to seed */
  }
  return false;
}

// Save synchronously on every change so a reload/navigation right after an edit
// never loses it (the doc is small; cost is negligible at this scale). Saved
// under the CURRENT scene's key so games stay isolated.
bus.subscribe(() => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(docKey(currentSceneId), JSON.stringify(bus.doc));
  } catch {
    /* quota / unavailable — non-fatal */
  }
});

// ── Disk persistence: the game's authored scene-asset ────────────────────────
// Design (editor-feature-spec §15): the SceneDocument is the SSOT, serialized as
// self-describing JSON. We persist it to the GAME's folder so it's git-trackable,
// AI-readable, and the same file ▶ Play can instantiate. Path:
//   .forgeax/games/<slug>/scene.json   (the active ?scene slug)
// Reached via the server's /api/files (same-origin through the interface proxy).
// localStorage stays as a fast offline mirror; disk is the durable source.
//
// The durable on-disk format is the engine's NATIVE scene pack (`scene.pack.json`)
// — the editor's in-memory SceneDocument is converted to/from it via
// @forgeax/scene's docToPack/packToDoc. (Legacy `scene.json` is still READ for
// backward-compat; it is migrated to a pack on the next save.)
function scenePath(): string | null {
  if (currentSceneId === 'default') return null;
  if (currentSceneFile) {
    const entry = sceneList.find((s) => s.id === currentSceneFile);
    if (entry) return `.forgeax/games/${currentSceneId}/${entry.pack}`;
  }
  return `.forgeax/games/${currentSceneId}/scene.pack.json`;
}
function legacyScenePath(): string | null {
  return currentSceneId === 'default' ? null : `.forgeax/games/${currentSceneId}/scene.json`;
}
/** The exact byte content saveDocToDisk would write for the current doc (used by
 *  the disk watcher to recognise its own echo). */
function serializedPack(): string {
  return JSON.stringify(docToPack(bus.doc), null, 2) + '\n';
}

/** Load the active game's scene from disk (native pack preferred, legacy
 *  scene.json fallback). Returns true if a valid doc was loaded. */
export async function loadDocFromDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  try {
    const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
    if (r.ok) {
      const j = (await r.json()) as { content?: string };
      if (j.content) {
        const parsed = JSON.parse(j.content);
        if (isScenePack(parsed)) {
          bus.doc = packToDoc(parsed);
          docVersion++;
          for (const fn of docListeners) fn();
          return true;
        }
      }
    }
  } catch { /* fall through to legacy / localStorage / seed */ }
  // Legacy scene.json (pre-native-pack) — load it; the next save writes a pack.
  const lp = legacyScenePath();
  if (lp) {
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(lp)}`);
      if (r.ok) {
        const j = (await r.json()) as { content?: string };
        if (j.content) {
          const parsed = JSON.parse(j.content);
          if (parsed && typeof parsed === 'object' && parsed.entities) {
            bus.doc = parsed;
            docVersion++;
            for (const fn of docListeners) fn();
            return true;
          }
        }
      }
    } catch { /* fall through */ }
  }
  return false;
}

/** Write the active game's scene to disk as a native engine scene pack. */
export async function saveDocToDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: serializedPack() }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Debounced disk autosave: every edit lands in localStorage immediately (above)
// and is flushed to the game's scene.pack.json shortly after the last change, so
// the authored scene persists per-game without a manual Save. The debounce is
// SHORT (was 1500ms) so the on-disk pack tracks edits closely — ▶ Play reads the
// disk, so a long debounce meant a freshly-switched Play showed a stale scene.
const AUTOSAVE_DEBOUNCE_MS = 400;
let _diskSaveTimer: ReturnType<typeof setTimeout> | null = null;
bus.subscribe(() => {
  if (_diskSaveTimer) clearTimeout(_diskSaveTimer);
  _diskSaveTimer = setTimeout(() => { void saveDocToDisk(); _diskSaveTimer = null; }, AUTOSAVE_DEBOUNCE_MS);
});

/** True while an edit is debounced but not yet written to disk. */
export function hasPendingDiskSave(): boolean {
  return _diskSaveTimer !== null;
}

// Flush a pending autosave SYNCHRONOUSLY-SAFE, even as the editor iframe is being
// torn down (mode switch edit→play unmounts EditMode → destroys this iframe). A
// normal `await fetch` would be aborted with the iframe; `navigator.sendBeacon`
// is the one write the browser guarantees to deliver during unload/pagehide. The
// server's POST /api/files reads c.req.json(), so a Blob typed application/json
// parses identically to the regular fetch save. Called on pagehide /
// visibilitychange(hidden) and on the VAG_EDITOR_FLUSH postMessage the interface
// sends right before it unmounts the editor — so Play always reads the latest
// pack the instant the user flips to it, with no race against the debounce.
export function flushPendingSaveBeacon(): void {
  if (_diskSaveTimer === null) return; // nothing dirty
  const p = scenePath();
  if (!p) return;
  clearTimeout(_diskSaveTimer);
  _diskSaveTimer = null;
  try {
    const blob = new Blob([JSON.stringify({ path: p, content: serializedPack() })], { type: 'application/json' });
    const ok = navigator.sendBeacon('/api/files', blob);
    // sendBeacon can refuse (queue full / too large); fall back to a keepalive
    // fetch which also survives teardown for small bodies.
    if (!ok) void fetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: blob, keepalive: true });
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
// Guards: (1) skip the echo of our own autosave (_lastDiskSaveAt window);
// (2) skip while we have unsaved local edits pending (_diskSaveTimer active) so
// an agent write never clobbers what the user is mid-editing.
export function initDiskWatch(): void {
  if (IS_POPOUT) return; // popouts mirror the main window over BroadcastChannel
  let ws: WebSocket | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;

  // Apply an externally-loaded doc WITHOUT rewriting it back to disk. replaceDoc
  // fires the bus → schedules an autosave; we cancel that pending save so we DON'T
  // overwrite the agent's just-written file with our canonical reformat. Rewriting
  // it would (a) churn the file under the agent and (b) risk a reformat ping-pong /
  // flicker. The next LOCAL edit will canonicalise it normally.
  const applyExternal = (next: SceneDocument): void => {
    replaceDoc(next);
    if (_diskSaveTimer) { clearTimeout(_diskSaveTimer); _diskSaveTimer = null; }
  };

  const reloadFromDisk = async (): Promise<void> => {
    const p = scenePath();
    if (!p) return;
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { content?: string };
      if (!j.content) return;
      const parsed = JSON.parse(j.content);
      const next = isScenePack(parsed) ? packToDoc(parsed)
        : (parsed && typeof parsed === 'object' && parsed.entities) ? parsed as SceneDocument
        : null;
      if (!next) return;
      // CANONICAL compare: normalise BOTH the incoming doc and the current doc
      // through docToPack, then compare. This skips not just our own autosave echo
      // but any reload that wouldn't actually change the scene (formatting / GUID /
      // float-rounding differences in the agent's write) — the definitive
      // no-op-reload / flicker-loop guard.
      if (JSON.stringify(docToPack(next)) === JSON.stringify(docToPack(bus.doc))) return;
      applyExternal(next);
    } catch { /* server unreachable / parse error → keep current doc */ }
  };

  const connect = (): void => {
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
      if (_diskSaveTimer !== null) return;        // user has unsaved edits → don't clobber
      // The reload itself content-compares against the current doc, so our own
      // autosave echo is a no-op (identical content) — no rebuild, no loop.
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void reloadFromDisk(); }, 400);
    });
    const retry = (): void => {
      ws = null;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => { try { ws?.close(); } catch { /* */ } });
  };
  connect();
}

/** Replace the entire authored document (scene load/import). Resets selection
 * and undo history since old inverses no longer apply to the new doc. */
export function replaceDoc(doc: SceneDocument): void {
  if (IS_POPOUT && !applyingSnapshot) { postSync({ t: 'replaceDoc', doc }); return; }
  bus.replaceDoc(doc);
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

// ── Cross-window sync wiring (design §0.2.2 Pop-out) ──────────────────────────
// Open the channel (keyed by the active scene) and wire the role-specific
// handlers. Call AFTER setSceneId so the channel name matches across windows.
let mirror: EditorSnapshot | null = null;

function buildSnapshot(): EditorSnapshot {
  return {
    doc: bus.doc,
    selection: [...selectionList],
    gizmo: gizmoMode,
    history: bus.historySteps(),
    applied: bus.appliedCount(),
    canUndo: bus.canUndo(),
    canRedo: bus.canRedo(),
  };
}

function broadcastSnapshot(): void {
  if (syncChannel) postSync({ t: 'snapshot', snap: buildSnapshot() });
}

/** Notify all ep:* panel iframes that the asset file list changed (triggers
 *  reload in the Assets panel's Files tab). No-op when not main or no channel. */
export function broadcastAssetsChanged(): void {
  if (!IS_POPOUT) postSync({ t: 'assetsChanged' });
}

// POPOUT: adopt the main window's authoritative state. We set bus.doc directly
// and fan out the React-facing listener sets WITHOUT touching the bus's own
// listeners (those drive main-only persistence), and we guard re-broadcasts.
function applySnapshot(snap: EditorSnapshot): void {
  applyingSnapshot = true;
  try {
    mirror = snap;
    bus.doc = snap.doc;
    selectionList = [...snap.selection];
    if (gizmoMode !== snap.gizmo) {
      gizmoMode = snap.gizmo;
      for (const fn of gizmoListeners) fn();
    }
    docVersion++;
    for (const fn of docListeners) fn();
    emitSelection();
  } finally {
    applyingSnapshot = false;
  }
}

// Dock (main window only) listens here to redock a panel when its popped-out OS
// window closes (the popout posts 'bye' on unload).
const popoutClosedListeners = new Set<(panel: SyncPanelId) => void>();
export function onPopoutClosed(cb: (panel: SyncPanelId) => void): () => void {
  popoutClosedListeners.add(cb);
  return () => popoutClosedListeners.delete(cb);
}
/** Tell the channel this popout is closing so the main window redocks it. */
export function announcePopoutClosing(panel: SyncPanelId): void {
  postSync({ t: 'bye', panel });
}

// Geometry memory (design §0.2.3): the popout reports its window size/position so
// the main window persists it and reopens the panel where the user left it.
const popoutGeomListeners = new Set<(panel: SyncPanelId, geom: PopoutGeom) => void>();
export function onPopoutGeom(cb: (panel: SyncPanelId, geom: PopoutGeom) => void): () => void {
  popoutGeomListeners.add(cb);
  return () => popoutGeomListeners.delete(cb);
}
export function announcePopoutGeom(panel: SyncPanelId, geom: PopoutGeom): void {
  postSync({ t: 'geom', panel, ...geom });
}

function initMain(ch: BroadcastChannel): void {
  bus.subscribe(() => broadcastSnapshot());
  onSelectionChange(() => broadcastSnapshot());
  onGizmoModeChange(() => broadcastSnapshot());
  ch.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as EditorSyncMsg;
    switch (msg.t) {
      case 'hello': broadcastSnapshot(); break;
      case 'cmd': bus.dispatch(msg.cmd, msg.origin); break;
      case 'undo': bus.undo(); break;
      case 'redo': bus.redo(); break;
      case 'jumpTo': bus.jumpTo(msg.target); break;
      case 'replaceDoc': replaceDoc(msg.doc); break;
      case 'selection': setSelectionMany(msg.ids); break;
      case 'gizmo': setGizmoMode(msg.mode); break;
      case 'frame': requestFrame(); break;
      case 'refEntity': requestRefEntity(msg.id); break;
      case 'refAsset': requestRefAsset(msg.asset); break;
      case 'geom': for (const fn of popoutGeomListeners) fn(msg.panel, { w: msg.w, h: msg.h, x: msg.x, y: msg.y }); break;
      case 'bye': for (const fn of popoutClosedListeners) fn(msg.panel); break;
      case 'openScene': void switchSceneFile(msg.id); break;
      default: break; // 'snapshot'/'sceneChanged' are main→popout only
    }
  };
  // Push the freshly-loaded doc to panels that were ALREADY open before this
  // main window (re)booted — e.g. after a scene switch navigation, the paired
  // Hierarchy/Inspector iframes must immediately mirror the new scene without
  // waiting for the first edit.
  broadcastSnapshot();
}

function initPopout(ch: BroadcastChannel): void {
  // Re-point the bus mutators at the channel: a popout never mutates locally, it
  // asks the main window to. Read-only accessors come from the last snapshot.
  bus.dispatch = (cmd: EditorCommand, origin: CommandOrigin = 'human') => {
    postSync({ t: 'cmd', cmd, origin });
    return { ok: true } as const;
  };
  bus.undo = () => { postSync({ t: 'undo' }); return true; };
  bus.redo = () => { postSync({ t: 'redo' }); return true; };
  bus.jumpTo = (target: number) => { postSync({ t: 'jumpTo', target }); };
  bus.canUndo = () => mirror?.canUndo ?? false;
  bus.canRedo = () => mirror?.canRedo ?? false;
  bus.historySteps = (): HistoryStep[] => mirror?.history ?? [];
  bus.appliedCount = () => mirror?.applied ?? 0;
  ch.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as EditorSyncMsg;
    if (msg.t === 'snapshot') { applySnapshot(msg.snap); return; }
    if (msg.t === 'sceneChanged') {
      // Our authority viewport navigated to another scene — follow it: reload
      // re-reads the persisted scene file and re-pairs on the new channel.
      if (msg.id !== currentSceneFile) location.reload();
      return;
    }
    if (msg.t === 'assetsChanged') {
      // Relay as a window message so the Assets panel's listener can reload.
      try { window.postMessage({ type: 'VAG_ASSETS_CHANGED' }, '*'); } catch { /* */ }
    }
  };
  postSync({ t: 'hello' }); // request the current state on open
}

export function initSync(): void {
  if (syncChannel) return; // idempotent
  // Cross-process doc sync (works even when BroadcastChannel can't span Tauri
  // WebviewWindow processes): the main window persists the doc to localStorage on
  // every edit; other same-origin windows get a `storage` event and re-read it.
  // (Fires only in OTHER contexts, never the writer — so no loop; loadDocFromStorage
  // sets bus.doc + bumps the React version without re-persisting.)
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === docKey(currentSceneId) && e.newValue) { loadDocFromStorage(); return; }
      if (e.key === selKey() && e.newValue) {
        try {
          const ids = JSON.parse(e.newValue);
          if (Array.isArray(ids)) { applyingExternalSel = true; selectionList = ids; emitSelection(); applyingExternalSel = false; }
        } catch { /* ignore */ }
      }
    });
  }
  // The channel IS the viewport↔panels pair: keyed per game AND per scene
  // file, so an editor instance editing level1 and another editing level2
  // (same game, separate windows) never cross-talk. Panels resolve the same
  // scene file via initSceneList before connecting.
  syncChannel = openSyncChannel(`${getSceneId()}::${currentSceneFile ?? 'main'}`);
  if (!syncChannel) return; // BroadcastChannel unavailable → still have storage sync
  if (IS_POPOUT) initPopout(syncChannel);
  else initMain(syncChannel);
}
