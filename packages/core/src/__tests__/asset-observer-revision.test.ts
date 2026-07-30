import { describe, expect, test } from 'bun:test';
import { createAssetObserverAdapter } from '../product/asset-producer-adapter';

describe('core observer revision adapter', () => {
  test('maps a revision gap to scoped recovery without enumerating all assets', () => {
    const adapter = createAssetObserverAdapter({ initialRevision: 'resource:r1' });
    const result = adapter.observe({
      kind: 'revision-gap',
      rootId: 'game-main',
      scope: 'assets/one.glb',
      baselineRevision: 'resource:r1',
      currentRevision: 'resource:r3',
    });

    expect(result.recoveryIntent).toMatchObject({
      kind: 'scoped-reconcile',
      scope: 'assets/one.glb',
      lastKnownGoodRevision: 'resource:r1',
    });
    expect(result.fullScan).toBe(false);
    expect(adapter.stats().fullScans).toBe(0);
  });
});
