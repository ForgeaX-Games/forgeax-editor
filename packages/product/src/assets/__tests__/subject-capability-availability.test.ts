import { describe, expect, test } from 'bun:test';
import { createAssetSubject, type AssetSubjectKind } from '../../contracts/asset-workspace';
import { getAssetSubjectCapability } from '../subject-capability';

function subject(kind: AssetSubjectKind) {
  return createAssetSubject({
    id: `subject:${kind}`,
    kind,
    provenance: { owner: 'engine', source: 'producer-catalog' },
    resourceId: `resource:${kind}`,
    path: `assets/${kind}.pack.json`,
    capabilities: {
      canImport: kind === 'source-dependency',
      canMove: kind !== 'imported-output',
      canDelete: kind === 'internal-asset' || kind === 'external-package' || kind === 'reference',
      canPreflight: true,
    },
  });
}

describe('subject capability availability', () => {
  test('publishes the same operation matrix shape for every subject kind', () => {
    const kinds: readonly AssetSubjectKind[] = [
      'internal-asset',
      'external-package',
      'imported-output',
      'source-dependency',
      'derived-artifact',
      'reference',
    ];
    const capabilities = kinds.map((kind) => getAssetSubjectCapability(subject(kind)));
    const operationNames = Object.keys(capabilities[0]!.operations).sort();

    expect(operationNames).toEqual([
      'delete',
      'discard-source-overrides-and-reimport',
      'duplicate',
      'move',
      'preflight',
      'reimport',
      'reimport-asset',
      'rename',
      'replace',
      'restore',
      'save-asset-source-override',
    ]);
    for (const capability of capabilities) {
      expect(Object.keys(capability.operations).sort()).toEqual(operationNames);
      expect(capability.subjectRef).toMatch(/^subject:/);
    }
  });

  test('makes imported output destructive operations unavailable with recovery data', () => {
    const capability = getAssetSubjectCapability(subject('imported-output'));

    for (const operation of ['delete', 'move', 'replace', 'reimport'] as const) {
      expect(capability.operations[operation].available).toBe(false);
      expect(capability.operations[operation].reason?.code).toBe('unsupported-subject-operation');
      expect(capability.operations[operation].reason?.hint).toContain('imported-output');
    }
  });
});
