import { describe, expect, test } from 'bun:test';

import {
  checkWave1Compatibility,
  createValidWave1Evidence,
  createValidWave1Manifest,
} from '../product-conformance';
import {
  ASSET_CONFORMANCE_SCENARIOS,
  runAssetConformance,
  validateAssetConformanceFixtures,
} from '@forgeax/editor-product';

describe('Wave 1 immutable input compatibility', () => {
  test('accepts a complete immutable manifest and matching evidence', () => {
    const manifest = createValidWave1Manifest();
    const evidence = createValidWave1Evidence(manifest);

    expect(checkWave1Compatibility(manifest, evidence)).toEqual({
      ok: true,
      blocking: false,
      code: 'wave1-compatible',
    });
  });

  test('returns a structured blocking result for a missing producer', () => {
    const manifest = createValidWave1Manifest();
    const evidence = createValidWave1Evidence(manifest);
    delete evidence.producers.engine;

    const result = checkWave1Compatibility(manifest, evidence);

    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.code).toBe('wave1-input-blocked');
    expect(result.issues).toContain('missing-producer:engine');
  });

  test('rejects evidence whose merged commit is not an ancestor', () => {
    const manifest = createValidWave1Manifest();
    const evidence = createValidWave1Evidence(manifest);
    evidence.producers.engine!.isAncestor = false;

    const result = checkWave1Compatibility(manifest, evidence);

    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.issues).toContain('ancestor-mismatch:engine');
  });

  test('rejects producer version content drift', () => {
    const manifest = createValidWave1Manifest();
    const evidence = createValidWave1Evidence(manifest);
    evidence.producers['platform-io']!.observedVersion = 'wrong-version';

    const result = checkWave1Compatibility(manifest, evidence);

    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.issues).toContain('version-mismatch:platform-io');
  });

  test('rejects a missing schema or fixture instead of guessing a path', () => {
    const manifest = createValidWave1Manifest();
    const evidence = createValidWave1Evidence(manifest);
    evidence.producers.harness!.fixtureAvailable = false;

    const result = checkWave1Compatibility(manifest, evidence);

    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.issues).toContain('missing-fixture:harness');
  });
});

describe('public asset conformance', () => {
  test('runs all 71 scenarios through the product adapter', async () => {
    const report = await runAssetConformance();

    expect(report.total).toBe(71);
    expect(report.passed).toBe(71);
    expect(report.failed).toBe(0);
    expect(report.scenarioIds).toContain('H01');
    expect(report.scenarioIds).toContain('H08');
    expect(report.driver).toBe('public-product-adapter');
    expect(report.privateImports).toEqual([]);
  });

  test('publishes a machine-valid fixture manifest with recovery anchors', () => {
    const validation = validateAssetConformanceFixtures(ASSET_CONFORMANCE_SCENARIOS);

    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual([]);
  });
});
