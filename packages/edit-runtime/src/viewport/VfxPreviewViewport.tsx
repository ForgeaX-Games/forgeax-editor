import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createApp, type App } from '@forgeax/engine-app';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  isVfxGpuEffectAsset,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import {
  createVfxRuntimeHost,
  type VfxRuntimeHost,
  type VfxRuntimeHostInspectSnapshot,
} from '@forgeax/engine-vfx-render';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
  perspective,
} from '@forgeax/engine-render';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import {
  createEngineFacade,
  useActiveEditorAsset,
} from '@forgeax/editor-core';
import { loadDocumentAssetPayload } from '@forgeax/editor-panels';
import { createParticleCameraSource } from './vfx-runtime-bridge';
import { createViewport, type Viewport } from './viewport';
import './vfx-preview.css';

const PREVIEW_BUNDLER_OPTIONS = {
  shaderManifestUrl: `${(import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')}/shaders/manifest.json`,
};

async function copyDependency(target: AssetRegistry, guid: string): Promise<void> {
  const payload = await loadDocumentAssetPayload(guid);
  if (payload === undefined) throw new Error(`VFX dependency ${guid} is unavailable from the Runtime projection`);
  target.catalog(guid, payload as never);
}

async function installEffectDependencies(
  target: AssetRegistry,
  effect: VfxGpuEffectAsset,
): Promise<void> {
  target.catalog(effect.guid, effect);
  const guids = new Set<string>();
  for (const emitter of effect.program.emitters) {
    for (const renderer of emitter.renderers) {
      guids.add(renderer.material);
      if (renderer.kind === 'mesh') guids.add(renderer.mesh);
    }
  }
  await Promise.all([...guids].map((guid) => copyDependency(target, guid)));
}

function inspectLabel(snapshot: VfxRuntimeHostInspectSnapshot | undefined): string {
  const player = snapshot?.players[0];
  if (!player) return 'Waiting for first fixed tick';
  const spawnedThisTick = player.emitters.reduce((sum, emitter) => sum + emitter.spawnCount, 0);
  const tick = Math.max(-1, ...player.emitters.map((emitter) => emitter.tick ?? -1));
  return `tick ${tick} · emitted this tick ${spawnedThisTick} · generation ${player.values.generation}`;
}

function autoReplayIntervalMs(effect: VfxGpuEffectAsset): number | undefined {
  const durations = effect.program.emitters
    .map((emitter) => emitter.schedule.loopDuration)
    .filter((duration): duration is number => typeof duration === 'number' && duration > 0);
  return durations.length === 0 ? undefined : Math.max(...durations) * 1000;
}

export function VfxPreviewViewport(): ReactElement {
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<{
    facade: ReturnType<typeof createEngineFacade>;
    host: VfxRuntimeHost;
    world: World;
    player: EntityHandle;
    playing: boolean;
  } | null>(null);
  const [status, setStatus] = useState<'booting' | 'ready' | 'error'>('booting');
  const [playing, setPlaying] = useState(true);
  const [inspect, setInspect] = useState<VfxRuntimeHostInspectSnapshot>();
  const [errorHint, setErrorHint] = useState<string>();

  useEffect(() => {
    if (asset?.kind !== 'particle-effect') return;
    const container = hostRef.current;
    if (!container) return;

    let cancelled = false;
    let app: App | null = null;
    let viewport: Viewport | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let inspectTimer: ReturnType<typeof setInterval> | null = null;
    let replayTimer: ReturnType<typeof setInterval> | null = null;
    let previewWorld: World | undefined;
    let cameraEntity: EntityHandle | undefined;
    const vfxHost = createVfxRuntimeHost({
      camera: createParticleCameraSource({
        world: () => previewWorld,
        cameraEntity: () => cameraEntity,
      }),
    });
    const canvas = document.createElement('canvas');
    canvas.className = 'vfx-preview-canvas';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    setStatus('booting');
    setErrorHint(undefined);

    const create = (rhi?: unknown) => createApp(canvas, {
      features: [vfxHost.feature],
      pointerLockAllowed: () => false,
      ...(rhi === undefined ? {} : { rhi: rhi as never }),
    }, PREVIEW_BUNDLER_OPTIONS);

    void (async () => {
      const loadedEffect = await loadDocumentAssetPayload(asset.guid);
      if (!isVfxGpuEffectAsset(loadedEffect)) {
        throw new Error(`VFX asset ${asset.guid} is not a cooked GPU effect`);
      }
      const effect = loadedEffect;
      let created = await create();
      if (!created.ok) {
        const rhiNull = await import('@forgeax/engine-rhi-null');
        created = await create(rhiNull.rhi);
      }
      if (!created.ok) throw created.error;
      if (cancelled) { created.value.stop(); return; }
      app = created.value;
      previewWorld = app.world;
      const assets = app.renderer.assets;
      if (assets === undefined) throw new Error('VFX preview renderer has no AssetRegistry');
      await installEffectDependencies(assets, effect);
      const attached = await vfxHost.attachWorld({ world: app.world, assets });
      if (!attached.ok) throw attached.error;

      const facade = createEngineFacade(app.world as never, assets);
      const camera = facade.spawn(
        { component: Transform, data: { pos: [0, 1.5, 4] } },
        { component: Camera, data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1 }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          clearColor: [0.025, 0.035, 0.06, 1],
        } },
      ).unwrap();
      cameraEntity = camera;
      const floorMaterial = Materials.standard({ baseColor: [0.055, 0.07, 0.1, 1], metallic: 0.15, roughness: 0.78 });
      const floorMaterialHandle = facade.allocSharedRef('MaterialAsset', floorMaterial);
      facade.spawn(
        { component: Transform, data: { pos: [0, -0.08, 0], scale: [10, 0.08, 10] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [floorMaterialHandle] } },
      ).unwrap();
      facade.spawn(
        { component: Transform, data: {} },
        { component: DirectionalLight, data: { direction: [0.4, -1, 0.3], color: [0.8, 0.9, 1], intensity: 1.8 } },
      ).unwrap();
      facade.spawn(
        { component: Transform, data: {} },
        { component: Skylight, data: { color: [0.25, 0.32, 0.5], intensity: 0.35 } },
      ).unwrap();
      const effectHandle = facade.allocSharedRef('ParticleEffectAsset', effect);
      const player = facade.spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: ParticleEffectPlayer, data: { effect: effectHandle, playing: true, seed: 1337, timeScale: 1 } },
      ).unwrap();
      const previewRuntime = { facade, host: vfxHost, world: app.world, player, playing: true };
      runtimeRef.current = previewRuntime;

      viewport = createViewport({
        canvas,
        engine: facade,
        editorEngine: facade,
        camera,
        initialOrbit: { target: [0, 1, 0], dist: 5, yaw: 0.55, pitch: -0.28 },
        interaction: 'orbit-only',
      });
      const syncSize = () => {
        const rect = container.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(rect.width * dpr));
        const height = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          viewport?.refresh();
        }
      };
      syncSize();
      resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(container);
      app.start();
      inspectTimer = setInterval(() => {
        if (!cancelled) setInspect(vfxHost.inspect(app!.world));
      }, 120);
      const replayEvery = autoReplayIntervalMs(effect);
      if (replayEvery !== undefined) {
        replayTimer = setInterval(() => {
          if (runtimeRef.current === previewRuntime && previewRuntime.playing) {
            previewRuntime.world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY).replay(player);
          }
        }, replayEvery);
      }
      setPlaying(true);
      setStatus('ready');
    })().catch((error) => {
      if (cancelled) return;
      setStatus('error');
      setErrorHint(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
      if (inspectTimer !== null) clearInterval(inspectTimer);
      if (replayTimer !== null) clearInterval(replayTimer);
      resizeObserver?.disconnect();
      try { viewport?.dispose(); } catch { /* disposed */ }
      if (app) vfxHost.detachWorld({ world: app.world });
      try { app?.stop(); } catch { /* stopped */ }
      runtimeRef.current = null;
      setInspect(undefined);
      if (canvas.parentElement === container) container.removeChild(canvas);
    };
  }, [asset?.guid]);

  const setPlayState = (next: boolean) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.facade.set(runtime.player, ParticleEffectPlayer, { playing: next });
    runtime.playing = next;
    setPlaying(next);
  };
  const reset = () => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) return;
    runtime.world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY).replay(runtime.player);
  };

  return <div className="vfx-preview" data-testid="vfx-preview-viewport">
    <div className="vfx-preview-toolbar">
      <button type="button" disabled={status !== 'ready'} onClick={() => setPlayState(!playing)}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" disabled={status !== 'ready'} onClick={reset}>Reset</button>
      <span>{inspectLabel(inspect)}</span>
    </div>
    <div className="vfx-preview-host" ref={hostRef}>
      {status === 'booting' && <div className="vfx-preview-status">Booting isolated VFX runtime…</div>}
      {status === 'error' && <div className="vfx-preview-status" data-testid="vfx-preview-error">Preview unavailable{errorHint ? `: ${errorHint}` : ''}</div>}
    </div>
  </div>;
}

export default VfxPreviewViewport;
