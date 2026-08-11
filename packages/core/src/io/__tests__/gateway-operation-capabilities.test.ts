import { expect, test } from 'bun:test';

import { EditGateway } from '../gateway';
import { domainOf, registerTransientApplier } from '../appliers';
import { createEditSession } from '../../session/document';

test('Gateway joins static contracts with live applier availability', () => {
  const gateway = new EditGateway(createEditSession());
  const before = gateway.operationCapabilitySnapshot();
  for (const descriptor of before.ops) {
    expect(descriptor.availability.available).toBe(domainOf(descriptor.id) === descriptor.domain);
    if (!descriptor.availability.available) {
      expect(descriptor.availability.code).toBe('applier-unavailable');
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
