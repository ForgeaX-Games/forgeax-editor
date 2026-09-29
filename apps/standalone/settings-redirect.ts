// Product destination for the shell's Settings intent. Interface owns overlay
// observation, clearing and reentry; Editor only toggles its dockable panel.
// The public installer and bus are injected so product tests need no shell store.
export type OverlayRedirectInstaller = (
  overlayId: string,
  onRedirect: () => void,
) => () => void;

export interface PanelOpenBusLike {
  emit(event: 'panel:open' | 'panel:close', payload: { id: string; source?: string }): void;
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

export function installSettingsPanelRedirect(
  installOverlayRedirect: OverlayRedirectInstaller,
  bus: PanelOpenBusLike,
  isSettingsPanelOpen: () => boolean = () => false,
): () => void {
  log('installed');
  return installOverlayRedirect('settings', () => {
    // Query live dock visibility on each request, not at installation time.
    if (isSettingsPanelOpen()) {
      log('redirect: panel visible — emit panel:close', SETTINGS_PANEL_ID);
      bus.emit('panel:close', { id: SETTINGS_PANEL_ID, source: 'topbar.settings' });
    } else {
      log('redirect: emit panel:open', SETTINGS_PANEL_ID);
      bus.emit('panel:open', { id: SETTINGS_PANEL_ID, source: 'topbar.settings' });
    }
    log('redirect: emitted');
  });
}
