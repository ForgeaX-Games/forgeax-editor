import { expect, test } from 'bun:test';

import { createGatewayCapabilityAdapter } from '../product/gateway-executor';
import { applyCreateMaterial, applyDestroyAsset } from '../session/pack-ops';
import { registerPostAssetWriteCatalogSync } from '../session/authored-asset-write';
import { setPathResolver } from '../util/path-resolver';

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

test('product capability execution waits for a nested Gateway operation run', async () => {
  const accepted = {
    runId: 'operation-run-switch',
    requestId: 'switch-board',
    status: 'running',
    retryable: true,
    recoveryActions: [],
  } as const;
  const terminal = { ...accepted, status: 'succeeded' as const, result: { sceneId: 'board' } };
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [{
      id: 'switchSceneFile',
      domain: 'session' as const,
      argsSchema: null,
      source: 'builtin' as const,
      title: 'Switch Scene File',
    }],
    dispatch: () => ({ ok: true, result: { created: [], operationRun: accepted } }),
    operationRuns: {
      get: () => ({ ok: true, value: terminal as never }),
      wait: async () => ({ ok: true, value: terminal as never }),
      subscribe: () => () => undefined,
      cancel: () => ({ ok: false, error: { code: 'not-cancellable', hint: 'not cancellable', retryable: false, recoveryActions: [] } }),
      retry: () => ({ ok: false, error: { code: 'not-retryable', hint: 'not retryable', retryable: false, recoveryActions: [] } }),
    },
  });

  expect(await adapter.product().capabilityRegistry.execute(
    'editor.switchSceneFile',
    { requestId: 'switch-board' },
    { host: 'bun' },
  )).toMatchObject({
    ok: true,
    result: {
      ok: true,
      result: { operationRun: { status: 'succeeded', result: { sceneId: 'board' } } },
    },
  });
});

test('createMaterial capability waits for disk commit and live catalog visibility', async () => {
  const events: string[] = [];
  let releaseWrite!: (value: { ok: boolean }) => void;
  setPathResolver((relativePath) => relativePath);
  registerPostAssetWriteCatalogSync(async (guid) => { events.push(`visible:${guid}`); });
  try {
    const adapter = createGatewayCapabilityAdapter({
      listOps: () => [{
        id: 'createMaterial',
        domain: 'document' as const,
        argsSchema: null,
        source: 'builtin' as const,
        title: 'Create Material',
        completion: { kind: 'asset-visible' as const, guidField: 'guid' },
      }],
      dispatch: () => {
        events.push('dispatch');
        applyCreateMaterial({
          assetIO: {
            createAssetInPack: () => new Promise((resolve) => { releaseWrite = resolve; }),
          },
        } as never, {
          kind: 'createMaterial', guid: 'material-guid', name: 'Material',
          baseColor: [1, 1, 1, 1], packPath: 'assets/materials.pack.json',
        } as never);
        return { ok: true, result: { created: [] } };
      },
    });

    const pending = adapter.product().capabilityRegistry.execute(
      'editor.createMaterial',
      { guid: 'material-guid' },
      { host: 'bun' },
    );
    await Promise.resolve();
    expect(events).toEqual(['dispatch']);
    releaseWrite({ ok: true });
    expect(await pending).toMatchObject({ ok: true });
    expect(events).toEqual(['dispatch', 'visible:material-guid']);
  } finally {
    registerPostAssetWriteCatalogSync(null);
    setPathResolver(null);
  }
});

test('destroyAsset capability waits for disk commit and reports background failure', async () => {
  let rejectDelete!: (error: Error) => void;
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [{
      id: 'destroyAsset',
      domain: 'document' as const,
      argsSchema: null,
      source: 'builtin' as const,
      title: 'Destroy Asset',
      completion: { kind: 'asset-write' as const, guidField: 'guid' },
    }],
    dispatch: () => {
      applyDestroyAsset({
        assetIO: {
          deletePackEntry: () => new Promise((_resolve, reject) => { rejectDelete = reject; }),
        },
      } as never, {
        kind: 'destroyAsset', guid: 'asset-guid', _resolvedPackPath: 'assets/ui.pack.json',
      } as never);
      return { ok: true, result: { created: [] } };
    },
  });

  const pending = adapter.product().capabilityRegistry.execute(
    'editor.destroyAsset',
    { guid: 'asset-guid' },
    { host: 'bun' },
  );
  await Promise.resolve();
  rejectDelete(new Error('disk denied'));
  expect(await pending).toMatchObject({
    ok: true,
    result: {
      ok: false,
      error: { code: 'asset-write-failed', recoveryActions: ['request.retry'] },
    },
  });
});
