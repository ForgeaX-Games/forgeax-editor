/**
 * Typed, synchronous event bus for host-window in-process communication.
 *
 * Renamed from editorBus → panelBridge to clarify its role: a notification
 * transport for cross-component/cross-boundary coordination — NOT the entry
 * point for state-changing operations (those go through gateway.dispatch).
 *
 * Two categories of events flow through this bridge:
 *  1. Coordination signals (drag, chat ref, asset catalog): lightweight
 *     cross-component wiring that does NOT change ledger-visible state.
 *  2. Applier notifications are emitted only when a live host callback consumes
 *     them. Do not add a postMessage compatibility copy: interface receives its
 *     structural bridge injection through PanelRenderers.
 *
 * Feedback: 2026-07-07-content-browser-drag-import-overlay-and-postmessage-legacy
 */
import type { DragAssetRef } from '../assets/drag-asset-spawn';
import type { AssetChatRef } from './cross-panel-types';
import type { EntityId } from '../types';

// ---------------------------------------------------------------------------
// Event map — every host→host message type that was formerly postMessage.
// ---------------------------------------------------------------------------

export interface PanelBridgeEvents {
  dragAssetStart: DragAssetRef;
  dragAssetEnd: void;
  addAssetToScene: DragAssetRef;
  /** Asset file/catalog changed; directory-only skips pack-catalog refresh. */
  assetsChanged: { hint?: 'directory-only' | 'pack-changed'; source?: 'local-op' | 'disk-watch' };
  /** In-process edit-runtime diagnostics; play keeps its real iframe VAG wire. */
  editorHealth: { level: 'info' | 'warn' | 'error'; code: string; message: string; ts: number };
  editorConsole: { level: 'log' | 'warn' | 'error' | 'info' | 'debug'; text: string; ts: number };
  editorNetwork: { kind: 'fetch' | 'xhr' | 'ws'; method: string; url: string; status: number; ms: number; ok: boolean; ts: number };
  editorRef: EditorRefPayload;
  addAssetToChat: AssetChatRef[];
}

export type EditorRefPayload =
  | { kind: 'entity'; id: EntityId; name: string; components: string[]; source?: { plugin?: string; docId?: string } }
  | { kind: 'component'; entityId: EntityId; entityName: string; comp: string; value: unknown }
  | { kind: 'asset'; guid: string; assetKind: string; name: string; packPath?: string };

// ---------------------------------------------------------------------------
// Minimal typed emitter (no third-party dependency).
// ---------------------------------------------------------------------------

type Listener<T> = (payload: T) => void;

class TypedEmitter<Events> {
  private readonly _listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this._listeners.get(event);
    if (!set) { set = new Set(); this._listeners.set(event, set); }
    set.add(fn as Listener<never>);
    return () => { set!.delete(fn as Listener<never>); };
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K] extends void ? [] : [Events[K]]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    const payload = args[0] as Events[K];
    for (const fn of set) (fn as Listener<Events[K]>)(payload);
  }
}

/** Singleton bridge for host-window panel events. */
export const panelBridge = new TypedEmitter<PanelBridgeEvents>();

// ---------------------------------------------------------------------------
// Backward-compat re-exports (deprecated, will be removed in next PR).
// ---------------------------------------------------------------------------

/** @deprecated Use PanelBridgeEvents instead. */
export type EditorBusEvents = PanelBridgeEvents;

/** @deprecated Use panelBridge instead. */
export const editorBus = panelBridge;
