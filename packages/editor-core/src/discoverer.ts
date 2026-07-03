// discoverer.ts — module discoverer: import → dual-enum → world registration (M4 w21/w22).
//
// Flow:
//   1. Receives script list from server manifest endpoint (w20).
//   2. Per-script: dynamic import with cache-busting.
//   3. Reads getRegisteredComponents() / getRegisteredSystems() registry delta.
//   4. Registers systems into the edit-mode world.
//
// Error handling (w22):
//   - Duplicate component/system name → fail-fast DiscoverError (.code/.expected/.hint).
//     Detects redefinition (same key, different value) across modules.
//   - Import failure → broken partial success (DiscoverError in result.errors).
//
// Anchors:
//   plan-strategy D-3/D-4: discoverer + errors + duplicate gate
//   requirements AC-07/09/10: dual-enum hit, duplicate gate, broken state
//   charter P3: explicit failure — structured errors with property access

import { getRegisteredComponents, getRegisteredSystems } from '@forgeax/engine-ecs';
import type { SystemHandle, World } from '@forgeax/engine-ecs';
import { DiscoverErrorCode } from './discoverer-errors';
import type { DiscoverError } from './discoverer-errors';
// Re-export so consumers/tests can import the error type from the discoverer barrel.
export type { DiscoverError } from './discoverer-errors';
import { and, notEditing } from './run-conditions';

// Local alias for the engine `World` class type (imported type-only).
type EcsWorld = World;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredModule {
  readonly relPath: string;
  readonly absPath: string;
  readonly components: string[];
  readonly systems: string[];
}

export interface DiscoverResult {
  readonly modules: DiscoveredModule[];
  readonly errors: DiscoverError[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _importCounter = 0;

/**
 * Snapshot both keys AND values of the global registries.
 * Engine silently overwrites duplicate keys -- we detect redefinition by
 * comparing value references before vs after import.
 */
function snapshotRegistries(): {
  components: Map<string, unknown>;
  systems: Map<string, unknown>;
} {
  return {
    components: new Map(getRegisteredComponents()),
    systems: new Map(getRegisteredSystems()),
  };
}

/**
 * Compute which component/system names were newly added or redefined
 * (existing key with changed value) by the last import.
 */
function diffRegistries(
  before: { components: Map<string, unknown>; systems: Map<string, unknown> },
): {
  components: string[];
  systems: string[];
  redefinedComps: string[];
  redefinedSystems: string[];
} {
  const comps: string[] = [];
  const systems: string[] = [];
  const redefinedComps: string[] = [];
  const redefinedSystems: string[] = [];

  for (const [k, v] of getRegisteredComponents()) {
    const prev = before.components.get(k);
    if (prev === undefined) {
      comps.push(k);
    } else if (prev !== v) {
      redefinedComps.push(k);
    }
  }

  for (const [k, v] of getRegisteredSystems()) {
    const prev = before.systems.get(k);
    if (prev === undefined) {
      systems.push(k);
    } else if (prev !== v) {
      redefinedSystems.push(k);
    }
  }

  return { components: comps, systems, redefinedComps, redefinedSystems };
}

/**
 * Create a structured error object.
 *
 * Uses Object.create + defineProperties to ensure .code / .expected / .hint
 * are own properties with proper descriptors, so `'code' in err` (and property
 * access) work across all JS engines including JavaScriptCore (Bun).
 */
function makeError(
  code: string,
  expected: string,
  hint: string,
  relPath?: string,
): DiscoverError {
  const base = new Error(`[${code}] ${expected}`);
  // Build a wrapper that delegates to the base Error but has our own properties.
  const props: PropertyDescriptorMap = {
    code: { value: code, enumerable: true, writable: false, configurable: true },
    expected: { value: expected, enumerable: true, writable: false, configurable: true },
    hint: { value: hint, enumerable: true, writable: false, configurable: true },
    message: { value: base.message, enumerable: true, writable: false, configurable: true },
    name: { value: 'DiscoverError', enumerable: true, writable: false, configurable: true },
    stack: { value: base.stack, enumerable: false, writable: false, configurable: true },
  };
  if (relPath !== undefined) {
    props.relPath = { value: relPath, enumerable: true, writable: false, configurable: true };
  }
  return Object.create(Error.prototype, props) as DiscoverError;
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Discover and register all game-logic modules from the provided script list.
 *
 * @throws DiscoverError on duplicate component/system (fail-fast).
 */
export async function discoverModules(
  world: EcsWorld,
  scripts: Array<{ relPath: string; absPath: string }>,
): Promise<DiscoverResult> {
  const modules: DiscoveredModule[] = [];
  const errors: DiscoverError[] = [];

  const seenComponents = new Map<string, string>();
  const seenSystems = new Map<string, string>();

  for (const script of scripts) {
    const before = snapshotRegistries();

    // Dynamic import with cache-busting query param (prevents module cache
    // from hanging on previously-failed modules).
    const cacheKey = `?t=${Date.now()}&i=${_importCounter++}`;
    try {
      await import(`${script.absPath}${cacheKey}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(
        makeError(
          DiscoverErrorCode.MODULE_IMPORT_FAILED,
          `Module at ${script.relPath} should be importable`,
          `Fix syntax or missing imports in ${script.relPath}: ${msg}`,
          script.relPath,
        ),
      );
      continue;
    }

    const delta = diffRegistries(before);

    // ── Duplicate detection ──
    const allComps = [...delta.components, ...delta.redefinedComps];
    const allSystems = [...delta.systems, ...delta.redefinedSystems];

    for (const compName of allComps) {
      const existingRel = seenComponents.get(compName);
      if (existingRel !== undefined && existingRel !== script.relPath) {
        throw makeError(
          DiscoverErrorCode.DUPLICATE_COMPONENT,
          `Unique component name expected — '${compName}' already defined in ${existingRel}`,
          `Rename '${compName}' in ${script.relPath} or ${existingRel}`,
          script.relPath,
        );
      }
      seenComponents.set(compName, script.relPath);
    }

    for (const sysName of allSystems) {
      const existingRel = seenSystems.get(sysName);
      if (existingRel !== undefined && existingRel !== script.relPath) {
        throw makeError(
          DiscoverErrorCode.DUPLICATE_SYSTEM,
          `Unique system name expected — '${sysName}' already defined in ${existingRel}`,
          `Rename '${sysName}' in ${script.relPath} or ${existingRel}`,
          script.relPath,
        );
      }
      seenSystems.set(sysName, script.relPath);
    }

    // ── Register systems into world ──
    // Game systems are gated by `notEditing` so they freeze when EditMode.active
    // (run=edit) and tick when EditMode is inactive (run=play). If a system
    // already declares a runIf, compose it with AND so both conditions hold;
    // otherwise gate it on notEditing alone. (plan-strategy D-1, requirements §8.)
    for (const sysName of allSystems) {
      const handle = getRegisteredSystems().get(sysName);
      if (handle) {
        const gated = {
          ...handle,
          runIf: handle.runIf ? and(handle.runIf, notEditing) : notEditing,
        };
        world.addSystem(gated);
      }
    }

    modules.push({
      relPath: script.relPath,
      absPath: script.absPath,
      components: allComps,
      systems: allSystems,
    });
  }

  return { modules, errors };
}