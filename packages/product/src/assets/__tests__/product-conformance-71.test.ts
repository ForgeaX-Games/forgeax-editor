import { describe, expect, test } from 'bun:test';
import { ASSET_CONFORMANCE_SCENARIOS, runAssetConformance } from '../conformance-driver';

describe('asset conformance 71 scenarios', () => {
  test('contains every numbered asset scenario and H01-H08 safety scenario', () => {
    expect(ASSET_CONFORMANCE_SCENARIOS).toHaveLength(71);
    expect(new Set(ASSET_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id)).size).toBe(71);
    expect(ASSET_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining(['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08']),
    );
  });

  test('reports complete success without private implementation imports', async () => {
    const report = await runAssetConformance();

    expect(report).toMatchObject({
      total: 71,
      passed: 71,
      failed: 0,
      driver: 'public-product-adapter',
      privateImports: [],
    });
  });
});
