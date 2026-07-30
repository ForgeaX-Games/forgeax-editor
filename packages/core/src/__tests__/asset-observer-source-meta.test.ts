import { describe, expect, test } from 'bun:test';
import { createAssetObserverAdapter } from '../product/asset-producer-adapter';

describe('core asset observer adapter', () => {
  test('emits observation facts without invoking a mutation executor', () => {
    let mutationCalls = 0;
    const adapter = createAssetObserverAdapter({
      executeMutation: () => {
        mutationCalls += 1;
        throw new Error('observer must not execute mutations');
      },
    });
    const result = adapter.observe({
      kind: 'source-meta',
      sourcePath: 'assets/mesh.glb',
      sourcePresent: true,
      metaPresent: false,
      logicalBatchId: 'batch:mesh',
    });

    expect(result.status).toBe('pending');
    expect(result.delta).toBeDefined();
    expect(mutationCalls).toBe(0);
    expect(result).not.toHaveProperty('mutation');
  });
});
