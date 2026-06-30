/** perception-stream — interface side of the感知接地 (R5/M8) take-data round-trip.
 *
 *  The orchestration layer (server) asks the running game for ground truth via
 *  the `query_world` / `capture_frame` tools. That HTTP-回打 `/:sid/perception-query`,
 *  which publishes a `perception:query` event onto the session EventBus → WS.
 *
 *  This module is the interface seam (mirrors lib/file-activity-stream.ts): it
 *  subscribes to `onSessionEvent`, picks `perception:query`, and re-emits it as a
 *  DOM `CustomEvent('forgeax:perception-query')`. The preview surface
 *  (PlaySurface, editor submodule) owns the game iframe + the reply POST, so it
 *  listens for that window event and does the postMessage → reply. Keeping the
 *  relay on `window` decouples the editor surface from interface internals (it
 *  never imports forgeax-bridge).
 *
 *  These events have no chat representation — session-stream's dispatch skips
 *  `perception:*` (so they're never rendered as system messages). */

import { onSessionEvent, type SessionEvent } from './forgeax-bridge';

/** Shape carried on the `forgeax:perception-query` CustomEvent detail. */
export interface PerceptionQueryDetail {
  sid: string;
  reqId: string;
  kind: 'world' | 'frame';
  query?: unknown;
}

export const PERCEPTION_QUERY_EVENT = 'forgeax:perception-query';

function dispatchPerception(evt: SessionEvent): void {
  if (evt.event.type !== 'perception:query') return;
  const p = evt.event.payload as { reqId?: string; kind?: string; query?: unknown };
  if (typeof p.reqId !== 'string') return;
  const detail: PerceptionQueryDetail = {
    sid: evt.sid,
    reqId: p.reqId,
    kind: p.kind === 'frame' ? 'frame' : 'world',
    query: p.query,
  };
  try {
    window.dispatchEvent(new CustomEvent(PERCEPTION_QUERY_EVENT, { detail }));
  } catch {
    /* SSR / no window — ignore */
  }
}

/** Wired in main.tsx alongside the other stream subscriptions. Idempotent —
 *  same handler key, HMR-safe. */
export function subscribePerceptionStream(): void {
  onSessionEvent('perception', dispatchPerception);
}
