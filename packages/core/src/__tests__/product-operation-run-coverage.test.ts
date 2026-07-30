import { expect, test } from 'bun:test';

import { createGatewayCapabilityAdapter } from '../product/gateway-executor';

const operationIds = [
  'createAsset',
  'renameAsset',
  'duplicateAsset',
  'destroyAsset',
  'saveDocToDisk',
  'importAsset',
  'deleteSourceFile',
  'addSceneAssetToScene',
  'bindAssetRef',
  'play',
] as const;

test('gateway exposes the ten representative operations through one run surface', () => {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => operationIds.map((id) => ({
      id,
      domain: 'session' as const,
      argsSchema: null,
      source: 'builtin' as const,
      title: id,
    })),
    dispatch: (command) => ({ ok: true, result: command.kind }),
  });

  for (const operationId of operationIds) {
    const accepted = adapter.dispatchRun(operationId, { value: operationId }, {
      runId: `run-${operationId}`,
      actor: { id: 'agent-1', kind: 'ai' },
      sessionId: 'session-1',
      scope: 'game-1',
    });
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) continue;
    const run = adapter.getRun(accepted.runId);
    expect(run).toMatchObject({ operationId, status: 'succeeded' });
    expect(adapter.listRunEvents(accepted.runId).some((event) => event.type === 'succeeded')).toBe(true);
  }
});

test('run coverage is terminal-query based and does not use a completion side channel', () => {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [{
      id: 'play',
      domain: 'session' as const,
      argsSchema: null,
      source: 'builtin' as const,
      title: 'Play',
    }],
    dispatch: () => ({ ok: true }),
  });
  const accepted = adapter.dispatchRun('play', {}, {
    runId: 'run-play',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  expect(adapter.getRun(accepted.runId)?.status).toBe('succeeded');
  expect(adapter.listRunEvents(accepted.runId).every((event) => !('promise' in event))).toBe(true);
});
