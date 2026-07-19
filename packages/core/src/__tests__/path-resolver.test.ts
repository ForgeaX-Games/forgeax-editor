// path-resolver.test.ts — pins the host-injected game path resolver contract
// (layout decoupling, 2026-06-25).
//
// WHY THIS EXISTS:
//   editor-core is layout-agnostic: it asks for game-relative paths and a HOST
//   installs the <slug>→disk mapping via setPathResolver. The critical invariant
//   is FAIL FAST (architecture-principles §5): with no resolver installed,
//   resolveGamePath must THROW EditorPathResolverError — never silently fall
//   back to the old `.forgeax/games/<slug>/…` convention (the exact coupling we
//   removed). A silent fallback would re-bake the host layout into the pure lib.

import { afterEach, describe, expect, it } from 'bun:test';

import {
  setPathResolver,
  resolveGamePath,
  hasPathResolver,
  EditorPathResolverError,
} from '../util/path-resolver';

// Each test owns the global singleton; always uninstall after.
afterEach(() => setPathResolver(null));

describe('path-resolver — fail fast (no resolver installed)', () => {
  it('throws EditorPathResolverError, not a silent fallback', () => {
    setPathResolver(null);
    expect(hasPathResolver()).toBe(false);
    expect(() => resolveGamePath('forge.json')).toThrow(EditorPathResolverError);
  });

  it('the thrown error carries the PATH_RESOLVER_NOT_SET code', () => {
    setPathResolver(null);
    try {
      resolveGamePath('scenes/main.pack.json');
      throw new Error('expected resolveGamePath to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EditorPathResolverError);
      expect((e as EditorPathResolverError).code).toBe('PATH_RESOLVER_NOT_SET');
    }
  });

  it('never returns the removed .forgeax/games convention by default', () => {
    setPathResolver(null);
    // If a future change re-added a silent default, this would return a string
    // instead of throwing — the regression we are guarding against.
    expect(() => resolveGamePath('forge.json')).toThrow();
  });
});

describe('path-resolver — installed resolver', () => {
  it('maps a game-relative path through the injected resolver', () => {
    setPathResolver((rel) => `host/root/${rel}`);
    expect(hasPathResolver()).toBe(true);
    expect(resolveGamePath('forge.json')).toBe('host/root/forge.json');
    expect(resolveGamePath('scenes/main.pack.json')).toBe('host/root/scenes/main.pack.json');
  });

  it('the slug is the host closure\'s concern, not the library\'s', () => {
    // The library passes only game-relative paths; the host bakes the slug in.
    const slug = 'spin-cube';
    setPathResolver((rel) => (rel ? `.forgeax/games/${slug}/${rel}` : `.forgeax/games/${slug}`));
    expect(resolveGamePath('assets')).toBe('.forgeax/games/spin-cube/assets');
    expect(resolveGamePath('')).toBe('.forgeax/games/spin-cube');
  });

  it('uninstalling restores the fail-fast behavior', () => {
    setPathResolver((rel) => rel);
    expect(resolveGamePath('x')).toBe('x');
    setPathResolver(null);
    expect(() => resolveGamePath('x')).toThrow(EditorPathResolverError);
  });
});
