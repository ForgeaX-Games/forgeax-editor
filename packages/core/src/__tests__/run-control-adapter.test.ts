import { expect, test } from 'bun:test';

import { createGatewayCapabilityAdapter } from '../product/gateway-executor';

test('gateway run adapter exposes progress and cancellation through the product run', () => {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [{
      id: 'importAsset',
      domain: 'session' as const,
      argsSchema: null,
      source: 'builtin' as const,
      title: 'Import Asset',
    }],
    dispatch: () => ({ ok: true }),
  });
  const accepted = adapter.acceptRun('importAsset', {}, {
    runId: 'run-import',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  expect(adapter.updateRunProgress(accepted.runId, { fraction: 0.5, stage: 'cook' })).toMatchObject({ ok: true });
  expect(adapter.cancelRun(accepted.runId)).toMatchObject({ ok: true });
  expect(adapter.getRun(accepted.runId)).toMatchObject({ status: 'cancelled' });
});

test('retry query retains the original terminal failure and links the new attempt', () => {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [{
      id: 'importAsset',
      domain: 'session' as const,
      argsSchema: null,
      source: 'builtin' as const,
      title: 'Import Asset',
    }],
    dispatch: () => ({ ok: false, error: { code: 'IMPORT_FAILED', hint: 'Cook failed' } }),
  });
  const accepted = adapter.acceptRun('importAsset', {}, {
    runId: 'run-import',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  expect(adapter.failRun(accepted.runId, {
    code: 'IMPORT_FAILED',
    hint: 'Cook failed',
    retryable: true,
    recoveryActions: ['operation.retry'],
  })).toMatchObject({ ok: true });
  expect(adapter.getRun(accepted.runId)).toMatchObject({ status: 'failed' });
  const retry = adapter.retryRun(accepted.runId, 'run-import-2');
  expect(retry).toMatchObject({ ok: true, runId: 'run-import-2' });
  expect(adapter.getRun(accepted.runId)?.status).toBe('failed');
  expect(adapter.getRun('run-import-2')).toMatchObject({ parentRunId: 'run-import', attempt: 2 });
});
