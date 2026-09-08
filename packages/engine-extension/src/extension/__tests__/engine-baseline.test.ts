import { describe, expect, test } from 'bun:test';
import manifest from '../fixtures/engine-baseline.json';
import { createEngineBaselineAdapter } from '../engine-baseline';

describe('Engine baseline extension contract', () => {
  test('provides preview/runtime capabilities without product imports', () => {
    expect(manifest.kind).toBe('engine');
    expect(manifest.variants).toEqual(['web', 'desktop']);
    expect(manifest.capabilities).toContain('engine.preview.create');
    expect(JSON.stringify(manifest)).not.toMatch(/agent|editor/i);
  });

  test('activates both supported platform variants', () => {
    const adapter = createEngineBaselineAdapter();
    expect(adapter.activate('web')).toEqual({
      contribution: 'engine.preview',
      capability: 'engine.preview.create',
      variant: 'web',
    });
    expect(adapter.activate('desktop').variant).toBe('desktop');
  });

  test('rejects unsupported platform variants', () => {
    const adapter = createEngineBaselineAdapter();
    expect(() => adapter.activate('mobile' as never)).toThrow('Unsupported engine variant: mobile');
  });
});
