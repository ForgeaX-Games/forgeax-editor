/**
 * WindowManager — detach a surface into its own OS window and redock it.
 *
 * This is the "windowing" layer. It is the OUT-OF-window twin of keep-alive:
 * keep-alive hosts a surface CSS-hidden inside the main window; windowing hosts
 * it in a separate Tauri WebviewWindow. The owning store flips a surface
 * between `docked` and `floating` and this manager makes the OS-level change.
 *
 * Pattern adapted from gameclaw_pet/src/shared/window-manager.ts (dynamic
 * WebviewWindow create/destroy), but our detached windows reuse the SAME
 * frontend bundle — they load `index.html?surface=...` and the entry renders a
 * single <DetachedSurface>. Cross-window business state stays consistent for
 * free because every window talks to the same backend (/api, /ws).
 *
 * Browser form: `canDetach()` is false and every method is a safe no-op, so the
 * web app is unaffected.
 */
import { isTauri, loadWebviewWindowApi } from './runtime';
import {
  type SurfaceDescriptor,
  encodeSurfaceQuery,
  surfaceWindowLabel,
} from './surface';

export interface DetachWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  /** On-desktop position (logical px). Used to reopen a popped panel in place. */
  x?: number;
  y?: number;
}

export interface WindowManager {
  /** True only inside Tauri. Components hide the "弹出窗口" affordance when false. */
  canDetach(): boolean;
  /** Open (or focus, if already open) a detached window for this surface. */
  openSurfaceWindow(d: SurfaceDescriptor, opts?: DetachWindowOptions): Promise<boolean>;
  /** Close the detached window for this surface, if any. */
  closeSurfaceWindow(d: SurfaceDescriptor): Promise<void>;
  isSurfaceWindowOpen(d: SurfaceDescriptor): Promise<boolean>;
  /** Register a callback fired when ANY detached surface window is closed
   *  (by the user clicking its close button). Used by the store to redock. */
  onSurfaceWindowClosed(cb: (d: SurfaceDescriptor) => void): () => void;
  /** Open (or focus) an arbitrary labeled OS window at `url`. Used by the editor
   *  (✎ Edit) to pop a panel out to `/editor/?panel=<id>` — the editor mirrors
   *  its own state over a BroadcastChannel, so no descriptor is needed. The
   *  label MUST match the `fx-surface-*` capability glob. Returns false in the
   *  browser (callers fall back to window.open).
   *  `onClose` is called when the OS window is destroyed (so the caller can
   *  redock the panel). */
  openLabeledWindow(label: string, url: string, opts?: DetachWindowOptions, onClose?: () => void): Promise<boolean>;
  /** Close a labeled window opened by openLabeledWindow, if any. */
  closeLabeledWindow(label: string): Promise<void>;
}

const closeListeners = new Set<(d: SurfaceDescriptor) => void>();

function notifyClosed(d: SurfaceDescriptor) {
  for (const cb of closeListeners) {
    try {
      cb(d);
    } catch {
      /* listener threw — ignore */
    }
  }
}

let _manager: WindowManager | null = null;

export function getWindowManager(): WindowManager {
  if (!_manager) _manager = isTauri() ? createTauriWindowManager() : createNoopWindowManager();
  return _manager;
}

function createTauriWindowManager(): WindowManager {
  return {
    canDetach: () => true,

    async openSurfaceWindow(d, opts) {
      const mod = await loadWebviewWindowApi();
      if (!mod) return false;
      const label = surfaceWindowLabel(d);

      const existing = await mod.WebviewWindow.getByLabel(label);
      if (existing) {
        try {
          await existing.show();
          await existing.setFocus();
        } catch {
          /* window vanished between check and focus */
        }
        return true;
      }

      const hasPos = typeof opts?.x === 'number' && typeof opts?.y === 'number';
      const win = new mod.WebviewWindow(label, {
        url: `index.html?${encodeSurfaceQuery(d)}`,
        title: opts?.title ?? d.id,
        width: opts?.width ?? 960,
        height: opts?.height ?? 720,
        ...(hasPos ? { x: opts!.x, y: opts!.y } : { center: true }),
        resizable: true,
        // Let the webview's own HTML5 drag-and-drop (dockview) work — Tauri's
        // native file-drop otherwise intercepts it.
        dragDropEnabled: false,
        // Detached editor windows are normal app windows (not the transparent
        // always-on-top pet style). macOS gets a native title bar for now;
        // a self-drawn one can come later behind ShellAdapter.startDragging.
      });

      // When the user closes the detached window, redock the surface back into
      // the main window's keep-alive layer. Use `destroyed` (not `close-requested`)
      // so we only call notifyClosed once the OS window is actually gone — firing on
      // `close-requested` would reopen the dock panel while the window was still
      // alive, causing a race if the user closed the dock panel in that gap.
      win.once('tauri://destroyed', () => notifyClosed(d));

      return new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), 2000);
        win.once('tauri://created', () => {
          clearTimeout(t);
          resolve(true);
        });
        win.once('tauri://error', () => {
          clearTimeout(t);
          resolve(false);
        });
      });
    },

    async closeSurfaceWindow(d) {
      const mod = await loadWebviewWindowApi();
      if (!mod) return;
      const existing = await mod.WebviewWindow.getByLabel(surfaceWindowLabel(d));
      if (existing) {
        try {
          await existing.destroy();
        } catch {
          /* already gone */
        }
      }
    },

    async isSurfaceWindowOpen(d) {
      const mod = await loadWebviewWindowApi();
      if (!mod) return false;
      return !!(await mod.WebviewWindow.getByLabel(surfaceWindowLabel(d)));
    },

    onSurfaceWindowClosed(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },

    async openLabeledWindow(label, url, opts, onClose) {
      const mod = await loadWebviewWindowApi();
      if (!mod) return false;

      const existing = await mod.WebviewWindow.getByLabel(label);
      if (existing) {
        try {
          await existing.show();
          await existing.setFocus();
        } catch {
          /* window vanished between check and focus */
        }
        return true;
      }

      const hasPos = typeof opts?.x === 'number' && typeof opts?.y === 'number';
      const win = new mod.WebviewWindow(label, {
        url,
        title: opts?.title ?? label,
        width: opts?.width ?? 420,
        height: opts?.height ?? 640,
        ...(hasPos ? { x: opts!.x, y: opts!.y } : { center: true }),
        resizable: true,
        dragDropEnabled: false,
      });

      // Fire onClose when the window is actually destroyed (not on close-requested,
      // which fires before the window is gone and would cause a double-call race).
      if (onClose) {
        win.once('tauri://destroyed', onClose);
      }

      return new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), 2000);
        win.once('tauri://created', () => {
          clearTimeout(t);
          resolve(true);
        });
        win.once('tauri://error', () => {
          clearTimeout(t);
          resolve(false);
        });
      });
    },

    async closeLabeledWindow(label) {
      const mod = await loadWebviewWindowApi();
      if (!mod) return;
      const existing = await mod.WebviewWindow.getByLabel(label);
      if (existing) {
        try {
          await existing.destroy();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

function createNoopWindowManager(): WindowManager {
  return {
    canDetach: () => false,
    async openSurfaceWindow() {
      return false;
    },
    async closeSurfaceWindow() {},
    async isSurfaceWindowOpen() {
      return false;
    },
    onSurfaceWindowClosed() {
      return () => {};
    },
    async openLabeledWindow() {
      return false;
    },
    async closeLabeledWindow() {},
  };
}
