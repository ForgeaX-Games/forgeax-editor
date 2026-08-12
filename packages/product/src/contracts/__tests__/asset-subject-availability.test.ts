import { describe, expect, test } from 'bun:test';
import { createAssetSubject, type AssetSubjectKind } from '../asset-workspace';
import { getAssetSubjectCapability } from '../../assets/subject-capability';

describe('asset subject availability contract', () => {
  test('uses stable subject references instead of concrete kind consumer branches', () => {
    const kinds: readonly AssetSubjectKind[] = ['internal-asset', 'external-package', 'derived-artifact'];
    const refs = kinds.map((kind) => {
      const subject = createAssetSubject({
        id: `subject:${kind}`,
        kind,
        provenance: { owner: 'engine', source: 'producer-catalog' },
        resourceId: `resource:${kind}`,
        path: `assets/${kind}.pack.json`,
        capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
      });
      return getAssetSubjectCapability(subject).subjectRef;
    });

    expect(refs).toEqual(['subject:internal-asset', 'subject:external-package', 'subject:derived-artifact']);
    expect(new Set(refs).size).toBe(kinds.length);
  });
});
