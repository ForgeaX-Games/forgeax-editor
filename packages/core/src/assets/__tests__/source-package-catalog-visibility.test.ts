import { describe, expect, it } from 'bun:test';
import {
  isSourcePackageCatalogVisible,
  sourcePathMatchesCatalogExpectation,
  type SourcePackageCatalogRow,
} from '../source-package-catalog-visibility';

const baseExpectation = {
  destPath: 'sample/assets/Fox.glb',
  sourceName: 'Fox.glb',
  subAssetGuids: ['mesh-guid', 'scene-guid', 'material-guid'],
} as const;

describe('sourcePathMatchesCatalogExpectation', () => {
  it('matches game-relative and sample-prefixed paths', () => {
    expect(sourcePathMatchesCatalogExpectation('sample/assets/Fox.glb', baseExpectation)).toBe(true);
    expect(sourcePathMatchesCatalogExpectation('assets/Fox.glb', {
      ...baseExpectation,
      destPath: 'assets/Fox.glb',
    })).toBe(true);
    expect(sourcePathMatchesCatalogExpectation('games/sample/assets/Fox.glb', baseExpectation)).toBe(true);
  });
});

describe('isSourcePackageCatalogVisible', () => {
  it('accepts the imported-output producer row', () => {
    const rows: SourcePackageCatalogRow[] = [{
      guid: 'producer',
      sourcePath: 'sample/assets/Fox.glb',
      lifecycle: 'current',
      projection: { subject: 'imported-output' },
    }];
    expect(isSourcePackageCatalogVisible(rows, baseExpectation)).toBe(true);
  });

  it('accepts when every sub-asset GUID is listed', () => {
    const rows: SourcePackageCatalogRow[] = baseExpectation.subAssetGuids.map((guid, index) => ({
      guid,
      kind: ['mesh', 'scene', 'material'][index],
      sourcePath: 'sample/assets/Fox.glb',
    }));
    expect(isSourcePackageCatalogVisible(rows, baseExpectation)).toBe(true);
  });

  it('accepts scene/mesh/material rows for the source file', () => {
    const rows: SourcePackageCatalogRow[] = [
      { guid: 'a', kind: 'scene', sourcePath: 'sample/assets/Fox.glb' },
      { guid: 'b', kind: 'mesh', sourcePath: 'sample/assets/Fox.glb' },
      { guid: 'c', kind: 'material', sourcePath: 'sample/assets/Fox.glb' },
    ];
    expect(isSourcePackageCatalogVisible(rows, { ...baseExpectation, subAssetGuids: [] })).toBe(true);
  });
});
