import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = readFileSync(new URL('../../bun.lock', import.meta.url), 'utf8');

test('all Editor workspaces use the product-pinned Vite runtime', () => {
  const pinned = packageJson.overrides?.vite;
  assert.match(pinned ?? '', /^\d+\.\d+\.\d+$/);

  const resolved = new Set(
    [...lock.matchAll(/"(?:[^"]*\/)?vite":\s*\["vite@(\d+\.\d+\.\d+)"/g)]
      .map((match) => match[1]),
  );

  assert.deepEqual([...resolved], [pinned]);
});
