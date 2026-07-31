import { expect, test } from 'bun:test';

import {
  RUNTIME_CONTRACT_VERSION,
  RuntimeAvailabilitySchema,
  RuntimeOperationSchema,
  createRuntimeAvailability,
  createStaleRuntimeHandleError,
  unavailableRuntimeError,
} from './runtime';

test('runtime contract keeps simulation operations independent from display operations', () => {
  expect(RUNTIME_CONTRACT_VERSION).toBe('game-runtime/v1');
  expect(RuntimeOperationSchema.safeParse('play').success).toBe(true);
  expect(RuntimeOperationSchema.safeParse('fixedStep').success).toBe(true);
  expect(RuntimeOperationSchema.safeParse('capture').success).toBe(true);
  expect(RuntimeOperationSchema.safeParse('notAnOperation').success).toBe(false);

  const availability = createRuntimeAvailability({
    host: 'bun',
    capabilities: {
      play: { available: true },
      stop: { available: true },
      query: { available: true },
      fixedStep: { available: true },
      dispose: { available: true },
      capture: { available: false, code: 'display-unavailable', reason: 'Bun has no canvas.' },
      reveal: { available: false, code: 'display-unavailable', reason: 'Bun has no focusable surface.' },
    },
  });

  expect(RuntimeAvailabilitySchema.safeParse(availability).success).toBe(true);
  expect(availability.capabilities.capture?.available).toBe(false);
  expect(availability.capabilities.play?.available).toBe(true);
  expect(availability.blocking).toBe(false);

  expect(unavailableRuntimeError('capture', 'Bun has no canvas.')).toMatchObject({
    recoveryActions: ['transport.describe'],
    subjectRef: { kind: 'runtime-operation', id: 'capture' },
  });
});

test('stale handles fail with a structured cross-world error', () => {
  const error = createStaleRuntimeHandleError({
    expectedWorldId: 'edit-world',
    actualWorldId: 'play-world',
    handleId: 'entity-1',
  });

  expect(error).toMatchObject({
    code: 'entity-state-stale-handle',
    retryable: false,
    recoveryActions: ['runtime.query'],
    subjectRef: { kind: 'entity', id: 'entity-1' },
    expected: { worldId: 'edit-world' },
    current: { worldId: 'play-world' },
  });
});
