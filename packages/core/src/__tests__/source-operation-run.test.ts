import { afterEach, describe, expect, test } from 'bun:test';
import type { CommandError, EditorOp } from '../types';
import { EditGateway } from '../io/gateway';
import { registerSessionApplier } from '../io/appliers';

type Completion =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: CommandError };

const operationIds = ['saveAssetSourceOverride', 'discardSourceOverridesAndReimport'] as const;
const unregisters: Array<() => void> = [];

afterEach(() => {
  while (unregisters.length > 0) unregisters.pop()?.();
});

function installSourceAppliers(completions: Map<string, (value: Completion) => void>) {
  let executions = 0;
  let casCommitted = new Set<string>();
  let cancelledBeforeCas = new Set<string>();

  for (const kind of operationIds) {
    unregisters.push(registerSessionApplier(kind, (op, ctx) => {
      const requestId = (op as { readonly requestId: string }).requestId;
      executions += 1;
      ctx?.operationRun?.registerCancelHandler?.(() => {
        if (casCommitted.has(requestId)) {
          return {
            ok: false as const,
            error: {
              code: 'asset-operation-cas-committed',
              hint: 'The Meta CAS already committed; recover the same run instead of cancelling.',
              retryable: true,
              recoveryActions: ['run.wait', 'run.retry'],
            },
          };
        }
        cancelledBeforeCas.add(requestId);
        return { ok: true as const };
      });
      return {
        ok: true,
        completion: new Promise<Completion>((resolve) => {
          completions.set(requestId, (value) => {
            if (cancelledBeforeCas.has(requestId)) {
              resolve({
                ok: false,
                error: {
                  code: 'run-cancelled-before-cas',
                  hint: 'The source mutation was cancelled before the Meta CAS boundary.',
                  retryable: false,
                  recoveryActions: ['run.get'],
                },
              });
              return;
            }
            resolve(value);
          });
        }),
      };
    }));
  }

  return {
    get executions() {
      return executions;
    },
    markCasCommitted(requestId: string) {
      casCommitted.add(requestId);
    },
  };
}

function operation(kind: string, requestId: string): EditorOp {
  return {
    kind,
    guid: 'guid:mesh',
    scope: { sourceKey: 'source:mesh' },
    expectedRevision: 'meta:r7',
    ...(kind === 'saveAssetSourceOverride' ? { override: { lod: 2 } } : {}),
    requestId,
  };
}

function sourceGateway(): EditGateway {
  const gateway = new EditGateway();
  gateway.doc.registry = {
    listCatalog: () => [{
      guid: 'guid:mesh',
      kind: 'mesh',
      packageUrl: 'assets/mesh.pack.json',
      sourceKey: 'source:mesh',
    }],
    catalogSnapshot: () => ({
      version: 7,
      stale: false,
      diagnostics: [],
      entries: [{
        guid: 'guid:mesh',
        kind: 'mesh',
        packageUrl: 'assets/mesh.pack.json',
        sourcePath: 'assets/mesh.glb',
        sourceKey: 'source:mesh',
        sourceOverrideDescriptors: [{
          sourceKey: 'source:mesh',
          payloadSchema: {
            type: 'object',
            properties: { lod: { type: 'number', minimum: 0, maximum: 4 } },
            required: ['lod'],
            additionalProperties: false,
          },
        }],
      }],
    }),
  } as never;
  return gateway;
}

describe('source OperationRun ownership', () => {
  test('reuses one run for an equivalent request and rejects a conflicting intent', async () => {
    const gateway = sourceGateway();
    const completions = new Map<string, (value: Completion) => void>();
    const state = installSourceAppliers(completions);

    const first = gateway.dispatch(operation('saveAssetSourceOverride', 'source-run-1'), 'ai');
    const duplicate = gateway.dispatch(operation('saveAssetSourceOverride', 'source-run-1'), 'ai');
    const conflict = gateway.dispatch(operation('discardSourceOverridesAndReimport', 'source-run-1'), 'ai');

    expect(first).toMatchObject({ ok: true, result: { operationRun: { status: 'running', requestId: 'source-run-1' } } });
    expect(duplicate).toMatchObject({ ok: true, result: { operationRun: { runId: (first as { result: { operationRun: { runId: string } } }).result.operationRun.runId, status: 'running' } } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'operation-request-id-conflict' } });
    expect(state.executions).toBe(1);

    completions.get('source-run-1')?.({ ok: true, result: { committed: false } });
    await expect(gateway.waitOperationRun('source-run-1')).resolves.toMatchObject({
      ok: true,
      value: { status: 'succeeded', requestId: 'source-run-1' },
    });
    expect(gateway.operationRunSnapshot().runs.filter((run) => run.requestId === 'source-run-1')).toHaveLength(1);
  });

  test('keeps cancellation before CAS distinct from cancellation after CAS', async () => {
    const gateway = sourceGateway();
    const completions = new Map<string, (value: Completion) => void>();
    const state = installSourceAppliers(completions);

    gateway.dispatch(operation('discardSourceOverridesAndReimport', 'cancel-before-cas'), 'human');
    const cancelled = gateway.cancelOperationRun('cancel-before-cas');
    completions.get('cancel-before-cas')?.({ ok: true, result: { committed: false } });
    expect(cancelled).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(state.executions).toBe(1);
    expect(await gateway.waitOperationRun('cancel-before-cas')).toMatchObject({ ok: true, value: { status: 'cancelled' } });

    gateway.dispatch(operation('discardSourceOverridesAndReimport', 'cancel-after-cas'), 'human');
    state.markCasCommitted('cancel-after-cas');
    const refused = gateway.cancelOperationRun('cancel-after-cas');
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'asset-operation-cas-committed', recoveryActions: ['run.wait', 'run.retry'] },
    });
    completions.get('cancel-after-cas')?.({ ok: true, result: { committed: true } });
    await expect(gateway.waitOperationRun('cancel-after-cas')).resolves.toMatchObject({ ok: true, value: { status: 'succeeded' } });
  });

  test('retries and reconciles through the same Gateway registry', async () => {
    const gateway = sourceGateway();
    const completions = new Map<string, (value: Completion) => void>();
    installSourceAppliers(completions);

    gateway.dispatch(operation('saveAssetSourceOverride', 'source-failed-1'), 'ai');
    completions.get('source-failed-1')?.({
      ok: false,
      error: {
        code: 'asset-cook-failed',
        hint: 'The source cook failed after the request was accepted.',
        retryable: true,
        recoveryActions: ['run.retry', 'catalog.reconcile'],
      },
    });
    await expect(gateway.waitOperationRun('source-failed-1')).resolves.toMatchObject({ ok: true, value: { status: 'failed' } });

    const retry = gateway.retryOperationRun('source-failed-1', 'source-retry-2', 'ai');
    expect(retry).toMatchObject({ ok: true, result: { operationRun: { requestId: 'source-retry-2', parentRunId: expect.any(String) } } });
    completions.get('source-retry-2')?.({ ok: true, result: { reconciled: true } });
    await expect(gateway.waitOperationRun('source-retry-2')).resolves.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(gateway.reconcileOperationRuns()).toMatchObject({ ok: true });
  });
});
