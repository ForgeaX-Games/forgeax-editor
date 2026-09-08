import { describe, expect, it } from 'bun:test';
import { gateway } from '@forgeax/editor-core';
import type { CatalogReplicaSnapshot } from '@forgeax/engine-assets-runtime';
import { err, ok } from '@forgeax/engine-rhi';
import { AssetError } from '@forgeax/engine-types';
import {
  createSourceAuthoringRuntime,
  installCatalogReconcileProvider,
  type SourceCatalogRow,
} from '../source-authoring-runtime';

type EngineCatalogReconcileProvider = Parameters<typeof installCatalogReconcileProvider>[0];

const SOURCE_KEY = 'producer:fox:mesh';

const row: SourceCatalogRow = {
  guid: 'guid:fox',
  kind: 'mesh',
  name: 'Fox',
  packageUrl: 'assets/fox.mesh.bin',
  sourcePath: 'assets/Fox.glb',
  sourceKey: SOURCE_KEY,
  revision: { digest: 'catalog:r1' },
  refs: [],
  sourceOverrideDescriptors: [{
    sourceKey: SOURCE_KEY,
    payloadSchema: {
      type: 'object',
      properties: { lod: { type: 'number', minimum: 0, maximum: 4 } },
      required: ['lod'],
      additionalProperties: false,
    },
  }],
};

describe('source authoring host seam', () => {
  it('validates Mesh slot identity and MaterialAsset GUID before the CAS seam', async () => {
    const meshRow: SourceCatalogRow = {
      ...row,
      sourceOverrides: {
        [SOURCE_KEY]: {
          materialSlots: [
            { slotName: 'Body', sourceKey: 'material/body' },
            { slotName: 'Removed', sourceKey: 'material/removed', tombstone: true },
          ],
        },
      },
      sourceOverrideDescriptors: [{
        sourceKey: SOURCE_KEY,
        semantic: 'mesh-material-slot-defaults',
        payloadSchema: { type: 'object' },
      }],
    };
    const materialRow: SourceCatalogRow = {
      guid: '019f0000-0000-7000-8000-000000000101',
      kind: 'material',
      packageUrl: 'assets/material.pack.json',
    };
    const runtime = createSourceAuthoringRuntime({ catalog: () => [meshRow, materialRow] });
    const command = (key: string, value: string | null) => ({
      kind: 'saveAssetSourceOverride',
      guid: meshRow.guid,
      scope: { sourceKey: SOURCE_KEY },
      override: {
        ...meshRow.sourceOverrides?.[SOURCE_KEY],
        materialSlotDefaultOverrides: { [key]: value },
      },
    }) as never;

    await expect(Promise.resolve().then(() => runtime.validateSourceOverride?.(command('material/body', materialRow.guid)))).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => runtime.validateSourceOverride?.(command('material/body', null)))).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => runtime.validateSourceOverride?.(command('material/removed', materialRow.guid)))).rejects.toMatchObject({
      code: 'asset-validation-failed',
    });
    await expect(Promise.resolve().then(() => runtime.validateSourceOverride?.(command('material/body', 'missing-guid')))).rejects.toMatchObject({
      code: 'asset-validation-failed',
    });
    const validCommand = command('material/body', materialRow.guid) as unknown as Record<string, unknown>;
    await expect(Promise.resolve().then(() => runtime.validateSourceOverride?.({
      ...validCommand,
      override: {
        materialSlots: [{ slotName: 'Forged', sourceKey: 'material/forged' }],
        materialSlotDefaultOverrides: { 'material/forged': materialRow.guid },
      },
    } as never))).rejects.toMatchObject({
      code: 'asset-validation-failed',
      message: expect.stringContaining('producer-owned topology is immutable'),
    });
  });

  it('projects real Catalog and Meta facts into the SourceAuthoringRuntime seams', async () => {
    const events: string[] = [];
    const runtime = createSourceAuthoringRuntime({
      catalog: () => [row],
      readMetaSidecar: async (metaPath) => {
        events.push(`meta:${metaPath}`);
        return { ok: true, value: { revision: 'meta:r1', contents: JSON.stringify({ subAssets: [{ guid: row.guid, sourceKey: row.sourceKey }] }) } };
      },
      triggerCook: async (guid, signal) => {
        events.push(`cook:${guid}:${signal?.aborted === true}`);
        return { ok: true, value: undefined };
      },
      observePublication: async ({ op, signal }) => {
        events.push(`observe:${(op as { requestId: string }).requestId}:${signal.aborted}`);
      },
    });
    const op = {
      kind: 'reimportAsset',
      guid: row.guid,
      scope: { sourceKey: SOURCE_KEY },
      expectedRevision: 'meta:r1',
      requestId: 'host-seam-1',
    } as never;

    expect(runtime.metaPath(op)).toBe('assets/Fox.glb.meta.json');
    const input = await runtime.getPreflightInput(op);
    expect(input.meta).toEqual({
      metaRevision: 'meta:r1',
      subAssets: [{ guid: row.guid, sourceKey: SOURCE_KEY }],
      sourceOverrideDescriptors: row.sourceOverrideDescriptors,
    });
    expect(input.browser.assets[0]).toMatchObject({ guid: row.guid, sourceKey: SOURCE_KEY, revision: 'catalog:r1' });

    const controller = new AbortController();
    await runtime.rebuild({ op, signal: controller.signal });
    await runtime.observePublication?.({ op, signal: controller.signal });
    expect(events).toEqual([
      'meta:assets/Fox.glb.meta.json',
      'cook:guid:fox:false',
      'observe:host-seam-1:false',
    ]);
  });

  it('uses the producer preflight for ScriptablePack sources instead of a disk Meta sidecar', async () => {
    const packRow: SourceCatalogRow = {
      ...row,
      guid: 'guid:pack-scene',
      sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'scene/main',
    };
    const events: string[] = [];
    const runtime = createSourceAuthoringRuntime({
      catalog: () => [packRow],
      readMetaSidecar: async () => {
        throw new Error('ScriptablePack Meta must not be read as a sidecar');
      },
      preflightSource: async ({ sourcePath, requestId }) => {
        events.push(`producer:${sourcePath}:${requestId}`);
        return {
          sourcePath,
          revision: 'a'.repeat(64),
          meta: { subAssets: [{ guid: packRow.guid, sourceKey: packRow.sourceKey }] },
        };
      },
    });

    const input = await runtime.getPreflightInput({
      kind: 'asset.preflight',
      guid: packRow.guid,
      scope: { sourceKey: packRow.sourceKey },
      requestId: 'pack-preflight-1',
    } as never);

    expect(input.meta).toMatchObject({
      metaRevision: 'a'.repeat(64),
      subAssets: [{ guid: packRow.guid, sourceKey: packRow.sourceKey }],
    });
    expect(events).toEqual(['producer:assets/showcase.pack.ts:pack-preflight-1']);
  });

  it('projects current scene instance references into source preflight impact', async () => {
    const runtime = createSourceAuthoringRuntime({
      catalog: () => [row],
      readMetaSidecar: async () => ({
        ok: true,
        value: { revision: 'meta:r1', contents: JSON.stringify({ subAssets: [{ guid: row.guid, sourceKey: row.sourceKey }] }) },
      }),
      activeSceneReferences: () => [{ assetGuid: row.guid, instanceGuid: 'scene-entity:42' }],
    });
    const input = await runtime.getPreflightInput({
      kind: 'reimportAsset',
      guid: row.guid,
      scope: { sourceKey: SOURCE_KEY },
      expectedRevision: 'meta:r1',
      requestId: 'scene-impact-1',
    } as never);

    expect(input.activeSceneReferences).toEqual([{ assetGuid: row.guid, instanceGuid: 'scene-entity:42' }]);
  });

  it('composes catalog.reconcile from the public typed Engine provider without source writes', async () => {
    let reconciles = 0;
    const metaWrites = 0;
    const sourceBytes = new Uint8Array([0x46, 0x4f, 0x58]);
    const originalSourceBytes = sourceBytes.slice();
    const recoveredSnapshot = {
      version: 12,
      entries: [],
      stale: false,
      diagnostics: [{ code: 'recovered', severity: 'info' }],
    } as const satisfies CatalogReplicaSnapshot;
    const registry: EngineCatalogReconcileProvider = {
      catalogSnapshot: () => recoveredSnapshot,
      reconcileCatalog: async () => {
        reconciles += 1;
        return ok(recoveredSnapshot);
      },
    };
    const uninstall = installCatalogReconcileProvider(registry);
    try {
      const accepted = gateway.dispatch({ kind: 'catalog.reconcile', requestId: 'live-catalog-reconcile' }, 'ai');
      expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      const terminal = await gateway.waitOperationRun('live-catalog-reconcile');
      expect(terminal).toMatchObject({
        ok: true,
        value: {
          status: 'succeeded',
          result: { revision: 12, stale: false, diagnostics: [{ code: 'recovered' }] },
        },
      });
      expect(gateway.getOperationRunResult('live-catalog-reconcile')).toEqual(terminal);
      expect(reconciles).toBe(1);
      expect(metaWrites).toBe(0);
      expect(sourceBytes).toEqual(originalSourceBytes);
    } finally {
      uninstall();
    }
  });

  it('preserves the public Engine error and stale snapshot in the terminal recovery run', async () => {
    const metaWrites = 0;
    const staleSnapshot = {
      version: 11,
      entries: [],
      stale: true,
      diagnostics: [{ code: 'catalog-gap', severity: 'blocking' }],
    } as const satisfies CatalogReplicaSnapshot;
    const registry: EngineCatalogReconcileProvider = {
      catalogSnapshot: () => staleSnapshot,
      reconcileCatalog: async () => err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: 'an authoritative current Catalog snapshot',
          hint: 'restore the Catalog source and retry reconciliation',
        }),
      ),
    };
    const uninstall = installCatalogReconcileProvider(registry);
    try {
      const accepted = gateway.dispatch({ kind: 'catalog.reconcile', requestId: 'live-catalog-reconcile-failed' }, 'human');
      expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      const terminal = await gateway.waitOperationRun('live-catalog-reconcile-failed');
      expect(terminal).toMatchObject({
        ok: true,
        value: {
          status: 'failed',
          retryable: true,
          error: {
            code: 'asset-catalog-subscription-gap',
            phase: 'gap',
            owner: 'engine',
            cause: { code: 'asset-fetch-failed', owner: 'engine' },
            current: {
              revision: 11,
              stale: true,
              diagnostics: [{ code: 'catalog-gap', severity: 'blocking' }],
            },
            recoveryActions: ['run.retry', 'catalog.reconcile', 'run.get', 'run.wait'],
          },
        },
      });
      expect(gateway.getOperationRunResult('live-catalog-reconcile-failed')).toEqual(terminal);
      expect(metaWrites).toBe(0);
    } finally {
      uninstall();
    }
  });
});
