// Edit VFX runtime bridge — the composition seam for the engine-owned host.
//
// The bridge owns no simulation, observation, registry, identity, or protocol
// state. It creates one ParticleRuntimeHost, forwards the existing viewport
// camera source, and exposes the host's readAll-backed diagnostics projection.
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
  createParticleRuntimeHost,
  type ParticleRenderCamera,
  type ParticleRenderFeatureOptions,
  type ParticleRuntimeHost,
  type ParticleRuntimeHostOptions,
  type ParticleRuntimeHostResult,
  type ParticleRuntimeHostAttachResult,
  type ParticleRuntimeHostDetachResult,
} from '@forgeax/engine-vfx-render';

export interface EditVfxRuntimeBridge {
  readonly host: ParticleRuntimeHost;
  readonly attachWorld: (
    world: World,
    assets: AssetRegistry,
  ) => Promise<ParticleRuntimeHostResult<ParticleRuntimeHostAttachResult>>;
  readonly detachWorld: (
    world: World,
  ) => ParticleRuntimeHostResult<ParticleRuntimeHostDetachResult>;
  readonly readDiagnostics: () => ReturnType<ParticleRuntimeHost['feature']['diagnostics']>;
  /** Gateway-ready projection of the same engine-owned render facts. */
  readonly diagnosticsProvider: RuntimeDiagnosticsProvider;
  /** Notify the Gateway when an engine-owned runtime transition was observed. */
  readonly notifyDiagnosticsChanged: () => void;
}

export interface EditVfxRuntimeBridgeOptions {
  readonly camera: ParticleRuntimeHostOptions['camera'];
  readonly hostFactory?: (options: ParticleRuntimeHostOptions) => ParticleRuntimeHost;
}

/** Create the one Edit-side engine host bridge. */
export function createEditVfxRuntimeBridge(
  options: EditVfxRuntimeBridgeOptions,
): EditVfxRuntimeBridge {
  const factory = options.hostFactory ?? createParticleRuntimeHost;
  const host = factory({ camera: options.camera });
  const readDiagnostics = (): ReturnType<ParticleRuntimeHost['feature']['diagnostics']> => host.feature.diagnostics();
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
    snapshot: () => [particleRenderDiagnostic(readDiagnostics())],
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
  diagnostics: ReturnType<ParticleRuntimeHost['feature']['diagnostics']>,
): string {
  return JSON.stringify([
    diagnostics.readiness,
    diagnostics.bucketCount,
    diagnostics.generation,
    diagnostics.error?.code,
    diagnostics.error?.hint,
    diagnostics.error?.expected,
    diagnostics.error?.detail,
  ]);
}

function particleRenderDiagnostic(
  diagnostics: ReturnType<ParticleRuntimeHost['feature']['diagnostics']>,
): RuntimeDiagnosticFact {
  const error = diagnostics.error;
  const failed = diagnostics.readiness === 'failed'
    || diagnostics.readiness === 'disabled'
    || diagnostics.readiness === 'unavailable';
  const severity = error !== undefined || failed ? 'warn' : 'info';
  const code = error?.code ?? `particle-render-${diagnostics.readiness}`;
  return Object.freeze({
    id: 'particle-render-feature',
    severity,
    code,
    title: 'Particle render feature',
    message: error?.hint ?? `Particle renderer readiness is ${diagnostics.readiness}.`,
    retryable: error !== undefined || failed,
    recoveryActions: Object.freeze(error !== undefined || failed ? ['stop', 'play'] : []),
    detail: Object.freeze({
      readiness: diagnostics.readiness,
      bucketCount: diagnostics.bucketCount,
      generation: diagnostics.generation,
      ...(error === undefined ? {} : { error }),
      ...(error !== undefined || failed
        ? { recovery: Object.freeze({ via: 'gateway.dispatch', operations: Object.freeze(['stop', 'play']) }) }
        : {}),
      provenance: Object.freeze({
        source: 'engine-vfx-render',
        host: 'ParticleRuntimeHost',
        feature: 'forgeax.vfx-render.particles',
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
): ParticleRenderFeatureOptions['camera'] {
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
