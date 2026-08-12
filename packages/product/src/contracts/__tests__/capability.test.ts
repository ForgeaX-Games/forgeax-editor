import { expect, test } from 'bun:test';

import type { CapabilityDescriptor, CapabilitySchema } from '../capability';

test('capability descriptors carry a stable subject.verb id and schemas', async () => {
  const module = await import('../capability');
  const inputSchema: CapabilitySchema = {
    type: 'object',
    properties: { subjectId: { type: 'string' } },
    required: ['subjectId'],
  };
  const descriptor: CapabilityDescriptor = {
    id: 'asset.inspect',
    kind: 'query',
    version: 'editor-product/v1',
    subject: 'asset',
    verb: 'inspect',
    inputSchema,
    outputSchema: { type: 'object' },
    availability: { available: true },
    preconditions: [],
    recoveryActions: [],
  };

  expect(module.isCapabilityDescriptor(descriptor)).toBe(true);
  expect(module.capabilityId('asset', 'inspect')).toBe('asset.inspect');
});

test('a missing executor is represented as unavailable instead of disappearing', async () => {
  const { CapabilityRegistry } = await import('../../kernel/capability-registry');
  const registry = new CapabilityRegistry();

  registry.register({
    id: 'asset.inspect',
    kind: 'query',
    version: 'editor-product/v1',
    subject: 'asset',
    verb: 'inspect',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    availability: { available: true },
    preconditions: [],
    recoveryActions: [],
  });

  const entry = registry.describe('asset.inspect');
  expect(entry?.availability).toMatchObject({
    available: false,
    code: 'executor-unavailable',
  });
  expect(entry?.availability.reason).toBeTruthy();
});
