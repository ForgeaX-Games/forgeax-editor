import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExternalRootFarmRuntimeRoot, setupExternalRootFarm } from '../external-root-farm';

describe('external root farm', () => {
  test('repairs the immutable asset farms at the authoritative project-bind boundary', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toMatch(/prepareGameMount:[\s\S]*?ensureExternalRootFarms\(\);[\s\S]*?setupSingleGameRootFarm/);
    expect(config).toMatch(/setupExternalRootFarm\(runtimeWorkspaceRoot, 'shared-assets'/);
    expect(config).toMatch(/setupExternalRootFarm\(runtimeWorkspaceRoot, 'engine-assets'/);
    expect(config).toMatch(/relative\(runtimeWorkspaceRoot, farmGamePath/);
  });

  test('uses the writable packaged runtime workspace instead of the read-only config directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-external-root-farm-'));
    try {
      const readOnlyConfigRoot = join(root, 'mounted-app-resources');
      const runtimeRoot = join(root, 'project-runtime');
      const target = join(root, 'assets');
      mkdirSync(readOnlyConfigRoot, { recursive: true });
      mkdirSync(runtimeRoot, { recursive: true });
      mkdirSync(target, { recursive: true });

      const selectedRoot = resolveExternalRootFarmRuntimeRoot(readOnlyConfigRoot, {
        FORGEAX_ENGINE_WORKSPACE_ROOT: runtimeRoot,
      });
      expect(realpathSync(selectedRoot)).toBe(realpathSync(runtimeRoot));

      const link = setupExternalRootFarm(selectedRoot, 'shared-assets', target);
      expect(realpathSync(link)).toBe(realpathSync(target));
      expect(existsSync(join(readOnlyConfigRoot, 'shared-assets'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates a missing asset farm and repairs it after runtime removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-external-root-farm-'));
    try {
      const runtimeRoot = join(root, 'runtime');
      const target = join(root, 'assets');
      mkdirSync(runtimeRoot, { recursive: true });
      mkdirSync(target, { recursive: true });

      const link = setupExternalRootFarm(runtimeRoot, 'shared-assets', target);
      expect(realpathSync(link)).toBe(realpathSync(target));

      rmSync(link, { force: true });
      expect(existsSync(link)).toBe(false);

      setupExternalRootFarm(runtimeRoot, 'shared-assets', target);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(target));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('repairs dangling or wrong symlinks and a Git text-file placeholder', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-external-root-farm-'));
    try {
      const runtimeRoot = join(root, 'runtime');
      const target = join(root, 'assets');
      const wrongTarget = join(root, 'wrong-assets');
      const link = join(runtimeRoot, 'shared-assets');
      mkdirSync(runtimeRoot, { recursive: true });
      mkdirSync(target, { recursive: true });
      mkdirSync(wrongTarget, { recursive: true });

      symlinkSync(join(root, 'missing-assets'), link, 'junction');
      setupExternalRootFarm(runtimeRoot, 'shared-assets', target);
      expect(realpathSync(link)).toBe(realpathSync(target));

      rmSync(link, { force: true });
      symlinkSync(wrongTarget, link, 'junction');
      setupExternalRootFarm(runtimeRoot, 'shared-assets', target);
      expect(realpathSync(link)).toBe(realpathSync(target));

      rmSync(link, { force: true });
      writeFileSync(link, '../../forgeax-editor-assets\n');
      setupExternalRootFarm(runtimeRoot, 'shared-assets', target);
      expect(realpathSync(link)).toBe(realpathSync(target));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to replace a real directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-external-root-farm-'));
    try {
      const runtimeRoot = join(root, 'runtime');
      const target = join(root, 'assets');
      mkdirSync(join(runtimeRoot, 'shared-assets'), { recursive: true });
      mkdirSync(target, { recursive: true });

      expect(() => setupExternalRootFarm(runtimeRoot, 'shared-assets', target)).toThrow(
        'refusing to replace non-symlink external root farm',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
