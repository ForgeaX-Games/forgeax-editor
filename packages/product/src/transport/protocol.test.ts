import { expect, test } from 'bun:test';

import {
  TRANSPORT_PROTOCOL_VERSION,
  TransportRequestSchema,
  TransportResponseSchema,
  createProtocolError,
  parseTransportMessage,
} from './protocol';

test('versioned JSON-RPC messages retain correlation and run identity', () => {
  const request = {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: 'request-1',
    correlationId: 'corr-1',
    scope: 'game:demo',
    method: 'run.get',
    params: { runId: 'run-1' },
  };
  const response = {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: 'request-1',
    correlationId: 'corr-1',
    runId: 'run-1',
    result: { status: 'succeeded' },
  };

  expect(TransportRequestSchema.safeParse(request).success).toBe(true);
  expect(TransportResponseSchema.safeParse(response).success).toBe(true);
  expect(parseTransportMessage(JSON.stringify(response))).toMatchObject({ ok: true, value: response });
});

test('invalid version, missing fields, wrong types, and malformed lines are protocol errors', () => {
  const invalidMessages: unknown[] = [
    { jsonrpc: '2.0', version: 'old', id: '1', correlationId: 'c', scope: 'game:demo', method: 'run.get', params: {} },
    { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: '1', scope: 'game:demo', method: 'run.get', params: {} },
    { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 1, correlationId: 'c', scope: 'game:demo', method: 'run.get', params: {} },
    { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: '1', correlationId: 'c', method: 'run.get', params: {} },
    '{not-json',
  ];

  for (const message of invalidMessages) {
    const result = parseTransportMessage(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expectedCode = typeof message === 'object' && message !== null && 'version' in message && message.version !== TRANSPORT_PROTOCOL_VERSION
        ? 'protocol-bad-version'
        : 'protocol-invalid-message';
      expect(result.error).toMatchObject({
        code: expectedCode,
        retryable: false,
        recoveryActions: ['transport.describe'],
      });
      expect(result.error.hint).not.toContain('Unexpected token');
    }
  }

  expect(createProtocolError('bad-version', 'use the current transport version')).toMatchObject({
    code: 'protocol-bad-version',
    expected: { version: TRANSPORT_PROTOCOL_VERSION },
  });
});
