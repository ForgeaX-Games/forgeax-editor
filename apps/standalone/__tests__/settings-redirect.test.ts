import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  installSettingsPanelRedirect,
  SETTINGS_PANEL_ID,
  type OverlayRedirectInstaller,
  type PanelOpenBusLike,
} from '../settings-redirect';

// Shell-state behavior is exercised against the real store by Interface's
// application-overlay-redirect contract. Here only the product destination is owned.
function fixture() {
  let onSettings: () => void = () => { throw new Error('not installed'); };
  let requestedOverlay: string | undefined;
  let disposed = false;
  const dispose = () => { disposed = true; };
  const install: OverlayRedirectInstaller = (overlayId, callback) => {
    requestedOverlay = overlayId;
    onSettings = callback;
    return dispose;
  };
  const events: Array<{ event: string; id: string; source?: string }> = [];
  const bus: PanelOpenBusLike = {
    emit: (event, payload) => { events.push({ event, ...payload }); },
  };
  return { install, bus, events, dispose, request: () => onSettings(),
    get requestedOverlay() { return requestedOverlay; },
    get disposed() { return disposed; } };
}

describe('standalone settings destination', () => {
  it('reads dock visibility from the public App Shell contract', () => {
    const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(source).toContain("import { isDockPanelVisible } from '@forgeax/app-shell/dock';");
    expect(source).not.toContain('@forgeax/interface/components/DockShell/DockRegion');
    expect(packageJson.dependencies?.['@forgeax/app-shell']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers only settings, does not route during setup, and returns the owner disposer', () => {
    const f = fixture();
    const dispose = installSettingsPanelRedirect(f.install, f.bus);
    expect(f.requestedOverlay).toBe('settings');
    expect(f.events).toEqual([]);
    expect(dispose).toBe(f.dispose);
    dispose();
    expect(f.disposed).toBe(true);
  });

  it('opens the product settings panel with the original source identity', () => {
    const f = fixture();
    installSettingsPanelRedirect(f.install, f.bus);
    f.request();
    expect(f.events).toEqual([{ event: 'panel:open', id: SETTINGS_PANEL_ID, source: 'topbar.settings' }]);
  });

  it('checks current visibility on every request for open-close-open parity', () => {
    const f = fixture();
    let visible = false;
    installSettingsPanelRedirect(f.install, f.bus, () => visible);
    f.request();
    visible = true;
    f.request();
    visible = false;
    f.request();
    expect(f.events).toEqual(['panel:open', 'panel:close', 'panel:open'].map((event) => ({
      event, id: SETTINGS_PANEL_ID, source: 'topbar.settings',
    })));
  });

  it('does not suppress product bus errors', () => {
    const f = fixture();
    const error = new Error('bus unavailable');
    installSettingsPanelRedirect(f.install, { emit: () => { throw error; } });
    expect(f.request).toThrow(error);
  });
});
