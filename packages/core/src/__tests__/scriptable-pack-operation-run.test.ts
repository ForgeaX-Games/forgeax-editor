import { afterEach, describe, expect, test } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { World } from '@forgeax/engine-ecs';
import {
  installSourceAuthoringOps,
  type SourceAuthoringRuntime,
  type SourceAuthoringRuntimeResult,
} from '../session/source-authoring-ops';
import { SOURCE_AUTHORING_OPERATION_DESCRIPTORS } from '@forgeax/engine-pack/source';

const uninstallers: Array<() => void> = [];

afterEach(() => {
  while (uninstallers.length > 0) uninstallers.pop()?.();
});

describe('asset source Gateway contract', () => {
  function runtime(
    executeStructured: NonNullable<SourceAuthoringRuntime['executeStructured']>,
  ): SourceAuthoringRuntime {
    return {
      getPreflightInput: async () => {
        throw new Error('not used by structured capability tests');
      },
      metaPath: () => '',
      validateSourceOverride: () => undefined,
      rebuild: async () => undefined,
      structuredOperations: SOURCE_AUTHORING_OPERATION_DESCRIPTORS,
      executeStructured,
    };
  }

  test('projects the complete live capability set with the correct domains', () => {
    uninstallers.push(installSourceAuthoringOps(runtime(async (operation) => ({
      ok: true,
      value: { sourcePath: (operation as { sourcePath: string }).sourcePath, revision: 'a'.repeat(64), meta: { subAssets: [] } },
    }))));
    const operations = new EditGateway().listOps().filter((entry) => entry.id.startsWith('asset-source.'));

    expect(operations.map((entry) => entry.id).sort()).toEqual([
      'asset-source.add-external-asset',
      'asset-source.add-output',
      'asset-source.clone',
      'asset-source.cold-cook',
      'asset-source.create',
      'asset-source.rebuild',
      'asset-source.remove-output',
      'asset-source.rename',
    ]);
    expect(operations.filter((entry) => entry.domain === 'transient')).toHaveLength(0);
    expect(operations.filter((entry) => entry.domain === 'session')).toHaveLength(8);
    for (const operation of operations) {
      expect(operation).toMatchObject({
        source: 'registered',
		argsSchema: { type: 'object', required: expect.arrayContaining(['requestId']) },
        operationRun: {
          read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
        },
      });
    }
  });

  test('keeps accepted work in one Gateway-owned OperationRun until publication completes', async () => {
    let complete: ((result: SourceAuthoringRuntimeResult) => void) | undefined;
    uninstallers.push(installSourceAuthoringOps(runtime(() => new Promise<SourceAuthoringRuntimeResult>((resolve) => {
      complete = resolve;
    }))));
    const gateway = new EditGateway();

    const accepted = gateway.dispatch({
      kind: 'asset-source.rebuild',
      sourcePath: 'assets/showcase.pack.ts',
      expectedRevision: 'b'.repeat(64),
      requestId: 'script-pack-rebuild-1',
    }, 'ai');
    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });

    complete?.({
      ok: true,
      value: {
        sourcePath: 'assets/showcase.pack.ts',
        revision: 'b'.repeat(64),
        meta: { subAssets: [{ guid: '11111111-1111-4111-8111-111111111111' }] },
        sourceCommitted: true,
        catalogObserved: true,
      },
    });
    await expect(gateway.waitOperationRun('script-pack-rebuild-1')).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'succeeded',
        result: { sourceCommitted: true, catalogObserved: true },
      },
    });
  });

  test('preserves structured revision conflicts in the terminal run', async () => {
    uninstallers.push(installSourceAuthoringOps(runtime(async () => ({
      ok: false,
      error: {
        code: 'pack-source-revision-conflict',
        hint: 'Source changed after preflight.',
        owner: 'engine',
        retryable: true,
        recoveryActions: ['asset.preflight'],
      },
    }))));
    const gateway = new EditGateway();
    gateway.dispatch({
      kind: 'asset-source.add-output',
      sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'mesh:new',
      assetKind: 'mesh',
      expectedRevision: 'c'.repeat(64),
      requestId: 'script-pack-stale-1',
    }, 'human');

    await expect(gateway.waitOperationRun('script-pack-stale-1')).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        error: {
          code: 'pack-source-revision-conflict',
          owner: 'engine',
          recoveryActions: ['asset.preflight'],
        },
      },
    });
  });

  test('allows inspection but rejects source mutation while Play owns the active world', () => {
    let executions = 0;
    uninstallers.push(installSourceAuthoringOps(runtime(async (operation) => {
      executions += 1;
      return {
        ok: true,
        value: { sourcePath: (operation as { sourcePath: string }).sourcePath, revision: 'd'.repeat(64), meta: { subAssets: [] } },
      };
    })));
    const gateway = new EditGateway();
    gateway.enterPlay(new World());

    expect(gateway.dispatch({
      kind: 'asset-source.rebuild',
      sourcePath: 'assets/showcase.pack.ts',
      expectedRevision: 'd'.repeat(64),
      requestId: 'script-pack-rebuild-play-1',
    }, 'ai')).toMatchObject({
      ok: false,
      error: { code: 'edit-rejected-in-play', recoveryActions: ['stop', 'asset.preflight', 'run.retry'] },
    });
    expect(executions).toBe(0);
  });
});
