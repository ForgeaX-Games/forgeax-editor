// Edit VFX runtime bridge — the composition seam for the engine-owned host.
//
// The bridge owns no simulation, observation, registry, identity, or protocol
// state. It creates one VfxRuntimeHost, forwards the existing viewport
// camera source, and projects the Renderer-owned feature diagnostics.
// The same host instance is attached to the persistent Edit World and each
// fresh Play World; the host itself owns attach/detach idempotency.
//
// Anchors: requirements AC-02/AC-03/AC-07/AC-08, plan-strategy §2 D-1/D-2/D-5
// and §7 M3. Editor authored writes remain behind EditGateway; this module only
// reads camera data and delegates runtime ownership to engine-vfx-render.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RuntimeDiagnosticFact, RuntimeDiagnosticsProvider } from '@forgeax/editor-core';
import { mat4, vec3 } from '@forgeax/engine-math';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  createVfxRuntimeHost,
  type ParticleRenderCamera,
  type ParticleRenderCameraSource,
  type VfxRuntimeHost,
  type VfxRuntimeHostOptions,
} from '@forgeax/engine-vfx-render';
import type { RenderFeatureDiagnostics } from '@forgeax/engine-render';

export interface EditVfxRuntimeBridge {
  readonly host: VfxRuntimeHost;
  readonly attachWorld: (
    world: World,
    assets: AssetRegistry,
  ) => ReturnType<VfxRuntimeHost['attachWorld']>;
  readonly detachWorld: (world: World) => ReturnType<VfxRuntimeHost['detachWorld']>;
  readonly readDiagnostics: () => readonly RenderFeatureDiagnostics[];
  /** Gateway-ready projection of the same engine-owned render facts. */
  readonly diagnosticsProvider: RuntimeDiagnosticsProvider;
  /** Notify the Gateway when an engine-owned runtime transition was observed. */
  readonly notifyDiagnosticsChanged: () => void;
}

export interface EditVfxRuntimeBridgeOptions {
  readonly camera: VfxRuntimeHostOptions['camera'];
  readonly renderFeatureDiagnostics: () => readonly RenderFeatureDiagnostics[];
  readonly hostFactory?: (options: VfxRuntimeHostOptions) => VfxRuntimeHost;
}

/** Create the one Edit-side engine host bridge. */
export function createEditVfxRuntimeBridge(
  options: EditVfxRuntimeBridgeOptions,
): EditVfxRuntimeBridge {
  const factory = options.hostFactory ?? createVfxRuntimeHost;
  const host = factory({ camera: options.camera });
  const readDiagnostics = (): readonly RenderFeatureDiagnostics[] =>
    options.renderFeatureDiagnostics().filter(
      (diagnostic) => diagnostic.identity === 'forgeax.vfx-render.gpu-particles',
    );
  const diagnosticsListeners = new Set<() => void>();
  let lastDiagnosticsKey = diagnosticsKey(readDiagnostics());
  const notifyDiagnosticsChanged = (): void => {
    const nextKey = diagnosticsKey(readDiagnostics());
    if (nextKey === lastDiagnosticsKey) return;
    lastDiagnosticsKey = nextKey;
    for (const listener of diagnosticsListeners) listener();
  };
  const diagnosticsProvider: RuntimeDiagnosticsProvider = {
    id: 'editor-vfx',
    snapshot: () => readDiagnostics().map(particleRenderDiagnostic),
    subscribe: (listener) => {
      diagnosticsListeners.add(listener);
      return () => diagnosticsListeners.delete(listener);
    },
  };
  return {
    host,
    attachWorld: async (world, assets) => {
      const result = await host.attachWorld({ world, assets });
      notifyDiagnosticsChanged();
      return result;
    },
    detachWorld: (world) => {
      const result = host.detachWorld({ world });
      notifyDiagnosticsChanged();
      return result;
    },
    readDiagnostics,
    diagnosticsProvider,
    notifyDiagnosticsChanged,
  };
}

function diagnosticsKey(
  diagnostics: readonly RenderFeatureDiagnostics[],
): string {
  return JSON.stringify(diagnostics);
}

function particleRenderDiagnostic(
  diagnostics: RenderFeatureDiagnostics,
): RuntimeDiagnosticFact {
  const error = diagnostics.latestError;
  const failed = diagnostics.status === 'failed' || diagnostics.status === 'disabled';
  const severity = error !== undefined || failed ? 'warn' : 'info';
  const code = error?.code ?? `particle-render-${diagnostics.status}`;
  return Object.freeze({
    id: 'particle-render-feature',
    severity,
    code,
    title: 'Particle render feature',
    message: error?.hint ?? `Particle renderer status is ${diagnostics.status}.`,
    retryable: error !== undefined || failed,
    recoveryActions: Object.freeze(error !== undefined || failed ? ['stop', 'play'] : []),
    detail: Object.freeze({
      status: diagnostics.status,
      identity: diagnostics.identity,
      order: diagnostics.order,
      ...(error === undefined ? {} : { error }),
      ...(error !== undefined || failed
        ? { recovery: Object.freeze({ via: 'gateway.dispatch', operations: Object.freeze(['stop', 'play']) }) }
        : {}),
      provenance: Object.freeze({
        source: 'engine-vfx-render',
        host: 'VfxRuntimeHost',
        feature: diagnostics.identity,
      }),
    }),
  });
}

export interface ParticleCameraSourceOptions {
  readonly world: () => World | undefined;
  readonly cameraEntity: () => EntityHandle | undefined;
}

/**
 * Adapt the existing viewport camera entity into the engine host camera seam.
 * The source is read-only and late-bound so the camera may be spawned after
 * createApp has captured the host feature, while camera orbit remains owned by
 * the existing viewport/editorWorld path.
 */
export function createParticleCameraSource(
  options: ParticleCameraSourceOptions,
): ParticleRenderCameraSource {
  return {
    read: () => {
      const world = options.world();
      const entity = options.cameraEntity();
      if (world === undefined || entity === undefined) return undefined;
      return readParticleCamera(world, entity);
    },
  };
}

function readParticleCamera(world: World, entity: EntityHandle): ParticleRenderCamera | undefined {
  const transform = world.get(entity, Transform);
  const camera = world.get(entity, Camera);
  if (!transform.ok || !camera.ok) return undefined;

  const worldMatrix = transform.value.world;
  const position = mat4.getTranslation(vec3.create(), worldMatrix as never);
  const right = mat4.getRight(vec3.create(), worldMatrix as never);
  const up = mat4.getUp(vec3.create(), worldMatrix as never);
  const forward = mat4.getForward(vec3.create(), worldMatrix as never);
  const px = position[0] ?? 0;
  const py = position[1] ?? 0;
  const pz = position[2] ?? 0;
  const fx = forward[0] ?? 0;
  const fy = forward[1] ?? 0;
  const fz = forward[2] ?? 0;
  const target = [
    px + fx,
    py + fy,
    pz + fz,
  ] as const;
  const viewProjection = mat4.computeViewProj(
    mat4.create(),
    position,
    target,
    up,
    Number(camera.value.fov),
    Number(camera.value.aspect),
    Number(camera.value.near),
    Number(camera.value.far),
  );

  return {
    position: new Float32Array([px, py, pz]),
    right: new Float32Array(right),
    up: new Float32Array(up),
    viewProjection: new Float32Array(viewProjection),
  };
}
