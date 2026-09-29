import { afterEach, describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph, createRuntimeUiOperations } from '../runtime-ui-diagnostics';

describe('runtime UI domain diagnostics counters', () => {
  let graph: ReturnType<typeof createRuntimeUiGraph> | null = null;

  afterEach(() => {
    graph?.dispose();
    graph = null;
  });

  it('reports runtime frames separately from producer-owned domain publishes', () => {
    graph = createRuntimeUiGraph();
    const diagnostics = createRuntimeUiOperations(graph).diagnostics();

    expect(diagnostics.counters).toMatchObject({
      runtimeFrameCount: 0,
      authoredPublishCount: 0,
      assetPublishCount: 0,
      historyPublishCount: 0,
      scenePublishCount: 0,
    });
    expect(diagnostics).not.toHaveProperty('selectorValue');
    expect(diagnostics).not.toHaveProperty('payload');
  });
});
