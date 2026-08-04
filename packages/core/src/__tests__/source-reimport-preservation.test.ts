import { describe, expect, test } from 'bun:test';
import { mergeSourceReimportMeta } from '../session/import-ops';

describe('ordinary source reimport preservation', () => {
  test('preserves authored overrides, output GUIDs, settings, and instance metadata', () => {
    const existing = {
      schemaVersion: 1,
      guid: 'guid:asset',
      sourcePath: 'assets/mesh.glb',
      sourceKey: 'source:mesh',
      importSettings: { scale: 2, generateTangents: true },
      sourceOverrides: { 'source:mesh': { lod: 2, collision: 'convex' } },
      subAssets: [{ guid: 'guid:mesh', kind: 'mesh', sourceIndex: 0, sourceKey: 'source:mesh' }],
      instances: [{ guid: 'instance:mesh', assetGuid: 'guid:mesh' }],
    };
    const rebuilt = {
      schemaVersion: 1,
      guid: 'guid:asset',
      sourcePath: 'assets/mesh.glb',
      sourceKey: 'source:mesh',
      importSettings: { scale: 1 },
      subAssets: [{ guid: 'guid:mesh-new', kind: 'mesh', sourceIndex: 0, sourceKey: 'source:mesh' }],
    };

    const result = mergeSourceReimportMeta(existing, rebuilt);

    expect(result.guid).toBe('guid:asset');
    expect(result.sourceOverrides).toEqual(existing.sourceOverrides);
    expect(result.importSettings).toEqual(existing.importSettings);
    expect(result.subAssets).toEqual(existing.subAssets);
    expect(result.instances).toEqual(existing.instances);
  });
});
