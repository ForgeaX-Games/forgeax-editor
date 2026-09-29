import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the real exit callback without booting Playwright or its Vite servers.
const config = readFileSync(new URL('../../../playwright.config.ts', import.meta.url), 'utf8');
const registration = config.slice(config.indexOf("process.once('exit',"), config.indexOf('\n\nexport default'));

function exitCleanup(root, remove) {
  let cleanup;
  runInNewContext(registration, {
    e2eTempRoot: root,
    rmSync: remove,
    process: { once(event, callback) {
      assert.equal(event, 'exit');
      assert.equal(cleanup, undefined, 'register one exit cleanup');
      cleanup = callback;
    } },
  });
  assert.equal(typeof cleanup, 'function');
  return cleanup;
}

test('Playwright temp cleanup bounds native retries for late ENOTEMPTY writers', () => {
  const root = '/owned-playwright-temp-root';
  let calls = 0;
  exitCleanup(root, (target, options) => {
    calls += 1;
    assert.equal(target, root);
    assert.deepEqual({ ...options }, {
      recursive: true, force: true, maxRetries: 3, retryDelay: 100,
    });
  })();
  assert.equal(calls, 1, 'Node owns bounded retry, not another unbounded loop');
});

test('Playwright temp cleanup still fails when native retry is exhausted', () => {
  const failure = Object.assign(new Error('still busy'), { code: 'ENOTEMPTY' });
  const cleanup = exitCleanup('/owned-playwright-temp-root', () => { throw failure; });
  assert.throws(cleanup, (error) => error === failure);
});

test('Playwright cleanup removes only its fixture and never follows dependency symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-cleanup-contract-'));
  const external = mkdtempSync(join(tmpdir(), 'forgeax-cleanup-external-'));
  try {
    writeFileSync(join(external, 'keep'), 'external dependency cache');
    symlinkSync(external, join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'temporary'), 'owned fixture');
    exitCleanup(root, rmSync)();
    assert.equal(existsSync(root), false);
    assert.equal(readFileSync(join(external, 'keep'), 'utf8'), 'external dependency cache');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
