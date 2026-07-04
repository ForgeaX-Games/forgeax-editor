// w16 + w17 + w18 — discoverer TDD red tests (co-commit: same file, shared fixture dir).
//
// w16: dual-enum hit — fixture TS scripts (defineComponent + defineSystem)
//      scanned by discoverer → getRegisteredComponents() / getRegisteredSystems()
//      contain the fixture-defined names.
//
// w17: duplicate fail-fast — two modules defineComponent('Health', ...) →
//      discoverer throws structured error with .code === 'DUPLICATE_COMPONENT',
//      .expected, .hint — property access consumption, not string parsing.
//
// w18: broken partial success — syntax-error script + normal script →
//      normal components/systems registered, broken script marked with
//      structured error (.code/.expected/.hint), process does not throw uncaught.
//
// Anchors:
//   plan-tasks.json w16/w17/w18: discoverer TDD tests
//   requirements AC-07: discoverer dual-enum hit (assets/ not forced to scripts/)
//   requirements AC-09: duplicate → structured error with .code/.expected/.hint
//   requirements AC-10: import failure → broken partial success
//   charter P3: explicit failure — structured errors, property access, no string parsing
//   plan-strategy D-3/D-4: discoverer + duplicate gate + broken state

import { afterEach, describe, expect, it } from 'bun:test';
import { World, defineComponent, defineSystem } from '@forgeax/engine-ecs';
import { getRegisteredComponents, getRegisteredSystems } from '@forgeax/engine-ecs';

import {
  discoverModules,
  type DiscoverResult,
  type DiscoveredModule,
  type DiscoverError,
} from '../assets/discoverer';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Absolute path to the fixture directory. */
const FIXTURE_DIR = import.meta.dirname + '/fixtures/discoverer';

/** Helper: build {relPath, absPath} pairs for a list of filenames. */
function scripts(...names: string[]): Array<{ relPath: string; absPath: string }> {
  return names.map((n) => ({ relPath: n, absPath: `${FIXTURE_DIR}/${n}` }));
}

/** Get a fresh World for each test (isolated state). */
function freshWorld(): World {
  return new World();
}

// ── Cleanup after each test (global registry is shared across tests!) ────────
// Engine's defineComponent / defineSystem use module-level Map state.
// Reset by clearing world-scoped state — the global registry persists
// but we overwrite entries. We use a per-test cleanup that re-defines
// components with known schemas to restore predictable state.

afterEach(() => {
  // Re-establish baseline registration state.
  // (The engine global registry is module-level — individual fixture imports
  //  overwrite entries, but we want a clean slate for each test.)
  // We rely on the fixture modules overwriting in the global registry;
  // the main invariant is that each test imports its own set of fixtures.
});

// ═══════════════════════════════════════════════════════════════════════════════
// w16 — dual-enum hit
// ═══════════════════════════════════════════════════════════════════════════════

describe('w16 — discoverer dual-enum hit', () => {
  it('discovers components and systems from asset scripts', async () => {
    const world = freshWorld();
    const scriptList = scripts('health.ts', 'movement.ts', 'render.ts');

    const result = await discoverModules(world, scriptList);

    // ── Components ──
    // Health should be registered (from health.ts)
    const compNames = new Set([...getRegisteredComponents().keys()]);
    expect(compNames.has('Health')).toBe(true);

    // ── Systems ──
    const sysNames = new Set([...getRegisteredSystems().keys()]);
    expect(sysNames.has('Movement')).toBe(true);
    expect(sysNames.has('Render')).toBe(true);

    // ── Result structure ──
    expect(result.modules.length).toBe(3);
    expect(result.errors.length).toBe(0);

    // Verify discovered modules track what they found
    const healthMod = result.modules.find((m) => m.relPath === 'health.ts')!;
    expect(healthMod.components).toContain('Health');

    const movementMod = result.modules.find((m) => m.relPath === 'movement.ts')!;
    expect(movementMod.systems).toContain('Movement');

    const renderMod = result.modules.find((m) => m.relPath === 'render.ts')!;
    expect(renderMod.systems).toContain('Render');
  });

  it('does not require assets/scripts/ sub-directory', async () => {
    // The fixture files are directly under assets/ — the discoverer should
    // handle any path as long as it receives valid absPath.
    const world = freshWorld();
    const scriptList = [{ relPath: 'foo.ts', absPath: `${FIXTURE_DIR}/health.ts` }];

    const result = await discoverModules(world, scriptList);

    // The Health component from health.ts should be registered, even though
    // the relPath doesn't follow any sub-directory convention.
    const compNames = new Set([...getRegisteredComponents().keys()]);
    expect(compNames.has('Health')).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// w17 — duplicate fail-fast with structured error
// ═══════════════════════════════════════════════════════════════════════════════

describe('w17 — duplicate component fail-fast', () => {
  it('throws structured error when two modules define the same component name', async () => {
    const world = freshWorld();
    // Import the first module to register Health component.
    // Then import the second module which also defines Health.
    const scriptList = scripts('dupe-a.ts', 'dupe-b.ts');

    try {
      await discoverModules(world, scriptList);
      // Should have thrown
      expect(false).toBe(true);
    } catch (e) {
      // Structured error with property access (charter P3)
      const err = e as DiscoverError;
      expect(err.code).toBe('DUPLICATE_COMPONENT');
      expect(typeof err.expected).toBe('string');
      expect(err.expected.length).toBeGreaterThan(0);
      expect(typeof err.hint).toBe('string');
      expect(err.hint.length).toBeGreaterThan(0);
      // hint should mention the conflicting module names
      expect(err.hint).toContain('Health');
    }
  });

  it('error has .code, .expected, .hint as top-level properties', async () => {
    const world = freshWorld();
    const scriptList = scripts('dupe-a.ts', 'dupe-b.ts');

    try {
      await discoverModules(world, scriptList);
      expect(false).toBe(true);
    } catch (e) {
      // All three properties must exist as own-enumerable (or own) properties,
      // not buried in a message string that requires parsing.
      expect('code' in (e as object)).toBe(true);
      expect('expected' in (e as object)).toBe(true);
      expect('hint' in (e as object)).toBe(true);

      // Values must be strings
      const err = e as { code: string; expected: string; hint: string };
      expect(err.code).toBe('DUPLICATE_COMPONENT');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// w18 — broken partial success
// ═══════════════════════════════════════════════════════════════════════════════

describe('w18 — broken partial success', () => {
  it('registers components from normal scripts when a bad script co-exists', async () => {
    const world = freshWorld();
    const scriptList = scripts('broken-syntax.ts', 'normal.ts');

    const result = await discoverModules(world, scriptList);

    // Normal script's component should be registered.
    const compNames = new Set([...getRegisteredComponents().keys()]);
    expect(compNames.has('Stamina')).toBe(true);

    // Normal script's system should be registered.
    const sysNames = new Set([...getRegisteredSystems().keys()]);
    expect(sysNames.has('Regen')).toBe(true);

    // The broken script should appear in errors (not modules).
    expect(result.errors.length).toBe(1);

    // Normal module should be in discovered modules.
    const normalMod = result.modules.find((m) => m.relPath === 'normal.ts');
    expect(normalMod).toBeDefined();
  });

  it('broken script has structured error with property access', async () => {
    const world = freshWorld();
    const scriptList = scripts('broken-syntax.ts', 'normal.ts');

    const result = await discoverModules(world, scriptList);

    expect(result.errors.length).toBe(1);
    const brokenErr = result.errors[0]!;

    // Structured error (charter P3: property access, not string parsing)
    expect(typeof brokenErr.code).toBe('string');
    expect(brokenErr.code.length).toBeGreaterThan(0);
    expect(typeof brokenErr.expected).toBe('string');
    expect(typeof brokenErr.hint).toBe('string');
    expect(brokenErr.hint.length).toBeGreaterThan(0);

    // The broken path should be recorded.
    expect(brokenErr.relPath).toBe('broken-syntax.ts');
  });

  it('does not throw uncaught — process continues for remaining scripts', async () => {
    const world = freshWorld();
    // broken-syntax.ts comes first — if discoverer didn't handle errors,
    // import would throw and stop processing. normal.ts should still work.
    const scriptList = scripts('broken-syntax.ts', 'normal.ts');

    // This must not throw.
    const result = await discoverModules(world, scriptList);

    // No uncaught exception. Both scripts were processed.
    // broken-syntax.ts → error, normal.ts → success.
    const processedPaths = [
      ...result.modules.map((m) => m.relPath),
      ...result.errors.map((e) => e.relPath),
    ];
    expect(processedPaths).toContain('broken-syntax.ts');
    expect(processedPaths).toContain('normal.ts');

    // Normal module found, no error for it.
    const normalMod = result.modules.find((m) => m.relPath === 'normal.ts')!;
    expect(normalMod.components).toContain('Stamina');
    expect(normalMod.systems).toContain('Regen');
  });
});