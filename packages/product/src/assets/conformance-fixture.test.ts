import { describe, expect, test } from 'bun:test';

import {
  ASSET_CONFORMANCE_SCENARIOS,
  type AssetConformanceScenario,
} from './conformance-driver';
import { validateAssetConformanceFixtures } from './conformance-report';

describe('asset conformance fixture schema', () => {
  test('contains the complete 63 lifecycle and 8 safety scenario set', () => {
    const ids = ASSET_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id);
    const validation = validateAssetConformanceFixtures(ASSET_CONFORMANCE_SCENARIOS);

    expect(ids).toHaveLength(71);
    expect(new Set(ids).size).toBe(71);
    expect(validation).toEqual({ ok: true, issues: [] });
    expect(ASSET_CONFORMANCE_SCENARIOS.every((scenario) => scenario.acAnchor.length > 0)).toBe(true);
    expect(ASSET_CONFORMANCE_SCENARIOS.every((scenario) => scenario.fixtureAnchor.length > 0)).toBe(true);
    expect(ASSET_CONFORMANCE_SCENARIOS.every((scenario) => scenario.recoveryActions.length > 0)).toBe(true);
  });

  test('report validation rejects missing acceptance and fixture anchors', () => {
    const missingAnchors = ASSET_CONFORMANCE_SCENARIOS.map((scenario, index) =>
      index === 0 ? { ...scenario, acAnchor: '', fixtureAnchor: '' } : scenario,
    ) as unknown as readonly AssetConformanceScenario[];

    const validation = validateAssetConformanceFixtures(missingAnchors);

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        { scenarioId: 'A01', field: 'acAnchor', code: 'missing-field' },
        { scenarioId: 'A01', field: 'fixtureAnchor', code: 'missing-field' },
      ]),
    );
  });

  test('report validation rejects an omitted or duplicated scenario id', () => {
    const incomplete = ASSET_CONFORMANCE_SCENARIOS.slice(0, -1);
    const duplicate = [...ASSET_CONFORMANCE_SCENARIOS.slice(0, -1), ASSET_CONFORMANCE_SCENARIOS[0]!];

    expect(validateAssetConformanceFixtures(incomplete).ok).toBe(false);
    expect(validateAssetConformanceFixtures(duplicate).issues).toEqual(
      expect.arrayContaining([
        { scenarioId: 'A01', field: 'id', code: 'duplicate-scenario-id' },
        { scenarioId: 'H08', field: 'id', code: 'invalid-scenario-id' },
      ]),
    );
  });
});
