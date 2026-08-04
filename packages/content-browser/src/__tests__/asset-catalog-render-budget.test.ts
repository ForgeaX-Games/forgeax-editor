import { describe, expect, it } from 'bun:test';
import { applyAssetBrowserDelta, type AssetBrowserDeltaState } from '../hooks/useAssetBrowserSnapshot';

interface BudgetRow {
  readonly guid: string;
  readonly label: string;
}

function baseline(): AssetBrowserDeltaState<BudgetRow> {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    guid: `guid-${index}`,
    label: `Asset ${index}`,
  }));
  return {
    rows,
    selection: Object.freeze(['guid-42']),
    expandedTree: Object.freeze(['assets']),
    filter: Object.freeze({ family: 'all', active: true }),
    sort: Object.freeze({ key: 'name', dir: 'asc' }),
    panelRealm: {},
    stale: false,
    reconcileRequired: false,
    rowRenderCounts: new Map(rows.map((row) => [row.guid, 0])),
  };
}

describe('Catalog row render budget', () => {
  it('keeps 10k baseline identity and folds one-row delta/reconcile locally', () => {
    const initial = baseline();
    const start = performance.now();
    const changed = applyAssetBrowserDelta(initial, {
      added: [],
      changed: [{ guid: 'guid-5000', label: 'Changed' } as never],
      removed: [],
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(changed.rows).toHaveLength(10_000);
    expect(changed.rows[42]).toBe(initial.rows[42]);
    expect(changed.rows[5000]).not.toBe(initial.rows[5000]);
    expect(changed.rowRenderCounts?.get('guid-5000')).toBe(1);
    expect(changed.rowRenderCounts?.get('guid-4999')).toBe(0);

    const reconciled = applyAssetBrowserDelta(changed, {
      added: [],
      changed: [],
      removed: [],
      authority: 'authoritative',
    });
    expect(reconciled.rows).toBe(changed.rows);
    expect(reconciled.rowRenderCounts?.get('guid-5000')).toBe(1);
    expect(reconciled.rowRenderCounts?.get('guid-4999')).toBe(0);
  });
});
