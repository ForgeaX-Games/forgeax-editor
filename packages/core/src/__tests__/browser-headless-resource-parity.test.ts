import { describe, expect, test } from 'bun:test';

import { createResourceTransactionAdapter } from '../product/resource-transaction';

describe('browser and headless resource parity', () => {
  test('the same mutation produces equivalent terminal and revision facts', async () => {
    const root = () => ({
      readSnapshot: async () => ({ revision: 'revision-0', active: {}, trash: [] }),
      commit: async (mutation: { identity: string; expectedRevision: string }) => ({
        ok: true as const,
        value: {
          identity: mutation.identity,
          beforeRevision: mutation.expectedRevision,
          afterRevision: 'revision-1',
          changed: true,
        },
      }),
    });
    const browser = createResourceTransactionAdapter(root());
    const headless = createResourceTransactionAdapter(root());
    const input = { identity: 'parity-1', changes: [{ kind: 'put' as const, resourceId: 'scene.pack', bytes: Uint8Array.from([1, 2, 3]) }] };
    const browserPrepared = await browser.prepare(input);
    const headlessPrepared = await headless.prepare(input);
    expect(browserPrepared.ok).toBe(true);
    expect(headlessPrepared.ok).toBe(true);
    if (!browserPrepared.ok || !headlessPrepared.ok) return;
    const [browserResult, headlessResult] = await Promise.all([
      browserPrepared.value.commit(),
      headlessPrepared.value.commit(),
    ]);
    expect(browserResult).toEqual(headlessResult);
  });
});
