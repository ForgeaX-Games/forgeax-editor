import { expect, test } from 'bun:test';

import { EditGateway } from '../gateway';
import { domainOf, registerTransientApplier } from '../appliers';
import { createEditSession } from '../../session/document';

test('Gateway joins static contracts with live applier availability', () => {
  const gateway = new EditGateway(createEditSession());
  const before = gateway.operationCapabilitySnapshot();
  for (const descriptor of before.ops) {
    const expectedAvailable = descriptor.capabilityStatus === 'blocked'
      ? false
      : domainOf(descriptor.id) === descriptor.domain;
    expect(descriptor.availability.available).toBe(expectedAvailable);
    if (!descriptor.availability.available) {
      expect(['applier-unavailable', 'capability-blocked']).toContain(descriptor.availability.code);
    }
  }
  expect(Object.isFrozen(before)).toBe(true);
  expect(Object.isFrozen(before.ops)).toBe(true);

  const observed: number[] = [];
  const unsubscribe = gateway.subscribeOperationCapabilities((snapshot) => observed.push(snapshot.revision));
  const dynamicId = 'test.runtimePreviewProbe';
  const unregisterDynamic = registerTransientApplier(dynamicId, () => ({ ok: true }), {
    title: 'Runtime Preview Probe',
    argsSchema: { type: 'object', properties: { entity: { type: 'number' } } },
  });
  expect(gateway.listOps().find((entry) => entry.id === dynamicId)).toMatchObject({
    source: 'registered',
    domain: 'transient',
    availability: { available: true },
    title: 'Runtime Preview Probe',
  });
  unregisterDynamic();
  expect(gateway.listOps().find((entry) => entry.id === dynamicId)).toBeUndefined();
  unsubscribe();
  expect(observed).toHaveLength(2);
});

test('g0 publishes createAsset as a serialized capability-blocked projection', () => {
  const gateway = new EditGateway(createEditSession());
  const snapshot = gateway.operationCapabilitySnapshot();
  const descriptor = snapshot.ops.find((entry) => entry.id === 'createAsset');

  expect(snapshot.capabilityGeneration).toBe('g0');
  expect(descriptor).toMatchObject({
    source: 'registered',
    domain: 'document',
    capabilityGeneration: 'g0',
    capabilityStatus: 'blocked',
    stage: 'preflight',
    owner: '@forgeax/editor-core OperationRun/applier contract owner',
    recoveryAction: 'owner.repair',
    diagnosticId: 'q5-create-asset-terminal-run',
    availability: {
      available: false,
      code: 'capability-blocked',
      capabilityGeneration: 'g0',
      stage: 'preflight',
      owner: '@forgeax/editor-core OperationRun/applier contract owner',
      recoveryAction: 'owner.repair',
      diagnosticId: 'q5-create-asset-terminal-run',
    },
  });
  expect(descriptor?.argsSchema).toMatchObject({
    type: 'object',
    required: ['packPath', 'guid', 'assetKind', 'name'],
  });
  expect(descriptor?.completion).toBeUndefined();
  expect(descriptor?.operationRun).toBeUndefined();
  expect(descriptor?.recoveryActions).toContain('owner.repair');
  expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({ capabilityGeneration: 'g0' });

  const listed = gateway.listOps().find((entry) => entry.id === 'createAsset');
  expect(listed).toEqual(descriptor);
  expect(gateway.operationCapabilitySnapshot().capabilityGeneration)
    .toBe(snapshot.capabilityGeneration);
});

test('a described downstream completion stays running until its Gateway OperationRun is terminal', async () => {
  const gateway = new EditGateway(createEditSession());
  let finish!: (value: { readonly ok: true; readonly result: unknown }) => void;
  const completion = new Promise<{ readonly ok: true; readonly result: unknown }>((resolve) => {
    finish = resolve;
  });
  const unregister = registerTransientApplier(
    'test.runtimeAsyncPreview',
    () => ({ ok: true, completion }),
    {
      title: 'Async Runtime Preview',
      argsSchema: {
        type: 'object',
        properties: { requestId: { type: 'string' } },
        required: ['requestId'],
      },
      operationRun: {
        acceptedStatuses: ['accepted', 'running'],
        terminalStatuses: ['succeeded', 'failed'],
        read: {
          get: 'getOperationRun',
          wait: 'waitOperationRun',
          subscribe: 'subscribeOperationRun',
        },
        retry: { requiresNewRequestId: true },
        retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
        cancellable: false,
      },
    },
  );
  try {
    expect(gateway.listOps().find((entry) => entry.id === 'test.runtimeAsyncPreview'))
      .toMatchObject({ operationRun: { cancellable: false } });
    const accepted = gateway.dispatch({
      kind: 'test.runtimeAsyncPreview',
      requestId: 'preview-async-1',
    } as never, 'ai');
    expect(accepted).toMatchObject({
      ok: true,
      result: { operationRun: { requestId: 'preview-async-1', status: 'running' } },
    });

    finish({ ok: true, result: { phaseTick: 120 } });
    await expect(gateway.waitOperationRun('preview-async-1')).resolves.toMatchObject({
      ok: true,
      value: { status: 'succeeded', result: { phaseTick: 120 } },
    });
  } finally {
    unregister();
  }
});
