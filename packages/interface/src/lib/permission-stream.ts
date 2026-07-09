/** permission-stream — interface side of the command-permission approval loop.
 *
 *  Subscribes to `onSessionEvent` and consumes two event types the server
 *  publishes while a turn is blocked waiting on a tool permission:
 *
 *    permission:request   → a gated command needs approval; show an approval card
 *    permission:resolved  → it was answered / timed out / aborted; dismiss the card
 *
 *  Exposes `usePendingPermission(sid)` — the current pending request for a
 *  session (or null). `<PermissionPrompt/>` renders it and POSTs the user's
 *  decision to /:sid/permission-reply, which unblocks the held HTTP request in
 *  the MCP permission server → the command executes or is blocked.
 *
 *  Mirrors file-activity-stream's module-singleton + useSyncExternalStore shape;
 *  events with type `permission:*` are routed here exclusively. */

import { useSyncExternalStore } from 'react';
import { getSessionClient, type SessionEvent } from '../store-parts/session-client';

export interface PendingPermission {
  reqId: string;
  toolName: string;
  command: string;
  agent: string;
  /** Raw tool input. For AskUserQuestion it holds { questions: [...] } so the
   *  card can render the option picker and return the user's answers. */
  input?: unknown;
  /** 信任闸命中的能力(exec/write/network/credential/delete);trust-gate ask 卡有,
   *  CC permission-prompt 卡无。用于卡片副标题 + 「记住本会话」的归类。 */
  capability?: string;
  /** trust-gate ask 卡允许「记住本会话」(CC 卡为 false/缺省)。 */
  canRemember?: boolean;
}

const _state = new Map<string, PendingPermission>();
const _listeners = new Set<() => void>();

function notify(): void {
  for (const l of _listeners) l();
}

function dispatchPermission(evt: SessionEvent): void {
  const t = evt.event.type;
  if (t !== 'permission:request' && t !== 'permission:resolved') return;
  const sid = evt.sid;
  const p = (evt.event.payload ?? {}) as Partial<PendingPermission> & { reqId?: string };
  if (typeof p.reqId !== 'string') return;
  if (t === 'permission:request') {
    _state.set(sid, {
      reqId: p.reqId,
      toolName: typeof p.toolName === 'string' ? p.toolName : 'tool',
      command: typeof p.command === 'string' ? p.command : '',
      agent: typeof p.agent === 'string' ? p.agent : 'forge',
      input: (p as { input?: unknown }).input,
      ...(typeof p.capability === 'string' ? { capability: p.capability } : {}),
      ...((p as { canRemember?: unknown }).canRemember === true ? { canRemember: true } : {}),
    });
  } else {
    // resolved — clear only if it's the same request still showing.
    if (_state.get(sid)?.reqId === p.reqId) _state.delete(sid);
  }
  notify();
}

/** Wired in main.tsx. Idempotent (same handler key, HMR-safe). */
export function subscribePermissionStream(): void {
  getSessionClient().onSessionEvent('permission', dispatchPermission);
}

function subscribe(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/** React hook — the pending permission request for `sid`, or null. */
export function usePendingPermission(sid: string | null): PendingPermission | null {
  return useSyncExternalStore(
    subscribe,
    () => (sid ? _state.get(sid) ?? null : null),
    () => null,
  );
}

/** Optimistically clear the local card (called right after POSTing a reply, so
 *  the UI dismisses immediately without waiting for the permission:resolved
 *  round-trip). */
export function clearPendingPermission(sid: string, reqId: string): void {
  if (_state.get(sid)?.reqId === reqId) {
    _state.delete(sid);
    notify();
  }
}

/** Evict on session close (mirror dropFileActivitySession — avoid retaining
 *  closed-session state). */
export function dropPermissionSession(sid: string): void {
  if (_state.delete(sid)) notify();
}
