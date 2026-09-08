import { describe, expect, it } from 'bun:test';
import { createAuthoringTransaction } from '../../product/resource-transaction';

describe('authoring conflict recovery contract', () => {
  it('keeps current/expected/recovery/inverse fields structured for a non-replayable draft', async () => {
    const transaction = createAuthoringTransaction({
      read: async () => ({ revision: 'external-r2', subjects: { 'mesh:mesh-1': { kind: 'mesh' as const, id: 'mesh-1', values: { scale: 1 } } } }),
      write: async () => ({ ok: true as const, revision: 'never', path: 'never' }),
    });
    const result = await transaction.commit({ requestId: 'run-2', subject: { kind: 'mesh', id: 'mesh-1' }, snapshot: { revision: 'local-r1', values: { scale: 1 } }, expectedRevision: 'local-r1', patch: { scale: 2 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.recoveryActions.length).toBeGreaterThan(0);
      expect(result.error.details).toMatchObject({ replayable: false, inverse: 'owner-defined' });
    }
  });
});
