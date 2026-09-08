import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDdcBuildCacheRoot,
  resolveDdcProjectRoot,
  resolveDdcRootPolicy,
} from '../vite/ddc-root-policy';

describe('DDC build cache root policy', () => {
  test('accepts the explicit absolute host root', () => {
    expect(resolveDdcBuildCacheRoot('/tmp/forgeax-default', {
      buildCacheRoot: '/tmp/forgeax-host-cache/../forgeax-host-cache',
    })).toBe('/tmp/forgeax-host-cache');
  });

  test('keeps a dynamic host fallback absolute', () => {
    expect(resolveDdcBuildCacheRoot(resolve('/tmp', 'forgeax-dynamic-ddc')))
      .toBe('/tmp/forgeax-dynamic-ddc');
  });

  test('rejects a relative explicit host root', () => {
    expect(() => resolveDdcBuildCacheRoot('/tmp/forgeax-default', {
      buildCacheRoot: 'relative-cache',
    })).toThrow('buildCacheRoot must be an absolute host-injected path');
  });

  test('keeps disposable publication roots outside the live game by explicit injection', () => {
    const game = mkdtempSync(resolve(tmpdir(), 'forgeax-ddc-root-policy-'));
    const disposable = resolve(game, '..', 'parity-output', 'project-ddc');
    writeFileSync(resolve(game, 'forge.json'), '{}');
    const previous = process.env.FORGEAX_DDC_PROJECT_ROOT;
    try {
      process.env.FORGEAX_DDC_PROJECT_ROOT = disposable;
      expect(resolveDdcProjectRoot(game)).toBe(disposable);
      const policy = resolveDdcRootPolicy(game, {
        buildCacheRoot: resolve(game, '..', 'parity-output', 'build-cache'),
      });
      expect(policy.projectDdcRoot).toBe(disposable);
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_DDC_PROJECT_ROOT;
      else process.env.FORGEAX_DDC_PROJECT_ROOT = previous;
      rmSync(game, { recursive: true, force: true });
    }
  });

  test('rejects a relative disposable publication root', () => {
    const game = mkdtempSync(resolve(tmpdir(), 'forgeax-ddc-root-policy-'));
    writeFileSync(resolve(game, 'forge.json'), '{}');
    try {
      expect(() => resolveDdcProjectRoot(game, { projectDdcRoot: 'relative-ddc' }))
        .toThrow('projectDdcRoot must be an absolute host-injected path');
    } finally {
      rmSync(game, { recursive: true, force: true });
    }
  });
});
