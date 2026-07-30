import { expect, test } from 'bun:test';

import { createGatewayCommitCollar } from '../product/commit-collar';

test('core adapter reuses an equivalent commit and rejects a conflicting payload', async () => {
  let effects = 0;
  const collar = createGatewayCommitCollar({
    executeCanonical: async (input) => {
      effects += 1;
      return { revision: `revision-${effects}`, result: input };
    },
    publishAuthored: async () => {},
  });
  const first = await collar.commit({ runId: 'run-1', operationId: 'asset.create', input: { guid: 'asset-1' }, idempotencyKey: 'key-1' });
  const repeat = await collar.commit({ runId: 'run-2', operationId: 'asset.create', input: { guid: 'asset-1' }, idempotencyKey: 'key-1' });
  const conflict = await collar.commit({ runId: 'run-3', operationId: 'asset.create', input: { guid: 'asset-2' }, idempotencyKey: 'key-1' });

  expect(first).toMatchObject({ ok: true, runId: 'run-1', reused: false });
  expect(repeat).toMatchObject({ ok: true, runId: 'run-1', reused: true });
  expect(conflict).toMatchObject({ ok: false, error: { code: 'idempotency-conflict' } });
  expect(effects).toBe(1);
});
