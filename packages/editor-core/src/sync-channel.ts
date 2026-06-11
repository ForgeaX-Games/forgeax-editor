// Cross-window editor state sync (design EDITOR-MODE §0.2.2 "弹出 Pop-out").
//
// A popped-out panel lives in its OWN OS window (Tauri WebviewWindow) / browser
// window (window.open fallback) — a SEPARATE document from the main editor
// iframe. Both load the same `/editor/` bundle and are SAME-ORIGIN, so they can
// talk over a BroadcastChannel without any opener reference. This is the
// "跨窗走现有 bus/postMessage" wire the design calls for, realized with the
// strictly-same-origin BroadcastChannel rather than postMessage plumbing.
//
// Authority model (single source of truth = the MAIN window's bus):
//   • MAIN  — owns the engine + authoritative EditorBus. Broadcasts a SNAPSHOT
//             (doc + history + selection + gizmo) on every change; applies
//             incoming commands/ops from popouts to its bus (→ re-broadcast).
//   • POPOUT— renders ONE panel, holds a thin mirror. It does NOT mutate a
//             local authoritative bus; every edit is FORWARDED to main and the
//             resulting snapshot is applied back. No divergence, no double
//             ledger entries.
import type { CommandOrigin, HistoryStep } from './bus';
import type { EditorCommand, EntityId, SceneDocument } from './types';
import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-shared';

export type EditorRole = 'main' | 'popout';

/** The dockable panels that can be popped out.
 *  Re-exported from @forgeax/editor-panels (SSOT). */
export type SyncPanelId = EditorPanelId;

/** A full editor-state snapshot the main window broadcasts to popouts. */
export interface EditorSnapshot {
  doc: SceneDocument;
  selection: EntityId[];
  gizmo: 'translate' | 'rotate' | 'scale';
  history: HistoryStep[];
  applied: number;
  canUndo: boolean;
  canRedo: boolean;
}

export type EditorSyncMsg =
  // popout → main: "I just opened, send me the current state"
  | { t: 'hello' }
  // main → popouts: authoritative state
  | { t: 'snapshot'; snap: EditorSnapshot }
  // popout → main: forwarded mutations / ops
  | { t: 'cmd'; cmd: EditorCommand; origin: CommandOrigin }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'jumpTo'; target: number }
  | { t: 'replaceDoc'; doc: SceneDocument }
  // selection / gizmo flow BOTH ways (echoed back inside the snapshot too)
  | { t: 'selection'; ids: EntityId[] }
  | { t: 'gizmo'; mode: 'translate' | 'rotate' | 'scale' }
  // popout → main: UI intents that main forwards to the interface shell
  | { t: 'frame'; id?: EntityId }
  | { t: 'refEntity'; id: EntityId }
  | { t: 'refAsset'; asset: { guid: string; kind: string; name: string; packPath?: string } }
  // popout → main: remember this window's geometry for next time (design §0.2.3)
  | { t: 'geom'; panel: SyncPanelId; w: number; h: number; x: number; y: number }
  // popout → main: the popout window is closing → redock the panel
  | { t: 'bye'; panel: SyncPanelId }
  // main → popouts: asset file list changed (trigger reload in Assets panel)
  | { t: 'assetsChanged' };

/** Persisted geometry of a popped-out panel window. */
export interface PopoutGeom { w: number; h: number; x: number; y: number }

/** All dockable panel IDs, re-exported from @forgeax/editor-panels (SSOT). */
const ALL_PANELS: readonly SyncPanelId[] = EDITOR_PANELS;

/** A popout window is launched with `?panel=<id>`; everything else is main.
 *  `search` defaults to the live location so callers can pass it for tests. */
export function getPopoutPanel(
  search: string = typeof location !== 'undefined' ? location.search : '',
): SyncPanelId | null {
  const p = new URLSearchParams(search).get('panel');
  return ALL_PANELS.includes(p as SyncPanelId) ? (p as SyncPanelId) : null;
}

export function getEditorRole(search?: string): EditorRole {
  return getPopoutPanel(search) ? 'popout' : 'main';
}

/** Open the per-scene sync channel, or null if BroadcastChannel is unavailable
 *  (very old runtime) — callers then degrade to a no-op (single-window only). */
export function openSyncChannel(sceneId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(`forgeax:editor:sync:${sceneId}`);
  } catch {
    return null;
  }
}
