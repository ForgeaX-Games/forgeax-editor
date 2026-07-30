import { describe, expect, test } from 'bun:test';

import { createGatewayCommitCollar } from '../product/commit-collar';

describe('core commit collar undo and redo', () => {
  test('publishes inverse only after the expected canonical revision is present', async () => {
    const calls: string[] = [];
    const collar = createGatewayCommitCollar({
      executeCanonical: async (input) => {
        calls.push(`effect:${String(input)}`);
        return { revision: 'revision-1', result: input, inverse: 'inverse' };
      },
      publishAuthored: async (entry) => {
        calls.push(`publish:${entry.operationId}`);
      },
    });
    const committed = await collar.commit({ runId: 'run-1', operationId: 'set', input: 'forward' });
    expect(committed).toMatchObject({ ok: true });
    const undone = await collar.undo({
      runId: 'run-2',
      operationId: 'undo',
      input: 'inverse',
      sourceRunId: 'run-1',
      expectedRevision: 'revision-1',
    });
    expect(undone).toMatchObject({ ok: true, revision: 'revision-1' });
    expect(calls).toEqual(['effect:forward', 'publish:set', 'effect:inverse', 'publish:undo']);
  });
});
