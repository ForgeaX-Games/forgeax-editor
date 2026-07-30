import { describe, expect, test } from 'bun:test';

import { createGatewayCommitCollar } from '../product/commit-collar';

describe('core authored commit order', () => {
  test('canonical effect is observed before the authored sink', async () => {
    const order: string[] = [];
    const collar = createGatewayCommitCollar({
      executeCanonical: async () => {
        order.push('canonical-effect');
        return { revision: 'revision-1', result: { changed: true }, inverse: { kind: 'undo' } };
      },
      publishAuthored: async () => {
        order.push('authored-ledger');
      },
    });

    const result = await collar.commit({
      runId: 'run-1',
      operationId: 'scene.set',
      input: { value: 1 },
    });

    expect(result).toMatchObject({ ok: true, revision: 'revision-1' });
    expect(order).toEqual(['canonical-effect', 'authored-ledger']);
  });
});
