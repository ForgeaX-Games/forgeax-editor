import { describe, expect, test } from 'bun:test';
import {
  createSourceMetaReconciler,
  type SourceMetaObservation,
} from './reconcile';

const source = (sourcePath: string): SourceMetaObservation => ({
  sourcePath,
  sourcePresent: true,
  metaPresent: false,
  logicalBatchId: `batch:${sourcePath}`,
});

const meta = (sourcePath: string): SourceMetaObservation => ({
  sourcePath,
  sourcePresent: false,
  metaPresent: true,
  logicalBatchId: `batch:${sourcePath}`,
  meta: {
    subjectIds: ['subject:mesh' as never],
    provenance: { owner: 'engine', source: 'asset-producer', packageId: 'package:mesh' },
  },
});

function complete(first: SourceMetaObservation, second: SourceMetaObservation) {
  const reconciler = createSourceMetaReconciler();
  const pending = reconciler.observe(first);
  const ready = reconciler.observe({
    ...second,
    sourcePresent: true,
    metaPresent: true,
  });
  return { pending, ready, reconciler };
}

describe('source/meta observation reconciliation', () => {
  test('source-first settles to one registration when metadata arrives', () => {
    const { pending, ready, reconciler } = complete(source('assets/mesh.glb'), meta('assets/mesh.glb'));

    expect(pending.status).toBe('pending');
    expect(ready.status).toBe('settled');
    expect(ready.registration?.sourcePath).toBe('assets/mesh.glb');
    expect(ready.registrationCount).toBe(1);
    expect(reconciler.stats().registrations).toBe(1);
  });

  test('meta-first settles without deleting or racing the sidecar', () => {
    const { pending, ready, reconciler } = complete(meta('assets/mesh.glb'), source('assets/mesh.glb'));

    expect(pending.status).toBe('pending');
    expect(ready.status).toBe('settled');
    expect(ready.registrationCount).toBe(1);
    expect(reconciler.stats().implicitDeletes).toBe(0);
    expect(reconciler.stats().sourceWrites).toBe(0);
  });

  test('same-batch source and metadata settle exactly once', () => {
    const reconciler = createSourceMetaReconciler();
    const observation: SourceMetaObservation = {
      sourcePath: 'assets/mesh.glb',
      sourcePresent: true,
      metaPresent: true,
      logicalBatchId: 'batch:mesh',
      meta: {
        subjectIds: ['subject:mesh' as never],
        provenance: { owner: 'engine', source: 'asset-producer', packageId: 'package:mesh' },
      },
    };
    const first = reconciler.observe(observation);
    const repeated = reconciler.observe(observation);

    expect(first.status).toBe('settled');
    expect(first.registrationCount).toBe(1);
    expect(repeated.registrationCount).toBe(0);
    expect(reconciler.stats().registrations).toBe(1);
  });
});
