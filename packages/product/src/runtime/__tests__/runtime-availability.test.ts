import { expect, test } from 'bun:test';

import {
  createRuntimeAvailability,
  RuntimeAvailabilitySchema,
  unavailableRuntimeError,
} from '@forgeax/editor-product';

test('runtime availability is derived from the host capability matrix', () => {
  for (const host of ['browser', 'bun', 'play'] as const) {
    const availability = createRuntimeAvailability({
      host,
      capabilities: {
        play: { available: true },
        stop: { available: true },
        query: { available: true },
        fixedStep: { available: true },
        dispose: { available: true },
        capture: { available: false, code: 'display-unavailable', reason: `${host} has no capture in this test` },
        reveal: { available: false, code: 'display-unavailable', reason: `${host} has no reveal in this test` },
      },
    });
    expect(RuntimeAvailabilitySchema.safeParse(availability).success).toBe(true);
    expect(availability.host).toBe(host);
    expect(availability.capabilities.capture).toMatchObject({ available: false, code: 'display-unavailable' });
    expect(availability.blocking).toBe(false);
  }
});

test('missing required runtime is blocking while display gaps remain recoverable', () => {
  const availability = createRuntimeAvailability({
    host: 'browser',
    blocking: true,
    capabilities: {
      play: { available: false, blocking: true, code: 'runtime-unavailable', reason: 'browser runtime is not connected', resolution: 'connect the browser adapter' },
      capture: { available: false, code: 'display-unavailable', reason: 'capture is optional' },
    },
  });
  expect(availability.blocking).toBe(true);
  expect(availability.capabilities.play).toMatchObject({ available: false, blocking: true });
  expect(unavailableRuntimeError('play', 'browser runtime is not connected', true)).toMatchObject({ code: 'runtime-unavailable', retryable: false });
});
