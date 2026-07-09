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
import { BUILTIN_WORKBENCHES, filterLayoutByMembership, buildDefault } from '../builtinWorkbenches';

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

describe('BUILTIN_WORKBENCHES layout data integrity', () => {
  for (const [id, spec] of Object.entries(BUILTIN_WORKBENCHES)) {
    it(`'${id}' — every leaf view has a matching panel spec`, () => {
      const referenced = new Set(leafPanelIds(spec.layout));
      for (const viewId of referenced) {
        expect(spec.layout.panels[viewId]).toBeDefined();
      }
    });

    it(`'${id}' — every panel spec is referenced by at least one leaf`, () => {
      const referenced = new Set(leafPanelIds(spec.layout));
      for (const panelId of Object.keys(spec.layout.panels)) {
        expect(referenced.has(panelId)).toBe(true);
      }
    });
  }

  it("full editor ('scene') seeds the 2x2 viewport panel + core editor panels", () => {
    const ids = leafPanelIds(BUILTIN_WORKBENCHES.scene.layout);
    // The 2x2 run x display viewport lives inside the 'scene' workbench.
    expect(ids).toContain('viewport');
    expect(ids).toContain('ep:hierarchy');
    expect(ids).toContain('ep:inspector');
    expect(ids).toContain('ep:history');
    expect(ids).toContain('chat');
    // Regression: 'ep:history' used to reference a nonexistent 'edit' panel
    // when the pre-2x2 code renamed the central panel. The new data shape
    // makes this impossible to encode incorrectly (integrity test above),
    // but keep the sentinel as a cheap sanity assertion.
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

describe('filterLayoutByMembership', () => {
  it('accept-all leaves the layout intact', () => {
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.ai.layout, () => true);
    expect(filtered).not.toBeNull();
    expect(new Set(leafPanelIds(filtered!))).toEqual(new Set(['tools', 'main', 'chat']));
    expect(Object.keys(filtered!.panels).sort()).toEqual(['chat', 'main', 'tools']);
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

  it("keeps sibling tabs — dropping 'ep:material' preserves ep:inspector/mesh/matgraph", () => {
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.scene.layout, (id) => id !== 'ep:material');
    expect(filtered).not.toBeNull();
    const survivingIds = new Set(leafPanelIds(filtered!));
    expect(survivingIds.has('ep:material')).toBe(false);
    expect(survivingIds.has('ep:inspector')).toBe(true);
    expect(survivingIds.has('ep:mesh')).toBe(true);
    expect(survivingIds.has('ep:matgraph')).toBe(true);
  });

  it('falls back activeView when the original active is dropped', () => {
    // Drop ep:history — the sibling leaf's activeView was 'ep:history'.
    const filtered = filterLayoutByMembership(BUILTIN_WORKBENCHES.scene.layout, (id) => id !== 'ep:history');
    expect(filtered).not.toBeNull();
    // Find the leaf that had ep:history as active.
    let found: { views: string[]; activeView?: string } | null = null;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { type?: string; data?: unknown };
      if (node.type === 'leaf') {
        const d = node.data as { views: string[]; activeView?: string };
        if (d.views.includes('ep:timeline')) found = d;
      } else if (node.type === 'branch') {
        (node.data as unknown[]).forEach(walk);
      }
    };
    walk(filtered!.grid.root);
    expect(found).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const leaf = found! as { views: string[]; activeView?: string };
    expect(leaf.views).not.toContain('ep:history');
    // activeView should have been swapped to a surviving view.
    expect(leaf.views).toContain(leaf.activeView!);
  });
});
