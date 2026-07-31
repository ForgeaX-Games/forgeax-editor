import { expect, test } from 'bun:test';

import {
  createEntityObjectRef,
  createErrorCause,
  createCommandError,
  isCommandError,
  withCommandErrorContext,
  type CommandError,
} from './error';

test('command errors expose machine-readable recovery fields', () => {
  const error: CommandError = createCommandError({
    code: 'permission-denied',
    hint: 'Request write permission for the asset scope.',
    expected: { permission: 'asset.write' },
    current: { permission: 'asset.read' },
    subjectRef: { kind: 'asset', id: 'asset-1' },
    retryable: false,
    recoveryActions: ['permission.request'],
    message: 'The actor is not allowed to write this asset.',
  });

  expect(isCommandError(error)).toBe(true);
  expect(error.code).toBe('permission-denied');
  expect(error.hint).toBeTruthy();
  expect(error.expected).toEqual({ permission: 'asset.write' });
  expect(error.current).toEqual({ permission: 'asset.read' });
  expect(error.subjectRef).toEqual({ kind: 'asset', id: 'asset-1' });
  expect(error.retryable).toBe(false);
  expect(error.recoveryActions).toEqual(['permission.request']);
});

test('error recognition does not depend on parsing the human message', () => {
  const error = createCommandError({
    code: 'confirmation-required',
    hint: 'Confirm the destructive operation before dispatch.',
    retryable: false,
    confirmation: { required: true, token: 'confirm-token' },
    recoveryActions: ['operation.confirm'],
    message: 'Any human-readable wording is allowed here.',
  });

  expect(isCommandError({ ...error, message: 'different wording' })).toBe(true);
  expect(isCommandError({ code: error.code, message: error.message })).toBe(false);
});

test('error envelope carries stable execution context and object references', () => {
  const error = createCommandError({
    owner: 'editor-core',
    category: 'validation',
    code: 'invalid-args',
    hint: 'Provide a scene and entity.',
    operationId: 'setComponent',
    requestId: 'request-1',
    objectRefs: {
      scene: { kind: 'scene', id: 'scene-1' },
      entity: { kind: 'entity', id: '42' },
      component: { kind: 'component', id: 'Transform' },
    },
    retryable: false,
    recoveryActions: ['editor.discover'],
    cause: { code: 'schema-invalid', owner: 'editor-core', hint: 'required field is missing' },
  });

  expect(isCommandError(error)).toBe(true);
  expect(error.operationId).toBe('setComponent');
  expect(error.requestId).toBe('request-1');
  expect(error.objectRefs?.entity).toEqual({ kind: 'entity', id: '42' });
  expect(error.cause?.code).toBe('schema-invalid');
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(error.objectRefs)).toBe(true);

  const projected = withCommandErrorContext(error, { requestId: 'request-2' });
  expect(projected.requestId).toBe('request-2');
  expect(projected.hint).toBe(error.hint);
});

test('entity object refs carry a stable id and an optional world-bound locator', () => {
  const stable = createEntityObjectRef({ handle: 42 });
  expect(stable).toEqual({ kind: 'entity', id: '42' });

  const located = createEntityObjectRef({ handle: 42, worldRef: 1, epoch: 7 });
  expect(located).toEqual({
    kind: 'entity',
    id: '42',
    locator: { kind: 'entity-handle', handle: 42, worldRef: 1, epoch: 7 },
  });

  const error = createCommandError({
    code: 'invalid-args',
    hint: 'The entity is not selectable in this world.',
    objectRefs: { entity: located },
    retryable: false,
    recoveryActions: ['editor.queryWorld'],
  });
  expect(isCommandError(error)).toBe(true);
  expect(isCommandError({
    ...error,
    objectRefs: {
      entity: {
        kind: 'entity',
        id: '42',
        locator: { kind: 'entity-handle', handle: '42', worldRef: 1, epoch: 7 },
      },
    },
  })).toBe(false);
  expect(isCommandError({
    ...error,
    objectRefs: {
      entity: { kind: 'asset', id: 'asset-1', locator: located.locator },
    },
  })).toBe(false);
});

test('exception causes remain structured and do not require message parsing', () => {
  expect(createErrorCause(new Error('disk is unavailable'), 'platform-io')).toEqual({
    code: 'exception',
    owner: 'platform-io',
    hint: 'disk is unavailable',
  });
  expect(createErrorCause('not-an-error')).toEqual({
    code: 'unknown-cause',
    hint: 'The operation threw a non-error value.',
  });
});
