import { expect, test } from 'bun:test';

import type { CapabilityDescriptor } from './capability';

test('capability descriptors declare permission and confirmation boundaries', async () => {
  const { isCapabilityDescriptor } = await import('./capability');
  const descriptor: CapabilityDescriptor = {
    id: 'asset.destroy',
    kind: 'operation',
    version: 'editor-product/v1',
    subject: 'asset',
    verb: 'destroy',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    availability: { available: true },
    preconditions: ['asset.preflight'],
    permission: { scope: 'asset', action: 'write' },
    confirmation: { required: true, reason: 'destructive-operation' },
    cancellation: { supported: false, reason: 'commit-is-atomic' },
    retry: { supported: true, createsNewAttempt: true },
    recoveryActions: ['asset.restore'],
  };

  expect(isCapabilityDescriptor(descriptor)).toBe(true);
  expect(descriptor.confirmation?.required).toBe(true);
  expect(descriptor.cancellation?.supported).toBe(false);
  expect(descriptor.retry?.createsNewAttempt).toBe(true);
});

test('a capability rejection keeps recovery actions separate from its message', async () => {
  const { unavailable } = await import('./error');
  const error = unavailable('permission-denied', {
    hint: 'The actor lacks the required scope.',
    recoveryActions: ['permission.request'],
  });

  expect(error.code).toBe('permission-denied');
  expect(error.recoveryActions).toEqual(['permission.request']);
  expect(error.message).not.toContain('permission.request');
});
