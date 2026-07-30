import { expect, test } from 'bun:test';

import {
  authorizeTransportRequest,
  createTransportSecurityPolicy,
} from './service';

const policy = createTransportSecurityPolicy({
  version: 'editor-transport/v1',
  scopes: ['game:sample'],
  permissions: { 'run.dispatch': 'execute', 'run.get': 'read' },
  confirmationMethods: ['asset.delete'],
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    version: 'editor-transport/v1',
    method: 'run.dispatch',
    scope: 'game:sample',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    permission: 'execute',
    ...overrides,
  };
}

test('security rejects incompatible, unauthorized, and out-of-scope requests before mutation', () => {
  const rejected = [
    request({ version: 'editor-transport/v0' }),
    request({ permission: 'read' }),
    request({ scope: 'game:other' }),
    request({ actor: { id: '', kind: 'ai' } }),
  ];

  for (const value of rejected) {
    const result = authorizeTransportRequest(value, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        retryable: false,
        recoveryActions: expect.arrayContaining(['transport.describe']),
      });
      expect(result.error.code).not.toBe('operation-failed');
    }
  }
});

test('confirmation and cancellation are explicit transport facts', () => {
  const confirmation = authorizeTransportRequest(request({ method: 'asset.delete' }), policy);
  expect(confirmation).toMatchObject({
    ok: false,
    error: { code: 'confirmation-required', confirmation: { required: true } },
  });

  const confirmed = authorizeTransportRequest(request({ method: 'asset.delete', confirmationToken: 'confirm-1' }), policy);
  expect(confirmed).toMatchObject({ ok: true });

  const cancelled = authorizeTransportRequest(request({ cancel: true }), policy);
  expect(cancelled).toMatchObject({ ok: false, error: { code: 'run-cancelled' } });
});
