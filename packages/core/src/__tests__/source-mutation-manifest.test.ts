import { afterEach, describe, expect, test } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { registerSessionApplier } from '../io/appliers';
import type { OpDescriptor } from '../io/catalog';
import type { CommandError } from '../types';

type SourceMutationDescriptor = OpDescriptor & {
  readonly destructive?: boolean;
  readonly recoveryActions?: readonly string[];
};

const SOURCE_OPERATION_IDS = [
  'previewAssetSourceMutation',
  'saveAssetSourceOverride',
  'reimportAsset',
  'discardSourceOverridesAndReimport',
] as const;

const OLD_SOURCE_OPERATION_IDS = ['editImportedSource', 'saveImportedSource'] as const;

const unregisters: Array<() => void> = [];

afterEach(() => {
  while (unregisters.length > 0) unregisters.pop()?.();
});

function sourceDescriptors(): readonly SourceMutationDescriptor[] {
  const gateway = new EditGateway();
  const descriptors = gateway.listOps() as readonly SourceMutationDescriptor[];
  return SOURCE_OPERATION_IDS.map((id) => {
    const descriptor = descriptors.find((entry) => entry.id === id);
    expect(descriptor).toBeDefined();
    return descriptor!;
  });
}

describe('source mutation operation manifest', () => {
  test('exposes the four intent descriptors and removes legacy source operations', () => {
    const gateway = new EditGateway();
    const ids = new Set(gateway.listOps().map((entry) => entry.id));

    for (const id of SOURCE_OPERATION_IDS) expect(ids.has(id)).toBe(true);
    expect(ids.has('asset.preflight')).toBe(true);
    for (const id of OLD_SOURCE_OPERATION_IDS) expect(ids.has(id)).toBe(false);
  });

  test('describes source scope, revision, request, and destructive intent', () => {
    const descriptors = sourceDescriptors();

    for (const descriptor of descriptors) {
      expect(descriptor.domain).toBe('session');
      expect(descriptor.argsSchema).toMatchObject({
        type: 'object',
        properties: {
          guid: { type: 'string', minLength: 1 },
          scope: { type: 'object' },
          expectedRevision: { type: 'string', minLength: 1 },
          requestId: { type: 'string', minLength: 1 },
        },
      });
      expect(descriptor.argsSchema?.properties?.scope).toMatchObject({
        properties: {
          sourceKey: { type: 'string', minLength: 1 },
          all: { type: 'boolean' },
        },
      });
      expect(descriptor.operationRun).toMatchObject({
        acceptedStatuses: ['accepted', 'running'],
        terminalStatuses: expect.arrayContaining(['succeeded', 'failed']),
        read: {
          get: 'getOperationRun',
          wait: 'waitOperationRun',
          subscribe: 'subscribeOperationRun',
        },
        retry: { requiresNewRequestId: true },
      });
      expect(descriptor.recoveryActions).toEqual(expect.arrayContaining([
        'run.get',
        'run.wait',
        'run.retry',
        'catalog.reconcile',
      ]));
    }

    expect(descriptors[0]?.destructive).toBe(false);
    expect(descriptors[1]?.destructive).toBe(false);
    expect(descriptors[2]?.destructive).toBe(false);
    expect(descriptors[3]?.destructive).toBe(true);
    expect(descriptors[3]?.argsSchema?.properties?.confirmationToken).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  test('keeps the capability fail-closed when no applier is registered', () => {
    const gateway = new EditGateway();

    expect(gateway.dispatch({
      kind: 'saveAssetSourceOverride',
      guid: 'guid:mesh',
      scope: { sourceKey: 'source:mesh' },
      expectedRevision: 'meta:r7',
      requestId: 'source-save-red',
    })).toMatchObject({
      ok: false,
      error: {
        code: expect.stringMatching(/UNKNOWN_OP|unavailable|source-authoring/),
      },
    });
  });

  test('rejects an ambiguous scope before the source applier and leaves side effects at zero', () => {
    let executions = 0;
    unregisters.push(registerSessionApplier('saveAssetSourceOverride', () => {
      executions += 1;
      return { ok: true };
    }));

    const gateway = new EditGateway();
    const result = gateway.dispatch({
      kind: 'saveAssetSourceOverride',
      guid: 'guid:mesh',
      scope: { sourceKey: 'source:mesh', all: true },
      expectedRevision: 'meta:r7',
      requestId: 'source-ambiguous-red',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/INVALID_ARGS|invalid/) },
    });
    expect(executions).toBe(0);
  });

  test('rejects a scope with neither sourceKey nor all before the source applier', () => {
    let executions = 0;
    unregisters.push(registerSessionApplier('saveAssetSourceOverride', () => {
      executions += 1;
      const error: CommandError = {
        code: 'UNKNOWN_OP',
        hint: 'must not execute',
        retryable: false,
        recoveryActions: [],
      };
      return { ok: false, error };
    }));

    const gateway = new EditGateway();
    const result = gateway.dispatch({
      kind: 'saveAssetSourceOverride',
      guid: 'guid:mesh',
      scope: {},
      expectedRevision: 'meta:r7',
      requestId: 'source-empty-scope-red',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/INVALID_ARGS|invalid/) },
    });
    expect(executions).toBe(0);
  });

  test('rejects a producer-invalid override before the source applier and run registry', () => {
    let executions = 0;
    unregisters.push(registerSessionApplier('saveAssetSourceOverride', () => {
      executions += 1;
      return { ok: true };
    }));
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

    const result = gateway.dispatch({
      kind: 'saveAssetSourceOverride',
      guid: 'guid:mesh',
      scope: { sourceKey: 'source:mesh' },
      expectedRevision: 'meta:r7',
      override: { lod: 99 },
      requestId: 'source-invalid-producer-payload',
    } as never);

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(executions).toBe(0);
    expect(gateway.getOperationRun('source-invalid-producer-payload')).toBeUndefined();
  });

  test('publishes catalog.reconcile as a canonical read-only Gateway operation', async () => {
    const gateway = new EditGateway();
    const descriptor = gateway.listOps().find((entry) => entry.id === 'catalog.reconcile');
    expect(descriptor).toMatchObject({
      id: 'catalog.reconcile',
      domain: 'transient',
      argsSchema: {
        type: 'object',
        required: ['requestId'],
      },
      operationRun: {
        read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
        retry: { requiresNewRequestId: true },
      },
    });

    const unregister = gateway.registerCatalogReconcile(
      async () => ({ revision: 8, stale: false, diagnostics: [] }),
    );
    const beforeLedger = gateway.ledger.length;
    const dispatched = gateway.dispatch({ kind: 'catalog.reconcile', requestId: 'catalog-reconcile-red' }, 'ai');
    expect(dispatched).toMatchObject({
      ok: true,
      result: { operationRun: { status: 'running', requestId: 'catalog-reconcile-red' } },
    });
    await expect(gateway.waitOperationRun('catalog-reconcile-red')).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'succeeded',
        result: { revision: 8, stale: false, diagnostics: [] },
      },
    });
    expect(gateway.ledger).toHaveLength(beforeLedger);
    unregister();
  });
});
