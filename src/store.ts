import { useSyncExternalStore } from 'react';
import { EditorBus } from './core/bus';
import type { CommandOrigin, HistoryStep } from './core/bus';
import { createDocument } from './core/document';
import type { EditorCommand, EntityId, SceneDocument } from './core/types';
import {
  getPopoutPanel,
  openSyncChannel,
  type EditorSnapshot,
  type EditorSyncMsg,
  type PopoutGeom,
  type SyncPanelId,
} from './core/sync-channel';

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
function docKey(id: string): string { return `${DOC_KEY_PREFIX}:${id}`; }

export function setSceneId(id: string | null | undefined): void {
  const v = (id ?? '').trim();
  currentSceneId = v || 'default';
}
export function getSceneId(): string { return currentSceneId; }

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
function scenePath(): string | null {
  return currentSceneId === 'default' ? null : `.forgeax/games/${currentSceneId}/scene.json`;
}

/** Load the active game's scene.json from disk. Returns true if a valid doc was
 *  loaded (→ caller skips localStorage + seed). */
export async function loadDocFromDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  try {
    const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
    if (!r.ok) return false; // 404 = no authored scene yet → fall through
    const j = (await r.json()) as { content?: string };
    if (!j.content) return false;
    const parsed = JSON.parse(j.content);
    if (parsed && typeof parsed === 'object' && parsed.entities) {
      bus.doc = parsed;
      docVersion++;
      for (const fn of docListeners) fn();
      return true;
    }
  } catch {
    /* server unreachable / parse error → fall through to localStorage/seed */
  }
  return false;
}

/** Write the active game's scene.json to disk (POST /api/files). */
export async function saveDocToDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: JSON.stringify(bus.doc, null, 2) + '\n' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Debounced disk autosave: every edit lands in localStorage immediately (above)
// and is flushed to the game's scene.json ~1.5s after the last change, so the
// authored scene persists per-game without a manual Save.
let _diskSaveTimer: ReturnType<typeof setTimeout> | null = null;
bus.subscribe(() => {
  if (_diskSaveTimer) clearTimeout(_diskSaveTimer);
  _diskSaveTimer = setTimeout(() => { void saveDocToDisk(); }, 1500);
});

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
      default: break; // 'snapshot' is main→popout only
    }
  };
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
    if (msg.t === 'snapshot') applySnapshot(msg.snap);
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
  syncChannel = openSyncChannel(getSceneId());
  if (!syncChannel) return; // BroadcastChannel unavailable → still have storage sync
  if (IS_POPOUT) initPopout(syncChannel);
  else initMain(syncChannel);
}
