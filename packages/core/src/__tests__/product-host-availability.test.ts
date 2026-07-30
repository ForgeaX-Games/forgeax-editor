import { expect, test } from 'bun:test';

import { createGatewayCapabilityAdapter } from '../product/gateway-executor';

test('gateway capability adapter derives one non-display set without browser dependencies', () => {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [
      { id: 'save', domain: 'document', argsSchema: null, source: 'builtin', title: 'Save' },
      { id: 'play', domain: 'session', argsSchema: null, source: 'builtin', title: 'Play' },
    ],
    dispatch: () => ({ ok: true }),
  });

  const descriptors = adapter.capabilities();

  expect(descriptors.map((entry) => entry.id)).toEqual(['editor.save', 'editor.play']);
  expect(descriptors.every((entry) => entry.presentationOnly !== true)).toBe(true);
  expect(descriptors.every((entry) => entry.availability.available)).toBe(true);
});

test('gateway capability adapter reports missing execution explicitly', () => {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [
      { id: 'save', domain: 'document', argsSchema: null, source: 'builtin', title: 'Save' },
    ],
  });

  const save = adapter.capabilities()[0];
  expect(save?.availability).toMatchObject({
    available: false,
    code: 'executor-unavailable',
  });
  expect(save?.availability.reason).toBeTruthy();
});
