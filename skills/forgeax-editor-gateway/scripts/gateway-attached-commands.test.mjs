import assert from 'node:assert/strict';
import { test } from 'bun:test';

import {
  isGatewayAttachedCommand,
  parseGatewayAttachedCommand,
  runGatewayAttachedCommand,
} from './gateway-attached-commands.mjs';

test('recognizes only structured attached-realm commands', () => {
  assert.equal(isGatewayAttachedCommand(['list']), true);
  assert.equal(isGatewayAttachedCommand(['help', 'play']), true);
  assert.equal(isGatewayAttachedCommand(['dispatch', 'play']), true);
  assert.equal(isGatewayAttachedCommand(['--file', 'snippet.js']), false);
});

test('parses a dispatch without product transport concepts', () => {
  assert.deepEqual(parseGatewayAttachedCommand([
    'dispatch', 'play', '--input', '{"dirtyPolicy":"last-saved"}', '--timeout', '120000',
  ]), {
    command: 'dispatch', operation: 'play', input: { dirtyPolicy: 'last-saved' }, timeout: 120000,
  });
});

test('translates dispatch to the public Gateway surface', async () => {
  const calls = [];
  const result = await runGatewayAttachedCommand(
    ['dispatch', 'stop'],
    async (code, timeout) => {
      calls.push({ code, timeout });
      return { ok: true, value: { ok: true } };
    },
  );
  assert.deepEqual(result, { ok: true, value: { ok: true } });
  assert.deepEqual(calls, [{ code: 'gateway.dispatch({...{},kind:"stop"},\'ai\')', timeout: undefined }]);
});

test('derives operation help from listOps instead of a CLI-owned schema', async () => {
  const calls = [];
  await runGatewayAttachedCommand(['help', 'importAsset'], async (code) => {
    calls.push(code);
    return { ok: true, value: { id: 'importAsset' } };
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /gateway\.listOps\(\)/);
  assert.match(calls[0], /importAsset/);
});
