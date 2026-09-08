// discoverer.ts — load native Cordis game Plugins into one World.
//
// Game modules are not evaluated for global ECS side effects. Each module is
// validated through the Engine app owner (`loadGame`), then installed into a
// World-local Cordis realm (`createWorldContext`). Component leases and system
// registration therefore belong to the World that will actually run them.

import { loadGame, type Plugin } from '@forgeax/engine-app';
import { createWorldContext } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';
import type { World } from '@forgeax/engine-ecs';
import { DiscoverErrorCode } from './discoverer-errors';
import type { DiscoverError } from './discoverer-errors';

export type { DiscoverError } from './discoverer-errors';

export interface DiscoveredModule {
  readonly relPath: string;
  readonly absPath: string;
  readonly components: string[];
  readonly systems: string[];
}

export interface DiscoverResult {
  readonly modules: DiscoveredModule[];
  readonly errors: DiscoverError[];
  /** Realms retained by the caller for the lifetime of the World. */
  readonly contexts: readonly Context[];
}

let _importCounter = 0;

function makeError(
  code: string,
  expected: string,
  hint: string,
  relPath?: string,
): DiscoverError {
  const base = new Error(`[${code}] ${expected}`);
  const props: PropertyDescriptorMap = {
    code: { value: code, enumerable: true, writable: false, configurable: true },
    expected: { value: expected, enumerable: true, writable: false, configurable: true },
    hint: { value: hint, enumerable: true, writable: false, configurable: true },
    message: { value: base.message, enumerable: true, writable: false, configurable: true },
    name: { value: 'DiscoverError', enumerable: true, writable: false, configurable: true },
    stack: { value: base.stack, enumerable: false, writable: false, configurable: true },
  };
  if (relPath !== undefined) props.relPath = { value: relPath, enumerable: true, writable: false, configurable: true };
  return Object.create(Error.prototype, props) as DiscoverError;
}

function moduleResolver(absPath: string): (slug: string) => Promise<{ readonly default?: unknown; readonly [key: string]: unknown }> {
  return async () => import(/* @vite-ignore */ `${absPath}?t=${Date.now()}&i=${_importCounter++}`);
}

function deltaNames(before: readonly string[], after: readonly string[]): string[] {
  const previous = new Set(before);
  return after.filter((name) => !previous.has(name));
}

/**
 * Load each game module as a native Cordis Plugin and install it in `world`.
 * The old global-registry diff path is intentionally gone: the World catalog
 * and schedule inspection are the only discovery surfaces.
 */
export async function discoverModules(
  world: World,
  scripts: Array<{ relPath: string; absPath: string }>,
): Promise<DiscoverResult> {
  const modules: DiscoveredModule[] = [];
  const errors: DiscoverError[] = [];
  const contexts: Context[] = [];
  const seenComponents = new Map<string, string>();
  const seenSystems = new Map<string, string>();

  for (const script of scripts) {
    const beforeComponents = [...world.components.entries().keys()];
    const beforeSystems = world.inspect().systems.map((system) => system.name);
    const loaded = await loadGame(script.relPath, moduleResolver(script.absPath));
    if (!loaded.ok) {
      errors.push(makeError(
        DiscoverErrorCode.MODULE_IMPORT_FAILED,
        loaded.error.expected,
        `${loaded.error.hint} (${script.relPath})`,
        script.relPath,
      ));
      continue;
    }

    let context: Context;
    try {
      context = await createWorldContext(world, [loaded.value as Plugin]);
    } catch (thrown: unknown) {
      const conflict = thrown as {
        readonly code?: unknown;
        readonly detail?: { readonly componentName?: unknown; readonly systemName?: unknown };
      };
      if (conflict.code === 'component-name-conflict' && typeof conflict.detail?.componentName === 'string') {
        const name = conflict.detail.componentName;
        const previous = seenComponents.get(name);
        throw makeError(
          DiscoverErrorCode.DUPLICATE_COMPONENT,
          `Unique component name expected — '${name}' already defined in ${previous ?? 'another plugin'}`,
          `Rename '${name}' in ${script.relPath} or ${previous ?? 'the previous plugin'}`,
          script.relPath,
        );
      }
      if (conflict.code === 'system-name-conflict' && typeof conflict.detail?.systemName === 'string') {
        const name = conflict.detail.systemName;
        const previous = seenSystems.get(name);
        throw makeError(
          DiscoverErrorCode.DUPLICATE_SYSTEM,
          `Unique system name expected — '${name}' already defined in ${previous ?? 'another plugin'}`,
          `Rename '${name}' in ${script.relPath} or ${previous ?? 'the previous plugin'}`,
          script.relPath,
        );
      }
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      errors.push(makeError(
        DiscoverErrorCode.MODULE_IMPORT_FAILED,
        `Plugin at ${script.relPath} should activate in the target World`,
        `Fix plugin activation in ${script.relPath}: ${msg}`,
        script.relPath,
      ));
      continue;
    }
    contexts.push(context);

    const components = deltaNames(beforeComponents, [...world.components.entries().keys()]);
    const systems = deltaNames(beforeSystems, world.inspect().systems.map((system) => system.name));
    for (const name of components) {
      const previous = seenComponents.get(name);
      if (previous !== undefined && previous !== script.relPath) {
        throw makeError(
          DiscoverErrorCode.DUPLICATE_COMPONENT,
          `Unique component name expected — '${name}' already defined in ${previous}`,
          `Rename '${name}' in ${script.relPath} or ${previous}`,
          script.relPath,
        );
      }
      seenComponents.set(name, script.relPath);
    }
    for (const name of systems) {
      const previous = seenSystems.get(name);
      if (previous !== undefined && previous !== script.relPath) {
        throw makeError(
          DiscoverErrorCode.DUPLICATE_SYSTEM,
          `Unique system name expected — '${name}' already defined in ${previous}`,
          `Rename '${name}' in ${script.relPath} or ${previous}`,
          script.relPath,
        );
      }
      seenSystems.set(name, script.relPath);
    }
    modules.push({ relPath: script.relPath, absPath: script.absPath, components, systems });
  }

  return { modules, errors, contexts };
}
