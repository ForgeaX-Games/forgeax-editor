import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPrBaseFreshness } from '../check-pr-base-freshness.mjs';

const current = 'a'.repeat(40);
const next = 'b'.repeat(40);

test('non pull-request events do not require a PR base', () => {
  assert.deepEqual(
    checkPrBaseFreshness({ eventName: 'push' }),
    { ok: true, code: 'not-applicable', eventName: 'push' },
  );
});

test('a PR whose base is current main is admitted', () => {
  const result = checkPrBaseFreshness({
    eventName: 'pull_request',
    eventBaseSha: current,
    remoteMainSha: current,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'pr-base-current');
  assert.equal(result.baseSha, current);
  assert.equal(result.remoteMainSha, current);
});

test('a PR based on an older main is rejected with structured recovery data', () => {
  const result = checkPrBaseFreshness({
    eventName: 'pull_request',
    eventBaseSha: current,
    remoteMainSha: next,
  });
  assert.deepEqual(result, {
    ok: false,
    code: 'pr-base-stale',
    expected: next,
    observed: current,
    hint: 'Update the pull-request branch onto the current main and rerun CI before merging.',
  });
});

test('a PR admission fails closed when either SHA is missing or malformed', () => {
  assert.equal(
    checkPrBaseFreshness({ eventName: 'pull_request', eventBaseSha: '', remoteMainSha: current }).code,
    'pr-base-sha-invalid',
  );
  assert.equal(
    checkPrBaseFreshness({ eventName: 'pull_request', eventBaseSha: current, remoteMainSha: 'not-a-sha' }).code,
    'remote-main-sha-invalid',
  );
});
