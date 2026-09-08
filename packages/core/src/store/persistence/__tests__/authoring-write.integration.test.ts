import { describe, expect, it } from 'bun:test';
import { createAuthoringTransaction } from '../../../product/resource-transaction';

describe('Project authoring write boundary', () => {
  it('does not treat an in-memory snapshot as authority after a failed write', async () => {
    let writes = 0;
    const transaction = createAuthoringTransaction({
      read: async () => ({ revision: 'r1', subjects: { 'vfx:vfx-1': { kind: 'vfx' as const, id: 'vfx-1', values: { rate: 10 } } } }),
      write: async () => { writes += 1; return { ok: false as const, error: { code: 'project-write-failed', hint: 'disk unavailable', recoveryActions: ['authoring.retry'] } }; },
    });
    const result = await transaction.commit({ requestId: 'run-3', subject: { kind: 'vfx', id: 'vfx-1' }, snapshot: { revision: 'r1', values: { rate: 10 } }, expectedRevision: 'r1', patch: { rate: 20 } });
    expect(result).toMatchObject({ ok: false, error: { code: 'project-write-failed' } });
    expect(writes).toBe(1);
    if (!result.ok) expect(result.error.draft?.values).toEqual({ rate: 20 });
  });
});
