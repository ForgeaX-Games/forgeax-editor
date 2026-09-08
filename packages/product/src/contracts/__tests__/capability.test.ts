import { expect, test } from 'bun:test';

import { createCapabilityManifest } from '../manifest';
import {
  isCapabilityBlocked,
  type CapabilityDescriptor,
  type CapabilitySchema,
} from '../capability';

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

test('a blocked descriptor remains discoverable with an opaque g0 and owner route', () => {
  const descriptor: CapabilityDescriptor = {
    id: 'scene.createAsset',
    kind: 'operation',
    version: 'editor-product/v1',
    subject: 'scene',
    verb: 'createAsset',
    capabilityGeneration: 'g0',
    inputSchema: { type: 'object', required: ['packPath', 'guid', 'assetKind', 'name'] },
    outputSchema: null,
    availability: {
      available: false,
      code: 'capability-blocked',
      reason: 'createAsset has no request-correlated terminal OperationRun',
      stage: 'preflight',
      owner: '@forgeax/editor-core OperationRun/applier contract owner',
      recoveryAction: 'owner.repair',
      diagnosticId: 'q5-create-asset-terminal-run',
    },
    preconditions: ['editor.discover'],
    recoveryActions: ['owner.repair', 'editor.discover'],
  };

  expect(isCapabilityBlocked(descriptor)).toBe(true);
  const manifest = createCapabilityManifest([descriptor], '0.1.0');
  expect(manifest.progressiveDisclosure).toMatchObject({
    proposition: expect.any(String),
    shortestPath: expect.arrayContaining(['discover', 'preflight']),
    recovery: expect.arrayContaining(['owner.repair']),
  });
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
