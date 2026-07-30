import { expect, test } from 'bun:test';

import {
  createCommandError,
  isCommandError,
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
