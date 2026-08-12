import { describe, expect, test } from 'bun:test';
import {
  createAssetSubject,
  type AssetSubject,
  type AssetSubjectKind,
} from '../asset-workspace';

const kinds: readonly AssetSubjectKind[] = [
  'internal-asset',
  'external-package',
  'imported-output',
  'source-dependency',
  'derived-artifact',
  'reference',
];

function subject(kind: AssetSubjectKind, id = `subject:${kind}`): AssetSubject {
  return createAssetSubject({
    id,
    kind,
    provenance: { owner: 'engine', source: 'producer-catalog', packageId: `package:${kind}` },
    resourceId: `resource:${kind}`,
    path: `assets/${kind}.pack.json`,
    capabilities: {
      canImport: kind === 'source-dependency',
      canMove: kind !== 'imported-output',
      canDelete: kind === 'internal-asset' || kind === 'external-package',
      canPreflight: true,
    },
    name: `${kind} name`,
  });
}

describe('asset subject contract', () => {
  test('keeps six subject semantics distinct in the public contract', () => {
    const subjects = kinds.map((kind) => subject(kind));

    expect(new Set(subjects.map((entry) => entry.kind)).size).toBe(6);
    expect(new Set(subjects.map((entry) => entry.stableIdentity)).size).toBe(6);
    expect(subjects.map((entry) => entry.provenance.source)).toEqual(
      kinds.map(() => 'producer-catalog'),
    );
  });

  test('does not derive identity from path, URL, display name, or array position', () => {
    const original = subject('internal-asset', 'subject:stable');
    const moved = createAssetSubject({
      ...original,
      path: 'renamed/assets/other-name.pack.json',
      name: 'another display name',
    });

    expect(moved.stableIdentity).toBe(original.stableIdentity);
    expect(moved.id).toBe(original.id);
    expect(moved.resourceId).toBe(original.resourceId);
  });
});
