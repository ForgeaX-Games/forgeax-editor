import { expect, test } from 'bun:test';

import { CapabilityRegistry } from './capability-registry';

test('manifest is a lossless projection of the registration SSOT', () => {
  const registry = new CapabilityRegistry();
  const execute = async () => ({ ok: true as const });
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
    executor: { execute },
  });

  const manifest = registry.manifest();
  expect(manifest.capabilities).toHaveLength(1);
  expect(manifest.capabilities[0]?.id).toBe('asset.inspect');
  expect(registry.discover().map((entry) => entry.id)).toEqual(['asset.inspect']);
});

test('new registrations automatically appear without concrete-kind branches', () => {
  const registry = new CapabilityRegistry();
  const descriptor = {
    id: 'scene.save',
    kind: 'operation' as const,
    version: 'editor-product/v1',
    subject: 'scene',
    verb: 'save',
    inputSchema: null,
    outputSchema: { type: 'object' as const },
    availability: { available: true as const },
    preconditions: [],
    recoveryActions: [],
    executor: { execute: async () => ({ ok: true as const }) },
  };

  registry.register(descriptor);

  expect(registry.manifest().capabilities).toContainEqual(
    expect.objectContaining({ id: 'scene.save', subject: 'scene', verb: 'save' }),
  );
});
