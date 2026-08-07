// Regression: standalone TopBar gear / Ctrl+, called openOverlay('settings')
// but this host injects no studio Settings overlay, so the click rendered
// nothing. The redirect must instead close the overlay and emit panel:open
// for the dockable ep:settings panel — and ONLY for the settings overlay.

import { describe, expect, it } from 'bun:test';
import {
  installSettingsPanelRedirect,
  SETTINGS_PANEL_ID,
  type OverlayStoreLike,
  type PanelOpenBusLike,
} from './settings-redirect';

interface FakeStore extends OverlayStoreLike {
  open(id: string): void;
}

function makeStore(): FakeStore {
  let state = { activeOverlay: null as string | null };
  const listeners = new Set<(s: { readonly activeOverlay: string | null }) => void>();
  const notify = (): void => { for (const fn of [...listeners]) fn(state); };
  return {
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getState: () => ({
      get activeOverlay() { return state.activeOverlay; },
      closeOverlay: () => { state = { activeOverlay: null }; notify(); },
    }),
    open: (id) => { state = { activeOverlay: id }; notify(); },
  };
}

function makeBus(): PanelOpenBusLike & { opened: string[] } {
  const opened: string[] = [];
  return { opened, emit: (_event, payload) => { opened.push(payload.id); } };
}

describe('standalone settings-redirect', () => {
  it('redirects openOverlay("settings") to the ep:settings dock panel', () => {
    const store = makeStore();
    const bus = makeBus();
    const dispose = installSettingsPanelRedirect(store, bus);
    try {
      store.open('settings');
      expect(store.getState().activeOverlay).toBeNull();
      expect(bus.opened).toEqual([SETTINGS_PANEL_ID]);
    } finally {
      dispose();
    }
  });

  it('ignores other overlays (dashboard stays open, no panel event)', () => {
    const store = makeStore();
    const bus = makeBus();
    const dispose = installSettingsPanelRedirect(store, bus);
    try {
      store.open('dashboard');
      expect(store.getState().activeOverlay).toBe('dashboard');
      expect(bus.opened).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('stops redirecting after dispose (uninstalled host seam = old behavior)', () => {
    const store = makeStore();
    const bus = makeBus();
    const dispose = installSettingsPanelRedirect(store, bus);
    dispose();
    store.open('settings');
    expect(store.getState().activeOverlay).toBe('settings');
    expect(bus.opened).toEqual([]);
  });

  it('emits once per open — closeOverlay re-notifies synchronously without double-firing', () => {
    const store = makeStore();
    const bus = makeBus();
    const dispose = installSettingsPanelRedirect(store, bus);
    try {
      store.open('settings');
      store.open('settings');
      expect(bus.opened).toEqual([SETTINGS_PANEL_ID, SETTINGS_PANEL_ID]);
    } finally {
      dispose();
    }
  });
});
