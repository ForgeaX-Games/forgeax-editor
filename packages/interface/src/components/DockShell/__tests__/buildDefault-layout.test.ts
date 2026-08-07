/**
 * Regression guard for the declarative BUILTIN_WORKBENCHES layouts.
 *
 * Historically this file exercised the imperative `api.addPanel()` sequence
 * of `buildFullEditorLayout` / `seedAiWorkbench` against a fake DockviewApi
 * that enforced the same `referencePanel-must-exist` invariant dockview
 * enforces at runtime. That imperative sequence has been retired: each
 * workbench now owns a `SerializedDockview` layout consumed by
 * `api.fromJSON()`, with region filtering applied at load time by
 * `filterLayoutByMembership`.
 *
 * The invariant these tests protect against — a layout that fails to
 * materialize (referencing panels that don't exist) — is now enforced
 * *by the data shape*: every leaf's `views[]` must have a matching entry
 * in `panels`. We assert that here, plus a handful of higher-level
 * expectations about which panels each built-in workbench seeds.
 */
import { describe, it, expect } from 'bun:test';
import {
  BUILTIN_WORKBENCHES,
  filterLayoutByMembership,
  buildDefault,
  FOOTER_PANEL_IDS,
  FOOTER_PANEL_ID_LIST,
} from '../builtinWorkbenches';

/** Collect every panel id referenced by the grid's leaves. */
function leafPanelIds(layout: { grid: { root: unknown } }): string[] {
  const ids: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; data?: unknown };
    if (n.type === 'leaf') {
      const d = n.data as { views?: string[] } | undefined;
      d?.views?.forEach((v) => ids.push(v));
    } else if (n.type === 'branch') {
      (n.data as unknown[]).forEach(walk);
    }
  };
  walk(layout.grid.root);
  return ids;
}

/** Collect every panel id referenced by edge groups (bottom footer strip, etc.).
 *  Edge groups live OUTSIDE the grid tree, so leafPanelIds never reaches them. */
function edgePanelIds(layout: unknown): string[] {
  const eg = (layout as { edgeGroups?: Record<string, { group?: { views?: string[] } }> }).edgeGroups;
  if (!eg) return [];
  return Object.values(eg).flatMap((entry) => entry.group?.views ?? []);
}

/** Every panel id a layout references — grid leaves + edge groups. */
function allReferencedPanelIds(layout: { grid: { root: unknown } }): string[] {
  return [...leafPanelIds(layout), ...edgePanelIds(layout)];
}

describe('BUILTIN_WORKBENCHES layout data integrity', () => {
  for (const [id, spec] of Object.entries(BUILTIN_WORKBENCHES)) {
    it(`'${id}' — every leaf view has a matching panel spec`, () => {
      const referenced = new Set(leafPanelIds(spec.layout));
      for (const viewId of referenced) {
        expect(spec.layout.panels[viewId]).toBeDefined();
      }
    });

    it(`'${id}' — every panel spec is referenced by a leaf or edge group`, () => {
      const referenced = new Set(allReferencedPanelIds(spec.layout));
      for (const panelId of Object.keys(spec.layout.panels)) {
        expect(referenced.has(panelId)).toBe(true);
      }
    });

    it(`'${id}' — footer chrome panels default into the bottom edge group`, () => {
      const edge = new Set(edgePanelIds(spec.layout));
      expect(edge).toEqual(new Set(['info', 'checkpoints', 'events']));
      for (const panelId of edge) {
        expect(spec.layout.panels[panelId]).toBeDefined();
      }
    });
  }

  it("'scene' fallback stays neutral; editor hosts inject their own layout", () => {
    const ids = leafPanelIds(BUILTIN_WORKBENCHES.scene.layout);
    expect(new Set(ids)).toEqual(new Set(['viewport', 'chat']));
    expect(ids.some((id) => id.startsWith('ep:'))).toBe(false);
    expect(ids).not.toContain('edit');
  });

  it("'ai' seeds exactly [tools, main, chat]", () => {
    expect(new Set(leafPanelIds(BUILTIN_WORKBENCHES.ai.layout))).toEqual(new Set(['tools', 'main', 'chat']));
  });

  it('buildDefault does not throw for known / unknown ids', () => {
    // Minimal DockviewApi mock — only `fromJSON` is called.
    const captured: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = { fromJSON: (data: unknown) => { captured.push(data); } } as any;
    expect(() => buildDefault(api, 'scene')).not.toThrow();
    expect(() => buildDefault(api, 'ai')).not.toThrow();
    expect(() => buildDefault(api, 'custom-xyz')).not.toThrow();
    expect(captured.length).toBe(3);
  });
});

describe('footer chrome SSOT', () => {
  it('FOOTER_PANEL_ID_LIST is the ordered footer chrome set; FOOTER_PANEL_IDS mirrors it', () => {
    expect(FOOTER_PANEL_ID_LIST).toEqual(['info', 'checkpoints', 'events']);
    expect(new Set(FOOTER_PANEL_IDS)).toEqual(new Set(FOOTER_PANEL_ID_LIST));
  });
});

describe('filterLayoutByMembership', () => {
  it('accept-all leaves the layout intact', () => {
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.ai.layout, () => true);
    expect(filtered).not.toBeNull();
    expect(new Set(leafPanelIds(filtered!))).toEqual(new Set(['tools', 'main', 'chat']));
    // Footer chrome (info/checkpoints/events) rides along in the bottom edge group.
    expect(Object.keys(filtered!.panels).sort()).toEqual(
      ['chat', 'checkpoints', 'events', 'info', 'main', 'tools'],
    );
    expect(new Set(edgePanelIds(filtered!))).toEqual(new Set(['info', 'checkpoints', 'events']));
  });

  it('reject-all returns null', () => {
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.ai.layout, () => false);
    expect(filtered).toBeNull();
  });

  it("drops a single view — 'chat' filtered out leaves [tools, main]", () => {
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.ai.layout, (id) => id !== 'chat');
    expect(filtered).not.toBeNull();
    expect(new Set(leafPanelIds(filtered!))).toEqual(new Set(['tools', 'main']));
    expect(filtered!.panels).not.toHaveProperty('chat');
    expect(filtered!.panels).toHaveProperty('tools');
    expect(filtered!.panels).toHaveProperty('main');
  });

  it('keeps sibling tabs when a host-injected editor view is filtered out', () => {
    const hostLayout = {
      grid: {
        width: 320,
        height: 240,
        root: {
          type: 'leaf',
          data: {
            views: ['ep:hierarchy', 'ep:inspector', 'ep:assets'],
            activeView: 'ep:hierarchy',
            id: 'g-editor',
          },
        },
      },
      panels: {
        'ep:hierarchy': { id: 'ep:hierarchy', contentComponent: 'ep:hierarchy', title: 'Hierarchy' },
        'ep:inspector': { id: 'ep:inspector', contentComponent: 'ep:inspector', title: 'Inspector' },
        'ep:assets': { id: 'ep:assets', contentComponent: 'ep:assets', title: 'Assets' },
      },
    } as unknown as import('dockview').SerializedDockview;
    const filtered = filterLayoutByMembership(hostLayout, (id) => id !== 'ep:inspector');
    expect(filtered).not.toBeNull();
    expect(new Set(leafPanelIds(filtered!))).toEqual(new Set(['ep:hierarchy', 'ep:assets']));
  });

  it('falls back activeView when the original host-injected active view is dropped', () => {
    const hostLayout = {
      grid: {
        width: 320,
        height: 240,
        root: {
          type: 'leaf',
          data: { views: ['ep:history', 'ep:capabilities'], activeView: 'ep:history', id: 'g-history' },
        },
      },
      panels: {
        'ep:history': { id: 'ep:history', contentComponent: 'ep:history', title: 'History' },
        'ep:capabilities': { id: 'ep:capabilities', contentComponent: 'ep:capabilities', title: 'Capabilities' },
      },
    } as unknown as import('dockview').SerializedDockview;
    const filtered = filterLayoutByMembership(hostLayout, (id) => id !== 'ep:history');
    expect(filtered).not.toBeNull();
    const leaf = filtered!.grid.root as unknown as { data: { views: string[]; activeView?: string } };
    expect(leaf.data.views).toEqual(['ep:capabilities']);
    expect(leaf.data.activeView).toBe('ep:capabilities');
  });
});
