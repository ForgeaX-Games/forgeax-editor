import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
// Relative import (not the '@forgeax/design' workspace alias): design lives
// INSIDE this package (packages/design), and a workspace member depending on
// its own nested member trips bun 1.3.14's --frozen-lockfile graph check
// (install/frozen disagree → CI frozen gate永远红). Same precedent as
// tailwind.config.ts. Root-workspace consumers (studio) keep the alias.
import { applyTheme } from '../packages/design/theme';
import { initI18n } from './i18n';
import { App } from './App';

// Dark-only today; dual-marks data-theme + .dark so tokens.css selectors and
// Tailwind's `dark:` variant stay in lockstep. A light skin later only adds
// token overrides — no .tsx change. index.html already sets these for no-flash;
// this keeps it correct if the attribute is ever cleared.
applyTheme('dark');

// Restore the persisted UI language before first paint. English is the default
// (source of truth); other languages are a user-facing overlay.
initI18n();
import { initAegis } from './lib/aegis';
import { BrandProvider } from './brand';
import { ErrorBoundary } from './components/ErrorBoundary';
import { bootStageEntry } from './boot/driver';
import { bootBroadcast } from './boot/broadcast';
import { isTrustedMessageOrigin } from './lib/trustedOrigins';
import { subscribeNarrativeCopilot } from './lib/narrative-copilot';
import { subscribeFileActivityStream } from './lib/file-activity-stream';
import { subscribePermissionStream } from './lib/permission-stream';
import { subscribePerceptionStream } from './lib/perception-stream';
import { bootUiBridge } from './lib/ui-bridge';
import { syncBrowserPrefsFromServer, startBrowserPrefsSync } from './lib/browser-prefs-sync';
import { useShellStore } from './store';
import { decodeSurfaceFromLocation, getWindowManager, isTauri, surfaceKey } from './lib/platform';
import { DetachedSurface } from './components/DetachedSurface';
import { installHealthBridge } from './components/StatusBar/healthBridge';
import { beginAppBoot, appBootSpan, endAppBoot } from './lib/trace';

// Boot Aegis (Galileo) front-end monitoring first, before any heavy boot work,
// so early throws are captured. Inert unless VITE_AEGIS_* is configured (PROD,
// or dev with VITE_AEGIS_DEV=1). MUST sit after all imports — Vite dev keeps
// source statement order, so a call placed above its import never binds.
initAegis();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');

// Desktop (WKWebView) renders the ambient scene-fx layer far more expensively
// than Chrome: animated large-radius blur + a rotating conic-gradient keep the
// compositor busy even when the UI is idle (a primary source of desktop jank /
// fans spinning). Mark the document so scene-fx.css drops the infinite
// animations and lightens the blur on desktop; the web form keeps the full look.
if (isTauri()) document.documentElement.dataset.perf = 'lite';

// fps / cow-survivor first-person mode pointer-lock bridge for Tauri.
// WKWebView denies the web Pointer Lock API for embedded iframe content, so
// games postMessage `{type:'fx-pointer-capture', capture:bool}` to the parent;
// here we forward that to the Tauri command `set_pointer_capture` which calls
// window.set_cursor_grab + set_cursor_visible(false) at the OS level. On web
// this branch is a no-op (games still use realRequestLock.call(canvas) +
// pointer-lock allow on the iframe). Wire ONCE at boot — listener stays for
// the lifetime of the window.
if (isTauri()) {
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      window.addEventListener('message', (ev) => {
        if (!isTrustedMessageOrigin(ev.origin)) return; // foreign-origin guard
        const data = ev.data as { type?: string; capture?: boolean } | null;
        if (data?.type !== 'fx-pointer-capture') return;
        void invoke('set_pointer_capture', { capture: !!data.capture });
      });
    } catch (err) {
      console.warn('[interface] fx-pointer-capture bridge unavailable:', (err as Error)?.message ?? err);
    }
  })();
}

// Detached-window entry: when launched with `?surface=...` (a popped-out OS
// window in the Tauri shell), render ONLY that surface — not the full IDE
// shell. Same bundle, single index.html, no multi-entry build. The boot splash
// in index.html is dismissed immediately since there's no heavy shell to wait
// for. Business state stays consistent via the shared backend (/api · /ws).
const detachedSurface = decodeSurfaceFromLocation();
if (detachedSurface) {
  // Boot splash is keyed off window.__forgeaxBoot; tell it we're done so the
  // splash fades out for the lightweight detached view.
  (window as unknown as { __forgeaxBoot?: { done?: () => void } }).__forgeaxBoot?.done?.();
  // Detached windows still need the store + live streams: a popped-out plugin
  // routes chat.post → store.sendMessage into the active session and reads
  // pinnedSlug for per-game data. Each OS window is its own client; they stay
  // consistent via the shared backend (/api · /ws). We deliberately skip the
  // window-close→redock listener here (that's the main window's job).
  bootStore();
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary scope="detached-surface">
        <BrandProvider>
          <DetachedSurface surface={detachedSurface} />
        </BrandProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
} else {
  // Restore UI layout prefs from server snapshot (export/import migration path).
  void syncBrowserPrefsFromServer().finally(() => {
    // The server snapshot may carry a different forgeax.locale than the value
    // present at first paint — re-apply it now that localStorage is restored.
    initI18n();
    startBrowserPrefsSync();
  });
  bootStageEntry();
  bootFullShell(rootEl);
}

// Shared store/stream bootstrap. NOTE (R4): chat's session-stream lives in
// `@forgeax/chat` now and is wired by the L3 host (studio). The standalone
// interface AppKit boot is chat-agnostic — it does not subscribe the chat
// message stream (L1 must not import L2 chat).
function bootStore() {
  // Health/INFO bridge — capture shell errors + iframe-forwarded health signals
  // (Play/Edit/plugin) into the status bar. Must run before any iframe mounts so
  // early createApp failures are caught. Idempotent.
  installHealthBridge();
  bootBroadcast(); // R5/P1 唯一公共广播 socket（telemetry / workspace-changed）
  subscribeNarrativeCopilot();
  subscribeFileActivityStream();
  subscribePermissionStream();
  subscribePerceptionStream();
  bootUiBridge(); // UI 语义操作层(ActionRegistry + lease + ui_* 应答;方案:产品AI化-语义操作层)
  void useShellStore.getState().initSessions();
}

function bootFullShell(el: HTMLElement) {
  // 全链路 trace:app.boot 初始化 trace(store-wiring + shell-mount;纯浏览器)。
  beginAppBoot();
  // R3 (2026-05-20 重做) —— boot 流程见 bootStore():subscribeSessionStream 先挂
  // handler,再 initSessions → connectForgeaXWs。store 是唯一真值源。
  appBootSpan('app.boot.store', () => bootStore());

  // Windowing: when a detached surface window is closed by the user, redock it
  // (the main window re-mounts its keep-alive iframe). No-op in the browser
  // (WindowManager.onSurfaceWindowClosed never fires there).
  getWindowManager().onSurfaceWindowClosed((d) => {
    useShellStore.getState().markSurfaceDocked(surfaceKey(d));
  });

  if (import.meta.env.DEV) {
    // DevTools bridge — exposes the Zustand store to window.__dev so that the
    // external forgeax-devtools panel (~/Dev/forgeax-devtools/) can read and
    // patch store state without being part of this repo. Stripped in production.
    (window as unknown as Record<string, unknown>)['__dev'] = useShellStore;
  }

  appBootSpan('app.boot.shell', () => {
    createRoot(el).render(
      <StrictMode>
        <ErrorBoundary scope="studio-shell">
          <BrandProvider>
            <App />
          </BrandProvider>
        </ErrorBoundary>
      </StrictMode>,
    );
  });
  endAppBoot();
}
