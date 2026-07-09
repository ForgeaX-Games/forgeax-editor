import { describe, expect, it } from 'bun:test';
import { hashHue } from './hashHue';

describe('hashHue', () => {
  it('returns an integer in [0, 360) for any string', () => {
    for (const name of ['Edit', 'renderChat', 'DockShell', '', 'a', 'workbenchPanels:wb-plugin-author']) {
      const h = hashHue(name);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('is deterministic — same input yields same hue', () => {
    expect(hashHue('renderChat')).toBe(hashHue('renderChat'));
    expect(hashHue('renderEditorPanel:hierarchy')).toBe(hashHue('renderEditorPanel:hierarchy'));
  });

  it('distributes distinct slot names across distinct hues (no full collision)', () => {
    const names = [
      'SceneEditor', 'renderChat', 'Dashboard',
      'Settings', 'StatusFeeds', 'SidebarAgents',
      'CornerAgentPicker', 'DockShell', 'StatusBar', 'WorkbenchSwitcher',
      'MainAreaBody', 'AgentsBrowser', 'FilesBrowser',
      'renderEditorPanel:hierarchy', 'renderEditorPanel:assets',
      'workbenchPanels:wb-plugin-author',
    ];
    const hues = new Set(names.map(hashHue));
    // Allow up to 1 collision across 14 names; >2 means the hash is too clumpy.
    expect(hues.size).toBeGreaterThanOrEqual(names.length - 1);
  });
});
