import { expect, test } from 'bun:test';

import {
  applierFor,
  applierRegistrySnapshot,
  registerApplier,
  subscribeApplierRegistry,
  type SessionApplier,
} from '../appliers';

test('applier registry publishes revisions and scoped replacements restore the previous executor', () => {
  const operationId = 'test.liveRegistryProjection';
  const revisions: number[] = [];
  const unsubscribe = subscribeApplierRegistry((revision) => revisions.push(revision));
  const before = applierRegistrySnapshot();
  const first: SessionApplier = () => ({ ok: true });
  const replacement: SessionApplier = () => ({ ok: true });

  const unregisterFirst = registerApplier('transient', operationId, first, {
    title: 'Live Registry Projection',
    argsSchema: { type: 'object' },
  });
  const registered = applierRegistrySnapshot();
  expect(registered.revision).toBe(before.revision + 1);
  expect(registered.entries.find((entry) => entry.id === operationId)).toEqual({
    id: operationId,
    domain: 'transient',
    title: 'Live Registry Projection',
    argsSchema: { type: 'object' },
  });
  expect(applierFor(operationId, 'transient')).toBe(first);

  const restoreFirst = registerApplier('transient', operationId, replacement);
  expect(applierFor(operationId, 'transient')).toBe(replacement);
  restoreFirst();
  expect(applierFor(operationId, 'transient')).toBe(first);
  const restoredRevision = applierRegistrySnapshot().revision;
  restoreFirst();
  expect(applierRegistrySnapshot().revision).toBe(restoredRevision);

  unregisterFirst();
  expect(applierFor(operationId, 'transient')).toBeUndefined();
  unsubscribe();
  expect(revisions).toEqual([
    before.revision + 1,
    before.revision + 2,
    before.revision + 3,
    before.revision + 4,
  ]);
});

test('out-of-order disposal never revives an already released executor', () => {
  const operationId = 'test.outOfOrderRuntimeOwners';
  const first: SessionApplier = () => ({ ok: true });
  const second: SessionApplier = () => ({ ok: true });
  const unregisterFirst = registerApplier('transient', operationId, first);
  const unregisterSecond = registerApplier('transient', operationId, second);
  const beforeHiddenDispose = applierRegistrySnapshot().revision;

  unregisterFirst();
  expect(applierFor(operationId, 'transient')).toBe(second);
  expect(applierRegistrySnapshot().revision).toBe(beforeHiddenDispose);

  unregisterSecond();
  expect(applierFor(operationId, 'transient')).toBeUndefined();
});
