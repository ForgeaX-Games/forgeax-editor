// Editor host adapter for asset-resident game plugins.
//
// Hosts own discovery (filesystem/API in the editor, a Vite URL manifest in
// pure preview). This module owns the shared runtime operation: import each
// module once, record the component/system registration delta, and attach the
// registered systems to a fresh Play World. Keeping this below both hosts is
// what makes defaultScene instantiation observe the same component registry.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Disabled, Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { createWorldContext } from '@forgeax/engine-ecs';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import { registerPhysicsComponents } from '@forgeax/engine-physics';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import type { Renderer } from '@forgeax/engine-render';
import type { SceneAsset } from '@forgeax/engine-types';
import type { App } from '@forgeax/engine-app';

interface NativeGameModule {
  readonly default?: unknown;
}

function isNativePlugin(value: unknown): value is Plugin {
  return typeof value === 'function'
    || (typeof value === 'object' && value !== null && 'apply' in value && typeof value.apply === 'function');
}

/**
 * Validate an asset plugin at the browser host boundary without importing the
 * Engine App facade. The facade also exports the Node-side CatalogLoader, so
 * using its small `loadGame` helper from this browser package would evaluate
 * `node:module` in the client. The host already owns module evaluation and
 * only needs the same default Cordis Plugin shape before World installation.
 */
function resolveNativePlugin(imported: unknown): Plugin | undefined {
  const candidate = (typeof imported === 'object' && imported !== null)
    ? (imported as NativeGameModule).default
    : undefined;
  if (isNativePlugin(candidate)) return candidate;
  return undefined;
}

/**
 * Admit the structural components that an editor-authored scene may carry.
 *
 * Engine component catalogs are World-local. `Entity` is structurally present
 * on every archetype, but the scene loader still resolves its serialized name
 * through the catalog. `ParticleEffectPlayer` is likewise attached by the VFX
 * host after scene materialization, so it must be admitted before loading a
 * scene. Keep this small profile at the shared Edit/Play composition boundary;
 * Engine's default profile should not opt every application into editor-only
 * vocabulary. Physics-authored scenes need their structural component tokens
 * in Edit without installing simulation; Play's physics plugin may acquire a
 * second lease for the same tokens. Skeletal scenes additionally use Engine's
 * `skinningPlugin()` at the same composition boundary.
 */
export function editorComponentVocabularyPlugin(): Plugin {
  return {
    name: 'editor-component-vocabulary',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        const leases = [Entity, Disabled, ParticleEffectPlayer].map((component) => {
          const lease = ctx.world.components.register(component);
          if (!lease.ok) throw lease.error;
          return lease.value;
        });
        const releasePhysicsComponents = registerPhysicsComponents(ctx.world);
        return () => {
          releasePhysicsComponents();
          for (let index = leases.length - 1; index >= 0; index -= 1) {
            leases[index]?.dispose();
          }
        };
      }, 'editor/components');
    },
  };
}

/** JSON-shaped data a game may intentionally project through a host bridge. */
export type GameProjectionValue =
  | null
  | boolean
  | number
  | string
  | GameProjectionValue[]
  | { [key: string]: GameProjectionValue };

/** Lightweight, host-agnostic argument schema for a game-owned action. */
export interface GameActionArgsSchema {
  readonly type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly properties?: Record<string, GameActionArgsSchema>;
  readonly required?: string[];
  readonly enum?: GameProjectionValue[];
  readonly items?: GameActionArgsSchema;
  readonly nullable?: boolean;
  readonly description?: string;
}

/**
 * A Play-only capability owned by game code. The host may discover and invoke it,
 * but never supplies its gameplay semantics or reaches into the game World.
 */
export interface GameActionDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: GameActionArgsSchema;
  readonly run: (
    args: GameProjectionValue,
  ) => GameProjectionValue | void | Promise<GameProjectionValue | void>;
}

/** A named, serializable Play-only read projection owned by game code. */
export interface GameReadDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly read: () => GameProjectionValue | Promise<GameProjectionValue>;
}

/**
 * Host-provided registration sink for one Play run. Games receive this only while
 * bootstrapping the fresh transient world; registrations are discarded on Stop.
 */
export interface GameProjectionRegistrar {
  registerAction(def: GameActionDef): () => void;
  registerRead(def: GameReadDef): () => void;
}

/** The stable wire identity for asset-resident gameplay producers. */
export const GAMEPLAY_PRODUCER_CONTRACT = 'forgeax.gameplay-producer' as const;
/** Bump only when the producer context or descriptor meaning changes. */
export const GAMEPLAY_PRODUCER_CONTRACT_VERSION = 1 as const;

/** Public identity a host can discover without importing game implementation code. */
export interface GamePluginDescriptor {
  readonly contract: typeof GAMEPLAY_PRODUCER_CONTRACT;
  readonly version: typeof GAMEPLAY_PRODUCER_CONTRACT_VERSION;
  readonly id: string;
  readonly title: string;
}

export type GamePluginDiagnosticCode =
  | 'producer-report'
  | 'producer-registration-failed'
  | 'producer-action-failed'
  | 'producer-read-failed'
  | 'producer-reload-failed';

export interface GamePluginDiagnostic {
  readonly code: GamePluginDiagnosticCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly pluginId: string;
  readonly message: string;
  readonly timestamp?: number;
}

export type GamePluginReloadResult =
  | { readonly ok: true; readonly reloaded: readonly string[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'game-plugin-reload-failed' | 'game-plugin-reload-unsupported';
        readonly pluginId: string;
        readonly hint: string;
      };
    };

export interface GamePluginProducerContext {
  readonly world: World;
  readonly gameProjection?: GameProjectionRegistrar;
  report(diagnostic: Omit<GamePluginDiagnostic, 'pluginId' | 'timestamp'>): void;
  onDispose(cleanup: () => void): void;
  onReload?(reload: () => void | Promise<void>): void;
}

export interface GamePluginProducer {
  readonly descriptor: GamePluginDescriptor;
  register(context: GamePluginProducerContext): void | Promise<void>;
}

/** One host-discovered plugin URL and its stable client-facing label. */
export interface GamePluginModule {
  readonly clientPath: string;
  readonly url: string;
  readonly revision?: string;
}

/** Registration facts shared by editor Play and pure preview. */
export interface LoadedGamePlugin {
  readonly clientPath: string;
  readonly url: string;
  readonly components: string[];
  readonly systems: string[];
  readonly descriptor?: GamePluginDescriptor;
  readonly producer?: GamePluginProducer;
  /** Native Cordis plugin loaded through Engine `loadGame`. */
  readonly plugin?: Plugin;
}

export interface GamePluginLoad {
  readonly plugins: LoadedGamePlugin[];
  readonly systems: string[];
  readonly components: string[];
  readonly errors: Array<{ clientPath: string; message: string }>;
  /** Cordis realms retained when a host explicitly installs into a World. */
  readonly contexts?: readonly Context[];
}

export interface GamePluginSystemDiagnostic {
  readonly pluginId: string;
  readonly system: string;
  readonly status: 'registered' | 'attached' | 'missing';
}

export interface GamePluginInstallation {
  readonly descriptors: readonly GamePluginDescriptor[];
  diagnostics(): readonly GamePluginDiagnostic[];
  reload(): Promise<GamePluginReloadResult>;
  dispose(): void;
}

export type GamePluginInstallResult =
  | { readonly ok: true; readonly value: GamePluginInstallation }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'game-plugin-registration-failed';
        readonly pluginId: string;
        readonly hint: string;
      };
    };

export interface BootstrapContext {
  readonly renderer?: Renderer;
  readonly defaultSceneRoot?: EntityHandle;
  readonly defaultScene?: SceneAsset;
  readonly assetRegistry?: AssetRegistry;
  /** Alias used by the thick execution host; both point at the same registry. */
  readonly assets?: AssetRegistry;
  readonly app?: App;
  readonly uiRoot?: HTMLElement;
  readonly registerCleanup?: (cleanup: () => void | Promise<void>) => void;
  readonly gameProjection?: GameProjectionRegistrar;
  readonly setPointerLockAllowed?: (allowed: boolean) => void;
}

export type BootstrapEntry = (world: World, ctx?: BootstrapContext) => void | Promise<void>;

export interface GameContext {
  readonly app: App;
  readonly world: World;
  readonly assetRegistry: AssetRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateProducer(
  value: unknown,
):
  | { readonly ok: true; readonly producer: GamePluginProducer }
  | { readonly ok: false; readonly message: string } {
  if (!isRecord(value) || typeof value.register !== 'function' || !isRecord(value.descriptor)) {
    return { ok: false, message: 'gameplay export must provide descriptor and register(context)' };
  }
  const descriptor = value.descriptor as unknown as GamePluginDescriptor;
  if (descriptor.contract !== GAMEPLAY_PRODUCER_CONTRACT) {
    return {
      ok: false,
      message: `unsupported gameplay producer contract: ${String(descriptor.contract)}`,
    };
  }
  if (descriptor.version !== GAMEPLAY_PRODUCER_CONTRACT_VERSION) {
    return {
      ok: false,
      message: `unsupported gameplay producer contract version: ${String(descriptor.version)}`,
    };
  }
  if (typeof descriptor.id !== 'string' || descriptor.id.trim() === '') {
    return { ok: false, message: 'gameplay producer descriptor.id must be non-empty' };
  }
  if (typeof descriptor.title !== 'string' || descriptor.title.trim() === '') {
    return { ok: false, message: 'gameplay producer descriptor.title must be non-empty' };
  }
  return { ok: true, producer: value as unknown as GamePluginProducer };
}

/**
 * Import the supplied plugin modules exactly once for this JS realm.
 */
export async function loadGamePluginModules(deps: {
  readonly modules: readonly GamePluginModule[];
  readonly importModule: (url: string) => Promise<unknown>;
  /** Optional edit World owner. Play passes plugins to createApp instead. */
  readonly world?: World;
}): Promise<GamePluginLoad> {
  const plugins: LoadedGamePlugin[] = [];
  const errors: Array<{ clientPath: string; message: string }> = [];
  const allSystems: string[] = [];
  const allComponents: string[] = [];

  for (const module of deps.modules) {
    let imported: unknown;
    try {
      imported = await deps.importModule(module.url);
    } catch (error) {
      errors.push({
        clientPath: module.clientPath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const plugin = resolveNativePlugin(imported);
    if (plugin === undefined) {
      errors.push({
        clientPath: module.clientPath,
        message: 'game plugin must export a default Cordis Plugin',
      });
      continue;
    }
    const components: string[] = [];
    const systems: string[] = [];
    let descriptor: GamePluginDescriptor | undefined;
    let producer: GamePluginProducer | undefined;
    const gameplay = isRecord(imported) ? imported.gameplay : undefined;
    if (gameplay !== undefined) {
      const validation = validateProducer(gameplay);
      if (!validation.ok) {
        errors.push({ clientPath: module.clientPath, message: validation.message });
      } else {
        producer = validation.producer;
        descriptor = producer.descriptor;
      }
    }
    plugins.push({
      clientPath: module.clientPath,
      url: module.url,
      components,
      systems,
      ...(descriptor !== undefined ? { descriptor } : {}),
      ...(producer !== undefined ? { producer } : {}),
      plugin,
    });
    allComponents.push(...components);
    allSystems.push(...systems);
  }

  const contexts: Context[] = [];
  if (deps.world !== undefined && plugins.length > 0) {
    const beforeComponents = new Set(deps.world.components.entries().keys());
    const beforeSystems = new Set(deps.world.inspect().systems.map((system) => system.name));
    const context = await createWorldContext(deps.world, plugins.flatMap((entry) => entry.plugin === undefined ? [] : [entry.plugin]));
    contexts.push(context);
    for (const name of deps.world.components.entries().keys()) {
      if (!beforeComponents.has(name)) allComponents.push(name);
    }
    for (const system of deps.world.inspect().systems) {
      if (!beforeSystems.has(system.name)) allSystems.push(system.name);
    }
  }
  return {
    plugins,
    systems: [...new Set(allSystems)],
    components: [...new Set(allComponents)],
    errors,
    ...(contexts.length === 0 ? {} : { contexts }),
  };
}

/** Convert a plugin import error into the Play startup terminal fact. */
export function getPlayPluginFailure(
  load: Pick<GamePluginLoad, 'errors'>,
): { code: 'play-plugin-failed'; hint: string } | null {
  const first = load.errors[0];
  if (!first) return null;
  return {
    code: 'play-plugin-failed',
    hint: `Play plugin ${first.clientPath} failed to load: ${first.message}`,
  };
}

/** Report native plugin systems already installed by `createWorldContext`. */
export function addGamePluginSystems(world: World, load: GamePluginLoad): string[] {
  const installed = new Set(world.inspect().systems.map((system) => system.name));
  return load.systems.filter((name) => installed.has(name));
}

/** Describe every system contributed by a discovered plugin and its Play state. */
export function describeGamePluginSystems(
  load: GamePluginLoad,
  attachedSystems: readonly string[],
): readonly GamePluginSystemDiagnostic[] {
  const registered = new Set<string>();
  const attached = new Set(attachedSystems);
  return load.plugins
    .flatMap((plugin) => {
      const pluginId = plugin.descriptor?.id ?? plugin.clientPath;
      return plugin.systems.map(
        (system) =>
          ({
            pluginId,
            system,
            status: attached.has(system)
              ? 'attached'
              : registered.has(system)
                ? 'registered'
                : 'missing',
          }) satisfies GamePluginSystemDiagnostic,
      );
    })
    .sort((a, b) => `${a.pluginId}:${a.system}`.localeCompare(`${b.pluginId}:${b.system}`));
}

/** Install producer-owned actions/reads and lifecycle hooks for one Play World. */
export async function installGamePluginProducers(
  load: GamePluginLoad,
  deps: { readonly world: World; readonly gameProjection?: GameProjectionRegistrar },
): Promise<GamePluginInstallResult> {
  const diagnostics: GamePluginDiagnostic[] = [];
  const cleanups: Array<{ readonly pluginId: string; readonly fn: () => void }> = [];
  const reloads: Array<{ readonly pluginId: string; readonly fn: () => void | Promise<void> }> = [];
  const descriptors = load.plugins.flatMap((plugin) =>
    plugin.descriptor ? [plugin.descriptor] : [],
  );
  let disposed = false;

  const installation: GamePluginInstallation = {
    descriptors,
    diagnostics: () => [...diagnostics],
    reload: async () => {
      if (disposed) {
        return {
          ok: false,
          error: {
            code: 'game-plugin-reload-failed',
            pluginId: 'gameplay',
            hint: 'gameplay producers are unavailable because Play has stopped',
          },
        };
      }
      const firstReload = reloads[0];
      if (!firstReload) {
        return {
          ok: false,
          error: {
            code: 'game-plugin-reload-unsupported',
            pluginId: descriptors[0]?.id ?? 'gameplay',
            hint: 'no producer-owned reload handler was registered',
          },
        };
      }
      for (const reload of reloads) {
        try {
          await reload.fn();
        } catch (error) {
          const hint = error instanceof Error ? error.message : String(error);
          diagnostics.push({
            code: 'producer-reload-failed',
            severity: 'error',
            pluginId: reload.pluginId,
            message: hint,
          });
          return {
            ok: false,
            error: {
              code: 'game-plugin-reload-failed',
              pluginId: reload.pluginId,
              hint,
            },
          };
        }
      }
      return { ok: true, reloaded: reloads.map((r) => r.pluginId) };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) {
        try {
          cleanup.fn();
        } catch (error) {
          console.warn(`[game-plugins] cleanup failed for ${cleanup.pluginId}:`, error);
        }
      }
    },
  };

  for (const plugin of load.plugins) {
    if (!plugin.producer) continue;
    const pluginId = plugin.producer.descriptor.id;
    const context: GamePluginProducerContext = {
      world: deps.world,
      ...(deps.gameProjection !== undefined ? { gameProjection: deps.gameProjection } : {}),
      report: (diagnostic) => {
        diagnostics.push({
          ...diagnostic,
          pluginId,
          timestamp: Date.now(),
        });
      },
      onDispose: (fn) => {
        cleanups.push({ pluginId, fn });
      },
      onReload: (fn) => {
        reloads.push({ pluginId, fn });
      },
    };

    try {
      await plugin.producer.register(context);
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: 'game-plugin-registration-failed',
          pluginId,
          hint,
        },
      };
    }
  }

  return { ok: true, value: installation };
}

export interface GamePluginDeps {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly gameRoot: string;
  readonly resolveGameFsBase: () => Promise<string>;
  readonly world?: World;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

function collectPluginPaths(node: TreeNode | null): string[] {
  if (!node) return [];
  if (node.type === 'file') return node.name.endsWith('.plugin.ts') ? [node.path] : [];
  return (node.children ?? []).flatMap(collectPluginPaths);
}

async function listPluginFiles(deps: GamePluginDeps): Promise<string[]> {
  const assetsRoot = deps.gameRoot ? `${deps.gameRoot}/assets` : 'assets';
  const url = `/api/files/tree?root=${encodeURIComponent(assetsRoot)}&optional=1`;
  const response = await deps.fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`/api/files/tree HTTP ${response.status}`);
  const json = (await response.json()) as { tree?: TreeNode | null };
  return collectPluginPaths(json.tree ?? null).sort();
}

export function gamePluginImportUrl(clientPath: string, gameRoot: string, gameFsBase: string): string {
  const prefix = gameRoot ? `${gameRoot}/` : '';
  const relativePath = clientPath.startsWith(prefix) ? clientPath.slice(prefix.length) : clientPath;
  return `${gameFsBase}/${relativePath}`;
}

export async function ensureGamePluginsLoaded(deps: GamePluginDeps): Promise<GamePluginLoad> {
  const gameFsBase = await deps.resolveGameFsBase();
  return (async (): Promise<GamePluginLoad> => {
    let files: string[];
    try {
      files = await listPluginFiles(deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const assetsRoot = deps.gameRoot ? `${deps.gameRoot}/assets` : 'assets';
      console.warn('[editor] game-plugins: listing failed:', message);
      return {
        plugins: [],
        systems: [],
        components: [],
        errors: [{ clientPath: assetsRoot, message }],
      };
    }

    const modules: GamePluginModule[] = files.map((clientPath) => ({
      clientPath,
      url: gamePluginImportUrl(clientPath, deps.gameRoot, gameFsBase),
    }));
    return loadGamePluginModules({
      modules,
      importModule: (url) => import(/* @vite-ignore */ url),
      ...(deps.world === undefined ? {} : { world: deps.world }),
    });
  })();
}
