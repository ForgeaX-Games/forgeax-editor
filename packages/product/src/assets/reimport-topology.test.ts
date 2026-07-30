import { describe, expect, test } from 'bun:test';
import { reconcileImportedTopology, type ImportedOutputRecord } from './subject-capability';

function output(
  subjectId: string,
  producerIdentity: string | undefined,
  kind: string,
  sourceIndex: number,
): ImportedOutputRecord {
  return { subjectId, producerIdentity, kind, sourceIndex };
}

describe('reimport topology reconciliation', () => {
  test('matches reorder and kind changes by producer identity', () => {
    const result = reconcileImportedTopology({
      previous: [
        output('subject:mesh', 'producer:mesh', 'mesh', 0),
        output('subject:material', 'producer:material', 'material', 1),
      ],
      next: [
        output('output:material', 'producer:material', 'material', 0),
        output('output:mesh', 'producer:mesh', 'skinned-mesh', 1),
        output('output:light', 'producer:light', 'light', 2),
      ],
      references: [{ referenceId: 'reference:mesh', subjectId: 'subject:mesh' }],
    });

    expect(result.status).toBe('migrated');
    expect(result.matches).toEqual([
      { previousSubjectId: 'subject:material', nextSubjectId: 'output:material', producerIdentity: 'producer:material' },
      { previousSubjectId: 'subject:mesh', nextSubjectId: 'output:mesh', producerIdentity: 'producer:mesh' },
    ]);
    expect(result.addedSubjectIds).toEqual(['output:light']);
    expect(result.removedSubjectIds).toEqual([]);
    expect(result.preservedReferences).toEqual([
      { referenceId: 'reference:mesh', subjectId: 'output:mesh' },
    ]);
  });

  test('returns ambiguous and preserves old references when identity is not unique', () => {
    const result = reconcileImportedTopology({
      previous: [output('subject:mesh', undefined, 'mesh', 0)],
      next: [
        output('output:left', undefined, 'mesh', 0),
        output('output:right', undefined, 'mesh', 0),
      ],
      references: [{ referenceId: 'reference:mesh', subjectId: 'subject:mesh' }],
    });

    expect(result.status).toBe('ambiguous');
    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toEqual([
      { previousSubjectId: 'subject:mesh', candidateSubjectIds: ['output:left', 'output:right'] },
    ]);
    expect(result.preservedReferences).toEqual([
      { referenceId: 'reference:mesh', subjectId: 'subject:mesh' },
    ]);
  });
});
