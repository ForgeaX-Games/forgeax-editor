import {
  type ExecutionBootstrapEntry,
  type Plugin,
} from '@forgeax/engine-app';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  addGamePluginSystems,
  describeGamePluginSystems,
  editorComponentVocabularyPlugin,
  installGamePluginProducers,
  loadGamePluginModules,
} from '@forgeax/editor-game-plugins';
import { audioPlugin } from '@forgeax/engine-audio';
import { Time, Update, type World } from '@forgeax/engine-ecs';
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { physicsPlugin } from '@forgeax/engine-physics';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { Renderer } from '@forgeax/engine-render';
import { ChildOf, Name } from '@forgeax/engine-scene';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { createPlayVfxRuntime } from './vfx-runtime';
import {
  PLAY_EXECUTION_PROTOCOL,
  createPlayRendererProvenance,
  parsePlayExecutionBootstrapData,
  type PlayExecutionModule,
  type PlayExecutionGameContext,
  type PlayExecutionRealmContext,
  type PlayExecutionRealmMessage,
  type PlayExecutionRuntimeDiagnostics,
} from './execution-contract';
import { installCompletedFrameHeartbeat } from './completed-frame-heartbeat';

const CYLINDER_GUID = 'c1111111-0000-5000-8000-000000000001';
let nextExecutionRendererGeneration = 0;

function post(port: MessagePort | undefined, message: PlayExecutionRealmMessage): void {
  port?.postMessage(message);
}

export interface PlayExecutionPulse {
  readonly diagnosticsDue: boolean;
}

/** Deterministic low-rate diagnostics clock; FPS is renderer-completion-owned. */
export function createPlayExecutionPulse(): (delta: number) => PlayExecutionPulse {
  let diagnosticsElapsed = 0;
  return (delta): PlayExecutionPulse => {
    diagnosticsElapsed += delta;
    const diagnosticsDue = diagnosticsElapsed >= 0.5;
    if (diagnosticsDue) diagnosticsElapsed = 0;
    return { diagnosticsDue };
  };
}

export function projectRuntimeDiagnostics(
  context: PlayExecutionRealmContext,
): PlayExecutionRuntimeDiagnostics {
  const inspection = context.world.inspect();
  const entityQuery = context.world
    .query<
      [typeof Name, typeof MeshFilter, typeof MeshRenderer],
      [],
      [typeof ChildOf]
    >({ read: [Name, MeshFilter, MeshRenderer], optional: [ChildOf] })
    .unwrap();
  // Query rows are borrowed facades: the engine rebinds one row object for
  // each iteration. Project each row before advancing the iterator so the
  // disposable snapshot never retains a later binding.
  type DiagnosticRow = {
    readonly entity: number;
    get(component: unknown): {
      readonly value?: string;
      readonly assetHandle?: number;
      readonly materials?: readonly unknown[];
      readonly parent?: number | null;
    } | undefined;
  };
  const projectedEntities = Array.from(entityQuery as Iterable<DiagnosticRow>, (row) => {
    const name = row.get(Name) as { readonly value: string };
    const meshFilter = row.get(MeshFilter) as { readonly assetHandle: number };
    const meshRenderer = row.get(MeshRenderer) as { readonly materials: readonly unknown[] };
    const childOf = row.get(ChildOf);
    const parent = childOf?.parent;
    const components: string[] = [Name.name, MeshFilter.name, MeshRenderer.name];
    if (childOf !== undefined) components.push(ChildOf.name);
    return {
      entity: row.entity,
      components,
      name: name.value,
      meshFilter: {
        hasAsset: Number.isSafeInteger(meshFilter.assetHandle) && meshFilter.assetHandle > 0,
      },
      meshRenderer: { materialCount: meshRenderer.materials.length },
      ...(parent === undefined || parent === null ? {} : { childOf: { parent } }),
    };
  });
  const projectedEntityHandles = new Set(projectedEntities.map((entity) => entity.entity));
  const entities = projectedEntities.map((entity) => {
    const parent = entity.childOf?.parent;
    if (parent === undefined || projectedEntityHandles.has(parent)) return entity;

    // A fresh scene instantiation may attach an authored root to an
    // unprojected synthetic SceneInstance wrapper. Keep topology generic by
    // reporting only ChildOf edges whose parent is in this entity projection.
    const withoutExternalParent = { ...entity };
    delete withoutExternalParent.childOf;
    return {
      ...withoutExternalParent,
      components: entity.components.filter((component) => component !== ChildOf.name),
    };
  });
  const vfxRuntime = context.world.hasResource('VfxGpuRuntime')
    ? context.world.getResource<{
        snapshot(): readonly unknown[];
        diagnostics(): readonly unknown[];
      }>('VfxGpuRuntime')
    : null;
  const feature = context.renderer.renderFeatureDiagnostics().find(
    (diagnostic) => diagnostic.identity === 'forgeax.vfx-render.gpu-particles',
  );
  const featurePass = context.renderer.perFramePassNames.find((name) => (
    name.startsWith('forgeax.vfx-render.gpu-particles::gpu.')
    && /\.draw(?:\.(?:regular|depth-sampled))?$/u.test(name)
  ));
  const renderer = context.renderer;
  const render = renderer.renderScene === undefined
    ? undefined
    : {
        frustum: { ...renderer.frustumStats },
        visibility: { ...renderer.visibilityStats },
        scene: {
          worldEntitiesScanned: renderer.renderScene.worldEntitiesScanned,
          projectionRecords: renderer.renderScene.projectionRecords,
          candidateCount: renderer.renderScene.topology.candidateCount,
          batchCount: renderer.renderScene.topology.batchCount,
          ineligible: renderer.renderScene.topology.ineligible,
          gpuStatus: renderer.renderScene.gpu.status,
        },
        meshMaterialBindings: renderer.meshMaterialBindings.slice(0, 32).map((observation) => ({
          worldId: observation.worldId,
          entityKey: observation.entityKey,
          bindingCount: observation.bindings.length,
          diagnosticCount: observation.diagnostics.length,
        })),
        bindGroupCreates: renderer.bindGroupCounts.createBindGroup,
        passCount: renderer.perFramePassNames.length,
      } satisfies PlayExecutionRuntimeDiagnostics['render'];
  return {
    entityCount: inspection.entityCount,
    activeComponents: [...inspection.activeComponents],
    entities,
    vfxRuntimePresent: vfxRuntime !== null,
    queuedIntents: vfxRuntime?.snapshot().length ?? -1,
    runtimeDiagnostics: (vfxRuntime?.diagnostics() ?? []) as PlayExecutionRuntimeDiagnostics['runtimeDiagnostics'],
    ...(featurePass === undefined ? {} : { featurePass }),
    ...(feature?.status === undefined ? {} : { featureStatus: feature.status }),
    featureError: feature?.latestError as PlayExecutionRuntimeDiagnostics['featureError'],
    ...(render === undefined ? {} : { render }),
  };
}

const bootstrap: ExecutionBootstrapEntry = async (rawData) => {
  const data = parsePlayExecutionBootstrapData(rawData);
  const gameModule = (await import(
    /* @vite-ignore */ data.gameEntryUrl
  )) as unknown as PlayExecutionModule;
  if (typeof gameModule.default !== 'function') {
    throw new TypeError('executionEntry must default-export an ExecutionBootstrapEntry');
  }
  const game = await gameModule.default(data.gameData);
  if (typeof game !== 'object' || game === null || typeof game.run !== 'function') {
    throw new TypeError('executionEntry must prepare an object with run(context)');
  }

  let runtimeWorld: World | undefined;
  const vfx = createPlayVfxRuntime({ world: () => runtimeWorld });
  const hostPlugin: Plugin = {
    name: 'play-execution-host',
    inject: ['world', 'renderer', 'assets', 'executionBootstrapHost'],
    async apply(context) {
      if (context.renderer === undefined || context.assets === undefined) {
        throw new Error('play execution host requires renderer and assets services');
      }
      runtimeWorld = context.world;
      const assets: AssetRegistry = context.assets;
      const renderer: Renderer = context.renderer;
      const cleanups: Array<() => void | Promise<void>> = [];
      const registerCleanup = (cleanup: () => void | Promise<void>): void => {
        cleanups.push(cleanup);
      };
      if (data.runtimeBinding !== undefined) {
        assets.configureRuntimeBinding(
          data.runtimeBinding as unknown as RuntimeAssetBinding,
        );
        await assets.refreshCatalog();
      }
      if (data.packIndexUrl !== undefined) assets.configurePackIndex(data.packIndexUrl);

      const cylinderGuid = AssetGuid.parse(CYLINDER_GUID);
      const cylinder = createCylinderGeometry(0.5, 0.5, 1, 18);
      if (cylinderGuid.ok && cylinder.ok) assets.catalog(cylinderGuid.value, cylinder.value);

      const attached = await vfx.attachWorld(context.world, assets);
      if (!attached.ok) throw attached.error;
      registerCleanup(async () => {
        await vfx.detachWorld(context.world);
        runtimeWorld = undefined;
      });

      const pluginLoad = await loadGamePluginModules({
        modules: data.gamePluginModules,
        importModule: (url) => import(/* @vite-ignore */ url),
      });
      for (const error of pluginLoad.errors) {
        console.error(`[engine] game plugin failed: ${error.clientPath}: ${error.message}`);
      }
      // Discovery is host-owned, while activation belongs to this App's
      // World-local Cordis realm. Install each native plugin before the game
      // bootstrap and default scene work can observe its component vocabulary.
      for (const loaded of pluginLoad.plugins) {
        if (loaded.plugin !== undefined) await context.plugin(loaded.plugin);
      }

      const gameContext: PlayExecutionGameContext = {
        world: context.world,
        renderer,
        assets,
        port: context.executionBootstrapHost.port,
        registerCleanup,
      };
      await game.run(gameContext);

      if (pluginLoad.systems.length > 0) {
        const added = addGamePluginSystems(context.world, pluginLoad);
        const missing = describeGamePluginSystems(pluginLoad, added).filter(
          (entry) => entry.status === 'missing',
        );
        if (missing.length > 0) {
          console.warn(
            `[engine] missing game systems: ${missing.map((entry) => entry.system).join(', ')}`,
          );
        }
      }
      if (pluginLoad.plugins.some((plugin) => plugin.producer !== undefined)) {
        const producers = await installGamePluginProducers(pluginLoad, { world: context.world });
        if (!producers.ok) throw new Error(producers.error.hint);
        registerCleanup(() => producers.value.dispose());
      }

      const rendererProvenance = createPlayRendererProvenance(
        renderer,
        nextExecutionRendererGeneration + 1,
      );
      if (rendererProvenance === null) {
        throw new Error('play renderer provenance unavailable in execution realm');
      }
      nextExecutionRendererGeneration = rendererProvenance.generation;
      Object.defineProperty(globalThis, '__forgeaxPlayRendererProvenance', {
        configurable: true,
        enumerable: false,
        get: () => rendererProvenance,
      });
      post(context.executionBootstrapHost.port, {
        protocol: PLAY_EXECUTION_PROTOCOL,
        kind: 'realm-ready',
        renderer: rendererProvenance,
      });

      const pulse = createPlayExecutionPulse();
      registerCleanup(installCompletedFrameHeartbeat({
        subscribe: (listener) => renderer.subscribe((event) => {
          if (event.kind === 'frame-submitted') listener();
        }),
        now: () => performance.now(),
        publish: (heartbeat) => {
          post(context.executionBootstrapHost.port, {
            protocol: PLAY_EXECUTION_PROTOCOL,
            kind: 'heartbeat',
            ...heartbeat,
          });
        },
      }));
      context.world
        .addSystem(Update, {
          name: 'play-execution-diagnostics',
          queries: [],
          fn: () => {
            const delta = context.world.getResource(Time).delta;
            const next = pulse(delta);
            if (next.diagnosticsDue) {
              post(context.executionBootstrapHost.port, {
                protocol: PLAY_EXECUTION_PROTOCOL,
                kind: 'runtime-diagnostics',
                diagnostics: projectRuntimeDiagnostics({ world: context.world, renderer }),
              });
            }
          },
        })
        .unwrap();

      return async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        runtimeWorld = undefined;
      };
    },
  };
  return {
    features: [vfx.host.feature, ...(game.features ?? [])],
    plugins: [
      editorComponentVocabularyPlugin(),
      skinningPlugin(),
      audioPlugin(),
      ...(data.physics === undefined ? [] : [physicsPlugin(data.physics)]),
      ...(game.plugins ?? []),
      hostPlugin,
    ],
  };
};

export default bootstrap;
