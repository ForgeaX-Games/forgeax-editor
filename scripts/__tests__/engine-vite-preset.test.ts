import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverParticleCodeModules, engineVitePreset } from '../vite/engine-vite-preset';
import { engineVitePreset as publicEngineVitePreset } from '../../engine-vite-preset';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-vfx-modules-'));
  tempRoots.push(root);
  return root;
}

describe('particle code module discovery', () => {
  test('refreshes when a dynamic host replaces the roots returned by its provider', () => {
    const root = tempRoot();
    const modulePath = join(root, 'charge.vfx.wgsl');
    let roots: readonly string[] = [];
    const modules = discoverParticleCodeModules(() => roots);

    expect(modules['charge.vfx.wgsl']).toBeUndefined();
    writeFileSync(modulePath, 'fn vfx_spawn() {}');
    roots = [root];
    expect(modules['charge.vfx.wgsl']?.entry).toBe('fn vfx_spawn() {}');
  });

  test('refreshes changed and removed WGSL when a watched pack is recooked', () => {
    const root = tempRoot();
    const modulePath = join(root, 'pulse.vfx.wgsl');
    writeFileSync(modulePath, 'fn vfx_spawn() {}');
    const modules = discoverParticleCodeModules([root]);

    expect(modules['pulse.vfx.wgsl']?.entry).toBe('fn vfx_spawn() {}');
    writeFileSync(modulePath, 'fn vfx_spawn() { let changed = true; }');
    expect(modules['pulse.vfx.wgsl']?.entry).toBe('fn vfx_spawn() { let changed = true; }');
    unlinkSync(modulePath);
    expect(modules['pulse.vfx.wgsl']).toBeUndefined();
  });

  test('fails fast when two roots claim the same module identity', () => {
    const root = tempRoot();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(root, 'pulse.vfx.wgsl'), 'fn vfx_spawn() {}');
    writeFileSync(join(nested, 'pulse.vfx.wgsl'), 'fn vfx_spawn() { let duplicate = true; }');

    expect(() => discoverParticleCodeModules([root])).toThrow(
      'duplicate VFX module identity pulse.vfx.wgsl',
    );
  });
});

describe('shared engine Vite preset', () => {
  test('keeps the host-facing config-time facade on the same implementation', () => {
    expect(publicEngineVitePreset).toBe(engineVitePreset);
  });

  test('pre-bundles Noble subpaths from their owning engine packages', () => {
    const preset = engineVitePreset({ base: '/', gameDirAbs: null });

    expect(preset.optimizeDeps.include).toEqual([
      '@forgeax/engine-animation > @noble/hashes/blake3.js',
      '@forgeax/engine-pack > @noble/hashes/sha2.js',
      '@forgeax/engine-pack > @noble/hashes/utils.js',
    ]);
  });
});
