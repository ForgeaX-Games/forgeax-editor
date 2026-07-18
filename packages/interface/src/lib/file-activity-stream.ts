/** file-activity-stream — interface side of the per-session file-activity
 *  ledger.
 *
 *  Subscribes to `onSessionEvent` and consumes two event types emitted by
 *  the server's AgentFsRecorder (packages/server/src/fs/agent-fs-recorder.ts):
 *
 *    file-activity:start  → an agent is about to write a file (lock on)
 *    file-activity:done   → write completed; ledger has the new record
 *
 *  We expose two pieces of derived state:
 *
 *    - `useFileLocks(sid)` — Map<absPath, { agentPath, op, since }> of files
 *      currently being edited. Drives the 🔒 indicator on AgentsPanel /
 *      WorkbenchMode rows.
 *    - `useFileActivityVersion(sid)` — monotonically increasing counter that
 *      bumps every time a 'done' event arrives. Panels that fetch the
 *      ledger via REST (`/api/sessions/:sid/file-activity`) include this
 *      version in their useEffect deps to auto-refresh on writes — no
 *      polling needed.
 *
 *  Events with type `file-activity:*` are routed here exclusively; the
 *  session-stream dispatch explicitly skips them (they'd otherwise be
 *  rendered as system messages by the fallback path). */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSessionClient, type SessionEvent } from '../store-parts/session-client';

export interface FileLockSnapshot {
  agentPath: string;
  op: string;
  since: number;
}

interface SessionState {
  locks: Map<string, FileLockSnapshot>;
  version: number;
}

const _state = new Map<string, SessionState>();
const _listeners = new Set<() => void>();

function getOrInit(sid: string): SessionState {
  let s = _state.get(sid);
  if (!s) {
    s = { locks: new Map(), version: 0 };
    _state.set(sid, s);
  }
  return s;
}

function notify(): void {
  for (const l of _listeners) l();
}

function dispatchFileActivity(evt: SessionEvent): void {
  const t = evt.event.type;
  if (t !== 'file-activity:start' && t !== 'file-activity:done') return;
  const sid = evt.sid;
  const p = evt.event.payload as {
    path?: string;
    agentPath?: string;
    op?: string;
    ts?: number;
  };
  if (typeof p.path !== 'string' || typeof p.agentPath !== 'string') return;
  const state = getOrInit(sid);
  if (t === 'file-activity:start') {
    state.locks.set(p.path, {
      agentPath: p.agentPath,
      op: p.op ?? 'write',
      since: p.ts ?? Date.now(),
    });
  } else {
    state.locks.delete(p.path);
    state.version += 1;
  }
  notify();
}

/** Wired in main.tsx alongside subscribeSessionStream. Idempotent — same
 *  handler key, HMR-safe. */
export function subscribeFileActivityStream(): void {
  getSessionClient().onSessionEvent('file-activity', dispatchFileActivity);
}

function subscribe(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/** React hook — locks for a given session. Re-renders whenever any
 *  file-activity event for that sid arrives. Returns empty Map for unknown
 *  / inactive sids. */
export function useFileLocks(sid: string | null): Map<string, FileLockSnapshot> {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (sid ? _state.get(sid)?.locks ?? _emptyLocks : _emptyLocks),
    () => _emptyLocks,
  );
  return snapshot;
}
const _emptyLocks: Map<string, FileLockSnapshot> = new Map();

/** React hook — bumps every time a file-activity:done lands for `sid`.
 *  Plug into useEffect deps to revalidate ledger fetches without polling. */
export function useFileActivityVersion(sid: string | null): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!sid) return;
    return subscribe(() => {
      const next = _state.get(sid)?.version ?? 0;
      setV(next);
    });
  }, [sid]);
  return v;
}

/** Evict a session's accumulated lock/version state. The module-level `_state`
 *  Map grows one entry per session that ever emits a file-activity event and was
 *  NEVER pruned, so every closed session permanently retained its entry (mem leak
 *  case-10 — symmetric to store.ts closeSession evicting liveAgents /
 *  agentFileActivity). closeSession calls this so closed sessions don't linger. */
export function dropFileActivitySession(sid: string): void {
  if (_state.delete(sid)) notify();
}

/** Test / debug helper — clears all in-memory state. */
export function _resetFileActivityStreamForTesting(): void {
  _state.clear();
  notify();
}

/** Test / debug — number of sessions currently retained in `_state`. The
 *  module-private Map is unreachable from the store DEV bridge, so the leak repro
 *  reads it through this seam. */
export function _fileActivityStreamSessionCount(): number {
  return _state.size;
}

/** Test / debug — seed a session's `_state` entry with `locks` open file locks,
 *  exactly the way a live `file-activity:start` event would (getOrInit + locks.set).
 *  Lets the deterministic repro exercise the close-session leak without a live WS. */
export function _seedFileActivityForTest(sid: string, locks: number): void {
  const st = getOrInit(sid);
  for (let i = 0; i < locks; i++) {
    st.locks.set('seed/' + sid + '/' + i + '.ts', { agentPath: 'agents/forge', op: 'edit', since: 0 });
  }
  st.version += 1;
  notify();
}
