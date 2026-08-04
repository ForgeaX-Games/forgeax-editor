import { describe, expect, test } from 'bun:test';
import {
  AssetIOFacade,
  AssetResourceConflictError,
  SOURCE_SIDECAR_REVISION_DOMAIN,
  type AssetResourceTransactionPort,
} from '../io/asset-io-facade';

describe('source authoring Meta CAS', () => {
  test('allows one winner for concurrent writes with the same revision', async () => {
    let contents = JSON.stringify({ schemaVersion: 1, subAssets: [] });
    let revision = 'meta:r7';
    const facade = new AssetIOFacade();
    facade.setResourceTransactionPort({
      supportsExpectedRevision: true,
      revisionDomain: SOURCE_SIDECAR_REVISION_DOMAIN,
      readResource: async () => ({ contents, revision }),
      prepare: async (rawInput: unknown) => {
        const input = rawInput as {
          readonly resource: { readonly kind: 'source-sidecar'; readonly path: string };
          readonly expectedRevision: string;
          readonly content: string;
        };
        if (input.expectedRevision !== revision) {
          throw new AssetResourceConflictError(input.expectedRevision, revision);
        }
        return {
          commit: async () => {
            if (input.expectedRevision !== revision) {
              throw new AssetResourceConflictError(input.expectedRevision, revision);
            }
            contents = input.content;
            revision = 'meta:r8';
            return { revision };
          },
        };
      },
    } satisfies AssetResourceTransactionPort);

    const writes = await Promise.allSettled([
      facade.commitSourceOverrides({
        metaPath: 'assets/mesh.meta.json',
        expectedRevision: 'meta:r7',
        scope: { sourceKey: 'source:mesh' },
        override: { lod: 2 },
      }),
      facade.commitSourceOverrides({
        metaPath: 'assets/mesh.meta.json',
        expectedRevision: 'meta:r7',
        scope: { sourceKey: 'source:mesh' },
        override: { lod: 4 },
      }),
    ]);

    expect(writes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect(writes.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: { code: 'asset-resource-conflict' },
    });
    expect(JSON.parse(contents).sourceOverrides).toMatchObject({ 'source:mesh': expect.any(Object) });
  });
});
