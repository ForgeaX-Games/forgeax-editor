import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { resolveGameEngineEntry } from './runtime-vite-preset';

const EDIT_RUNTIME = resolve(import.meta.dir, '..', '..');

describe('resolveGameEngineEntry', () => {
  test('maps public root and subpath imports through Edit Runtime exports', () => {
    expect(resolveGameEngineEntry('@forgeax/engine-assets-runtime')).toBe(
      resolve(EDIT_RUNTIME, 'node_modules/@forgeax/engine-assets-runtime/dist/index.mjs'),
    );
    expect(resolveGameEngineEntry('@forgeax/engine-pack/guid')).toBe(
      resolve(EDIT_RUNTIME, 'node_modules/@forgeax/engine-pack/dist/guid.mjs'),
    );
  });

  test('leaves unavailable package exports unresolved', () => {
    expect(resolveGameEngineEntry('@forgeax/not-an-engine-package')).toBeNull();
    expect(resolveGameEngineEntry('@forgeax/engine-assets-runtime/not-exported')).toBeNull();
  });
});
