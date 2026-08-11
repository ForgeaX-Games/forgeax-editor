import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createApp, type App } from '@forgeax/engine-app';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { FixedTime, type EntityHandle, type World } from '@forgeax/engine-ecs';
import {
  isVfxGpuEffectAsset,
  ParticleEffectPlayer,
  type VfxGpuEffectAsset,
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
  const phaseTick = Math.max(-1, ...player.emitters.map((emitter) => emitter.phaseTick ?? -1));
  return `phase ${phaseTick} · emitted ${spawnedThisTick} · generation ${player.values.generation}`;
}

function previewErrorHint(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object') {
    const hint = (error as { readonly hint?: unknown }).hint;
    if (typeof hint === 'string' && hint.length > 0) return hint;
  }
  return String(error);
}

export function VfxPreviewViewport(): ReactElement {
  const asset = useActiveEditorAsset();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<{
    app: App;
    facade: ReturnType<typeof createEngineFacade>;
    host: VfxRuntimeHost;
    world: World;
    player: EntityHandle;
    playing: boolean;
    emitterIds: readonly string[];
    setPlaying(next: boolean): void;
    replay(): void;
    setEnabledEmitterIds(next: readonly string[]): void;
    seekPhaseTick(target: number): Promise<void>;
  } | null>(null);
  const [status, setStatus] = useState<'booting' | 'ready' | 'error'>('booting');
  const [playing, setPlaying] = useState(true);
  const [inspect, setInspect] = useState<VfxRuntimeHostInspectSnapshot>();
  const [errorHint, setErrorHint] = useState<string>();
  const [enabledEmitterIds, setEnabledEmitterIds] = useState<readonly string[]>([]);
  const [phaseDraft, setPhaseDraft] = useState(0);
  const [maxPhaseTick, setMaxPhaseTick] = useState(300);
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    if (asset?.kind !== 'particle-effect') return;
    const container = hostRef.current;
    if (!container) return;

    let cancelled = false;
    let app: App | null = null;
    let viewport: Viewport | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let inspectTimer: ReturnType<typeof setInterval> | null = null;
    let previewWorld: World | undefined;
    let cameraEntity: EntityHandle | undefined;
    let appPausedForSeek = false;
    let seekInFlight = false;
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
      const control = vfxHost.acquireControl(app.world);
      if (!control.ok) throw control.error;

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
      const emitterIds = Object.freeze(effect.program.emitters.map((emitter) => emitter.id));
      const currentApp = app;
      const previewRuntime = {
        app: currentApp,
        facade,
        host: vfxHost,
        world: currentApp.world,
        player,
        playing: true,
        emitterIds,
        setPlaying(next: boolean) {
          facade.set(player, ParticleEffectPlayer, { playing: next }).unwrap();
          previewRuntime.playing = next;
          setPlaying(next);
        },
        replay() {
          const result = control.value.replay({ player });
          if (!result.ok) throw result.error;
          setPhaseDraft(0);
        },
        setEnabledEmitterIds(nextEnabledEmitterIds: readonly string[]) {
          const enabled = new Set(nextEnabledEmitterIds);
          for (const emitterId of emitterIds) {
            const result = control.value.setEmitterSessionEnabled({
              player,
              emitterId,
              enabled: enabled.has(emitterId),
            });
            if (!result.ok) throw result.error;
          }
          setEnabledEmitterIds(Object.freeze([...nextEnabledEmitterIds]));
        },
        async seekPhaseTick(targetPhaseTick: number) {
          if (seekInFlight) throw new Error('a VFX preview seek is already running');
          seekInFlight = true;
          setSeeking(true);
          try {
            currentApp.pause().unwrap();
            appPausedForSeek = true;
            facade.set(player, ParticleEffectPlayer, { playing: true }).unwrap();
            const replayed = control.value.replay({ player });
            if (!replayed.ok) throw replayed.error;
            const fixedDelta = currentApp.world.getResource(FixedTime).delta;
            const steps = targetPhaseTick + 1;
            for (let step = 0; step < steps; step += 1) {
              if (cancelled || runtimeRef.current !== previewRuntime) {
                throw new Error('the VFX preview generation changed during seek');
              }
              currentApp.stepFrame(fixedDelta).unwrap();
              if ((step + 1) % 30 === 0 && step + 1 < steps) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              }
            }
            facade.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
            previewRuntime.playing = false;
            setPlaying(false);
            setInspect(vfxHost.inspect(currentApp.world));
            setPhaseDraft(targetPhaseTick);
          } finally {
            seekInFlight = false;
            setSeeking(false);
            if (!cancelled && appPausedForSeek) {
              currentApp.resume().unwrap();
              appPausedForSeek = false;
            }
          }
        },
      };
      runtimeRef.current = previewRuntime;

      viewport = createViewport({
        canvas,
        engine: facade,
        editorEngine: facade,
        camera,
        initialOrbit: { target: [0, 0.8, 0], dist: 6, yaw: 0.55, pitch: -0.24 },
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
      setEnabledEmitterIds(emitterIds);
      const loopSeconds = Math.max(
        5,
        ...effect.program.emitters.map((emitter) => emitter.schedule.loopDuration ?? 0),
      );
      setMaxPhaseTick(Math.min(3_600, Math.max(1, Math.ceil(loopSeconds * 60))));
      inspectTimer = setInterval(() => {
        if (!cancelled && !seekInFlight) {
          const snapshot = vfxHost.inspect(app!.world);
          setInspect(snapshot);
          const phaseTick = Math.max(
            0,
            ...(snapshot?.players[0]?.emitters.map((emitter) => emitter.phaseTick ?? 0) ?? [0]),
          );
          setPhaseDraft(phaseTick);
        }
      }, 120);
      setPlaying(true);
      setStatus('ready');
    })().catch((error) => {
      if (cancelled) return;
      setStatus('error');
      setErrorHint(previewErrorHint(error));
    });

    return () => {
      cancelled = true;
      if (inspectTimer !== null) clearInterval(inspectTimer);
      resizeObserver?.disconnect();
      try { viewport?.dispose(); } catch { /* disposed */ }
      if (app) vfxHost.detachWorld({ world: app.world });
      if (app && appPausedForSeek) {
        try { app.resume(); } catch { /* stopping */ }
        appPausedForSeek = false;
      }
      try { app?.stop(); } catch { /* stopped */ }
      runtimeRef.current = null;
      setInspect(undefined);
      setEnabledEmitterIds([]);
      if (canvas.parentElement === container) container.removeChild(canvas);
    };
  }, [asset?.guid]);

  const setPlayState = (next: boolean) => {
    try {
      runtimeRef.current?.setPlaying(next);
      setErrorHint(undefined);
    } catch (error) {
      setErrorHint(previewErrorHint(error));
    }
  };
  const reset = () => {
    try {
      runtimeRef.current?.replay();
      setErrorHint(undefined);
    } catch (error) {
      setErrorHint(previewErrorHint(error));
    }
  };
  const setEmitterMask = (next: readonly string[]) => {
    try {
      runtimeRef.current?.setEnabledEmitterIds(next);
      setErrorHint(undefined);
    } catch (error) {
      setErrorHint(previewErrorHint(error));
    }
  };
  const toggleEmitter = (emitterId: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const enabled = new Set(enabledEmitterIds);
    if (enabled.has(emitterId) && enabled.size === 1) {
      setEmitterMask(runtime.emitterIds);
      return;
    }
    if (enabled.has(emitterId)) setEmitterMask([emitterId]);
    else setEmitterMask([...enabled, emitterId]);
  };
  const seek = (phaseTick: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    void runtime.seekPhaseTick(phaseTick).then(
      () => setErrorHint(undefined),
      (error) => setErrorHint(previewErrorHint(error)),
    );
  };

  return <div className="vfx-preview" data-testid="vfx-preview-viewport">
    <div className="vfx-preview-toolbar">
      <button type="button" disabled={status !== 'ready' || seeking} onClick={() => setPlayState(!playing)}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" disabled={status !== 'ready' || seeking} onClick={reset}>Reset</button>
      <label className="vfx-preview-phase">
        <span>Phase</span>
        <input
          type="range"
          min={0}
          max={maxPhaseTick}
          step={1}
          value={Math.min(maxPhaseTick, phaseDraft)}
          disabled={status !== 'ready' || seeking}
          onChange={(event) => setPhaseDraft(Number(event.currentTarget.value))}
          onPointerUp={(event) => seek(Number(event.currentTarget.value))}
          onKeyUp={(event) => seek(Number(event.currentTarget.value))}
        />
        <output>{phaseDraft}</output>
      </label>
      <div className="vfx-preview-emitter-mask" aria-label="Preview emitter mask">
        <button
          type="button"
          disabled={status !== 'ready' || seeking}
          onClick={() => setEmitterMask(runtimeRef.current?.emitterIds ?? [])}
        >All</button>
        {runtimeRef.current?.emitterIds.map((emitterId) => <button
          type="button"
          key={emitterId}
          className={enabledEmitterIds.includes(emitterId) ? 'active' : ''}
          disabled={status !== 'ready' || seeking}
          onClick={() => toggleEmitter(emitterId)}
          title="Click to isolate; click the isolated emitter again to show all"
        >{emitterId}</button>)}
      </div>
      <span className="vfx-preview-inspect">{seeking ? `Seeking phase ${phaseDraft}…` : inspectLabel(inspect)}</span>
    </div>
    <div className="vfx-preview-host" ref={hostRef}>
      {status === 'booting' && <div className="vfx-preview-status">Booting isolated VFX runtime…</div>}
      {status === 'error' && <div className="vfx-preview-status" data-testid="vfx-preview-error">Preview unavailable{errorHint ? `: ${errorHint}` : ''}</div>}
    </div>
  </div>;
}

export default VfxPreviewViewport;
