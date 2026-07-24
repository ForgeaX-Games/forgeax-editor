/**
 * Typed, synchronous event bus for host-window in-process communication.
 * A notification transport for cross-component coordination — NOT the entry
 * point for state-changing operations (those go through gateway.dispatch).
 *
 * Two categories of events flow through here:
 *  1. Coordination signals (drag, chat ref, asset catalog): lightweight
 *     cross-component wiring that does NOT change ledger-visible state.
 *  2. Applier notifications, emitted only when a live host callback consumes
 *     them. No postMessage compatibility mirror — interface receives its
 *     structural bridge injection through PanelRenderers.
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
  /**
   * Asset filesystem/write operation FAILED asynchronously (after the applier
   * already returned `ok:true` and control has left the gateway). This is the
   * companion channel to `assetsChanged` for the failure case — panels can
   * subscribe and surface a toast so a background disk/network error becomes
   * user-visible instead of a silent console.warn.
   *
   * Emitted by session appliers (broadcastAssetsError() in
   * session/asset-error-bus.ts) with the op-kind for attribution and a hint
   * text safe to display verbatim. Synchronous INVALID_ARGS from the gateway
   * is NOT emitted here — that path returns `{ok:false}` on `dispatch` and
   * the caller can react at the callsite.
   */
  assetsError: {
    op: string;
    path?: string;
    hint: string;
    ts: number;
  };
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
