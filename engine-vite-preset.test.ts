import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverParticleCodeModules } from './engine-vite-preset';

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
