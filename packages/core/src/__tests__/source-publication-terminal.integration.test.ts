import { describe, expect, test } from 'bun:test';
import { awaitSourcePublicationTerminal } from '../io/operation-runs';

describe('source publication terminal barrier', () => {
  test('does not succeed until Catalog, preview, and runtime observation complete', async () => {
    const order: string[] = [];
    const result = await awaitSourcePublicationTerminal({
      timeoutMs: 100,
      waitForCatalog: async () => { order.push('catalog'); },
      waitForPreview: async () => { order.push('preview'); },
      waitForRuntime: async () => { order.push('runtime'); },
    });

    expect(result).toMatchObject({
      ok: true,
      terminal: 'succeeded',
      observations: { catalog: true, preview: true, runtime: true },
    });
    expect(order).toEqual(['catalog', 'preview', 'runtime']);
  });

  test('turns an observation timeout into a failed terminal result', async () => {
    const result = await awaitSourcePublicationTerminal({
      timeoutMs: 1,
      waitForCatalog: async () => {},
      waitForPreview: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); },
      waitForRuntime: async () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      terminal: 'failed',
      error: { code: 'asset-publish-observation-timeout' },
    });
  });
});
