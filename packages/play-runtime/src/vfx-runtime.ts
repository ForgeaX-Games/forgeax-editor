// Independent Play composition for the engine-owned particle runtime.
//
// This module owns no particle simulation, asset cooking, or VAG transport. It
// creates exactly one public VfxRuntimeHost and adapts the live Play World
// camera to the host's render-feature seam. The runtime entry owns the fresh
// World and shared AssetRegistry; this module only binds those host facts.
// Anchors: requirements AC-02/AC-03/AC-08, plan-strategy §2 D-1/D-5.

import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import {
  createVfxRuntimeHost,
  type ParticleRenderCamera,
  type VfxRuntimeHost,
  type VfxRuntimeHostOptions,
} from '@forgeax/engine-vfx-render';

export interface PlayVfxRuntimeOptions {
  readonly world: () => World | undefined;
  readonly hostFactory?: (options: VfxRuntimeHostOptions) => VfxRuntimeHost;
}

export interface PlayVfxRuntime {
  readonly host: VfxRuntimeHost;
  readonly attachWorld: (
    world: World,
    assets: AssetRegistry,
  ) => ReturnType<VfxRuntimeHost['attachWorld']>;
  readonly detachWorld: (world: World) => ReturnType<VfxRuntimeHost['detachWorld']>;
}

export function createPlayVfxRuntime(options: PlayVfxRuntimeOptions): PlayVfxRuntime {
  const factory = options.hostFactory ?? createVfxRuntimeHost;
  const host = factory({ camera: { read: (world) => readParticleCamera(options.world() ?? world) } });
  return {
    host,
    attachWorld: (world, assets) => host.attachWorld({ world, assets }),
    detachWorld: (world) => host.detachWorld({ world }),
  };
}

function readParticleCamera(world: World | undefined): ParticleRenderCamera | undefined {
  if (world === undefined) return undefined;
  const query = world.query({ read: [Camera, Transform] }).unwrap();
  const first = query[Symbol.iterator]().next();
  if (first.done) return undefined;
  const transform = first.value.get(Transform);
  const camera = first.value.get(Camera);

  const worldMatrix = transform.world;
  const position = mat4.getTranslation(vec3.create(), worldMatrix as never);
  const right = mat4.getRight(vec3.create(), worldMatrix as never);
  const up = mat4.getUp(vec3.create(), worldMatrix as never);
  const forward = mat4.getForward(vec3.create(), worldMatrix as never);
  const px = position[0] ?? 0;
  const py = position[1] ?? 0;
  const pz = position[2] ?? 0;
  const target = [px + (forward[0] ?? 0), py + (forward[1] ?? 0), pz + (forward[2] ?? 0)] as const;
  const viewProjection = mat4.computeViewProj(
    mat4.create(),
    position,
    target,
    up,
    Number(camera.fov),
    Number(camera.aspect),
    Number(camera.near),
    Number(camera.far),
  );
  return {
    position: new Float32Array([px, py, pz]),
    right: new Float32Array(right),
    up: new Float32Array(up),
    viewProjection: new Float32Array(viewProjection),
  };
}
