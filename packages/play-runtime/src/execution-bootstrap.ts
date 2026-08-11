import {
  addGamePluginSystems,
  describeGamePluginSystems,
  installGamePluginProducers,
  loadGamePluginModules,
  type ExecutionBootstrapEntry,
  type ExecutionRealmBootstrapContext,
} from '@forgeax/engine-app';
import { audioPlugin } from '@forgeax/engine-audio';
import { Time, Update, type World } from '@forgeax/engine-ecs';
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { physicsPlugin } from '@forgeax/engine-physics';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { createPlayVfxRuntime } from './vfx-runtime';
import {
  PLAY_EXECUTION_PROTOCOL,
  parsePlayExecutionBootstrapData,
  type PlayExecutionModule,
  type PlayExecutionRealmMessage,
  type PlayExecutionRuntimeDiagnostics,
} from './execution-contract';

const CYLINDER_GUID = 'c1111111-0000-5000-8000-000000000001';

function post(port: MessagePort | undefined, message: PlayExecutionRealmMessage): void {
  port?.postMessage(message);
}

export interface PlayExecutionPulse {
  readonly diagnosticsDue: boolean;
  readonly heartbeat?: { readonly fps: number; readonly sentinel: number };
}

/** Deterministic timing state shared by Host and Worker bootstrap lanes. */
export function createPlayExecutionPulse(): (delta: number) => PlayExecutionPulse {
  let frames = 0;
  let elapsed = 0;
  let sentinel = 0;
  let diagnosticsElapsed = 0;
  return (delta): PlayExecutionPulse => {
    frames += 1;
    elapsed += delta;
    diagnosticsElapsed += delta;
    const diagnosticsDue = diagnosticsElapsed >= 0.5;
    if (diagnosticsDue) diagnosticsElapsed = 0;
    if (elapsed < 0.1) return { diagnosticsDue };
    const fps = Math.round(frames / elapsed);
    frames = 0;
    elapsed = 0;
    sentinel += 1;
    return { diagnosticsDue, heartbeat: { fps, sentinel } };
  };
}

export function projectRuntimeDiagnostics(
  context: ExecutionRealmBootstrapContext,
): PlayExecutionRuntimeDiagnostics {
  const inspection = context.world.inspect();
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
  return {
    entityCount: inspection.entityCount,
    activeComponents: [...inspection.activeComponents],
    vfxRuntimePresent: vfxRuntime !== null,
    queuedIntents: vfxRuntime?.snapshot().length ?? -1,
    runtimeDiagnostics: (vfxRuntime?.diagnostics() ?? []) as PlayExecutionRuntimeDiagnostics['runtimeDiagnostics'],
    ...(featurePass === undefined ? {} : { featurePass }),
    ...(feature?.status === undefined ? {} : { featureStatus: feature.status }),
    featureError: feature?.latestError as PlayExecutionRuntimeDiagnostics['featureError'],
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
  return {
    features: [vfx.host.feature, ...(game.features ?? [])],
    plugins: [
      audioPlugin(),
      ...(data.physics === undefined ? [] : [physicsPlugin(data.physics)]),
      ...(game.plugins ?? []),
    ],
    async run(context): Promise<void> {
      runtimeWorld = context.world;
      if (data.runtimeBinding !== undefined) {
        context.assets.configureRuntimeBinding(
          data.runtimeBinding as unknown as RuntimeAssetBinding,
        );
      }
      if (data.packIndexUrl !== undefined) context.assets.configurePackIndex(data.packIndexUrl);

      const cylinderGuid = AssetGuid.parse(CYLINDER_GUID);
      const cylinder = createCylinderGeometry(0.5, 0.5, 1, 18);
      if (cylinderGuid.ok && cylinder.ok) context.assets.catalog(cylinderGuid.value, cylinder.value);

      const attached = await vfx.attachWorld(context.world, context.assets);
      if (!attached.ok) throw attached.error;
      context.registerCleanup(() => {
        vfx.detachWorld(context.world);
        runtimeWorld = undefined;
      });

      const pluginLoad = await loadGamePluginModules({
        modules: data.gamePluginModules,
        importModule: (url) => import(/* @vite-ignore */ url),
      });
      for (const error of pluginLoad.errors) {
        console.error(`[engine] game plugin failed: ${error.clientPath}: ${error.message}`);
      }

      await game.run(context);

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
      }

      const rendererRecord = context.renderer as unknown as {
        readonly identity?: unknown;
        readonly generation?: unknown;
      };
      const identity =
        typeof rendererRecord.identity === 'string' && rendererRecord.identity.length > 0
          ? rendererRecord.identity
          : 'unavailable';
      const generation =
        typeof rendererRecord.generation === 'number' &&
        Number.isInteger(rendererRecord.generation) &&
        rendererRecord.generation >= 0
          ? rendererRecord.generation
          : 0;
      post(context.port, {
        protocol: PLAY_EXECUTION_PROTOCOL,
        kind: 'realm-ready',
        rendererIdentity: identity,
        rendererGeneration: generation,
      });

      const pulse = createPlayExecutionPulse();
      context.world
        .addSystem(Update, {
          name: 'play-execution-heartbeat',
          queries: [],
          fn: () => {
            const delta = context.world.getResource(Time).delta;
            const next = pulse(delta);
            if (next.diagnosticsDue) {
              post(context.port, {
                protocol: PLAY_EXECUTION_PROTOCOL,
                kind: 'runtime-diagnostics',
                diagnostics: projectRuntimeDiagnostics(context),
              });
            }
            if (next.heartbeat === undefined) return;
            post(context.port, {
              protocol: PLAY_EXECUTION_PROTOCOL,
              kind: 'heartbeat',
              ...next.heartbeat,
            });
          },
        })
        .unwrap();
    },
  };
};

export default bootstrap;
