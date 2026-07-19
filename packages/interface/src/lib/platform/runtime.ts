/**
 * Runtime detection — is this code running inside the Tauri desktop shell, or
 * a plain browser (the web-server form, e.g. http://9.208:18920)?
 *
 * 这是"一套代码,两种形态"的开关。检测方式与 gameclaw_pet 的 ShellAdapter
 * 一致:Tauri 会在 webview 里注入 `__TAURI_INTERNALS__`。所有原生能力
 * (窗口控制、托盘、多窗口)都 gate 在 `isTauri()` 之后,浏览器形态全 no-op,
 * 现有 web 流程零回归。
 *
 * Tauri 的 JS API 通过**动态 import** 懒加载:浏览器形态永远不会走到那些
 * 分支,所以那个 chunk 永远不会被 fetch,纯 web bundle 无额外成本。
 */

export type PlatformRuntime = 'tauri' | 'web';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function platformRuntime(): PlatformRuntime {
  return isTauri() ? 'tauri' : 'web';
}

// --- Lazy Tauri API loaders ------------------------------------------------
// Cached module handles so repeated calls don't re-import. Each loader returns
// null in the browser so callers can branch without try/catch noise.

type WebviewWindowMod = typeof import('@tauri-apps/api/webviewWindow');
type EventMod = typeof import('@tauri-apps/api/event');
type WindowMod = typeof import('@tauri-apps/api/window');

let _webviewWindow: WebviewWindowMod | null = null;
let _event: EventMod | null = null;
let _window: WindowMod | null = null;

export async function loadWebviewWindowApi(): Promise<WebviewWindowMod | null> {
  if (!isTauri()) return null;
  if (!_webviewWindow) _webviewWindow = await import('@tauri-apps/api/webviewWindow');
  return _webviewWindow;
}

export async function loadEventApi(): Promise<EventMod | null> {
  if (!isTauri()) return null;
  if (!_event) _event = await import('@tauri-apps/api/event');
  return _event;
}

export async function loadWindowApi(): Promise<WindowMod | null> {
  if (!isTauri()) return null;
  if (!_window) _window = await import('@tauri-apps/api/window');
  return _window;
}
