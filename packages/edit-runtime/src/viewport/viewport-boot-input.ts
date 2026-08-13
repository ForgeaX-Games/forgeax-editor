// Boot-window input bridge (2026-08-07 bug fix: "view menu clicks / Alt+G/H/J/K
// dead after launch").
//
// The React chrome (view menu + global keyboard router) mounts seconds BEFORE
// createViewport() finishes the async engine boot (createApp / WebGPU). Input
// delivered in that window used to hit a null key handler and vanish silently.
//
// This bridge owns the active-handler slot plus a small pending queue:
//   - route(): deliver immediately once the handler is installed; before that,
//     buffer ONLY discrete modified-key commands (Alt/Ctrl/Meta keydowns —
//     view presets, bookmarks). Plain keys feed the fly keyState and must
//     NEVER be replayed: their keyup may already have fired before our
//     listeners exist, so a replayed keydown would wedge the key in keyState
//     and drift the camera.
//   - install()/uninstall(): driven by createViewport() / its dispose.
//   - readiness mirror: lets the PanelShell camera control stay disabled until
//     the camera session ops it dispatches actually have an applier.

export interface ViewportBootInput {
  route(event: KeyboardEvent): void;
  install(handler: (event: KeyboardEvent) => void): void;
  uninstall(handler: (event: KeyboardEvent) => void): void;
  isReady(): boolean;
  onReadyChange(listener: (ready: boolean) => void): () => void;
}

const PENDING_MAX = 8;

export function createViewportBootInput(): ViewportBootInput {
  let handler: ((event: KeyboardEvent) => void) | null = null;
  let pending: KeyboardEvent[] = [];
  const readyListeners = new Set<(ready: boolean) => void>();
  const setReady = (ready: boolean): void => {
    for (const l of readyListeners) {
      try { l(ready); } catch { /* a listener must never break the viewport */ }
    }
  };
  return {
    route(event) {
      if (handler) { handler(event); return; }
      if (event.type !== 'keydown') return;
      if (!event.altKey && !event.ctrlKey && !event.metaKey) return;
      if (pending.length < PENDING_MAX) pending.push(event);
    },
    install(h) {
      handler = h;
      setReady(true);
      const flush = pending;
      pending = [];
      for (const e of flush) h(e);
    },
    uninstall(h) {
      if (handler !== h) return;
      handler = null;
      pending = [];
      setReady(false);
    },
    isReady: () => handler !== null,
    onReadyChange(listener) {
      readyListeners.add(listener);
      return () => { readyListeners.delete(listener); };
    },
  };
}

/** Singleton bridge shared by createViewport() and the keyboard-router deps. */
export const viewportBootInput = createViewportBootInput();
