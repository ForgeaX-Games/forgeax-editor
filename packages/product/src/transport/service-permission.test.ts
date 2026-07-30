import { expect, test } from 'bun:test';

import {
  createTransportSecurityPolicy,
  validateTransportScope,
} from './service';

test('scope validation exposes a recovery hint instead of parsing message text', () => {
  const policy = createTransportSecurityPolicy({
    version: 'editor-transport/v1',
    scopes: ['game:sample'],
    permissions: { 'asset.query': 'read' },
  });

  expect(validateTransportScope('game:other', policy)).toMatchObject({
    ok: false,
    error: {
      code: 'scope-mismatch',
      expected: { scopes: ['game:sample'] },
      recoveryActions: ['transport.describe', 'scope.select'],
    },
  });
  expect(validateTransportScope('game:sample', policy)).toEqual({ ok: true });
});
