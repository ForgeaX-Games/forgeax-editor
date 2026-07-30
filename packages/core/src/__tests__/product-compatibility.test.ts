import { describe, expect, test } from 'bun:test';

import {
  checkWave1Compatibility,
  createValidWave1Evidence,
  createValidWave1Manifest,
} from '../../../../scripts/product-conformance';

describe('core product compatibility boundary', () => {
  test('keeps compatibility checking independent of core producer internals', () => {
    const manifest = createValidWave1Manifest();
    const evidence = createValidWave1Evidence(manifest);
    const result = checkWave1Compatibility(manifest, evidence);

    expect(result.ok).toBe(true);
    expect(result.blocking).toBe(false);
  });

  test('exposes blocking availability for incomplete inputs', () => {
    const manifest = createValidWave1Manifest();
    const validEvidence = createValidWave1Evidence(manifest);
    const evidence = {
      producers: {
        ...validEvidence.producers,
        engine: {
          ...validEvidence.producers.engine!,
          schemaAvailable: false,
        },
      },
    };

    const result = checkWave1Compatibility(manifest, evidence);

    if (result.ok) throw new Error('expected incomplete input to block compatibility');
    expect(result.blocking).toBe(true);
    expect(result.code).toBe('wave1-input-blocked');
    expect(result.issues).toContain('missing-schema:engine');
  });
});
