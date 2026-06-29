import { useSyncExternalStore } from 'react';
import { sessionToPack, packToSession, isScenePack, stableGuid } from './scene-pack';
import { EditorBus } from './bus';
import type { CommandOrigin, HistoryStep } from './bus';
import { createEditSession } from './document';
import { makeEditSession } from './edit-session';
import type { EditorCommand, EntityId, EditSession } from './types';
import {
  getPopoutPanel,
  openSyncChannel,
  openControlChannel,
  parseEditorSyncMsg,
  type EditorSnapshot,
  type EditorSyncMsg,
  type PopoutGeom,
  type SyncPanelId,
  type AssetChatRef,
  type MeshStatsWire,
} from './sync-channel';
import { loadGameProject, FORGE_JSON, GameProjectError, type GameProject } from '@forgeax/engine-project';
import { getApiClient } from './api-client';
import { findScenePackByGuid } from './assets';
import { fetchWithTimeout } from './net';
import { resolveGamePath } from './path-resolver';

// App-level singletons. The bus is the authoritative mutable path; selection is
// transient view state (NOT a command) — but selecting is exactly what turns a
// vague "this" into a concrete pointing handle for the AI (deixis).
//
// Ported (trimmed) from the unveil-studio prototype: Edit-only — the Play
// snapshot / runtime-systems half of the prototype store is dropped here because
// in forgeax the *engine itself* runs Play mode (see interface ▶ Play). The Edit
// surface keeps the authored doc static and projects it onto the forgeax world.
export const bus = new EditorBus(createEditSession());

// ── Cross-window sync (design §0.2.2 Pop-out) ────────────────────────────────
// `?panel=<id>` marks a popped-out OS window that renders a SINGLE panel and
// mirrors the main window's bus over a same-origin BroadcastChannel. In the main
// window IS_POPOUT is false and the channel is used to broadcast snapshots +
// receive forwarded edits. Channel is opened lazily by initSync() (after the
// scene id is known) so the name keys per game.
export const IS_POPOUT = getPopoutPanel() !== null;
let syncChannel: BroadcastChannel | null = null;
// Per-GAME control channel (survives scene-file switches) — carries only the
// file-independent navigation signals so a scene switch re-pairs every window IN
// PLACE (no location.reload → no WebGPU context recreate → no WKWebView wedge).
let controlChannel: BroadcastChannel | null = null;
let applyingSnapshot = false; // guard: applying a remote snapshot must not re-emit upstream

// Single re-entrancy invariant for cross-window selection sync. While we are
// APPLYING a remote update (a localStorage `storage` echo OR a BroadcastChannel
// snapshot mirror), every OUTBOUND propagation channel must stay silent —
// otherwise the windows ping-pong forever (see
// docs/design/editor-cross-window-selection-sync-loop.md).
//
// IMPORTANT: this only suppresses *echoes*. A genuine inbound selection from a
// popout arrives via mainOnMessage → setSelectionMany (applyingRemote === false),
// so the main window still persists + broadcasts it (legitimate fan-out). Do NOT
// widen this guard to cover setSelection/setSelectionMany themselves.
//
// INVARIANT (do not break): applyingExternalSel / applyingSnapshot are plain
// booleans, not depth counters. They are only correct because every site sets →
// emits SYNCHRONOUSLY → resets within one call frame, with no `await`/microtask
// in between and no nesting (storage events + channel messages are delivered as
// separate, serial tasks). If a future change makes emit() async or re-entrant,
// convert these to a depth counter before relying on them.
function applyingRemote(): boolean {
  return applyingExternalSel || applyingSnapshot;
}

// Channel-択一 (single transport) for cross-window SELECTION sync. The editor
// has two cross-window transports — BroadcastChannel (snapshots + 'selection'
// upstream) and a localStorage `storage`-event mirror. Running BOTH for selection
// double-delivers and is the structural cause of the historical echo loop (see
// docs/design/editor-cross-window-selection-sync-loop.md §4.3). So:
//   • BroadcastChannel OPEN  → it is the SOLE selection transport; the
//     localStorage selKey mirror is fully disabled (no writes, no reads).
//   • BroadcastChannel CLOSED → fall back to the localStorage mirror (Tauri
//     cross-process WebviewWindows, where BroadcastChannel can't reach, or before
//     initSync has opened the channel).
// NOTE: the selKey value is NEVER read at load time (selection is transient, not
// restored), so disabling it loses nothing in the browser path.
//
// DETECTION — must NOT be `syncChannel !== null`: in Tauri the BroadcastChannel
// object EXISTS but cannot span WebviewWindow processes, so the object's presence
// does not prove cross-window delivery. We instead require PROOF: the channel is
// only treated as the live transport once we have actually RECEIVED a cross-window
// message over it (`broadcastProven`). In the browser (same-process iframes) the
// init handshake (`hello`/`snapshot`) flips this on within a tick; in Tauri it
// never flips, so the localStorage fallback stays active.
let broadcastProven = false;
function markBroadcastProven(): void { broadcastProven = true; }
function broadcastActive(): boolean {
  return broadcastProven;
}

// Order-sensitive id-list equality (selection is small; the last element is the
// primary, so order matters). Used to short-circuit redundant remote selection
// applications before they emit + re-render.
function sameIdList(a: EntityId[], b: EntityId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function postSync(msg: EditorSyncMsg): void {
  syncChannel?.postMessage(msg);
}
function postControl(msg: EditorSyncMsg): void {
  controlChannel?.postMessage(msg);
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
  // applyingRemote(): a window mirroring a remote selection must NOT write the
  // authoritative localStorage key — that write would `storage`-event back into
  // every other window and start an unbounded cross-window echo.
  // broadcastActive(): when BroadcastChannel is the live transport, the
  // localStorage selection mirror is redundant (channel-択一) — skip it entirely.
  if (applyingRemote() || broadcastActive() || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(selKey(), JSON.stringify(selectionList)); } catch { /* quota */ }
}

// Dev-only runaway-propagation net: if selection emits storm within a short
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
  if (IS_POPOUT && !applyingRemote()) postSync({ t: 'selection', ids: selectionList });
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

/** Batch-add asset/folder refs into the ForgeaX AI Chat context (M5).
 *  Carries full payload so the AI can reason about asset contents. */
export function requestAddAssetsToChat(refs: AssetChatRef[]): void {
  if (refs.length === 0) return;
  if (IS_POPOUT) { postSync({ t: 'addAssetToChat', refs }); return; }
  try {
    window.parent?.postMessage(
      { type: 'FORGEAX_ADD_ASSET_TO_CHAT', refs },
      '*',
    );
  } catch {
    /* cross-origin — non-fatal */
  }
}

/** Add an asset to the active Scene viewport (context-menu equivalent of dragging
 *  it onto the viewport — D-6). Routes to the Shell, where EditSurface builds the
 *  spawn entity (split sub-asset) or runs import-scene (whole GLB). A popped-out
 *  panel forwards via the sync channel to the main window first. */
export function requestAddAssetToScene(ref: AssetChatRef): void {
  if (IS_POPOUT) { postSync({ t: 'addAssetToScene', ref }); return; }
  try {
    window.parent?.postMessage({ type: 'FORGEAX_ADD_ASSET_TO_SCENE', ref }, '*');
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

// ── Popout ↔ main connectivity (design §0.2.2) ───────────────────────────────
// A popped-out / ep:* panel is a pure MIRROR: it has no authoritative bus and
// only shows content once the MAIN viewport (the BroadcastChannel "main") has
// answered its `hello` with a snapshot. Until then History/Timeline render an
// empty state that is INDISTINGUISHABLE from "viewport open but nothing edited
// yet" — so a panel docked without an open Edit viewport looks silently broken
// ("没接通"). This flag makes the distinction legible: false = no main has
// answered (show a "open the Edit viewport" hint); true = mirroring a live
// viewport (empty is then genuinely empty). Always true in the main window.
let mainConnected = !IS_POPOUT;
const connectedListeners = new Set<() => void>();
function markMainConnected(): void {
  if (mainConnected) return;
  mainConnected = true;
  for (const fn of connectedListeners) fn();
}
function subscribeConnected(fn: () => void): () => void {
  connectedListeners.add(fn);
  return () => connectedListeners.delete(fn);
}
/** True once this surface has authority (main window) or a live snapshot from
 *  one (popout). False in a popout whose Edit viewport isn't open yet. */
export function useMainConnected(): boolean {
  return useSyncExternalStore(subscribeConnected, () => mainConnected, () => mainConnected);
}

export function dispatch(cmd: EditorCommand): void {
  // In a popout the bus is a read-only mirror: forward the command to the main
  // window (the authority), which applies it and broadcasts the new snapshot
  // back. We ids-allocated in ops.ts off the synced bus.doc.nextLocalId, so they line
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
    // but NOT the bus.subscribe listeners createEngineSync uses to (re)build the
    // RENDERED scene — so without this the viewport keeps showing the OLD scene
    // (verified: doc updates 64→136 but world stays 67). Fire them via replaceDoc,
    // which also clears the previous scene's undo history (correct for a swap).
    // Run BEFORE repairSceneChannelMain so its broadcastSnapshot carries the NEW doc.
    replaceDoc(bus.doc);
    repairSceneChannelMain();
    // Panels are separate DOM iframes (no WebGPU) — reloading them is cheap + safe.
    // Sent on the per-GAME control channel so they hear it regardless of which
    // per-file channel they were paired on.
    postControl({ t: 'sceneChanged', id });
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
  const packContent = JSON.stringify(sessionToPack(sourceDoc, stableGuid('scene|' + newPath)), null, 2) + '\n';
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

/** Revive a plain parsed object (localStorage mirror / legacy scene.json) into a
 *  live EditSession with the engine-POD `asset` getter. Reads either the current
 *  `nextLocalId` field or a legacy `nextId` (pre-M6 persisted mirrors). */
function reviveSession(parsed: {
  entities: EditSession['entities'];
  order?: EntityId[];
  nextLocalId?: EntityId;
  nextId?: EntityId;
}): EditSession {
  const order = parsed.order ?? Object.keys(parsed.entities).map(Number);
  const next = parsed.nextLocalId ?? parsed.nextId ?? (order.reduce((m, id) => Math.max(m, id), 0) + 1);
  return makeEditSession(parsed.entities, order, next);
}

export function loadDocFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(docKey(currentSceneId));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entities) {
      bus.doc = reviveSession(parsed);
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
function legacyScenePath(): string | null {
  return currentSceneId === 'default' ? null : resolveGamePath('scene.json');
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

/** The exact byte content saveDocToDisk would write for the current doc (used by
 *  the disk watcher to recognise its own echo). */
function serializedPack(): string {
  return JSON.stringify(sessionToPack(bus.doc, sceneGuidForSave()), null, 2) + '\n';
}

/** Load the active game's scene from disk (native pack preferred, legacy
 *  scene.json fallback). Returns true if a valid doc was loaded. */
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
          const sceneAsset = parsed.assets.find((a) => a.kind === 'scene');
          if (sceneAsset?.guid) currentSceneGuid = sceneAsset.guid;
          bus.doc = packToSession(parsed);
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
      const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(lp)}`);
      if (r.ok) {
        const j = (await r.json()) as { content?: string };
        if (j.content) {
          const parsed = JSON.parse(j.content);
          if (parsed && typeof parsed === 'object' && parsed.entities) {
            bus.doc = reviveSession(parsed);
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

/** Write the active game's scene to disk as a native engine scene pack. This is
 *  the MANUAL save (D-7): the user clicks Save in the toolbar → this runs and,
 *  on success, clears the dirty flag so the dirty indicator turns off. */
export async function saveDocToDisk(): Promise<boolean> {
  const p = scenePath();
  if (!p) return false;
  try {
    const r = await getApiClient().fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: serializedPack() }),
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
  _isDirty = false;
  try {
    const blob = new Blob([JSON.stringify({ path: p, content: serializedPack() })], { type: 'application/json' });
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
export function initDiskWatch(): void {
  if (IS_POPOUT) return; // popouts mirror the main window over BroadcastChannel
  let ws: WebSocket | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;

  // Apply an externally-loaded doc WITHOUT rewriting it back to disk. replaceDoc
  // fires the bus → marks the scene dirty; we clear that dirty flag so a later
  // flush/save does NOT overwrite the agent's just-written file with our
  // canonical reformat. Rewriting it would (a) churn the file under the agent and
  // (b) risk a reformat ping-pong / flicker. The next LOCAL edit re-marks dirty.
  const applyExternal = (next: EditSession): void => {
    replaceDoc(next);
    _isDirty = false;
  };

  const reloadFromDisk = async (): Promise<void> => {
    const p = scenePath();
    if (!p) return;
    try {
      const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { content?: string };
      if (!j.content) return;
      const parsed = JSON.parse(j.content);
      const next = isScenePack(parsed) ? packToSession(parsed)
        : (parsed && typeof parsed === 'object' && parsed.entities) ? reviveSession(parsed)
        : null;
      if (!next) return;
      // CANONICAL compare: normalise BOTH the incoming doc and the current doc
      // through sessionToPack, then compare. This skips not just our own autosave echo
      // but any reload that wouldn't actually change the scene (formatting / GUID /
      // float-rounding differences in the agent's write) — the definitive
      // no-op-reload / flicker-loop guard.
      if (JSON.stringify(sessionToPack(next)) === JSON.stringify(sessionToPack(bus.doc))) return;
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
      if (_isDirty) return;                        // user has unsaved edits → don't clobber
      // The reload itself content-compares against the current doc, so our own
      // save echo is a no-op (identical content) — no rebuild, no loop.
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
export function replaceDoc(doc: EditSession): void {
  if (IS_POPOUT && !applyingSnapshot) { postSync({ t: 'replaceDoc', doc }); return; }
  // A doc arriving over the BroadcastChannel (replaceDoc message) is a
  // structuredClone that has lost the EditSession `asset` getter — revive it so
  // downstream `bus.doc.asset` reads stay live (w34). A locally-built session
  // already carries the getter; reviveSession rebuilds it idempotently.
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
  // Never re-broadcast a state we are CURRENTLY applying from a remote source —
  // otherwise an inbound storage echo / snapshot mirror is bounced straight back
  // out, closing the cross-window loop. Genuine local edits run with
  // applyingRemote() === false and broadcast normally.
  if (applyingRemote()) return;
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
    markMainConnected(); // a main answered → this panel is live, not orphaned
    // BroadcastChannel structuredClone drops the EditSession `asset` getter —
    // revive it so popout panels reading bus.doc.asset stay live (w34).
    bus.doc = reviveSession(snap.doc);
    const selChanged = !sameIdList(selectionList, snap.selection);
    if (selChanged) selectionList = [...snap.selection];
    if (gizmoMode !== snap.gizmo) {
      gizmoMode = snap.gizmo;
      for (const fn of gizmoListeners) fn();
    }
    docVersion++;
    for (const fn of docListeners) fn();
    // Only re-emit selection when it actually changed — avoids redundant panel
    // re-renders on every snapshot (doc edits arrive far more often than
    // selection changes).
    if (selChanged) emitSelection();
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

// Extracted so repairSceneChannelMain() can re-attach it to a fresh per-file
// channel after an IN-PLACE scene switch (no page reload). The bus/selection/gizmo
// subscriptions live in initMain (attached ONCE) and post to whatever syncChannel
// is current via postSync — so swapping the channel needs only onmessage + a push.
function mainOnMessage(ev: MessageEvent): void {
  markBroadcastProven(); // receiving anything proves the channel reaches siblings
  const msg = parseEditorSyncMsg(ev.data);
  if (!msg) { console.warn('[sync] dropped malformed channel message (main)', ev.data); return; }
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
    case 'addAssetToChat': requestAddAssetsToChat(msg.refs); break;
    case 'addAssetToScene': requestAddAssetToScene(msg.ref); break;
    case 'geom': for (const fn of popoutGeomListeners) fn(msg.panel, { w: msg.w, h: msg.h, x: msg.x, y: msg.y }); break;
    case 'bye': for (const fn of popoutClosedListeners) fn(msg.panel); break;
      case 'openScene': void switchSceneFile(msg.id); break;
    case 'assetSelect': applyRemoteAssetSelection(msg.asset as SelectedAsset | null); break;
    default: break; // 'snapshot'/'sceneChanged' are main→popout only
  }
}

function initMain(ch: BroadcastChannel): void {
  bus.subscribe(() => broadcastSnapshot());
  onSelectionChange(() => broadcastSnapshot());
  onGizmoModeChange(() => broadcastSnapshot());
  ch.onmessage = mainOnMessage;
  // Push the freshly-loaded doc to panels that were ALREADY open before this
  // main window (re)booted — e.g. after a scene switch navigation, the paired
  // Hierarchy/Inspector iframes must immediately mirror the new scene without
  // waiting for the first edit.
  broadcastSnapshot();
}

// Swap the MAIN window's per-file sync channel to the current scene file WITHOUT a
// page reload — reloading the main window re-creates the WebGPU device, which
// wedges WKWebView's GPU process. The bus subscriptions from initMain persist and
// post to the new channel (postSync reads the current syncChannel), so we only
// re-attach onmessage + push a fresh snapshot for the reloaded panels.
function repairSceneChannelMain(): void {
  try { syncChannel?.close(); } catch { /* already closed */ }
  syncChannel = openSyncChannel(`${getSceneId()}::${currentSceneFile ?? 'main'}`);
  if (syncChannel) { syncChannel.onmessage = mainOnMessage; broadcastSnapshot(); }
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
    markBroadcastProven(); // receiving anything proves the channel reaches siblings
    const msg = parseEditorSyncMsg(ev.data);
    if (!msg) { console.warn('[sync] dropped malformed channel message (popout)', ev.data); return; }
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
      return;
    }
    if (msg.t === 'assetSelect') {
      applyRemoteAssetSelection(msg.asset as SelectedAsset | null);
      return;
    }
    if (msg.t === 'meshStats') {
      applyRemoteMeshStats(msg.stats as MeshStats | null);
      return;
    }
  };
  // Request the current state on open. A SINGLE hello is lost if the main
  // viewport hasn't booted yet — and in the studio DockShell the reload
  // coordinator serializes iframe loads one-at-a-time, so a panel routinely
  // connects SECONDS before its Edit viewport ("main") is ready to answer. The
  // panel would then wait for the next edit-triggered snapshot (looking
  // "没接通" until the user happens to edit). Re-poll a few times so we latch
  // onto a late-booting main; stop as soon as a snapshot lands (markMainConnected).
  postSync({ t: 'hello' });
  let tries = 0;
  const poll = setInterval(() => {
    if (mainConnected || ++tries > 20) { clearInterval(poll); return; }
    postSync({ t: 'hello' });
  }, 500);
}

export function initSync(): void {
  if (syncChannel) return; // idempotent
  // Cross-process doc sync (works even when BroadcastChannel can't span Tauri
  // WebviewWindow processes): the main window persists the doc to localStorage on
  // every edit; other same-origin windows get a `storage` event and re-read it.
  // (Fires only in OTHER contexts, never the writer — so no loop; loadDocFromStorage
  // sets bus.doc + bumps the React version without re-persisting.)
  if (typeof window !== 'undefined') {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === docKey(currentSceneId) && e.newValue) { loadDocFromStorage(); return; }
      // Channel-択一: only honour the localStorage selection mirror when the
      // BroadcastChannel transport is NOT live (fallback path). When the channel
      // is open it is the sole selection transport, so ignore selKey writes.
      if (!broadcastActive() && e.key === selKey() && e.newValue) {
        try {
          const ids = JSON.parse(e.newValue);
          // Short-circuit identical echoes so a redundant `storage` event never
          // re-emits / re-renders (defence-in-depth alongside applyingRemote).
          if (Array.isArray(ids) && !sameIdList(selectionList, ids)) {
            applyingExternalSel = true; selectionList = ids; emitSelection(); applyingExternalSel = false;
          }
        } catch { /* ignore */ }
      }
    };
    window.addEventListener('storage', onStorage);
    // Lifecycle: the channel + storage listener live for the document's lifetime,
    // but explicitly release them on pagehide so a reused bfcache document or a
    // popout that navigates doesn't leak a dangling channel / double-handle.
    window.addEventListener('pagehide', () => {
      try { syncChannel?.close(); } catch { /* already closed */ }
      try { controlChannel?.close(); } catch { /* already closed */ }
      syncChannel = null;
      controlChannel = null;
      window.removeEventListener('storage', onStorage);
    }, { once: true });
  }
  // The channel IS the viewport↔panels pair: keyed per game AND per scene
  // file, so an editor instance editing level1 and another editing level2
  // (same game, separate windows) never cross-talk. Panels resolve the same
  // scene file via initSceneList before connecting.
  syncChannel = openSyncChannel(`${getSceneId()}::${currentSceneFile ?? 'main'}`);
  if (!syncChannel) return; // BroadcastChannel unavailable → still have storage sync
  if (IS_POPOUT) initPopout(syncChannel);
  else initMain(syncChannel);

  // Per-GAME control channel — survives scene-file switches so an in-place
  // switchSceneFile re-pairs every window WITHOUT a page reload (no WebGPU context
  // recreate → no WKWebView wedge). Main: a panel's openScene → switch in place.
  // Panels: the viewport's sceneChanged → reload the (GPU-less) panel iframe to
  // re-pair on the new per-file channel.
  controlChannel = openControlChannel(getSceneId());
  if (controlChannel) {
    controlChannel.onmessage = (ev: MessageEvent) => {
      const msg = parseEditorSyncMsg(ev.data);
      if (!msg) return;
      if (!IS_POPOUT) {
        if (msg.t === 'openScene') void switchSceneFile(msg.id);
      } else if (msg.t === 'sceneChanged' && msg.id !== currentSceneFile) {
        location.reload();
      }
    };
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

let applyingRemoteAssetSel = false;
export function setAssetSelection(asset: SelectedAsset | null): void {
  if (selectedAsset?.guid === asset?.guid) return;
  selectedAsset = asset;
  emitAssetSel();
  if (!applyingRemoteAssetSel) postSync({ t: 'assetSelect', asset });
}
export function applyRemoteAssetSelection(asset: SelectedAsset | null): void {
  applyingRemoteAssetSel = true;
  selectedAsset = asset;
  emitAssetSel();
  applyingRemoteAssetSel = false;
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

let applyingRemoteMeshStats = false;
/** MAIN window: publish derived stats for the currently-selected mesh (broadcasts
 *  to popouts/panels). Pass null to clear. */
export function publishMeshStats(stats: MeshStats | null): void {
  selectedMeshStats = stats;
  emitMeshStats();
  if (!applyingRemoteMeshStats) postSync({ t: 'meshStats', stats });
}
export function applyRemoteMeshStats(stats: MeshStats | null): void {
  applyingRemoteMeshStats = true;
  selectedMeshStats = stats;
  emitMeshStats();
  applyingRemoteMeshStats = false;
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
