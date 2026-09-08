import { describe, expect, test } from 'bun:test';
import { refreshPlayCatalogUntilReady } from '../play-catalog-ready';

describe('refreshPlayCatalogUntilReady', () => {
  test('refreshes once when no GUID is required', async () => {
    let refreshCount = 0;
    const ok = await refreshPlayCatalogUntilReady({
      refreshCatalog: async () => {
        refreshCount += 1;
        return true;
      },
      listCatalog: () => [],
    });
    expect(ok).toBe(true);
    expect(refreshCount).toBe(1);
  });

  test('retries until the required defaultScene GUID is catalogued', async () => {
    let refreshCount = 0;
    const ok = await refreshPlayCatalogUntilReady({
      refreshCatalog: async () => {
        refreshCount += 1;
        return true;
      },
      listCatalog: () => refreshCount >= 3
        ? [{ guid: '019FB7CE-3400-7000-8000-000000000001' }]
        : [],
    }, {
      requiredGuid: '019fb7ce-3400-7000-8000-000000000001',
      timeoutMs: 1_000,
      retryDelayMs: 0,
    });
    expect(ok).toBe(true);
    expect(refreshCount).toBe(3);
  });

  test('returns false when the catalog never contains the GUID', async () => {
    let now = 0;
    const ok = await refreshPlayCatalogUntilReady({
      refreshCatalog: async () => true,
      listCatalog: () => [],
    }, {
      requiredGuid: '019fb7ce-3400-7000-8000-000000000001',
      timeoutMs: 50,
      retryDelayMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(ok).toBe(false);
  });
});
