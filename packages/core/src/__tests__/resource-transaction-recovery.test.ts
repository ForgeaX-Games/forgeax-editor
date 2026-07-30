import { describe, expect, test } from 'bun:test';

import { createResourceTransactionAdapter } from '../product/resource-transaction';

describe('core resource transaction recovery', () => {
  test('commits all changes through one root seam and exposes the committed revision', async () => {
    const calls: unknown[] = [];
    const adapter = createResourceTransactionAdapter({
      readSnapshot: async () => ({ revision: 'revision-0', active: {}, trash: [] }),
      commit: async (mutation) => {
        calls.push(mutation);
        return { ok: true, value: { beforeRevision: 'revision-0', afterRevision: 'revision-1', identity: mutation.identity, changed: true } };
      },
    });

    const prepared = await adapter.prepare({
      identity: 'commit-1',
      changes: [
        { kind: 'put', resourceId: 'pack-a', bytes: Uint8Array.from([1]) },
        { kind: 'put', resourceId: 'pack-b', bytes: Uint8Array.from([2]) },
      ],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const committed = await prepared.value.commit();

    expect(committed).toMatchObject({ ok: true, value: { afterRevision: 'revision-1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ identity: 'commit-1', expectedRevision: 'revision-0' });
  });

  test('a root failure returns a structured result without fabricating a revision', async () => {
    const adapter = createResourceTransactionAdapter({
      readSnapshot: async () => ({ revision: 'revision-4', active: {}, trash: [] }),
      commit: async () => ({ ok: false, error: { code: 'storage-failure', hint: 'second resource failed' } }),
    });
    const prepared = await adapter.prepare({
      identity: 'commit-failure',
      changes: [{ kind: 'put', resourceId: 'pack-a', bytes: Uint8Array.from([1]) }],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(await prepared.value.commit()).toMatchObject({ ok: false, error: { code: 'storage-failure' } });
  });
});
