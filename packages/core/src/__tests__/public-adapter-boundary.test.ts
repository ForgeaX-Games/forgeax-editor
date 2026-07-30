import { describe, expect, test } from 'bun:test';

import {
  createPublicAdapterFixture,
  createValidWave1Manifest,
  runPublicAdapter,
} from '../../../../scripts/product-conformance';

describe('core public adapter boundary', () => {
  test('accepts only the public adapter projection', async () => {
    const manifest = createValidWave1Manifest();
    const result = await runPublicAdapter(
      createPublicAdapterFixture(manifest),
      manifest,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected public adapter to be accepted');
    expect(result.source).toBe('public');
  });

  test('does not turn a private parser into product availability', async () => {
    const manifest = createValidWave1Manifest();
    const result = await runPublicAdapter(
      createPublicAdapterFixture(manifest, { usesFallbackParser: true }),
      manifest,
    );

    expect(result).toMatchObject({
      ok: false,
      blocking: true,
      code: 'adapter-boundary-blocked',
    });
  });
});
