import { describe, expect, test } from 'bun:test';
import { createAssetSubject, type AssetSubject, type AssetSubjectKind } from '../../contracts/asset-workspace';
import { getAssetSubjectCapability } from '../subject-capability';

function subject(kind: AssetSubjectKind, canMove = true, canDelete = true): AssetSubject {
  return createAssetSubject({
    id: `subject:${kind}`,
    kind,
    provenance: { owner: 'engine', source: 'producer-catalog', packageId: `package:${kind}` },
    resourceId: `resource:${kind}`,
    path: `assets/${kind}.pack.json`,
    capabilities: { canImport: false, canMove, canDelete, canPreflight: true },
  });
}

describe('asset subject capabilities', () => {
  test('exposes destructive operation policy from the subject capability', () => {
    const importedOutput = subject('imported-output', false, false);
    const capability = getAssetSubjectCapability(importedOutput);

    expect(capability.subjectRef).toBe(importedOutput.id);
    expect(capability.operations.delete.available).toBe(false);
    expect(capability.operations.move.available).toBe(false);
    expect(capability.operations.delete.reason?.code).toBe('unsupported-subject-operation');
  });

  test('keeps consumers on operation semantics instead of concrete kind switches', () => {
    const capabilities = (['internal-asset', 'external-package', 'reference'] as const)
      .map((kind) => getAssetSubjectCapability(subject(kind)));

    expect(capabilities.every((entry) => 'rename' in entry.operations)).toBe(true);
    expect(capabilities.every((entry) => 'preflight' in entry.operations)).toBe(true);
  });
});
