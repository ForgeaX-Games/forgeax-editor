/**
 * Typed, synchronous event bus for host-window in-process communication.
 *
 * Replaces the legacy `window.parent?.postMessage` self-posting pattern that
 * survived the M2/M4 single-realm migration (panels are no longer in separate
 * iframes). All events here are **host→host** — iframe↔host messages (engine
 * viewport) still use postMessage.
 *
 * Feedback: 2026-07-07-content-browser-drag-import-overlay-and-postmessage-legacy
 */
import type { DragAssetRef } from '../assets/drag-asset-spawn';
import type { AssetChatRef } from './cross-panel-types';
import type { EntityId } from '../types';

// ---------------------------------------------------------------------------
// Event map — every host→host message type that was formerly postMessage.
// ---------------------------------------------------------------------------

export interface EditorBusEvents {
  dragAssetStart: DragAssetRef;
  dragAssetEnd: void;
  addAssetToScene: DragAssetRef;
  focusPanel: { panel: string };
  editorRef: EditorRefPayload;
  addAssetToChat: AssetChatRef[];
  openSource: { plugin: string; docId: string };
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

/** Singleton bus for host-window editor events. */
export const editorBus = new TypedEmitter<EditorBusEvents>();
