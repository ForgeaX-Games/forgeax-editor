// discoverer.ts — module discoverer: manifest → /@fs/ import → dual-enum → world registration (M4 w21).
//
// Flow:
//   1. Receives script list from server manifest endpoint (w20).
//   2. Per-script: import('/@fs/<absPath>?t=<ts>') dynamic import.
//   3. Reads getRegisteredComponents() / getRegisteredSystems() registry delta.
//   4. Registers systems into the edit-mode world.
//   5. Labels determine gameplay vs structure (D-5).
//
// Error handling (w22):
//   - Duplicate component/system name → fail-fast DiscoverError (.code/.expected/.hint).
//   - Import failure → broken partial success (DiscoverError in result.errors).
//
// Anchors:
//   plan-strategy D-3/D-4/D-5: discoverer + errors + label filtering
//   requirements AC-07/09/10: dual-enum hit, duplicate gate, broken state
//   charter P3: explicit failure — structured errors with property access

import type { World } from '@forgeax/engine-ecs';
import type { DiscoverError } from './discoverer-errors';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single module discovered and successfully processed. */
export interface DiscoveredModule {
  /** Relative path within the project (e.g. 'assets/health.ts'). */
  readonly relPath: string;
  /** Absolute filesystem path used for import. */
  readonly absPath: string;
  /** Component names registered by this module. */
  readonly components: string[];
  /** System names registered by this module. */
  readonly systems: string[];
}

/** Result of a complete discovery pass. */
export interface DiscoverResult {
  /** Successfully processed modules. */
  readonly modules: DiscoveredModule[];
  /** Errors (broken modules, duplicate conflicts) — partial success. */
  readonly errors: DiscoverError[];
}

// ── Implement stubs (TDD red stage) ──────────────────────────────────────────

/**
 * Discover and register all game-logic modules from the provided script list.
 *
 * @param world - The edit-mode world to register systems into.
 * @param scripts - { relPath, absPath } pairs from the server manifest.
 * @returns Discovery result with modules and errors.
 * @throws DiscoverError on duplicate component/system (fail-fast).
 */
export async function discoverModules(
  _world: World,
  _scripts: Array<{ relPath: string; absPath: string }>,
): Promise<DiscoverResult> {
  // TDD red stage — stub that will be replaced in w21/w22.
  return { modules: [], errors: [] };
}
