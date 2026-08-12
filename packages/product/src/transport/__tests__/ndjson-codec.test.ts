import { expect, test } from 'bun:test';

import {
  decodeNdjson,
  encodeNdjson,
  parseTransportMessage,
} from '../protocol';

test('NDJSON codec preserves one typed message per line', () => {
  const messages = [
    { jsonrpc: '2.0', version: 'editor-transport/v1', id: '1', correlationId: 'c1', scope: 'game:demo', method: 'discover', params: {} },
    { jsonrpc: '2.0', version: 'editor-transport/v1', id: '2', correlationId: 'c2', scope: 'game:demo', method: 'run.wait', params: { runId: 'run-1' } },
  ];
  const encoded = messages.map((message) => encodeNdjson(message as Parameters<typeof encodeNdjson>[0])).join('');
  expect(encoded.endsWith('\n')).toBe(true);
  const decoded = decodeNdjson(encoded);
  expect(decoded).toHaveLength(2);
  expect(decoded.every((message) => message.ok)).toBe(true);
  expect(parseTransportMessage(decoded[1] && decoded[1].ok ? decoded[1].value : null)).toMatchObject({ ok: true });
});

test('NDJSON decoder reports malformed lines without throwing or dropping the line', () => {
  const decoded = decodeNdjson('{"jsonrpc":"2.0"}\nnot-json\n');
  expect(decoded).toHaveLength(2);
  expect(decoded.every((message) => !message.ok)).toBe(true);
  expect(decoded.map((message) => message.ok ? 'ok' : message.error.code)).toEqual([
    'protocol-bad-version',
    'protocol-invalid-message',
  ]);
});
