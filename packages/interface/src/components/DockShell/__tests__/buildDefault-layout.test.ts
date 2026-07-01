/**
 * Regression guard: dockview layout referencePanel integrity.
 *
 * A layout builder that calls `api.addPanel({ position: { referencePanel } })`
 * with a referencePanel that has NOT been added yet throws at runtime
 * (`dockview: referencePanel '<id>' does not exist`) and crashes the whole
 * studio shell — a class of bug that pure type-checking and DOM-less unit
 * suites miss. It cost a full human trial + verify round once: the 2x2
 * redesign renamed the central panel 'edit' -> 'viewport' but left one stale
 * `referencePanel: 'edit'` in buildFullEditorLayout (DockShell.tsx), so the
 * editor never rendered.
 *
 * This test replays each workspace's buildDefault against a fake DockviewApi
 * that enforces the same invariant dockview enforces — every referencePanel
 * must already exist — without needing a browser.
 */
import { describe, it, expect } from 'bun:test';
import type { DockviewApi } from 'dockview';
import { buildDefault } from '../DockShell';

interface AddPanelArg {
  id: string;
  position?: { referencePanel?: string };
}

/** Minimal DockviewApi stand-in enforcing referencePanel-must-exist. */
function makeFakeApi(): { api: DockviewApi; ids: string[] } {
  const ids: string[] = [];
  const panels = new Map<string, { api: { setSize: () => void; setActive: () => void } }>();
  const api = {
    addPanel(arg: AddPanelArg) {
      const ref = arg.position?.referencePanel;
      if (ref !== undefined && !panels.has(ref)) {
        // Mirror dockview's real error so a regression reads identically.
        throw new Error(`dockview: referencePanel '${ref}' does not exist`);
      }
      const panel = { api: { setSize() {}, setActive() {} } };
      panels.set(arg.id, panel);
      ids.push(arg.id);
      return panel;
    },
    getPanel(id: string) {
      return panels.get(id);
    },
  } as unknown as DockviewApi;
  return { api, ids };
}

describe('buildDefault layout — referencePanel integrity', () => {
  for (const workspaceId of ['edit', 'workbench', 'custom-xyz']) {
    it(`workspace '${workspaceId}' adds every panel before it is referenced (no crash)`, () => {
      const { api, ids } = makeFakeApi();
      expect(() => buildDefault(api, workspaceId)).not.toThrow();
      // sanity: at least one panel got added
      expect(ids.length).toBeGreaterThan(0);
    });
  }

  it("full editor ('edit') seeds the 2x2 viewport panel + core editor panels", () => {
    const { api, ids } = makeFakeApi();
    buildDefault(api, 'edit');
    // The 2x2 run x display viewport lives inside the 'edit' workspace.
    expect(ids).toContain('viewport');
    expect(ids).toContain('ep:hierarchy');
    expect(ids).toContain('ep:inspector');
    expect(ids).toContain('ep:history');
    expect(ids).toContain('chat');
    // Regression: 'ep:history' used to reference a nonexistent 'edit' panel.
    expect(ids).not.toContain('edit');
  });
});
