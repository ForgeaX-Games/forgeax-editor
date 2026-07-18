/**
 * ShellAdapter — OS-window / shell capabilities, abstracted over the two
 * runtimes. Mirrors gameclaw_pet/src/shell/ShellAdapter.ts: the React app only
 * ever talks to this interface, so the SAME components run unchanged in the
 * browser (web-server form, every method a no-op) and inside Tauri (real
 * native calls).
 *
 * Keep this surface small and capability-oriented — add a method only when a
 * component actually needs it, and always provide a sane browser fallback.
 */
import {
  isTauri,
  platformRuntime,
  type PlatformRuntime,
  loadWebviewWindowApi,
  loadWindowApi,
} from './runtime';

export interface ShellAdapter {
  readonly runtime: PlatformRuntime;
  isTauri(): boolean;
  /** 'macos' | 'windows' | 'linux' | 'browser'. */
  getPlatform(): Promise<string>;
  /** Begin an OS window drag (for custom/decoration-less title bars). */
  startDragging(): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  setAlwaysOnTop(onTop: boolean): Promise<void>;
}

let _adapter: ShellAdapter | null = null;

export function getShellAdapter(): ShellAdapter {
  if (!_adapter) _adapter = isTauri() ? createTauriAdapter() : createBrowserAdapter();
  return _adapter;
}

function createTauriAdapter(): ShellAdapter {
  return {
    runtime: 'tauri',
    isTauri: () => true,
    async getPlatform() {
      try {
        const os = await import('@tauri-apps/plugin-os');
        return os.platform();
      } catch {
        return 'unknown';
      }
    },
    async startDragging() {
      const mod = await loadWebviewWindowApi();
      await mod?.getCurrentWebviewWindow().startDragging();
    },
    async minimizeWindow() {
      const mod = await loadWebviewWindowApi();
      await mod?.getCurrentWebviewWindow().minimize();
    },
    async toggleMaximizeWindow() {
      const mod = await loadWebviewWindowApi();
      await mod?.getCurrentWebviewWindow().toggleMaximize();
    },
    async closeWindow() {
      const mod = await loadWebviewWindowApi();
      await mod?.getCurrentWebviewWindow().close();
    },
    async setAlwaysOnTop(onTop: boolean) {
      const mod = await loadWindowApi();
      const wvMod = await loadWebviewWindowApi();
      // setAlwaysOnTop lives on the Window handle in tauri 2.
      if (wvMod) await wvMod.getCurrentWebviewWindow().setAlwaysOnTop(onTop);
      else void mod;
    },
  };
}

function createBrowserAdapter(): ShellAdapter {
  // Every native op is a no-op in the browser; the web app behaves exactly as
  // it does today (the user manages the browser window themselves).
  const noop = async () => {};
  return {
    runtime: platformRuntime(),
    isTauri: () => false,
    async getPlatform() {
      return 'browser';
    },
    startDragging: noop,
    minimizeWindow: noop,
    toggleMaximizeWindow: noop,
    closeWindow: noop,
    setAlwaysOnTop: noop,
  };
}
