import { describe, expect, it } from 'bun:test';
import { createAuthoringTransaction, type AuthoringProjectState } from '../resource-transaction';

function state(revision = 'r1'): AuthoringProjectState {
  return { revision, subjects: { 'material:mat-1': { kind: 'material', id: 'mat-1', values: { roughness: 0.5 } } } };
}

describe('authoring producer transaction', () => {
  it('serializes before write and publishes only after a successful terminal commit', async () => {
    let current = state();
    const transaction = createAuthoringTransaction({
      read: async () => current,
      write: async (request) => { current = { revision: 'r2', subjects: request.subjects }; return { ok: true, revision: 'r2', path: 'authoring/material/mat-1.json' }; },
    });
    const result = await transaction.commit({ requestId: 'run-1', subject: { kind: 'material', id: 'mat-1' }, snapshot: { revision: 'r1', values: { roughness: 0.5 } }, expectedRevision: 'r1', patch: { roughness: 0.25 } });
    expect(result.ok).toBe(true);
    expect(current.revision).toBe('r2');
    if (result.ok) expect(result.artifacts[0]?.kind).toBe('project-file');
  });

  it('returns draft evidence and does not publish a partial Project fact on conflict', async () => {
    let writes = 0;
    const transaction = createAuthoringTransaction({ read: async () => state('r2'), write: async () => { writes += 1; return { ok: true, revision: 'r3', path: 'never' }; } });
    const result = await transaction.commit({ requestId: 'run-conflict', subject: { kind: 'material', id: 'mat-1' }, snapshot: { revision: 'r1', values: { roughness: 0.5 } }, expectedRevision: 'r1', patch: { roughness: 0.1 } });
    expect(result).toMatchObject({ ok: false, error: { code: 'authoring-revision-conflict', expected: 'r1', current: 'r2' } });
    if (!result.ok) expect(result.error.draft?.values).toEqual({ roughness: 0.1 });
    expect(writes).toBe(0);
  });
});
