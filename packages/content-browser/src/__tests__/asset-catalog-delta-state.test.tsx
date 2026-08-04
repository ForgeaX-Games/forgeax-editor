import { describe, expect, it } from 'bun:test';
import type { CatalogDelta } from '@forgeax/engine-types';
import { applyAssetBrowserDelta, type AssetBrowserDeltaState } from '../hooks/useAssetBrowserSnapshot';

interface TestRow {
  readonly guid: string;
  readonly label: string;
}

function delta(overrides: Partial<CatalogDelta>): CatalogDelta {
  return { added: [], changed: [], removed: [], ...overrides };
}

function state(): AssetBrowserDeltaState<TestRow> {
  return {
    rows: [
      { guid: 'stable', label: 'Stable' },
      { guid: 'changed', label: 'Before' },
    ],
    selection: Object.freeze(['stable']),
    expandedTree: Object.freeze(['assets/characters']),
    filter: Object.freeze({ family: 'model', active: true }),
    sort: Object.freeze({ key: 'name', dir: 'asc' }),
    panelRealm: {},
    stale: false,
    reconcileRequired: false,
  };
}

describe('Content Browser Catalog delta state', () => {
  it('keeps UI context and unaffected row identity for added/changed/removed/gap', () => {
    const initial = state();
    const changed = applyAssetBrowserDelta(initial, delta({
      changed: [{ guid: 'changed', label: 'After' } as never],
    }));
    expect(changed.rows.find((row) => row.guid === 'stable')).toBe(initial.rows[0]);
    expect(changed.rows.find((row) => row.guid === 'changed')).toEqual({ guid: 'changed', label: 'After' });
    expect(changed.selection).toBe(initial.selection);
    expect(changed.expandedTree).toBe(initial.expandedTree);
    expect(changed.filter).toBe(initial.filter);
    expect(changed.sort).toBe(initial.sort);
    expect(changed.panelRealm).toBe(initial.panelRealm);

    const added = applyAssetBrowserDelta(changed, delta({ added: [{ guid: 'added', label: 'Added' } as never] }));
    expect(added.rows.find((row) => row.guid === 'stable')).toBe(initial.rows[0]);
    expect(added.rows.find((row) => row.guid === 'changed')).toBe(changed.rows.find((row) => row.guid === 'changed'));

    const removed = applyAssetBrowserDelta(added, delta({ removed: ['changed'] }));
    expect(removed.rows.map((row) => row.guid)).toEqual(['stable', 'added']);
    expect(removed.selection).toBe(initial.selection);
    expect(removed.panelRealm).toBe(initial.panelRealm);

    const gap = applyAssetBrowserDelta(removed, delta({ authority: 'degraded' }));
    expect(gap.rows).toBe(removed.rows);
    expect(gap.reconcileRequired).toBe(true);
    expect(gap.stale).toBe(true);
    expect(gap.selection).toBe(initial.selection);
    expect(gap.expandedTree).toBe(initial.expandedTree);
    expect(gap.filter).toBe(initial.filter);
    expect(gap.sort).toBe(initial.sort);
    expect(gap.panelRealm).toBe(initial.panelRealm);
  });
});
