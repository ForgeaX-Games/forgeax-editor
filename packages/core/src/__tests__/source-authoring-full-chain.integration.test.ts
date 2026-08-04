import { afterEach, describe, expect, test } from 'bun:test';
import { AssetResourceConflictError } from '../io/asset-io-facade';
import { EditGateway } from '../io/gateway';
import {
  installSourceAuthoringOps,
  type SourceAuthoringRuntime,
} from '../session/source-authoring-ops';
import type { EditorOp } from '../types';

const sourceInput = {
  browser: {
    assets: [{
      guid: 'guid:mesh',
      kind: 'mesh',
      name: 'Mesh',
      packageUrl: '/game/assets/mesh.glb',
      storagePackageUrl: '/game/assets/mesh.glb',
      sourcePath: 'assets/mesh.glb',
      sourceKey: 'source:mesh',
      revision: 'catalog:r1',
      refs: [],
      relations: [],
    }],
    relations: [],
  },
  meta: {
    metaRevision: 'meta:r1',
    subAssets: [{ guid: 'guid:mesh', sourceKey: 'source:mesh' }],
    sourceOverrideDescriptors: [{
      sourceKey: 'source:mesh',
      payloadSchema: {
        type: 'object',
        properties: { lod: { type: 'number', minimum: 0, maximum: 4 } },
        required: ['lod'],
        additionalProperties: false,
      },
    }],
  },
  activeSceneReferences: [],
} as const;

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe('source authoring full Gateway chain', () => {
  test('returns Meta revision, producer schema, and impact through asset.preflight without authored writes', async () => {
    const events: string[] = [];
    uninstall = installSourceAuthoringOps({
      getPreflightInput: async () => sourceInput,
      metaPath: () => 'assets/mesh.meta.json',
      commitSourceOverrides: async () => { events.push('cas'); },
      rebuild: async () => { events.push('rebuild'); },
    });
    const gateway = sourceGateway();
    const ledgerBefore = gateway.ledger.length;
    const accepted = gateway.dispatch({
      kind: 'asset.preflight',
      guid: 'guid:mesh',
      scope: { sourceKey: 'source:mesh' },
      requestId: 'source-public-preflight',
    } as never, 'ai');

    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    await expect(gateway.waitOperationRun('source-public-preflight')).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'succeeded',
        operationId: 'asset.preflight',
        result: {
          source: {
            revisionSource: 'meta',
            expectedRevision: 'meta:r1',
            sourceKeys: ['source:mesh'],
            sourceOverrideDescriptors: [{ sourceKey: 'source:mesh', payloadSchema: { type: 'object' } }],
          },
          impact: {
            sourceKeys: ['source:mesh'],
            affectedGuids: ['guid:mesh'],
            expectedRevision: 'meta:r1',
          },
        },
      },
    });
    expect(events).toEqual([]);
    expect(gateway.ledger).toHaveLength(ledgerBefore);
  });

  test('runs preflight, Meta CAS, rebuild, and publication observation as one operation', async () => {
    const events: string[] = [];
    const runtime: SourceAuthoringRuntime = {
      getPreflightInput: async () => sourceInput,
      metaPath: () => 'assets/mesh.meta.json',
      commitSourceOverrides: async () => { events.push('cas'); },
      rebuild: async () => { events.push('rebuild'); },
      observePublication: async () => { events.push('observe'); },
    };
    uninstall = installSourceAuthoringOps(runtime);
    const gateway = sourceGateway();
    const result = gateway.dispatch(sourceOperation('req-full-chain'), 'ai');

    expect(result).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    await expect(gateway.waitOperationRun('req-full-chain')).resolves.toMatchObject({
      ok: true,
      value: { status: 'succeeded', operationId: 'saveAssetSourceOverride' },
    });
    expect(events).toEqual(['cas', 'rebuild', 'observe']);
  });

  const failures = [
    {
      name: 'entry',
      sourceKey: 'source:missing',
      code: 'asset-source-key-unknown',
      phase: 'entry',
      expected: undefined,
      actual: undefined,
      recoveryActions: ['asset.preflight'],
      failAt: 'entry',
    },
    {
      name: 'CAS',
      sourceKey: 'source:mesh',
      code: 'asset-meta-revision-conflict',
      phase: 'cas',
      expected: 'meta:r1',
      actual: 'meta:r2',
      recoveryActions: ['run.retry', 'asset.preflight'],
      failAt: 'cas',
    },
    {
      name: 'cook',
      sourceKey: 'source:mesh',
      code: 'asset-cook-failed',
      phase: 'cook',
      expected: 'ddc:desired',
      actual: 'ddc:lkg',
      recoveryActions: ['run.retry', 'catalog.reconcile'],
      failAt: 'cook',
    },
    {
      name: 'validation',
      sourceKey: 'source:mesh',
      code: 'asset-validation-failed',
      phase: 'validation',
      expected: 'schema:v2',
      actual: 'schema:v1',
      recoveryActions: ['run.retry', 'catalog.reconcile'],
      failAt: 'validation',
    },
    {
      name: 'publication',
      sourceKey: 'source:mesh',
      code: 'asset-publish-observation-timeout',
      phase: 'publication',
      expected: 'catalog:r2',
      actual: 'catalog:r1',
      recoveryActions: ['run.retry', 'catalog.reconcile'],
      failAt: 'publication',
    },
    {
      name: 'gap',
      sourceKey: 'source:mesh',
      code: 'asset-catalog-subscription-gap',
      phase: 'gap',
      expected: 'catalog:r2',
      actual: 'catalog:r0',
      recoveryActions: ['catalog.reconcile'],
      failAt: 'gap',
    },
  ] as const;

  for (const scenario of failures) {
    test(`publishes the ${scenario.name} failure as one structured terminal`, async () => {
      const runtime: SourceAuthoringRuntime = {
        getPreflightInput: async () => sourceInput,
        metaPath: () => 'assets/mesh.meta.json',
        commitSourceOverrides: async () => {
          if (scenario.failAt === 'cas') throw new AssetResourceConflictError('meta:r1', 'meta:r2');
        },
        rebuild: async () => {
          if (scenario.failAt === 'cook') throw sourceFailure('asset-cook-failed', 'ddc:desired', 'ddc:lkg');
          if (scenario.failAt === 'validation') throw sourceFailure('asset-validation-failed', 'schema:v2', 'schema:v1');
        },
        observePublication: async () => {
          if (scenario.failAt === 'publication') throw sourceFailure('asset-publish-observation-timeout', 'catalog:r2', 'catalog:r1');
          if (scenario.failAt === 'gap') throw sourceFailure('asset-catalog-subscription-gap', 'catalog:r2', 'catalog:r0');
        },
      };
      uninstall = installSourceAuthoringOps(runtime);
      const gateway = sourceGateway();
      const requestId = `req-source-${scenario.name.toLowerCase()}`;
      const accepted = gateway.dispatch(sourceOperation(requestId, scenario.sourceKey), 'ai');
      expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });

      const run = accepted.ok ? accepted.result?.operationRun : undefined;
      const terminal = await gateway.waitOperationRun(requestId);
      expect(terminal).toMatchObject({
        ok: true,
        value: {
          status: 'failed',
          operationId: 'saveAssetSourceOverride',
          requestId,
          runId: run?.runId,
          error: {
            code: scenario.code,
            phase: scenario.phase,
            subjectRef: { kind: 'asset-source', guid: 'guid:mesh', sourceKey: scenario.sourceKey },
            expected: scenario.expected,
            actual: scenario.actual,
            recoveryActions: scenario.recoveryActions,
          },
        },
      });
      expect(terminal).not.toMatchObject({ value: { error: { code: 'asset-operation-failed' } } });
      await expect(gateway.waitOperationRun(requestId)).resolves.toEqual(terminal);
    });
  }

  test('normalizes an unknown host code to the captured phase fallback', async () => {
    const runtime: SourceAuthoringRuntime = {
      getPreflightInput: async () => sourceInput,
      metaPath: () => 'assets/mesh.meta.json',
      commitSourceOverrides: async () => undefined,
      rebuild: async () => {
        throw sourceFailure('asset-meta-read-failed', 'ddc:desired', 'ddc:lkg');
      },
    };
    uninstall = installSourceAuthoringOps(runtime);
    const gateway = sourceGateway();
    const requestId = 'req-unknown-host-code';
    gateway.dispatch(sourceOperation(requestId), 'ai');

    await expect(gateway.waitOperationRun(requestId)).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        error: {
          code: 'asset-cook-failed',
          phase: 'cook',
          expected: 'ddc:desired',
          actual: 'ddc:lkg',
          recoveryActions: ['run.retry', 'catalog.reconcile'],
        },
      },
    });
    await expect(gateway.waitOperationRun(requestId)).resolves.not.toMatchObject({
      value: { error: { code: 'asset-meta-read-failed' } },
    });
  });
});

function sourceOperation(requestId: string, sourceKey = 'source:mesh'): EditorOp {
  return {
    kind: 'saveAssetSourceOverride',
    guid: 'guid:mesh',
    scope: { sourceKey },
    expectedRevision: 'meta:r1',
    override: { lod: 2 },
    requestId,
  } as EditorOp;
}

function sourceGateway(): EditGateway {
  const gateway = new EditGateway();
  gateway.doc.registry = {
    listCatalog: () => [{
      guid: 'guid:mesh',
      kind: 'mesh',
      packageUrl: 'assets/mesh.pack.json',
      sourceOverrideDescriptors: [
        ...sourceInput.meta.sourceOverrideDescriptors,
        { sourceKey: 'source:missing', payloadSchema: sourceInput.meta.sourceOverrideDescriptors[0].payloadSchema },
      ],
    }],
  } as never;
  return gateway;
}

function sourceFailure(code: string, expected: string, actual: string): Error {
  return Object.assign(new Error(`${code}: ${actual}`), { code, expected, actual });
}
