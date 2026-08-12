import { expect, test } from 'bun:test';

import {
  CapabilityRegistry,
  compareHostCapabilities,
  type CapabilityHost,
} from '../capability-registry';

const hosts: readonly CapabilityHost[] = ['bun', 'edit', 'play'];

test('non-display capabilities have the same ids on Bun, Edit, and Play hosts', () => {
  const registry = new CapabilityRegistry();
  const executor = { execute: async () => ({ ok: true as const }) };
  registry.register({
    id: 'scene.save',
    kind: 'operation',
    version: 'editor-product/v1',
    subject: 'scene',
    verb: 'save',
    inputSchema: null,
    outputSchema: { type: 'object' },
    availability: { available: true },
    availabilityByHost: {
      bun: { available: true },
      edit: { available: true },
      play: { available: true },
    },
    preconditions: [],
    recoveryActions: [],
    executor,
  });

  const parity = compareHostCapabilities(registry, hosts);

  expect(parity.nonDisplayIdsByHost.bun).toEqual(['scene.save']);
  expect(parity.nonDisplayDifferences).toEqual([]);
});

test('display-only capabilities expose host availability instead of changing the shared set', () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'runtime.capture',
    kind: 'query',
    version: 'editor-product/v1',
    subject: 'runtime',
    verb: 'capture',
    presentationOnly: true,
    inputSchema: null,
    outputSchema: { type: 'object' },
    availability: { available: true },
    availabilityByHost: {
      bun: { available: false, code: 'host-unavailable', reason: 'Bun has no display surface.' },
      edit: { available: true },
      play: { available: true },
    },
    preconditions: [],
    recoveryActions: ['runtime.query'],
    executor: { execute: async () => ({ ok: true as const }) },
  });

  const parity = compareHostCapabilities(registry, hosts);

  expect(parity.nonDisplayDifferences).toEqual([]);
  expect(parity.availabilityByHost.bun?.['runtime.capture']).toMatchObject({
    available: false,
    code: 'host-unavailable',
  });
});
