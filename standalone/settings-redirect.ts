// Standalone host seam: the interface TopBar gear (and the Ctrl+, shortcut)
// calls openOverlay('settings'), but the full-screen Settings overlay is a
// STUDIO product surface (@forgeax/settings) that this host never injects —
// clicking the gear used to flip activeOverlay and render nothing (dead
// button). Redirect the intent to the dockable Settings editor panel
// (ep:settings) through the standard panel:open bus event, the same path the
// dock Window menu uses. Chrome layout only — no editor state, no gateway op.
//
// The store/bus are injected as minimal structural interfaces so the unit
// test stays hermetic (no interface-store import, no DOM).

export interface OverlayStoreLike {
  subscribe(listener: (state: { readonly activeOverlay: string | null }) => void): () => void;
  getState(): { readonly activeOverlay: string | null; closeOverlay(): void };
}

export interface PanelOpenBusLike {
  emit(event: 'panel:open', payload: { id: string; source?: string }): void;
}

/** Dock id of the Settings editor panel (editorPanelIds are ep:-prefixed). */
export const SETTINGS_PANEL_ID = 'ep:settings';

const LOG_PREFIX = '[settings-redirect]';

// Probe logging must bypass the editor's console bridge
// (viewport-runtime-bridges.ts installConsoleBridge monkeypatches console.* and
// re-emits every call into the panel bridge -> store -> subscriber loop).
// This module evaluates BEFORE the viewport boots, so capturing the methods
// here yields the unwrapped originals and breaks that feedback cycle.
const rawInfo: (...args: unknown[]) => void = /* @__PURE__ */ (() => {
  try { return console.info.bind(console); } catch { return () => {}; }
})();

function log(...args: unknown[]): void {
  try { rawInfo(LOG_PREFIX, ...args); } catch { /* probe must never break the host */ }
}

export function installSettingsPanelRedirect(store: OverlayStoreLike, bus: PanelOpenBusLike): () => void {
  // Reentrancy guard: closeOverlay() sets state synchronously, re-entering
  // this listener with activeOverlay already null. The flag keeps the
  // contract explicit instead of relying on that notification ordering.
  let redirecting = false;
  let lastLogged: string | null | undefined;
  log('installed');
  return store.subscribe((state) => {
    // Log transitions only — the shell store notifies on every state change,
    // and value-repeats carry no diagnostic signal.
    if (state.activeOverlay !== lastLogged) {
      lastLogged = state.activeOverlay;
      log('notify activeOverlay =', state.activeOverlay);
    }
    if (redirecting || state.activeOverlay !== 'settings') return;
    redirecting = true;
    try {
      log('redirect: closeOverlay + emit panel:open', SETTINGS_PANEL_ID);
      store.getState().closeOverlay();
      bus.emit('panel:open', { id: SETTINGS_PANEL_ID, source: 'topbar.settings' });
      log('redirect: emitted');
    } finally {
      redirecting = false;
    }
  });
}
