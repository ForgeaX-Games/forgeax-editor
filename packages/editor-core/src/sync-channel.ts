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
import { z } from 'zod';
import type { CommandOrigin, HistoryStep } from './bus';
import type { EditorCommand, EntityId, EditSession } from './types';

// Panel IDs are defined in @forgeax/editor-shared (SSOT). To avoid a
// dep cycle (core → shared → core), we inline the list here instead of
// importing from shared. The 8-panel set is stable (only changes during
// major editor feature work), and the runtime cost of a second source
// for an 8-element const array is negligible.

/** The 11 dockable business panels of the forgeax editor. */
const EDITOR_PANELS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'material',
  'timeline',
  'matgraph',
  'launcher',
  'asset-inspector',
  'systems',
] as const;

/** Union type of all editor panel IDs. */
type EditorPanelId = (typeof EDITOR_PANELS)[number];

export type EditorRole = 'main' | 'popout';

/** The dockable panels that can be popped out. */
export type SyncPanelId = EditorPanelId;

/** A full editor-state snapshot the main window broadcasts to popouts.
 *
 *  `doc` carries the EditSession's authoring state (entities / order /
 *  nextLocalId). NOTE: BroadcastChannel uses structuredClone, which DROPS the
 *  EditSession's `asset` getter — the receiver (store.ts applySnapshot) revives
 *  it via `makeEditSession` so `bus.doc.asset` is live again on the popout side.
 *  The engine `SceneAsset` POD is a derived projection, never the wire payload. */
export interface EditorSnapshot {
  doc: EditSession;
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
  | { t: 'replaceDoc'; doc: EditSession }
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
  | { t: 'assetsChanged' }
  // panel → main: open another scene/asset pack in the editor (the main
  // window persists the selection and reloads into it — UE asset double-click)
  | { t: 'openScene'; id: string }
  // main → panels: the authority viewport is navigating to another scene —
  // scene-scoped panels (Hierarchy/Inspector/…) reload and re-pair with it
  | { t: 'sceneChanged'; id: string }
  // any panel → all: asset selection changed (Content Browser → Asset Inspector)
  | { t: 'assetSelect'; asset: { guid: string; kind: string; name: string; payload: Record<string, unknown>; packPath: string } | null };

/** Persisted geometry of a popped-out panel window. */
export interface PopoutGeom { w: number; h: number; x: number; y: number }

/** All dockable panel IDs. */
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

// ── Inbound validation ───────────────────────────────────────────────────────
// BroadcastChannel is same-origin-only, so this is NOT a cross-origin attack
// surface — but both receivers (store.ts initMain/initPopout) previously
// raw-cast `ev.data as EditorSyncMsg` and applied `cmd`/`replaceDoc`/`snapshot`
// to the AUTHORITATIVE bus with zero shape check. A version-skewed or corrupt
// message (e.g. a stale popout after a code update) could drive the bus into a
// bad state. We validate the ENVELOPE (discriminant + scalar fields) here;
// heavy payloads (snap/cmd/doc — EditSession / EditorCommand trees that evolve
// independently) stay loose (object-presence only) so legit docs are never
// rejected, mirroring the VAG_SPAWN_ENTITY z.unknown() approach.
const GizmoModeZ = z.enum(['translate', 'rotate', 'scale']);
const EntityIdZ = z.union([z.number(), z.string()]);
const ObjZ = z.object({}).passthrough();

const EditorSyncMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello') }),
  z.object({ t: z.literal('snapshot'), snap: ObjZ }),
  z.object({ t: z.literal('cmd'), cmd: ObjZ, origin: z.unknown() }),
  z.object({ t: z.literal('undo') }),
  z.object({ t: z.literal('redo') }),
  z.object({ t: z.literal('jumpTo'), target: z.number() }),
  z.object({ t: z.literal('replaceDoc'), doc: ObjZ }),
  z.object({ t: z.literal('selection'), ids: z.array(EntityIdZ) }),
  z.object({ t: z.literal('gizmo'), mode: GizmoModeZ }),
  z.object({ t: z.literal('frame'), id: EntityIdZ.optional() }),
  z.object({ t: z.literal('refEntity'), id: EntityIdZ }),
  z.object({
    t: z.literal('refAsset'),
    asset: z.object({ guid: z.string(), kind: z.string(), name: z.string(), packPath: z.string().optional() }),
  }),
  z.object({ t: z.literal('geom'), panel: z.string(), w: z.number(), h: z.number(), x: z.number(), y: z.number() }),
  z.object({ t: z.literal('bye'), panel: z.string() }),
  z.object({ t: z.literal('assetsChanged') }),
  z.object({ t: z.literal('openScene'), id: z.string() }),
  z.object({ t: z.literal('sceneChanged'), id: z.string() }),
  z.object({ t: z.literal('assetSelect'), asset: z.union([ObjZ, z.null()]) }),
]);

/** Validate an inbound BroadcastChannel message envelope. Returns the typed
 *  message (loose inner payloads cast to the precise union — the producer is
 *  trusted for deep ECS shape), or null if the envelope is malformed. */
export function parseEditorSyncMsg(data: unknown): EditorSyncMsg | null {
  const r = EditorSyncMsgSchema.safeParse(data);
  return r.success ? (r.data as EditorSyncMsg) : null;
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

/** Open the per-GAME control channel — survives scene-file switches (the per-file
 *  sync channel above is recreated on every switch). Carries only the
 *  file-independent navigation signals (`openScene` panel→main, `sceneChanged`
 *  main→panels) so a scene switch can re-pair every window/panel IN PLACE without
 *  a full `location.reload` (which on WKWebView drops the WebGPU context and
 *  wedges the GPU process). Keyed per game so two games never cross-talk. */
export function openControlChannel(gameId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(`forgeax:editor:scene-ctl:${gameId}`);
  } catch {
    return null;
  }
}
