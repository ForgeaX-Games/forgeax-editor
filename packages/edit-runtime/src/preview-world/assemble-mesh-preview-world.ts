// @forgeax/editor-edit-runtime — isolated Mesh preview-world assembly (STD-01/T1.1).
//
// The assembly owns only transient preview entities. It never receives the
// editor document world and therefore cannot write an authored SceneDoc.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
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
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import type { EngineFacade } from '@forgeax/editor-core';

export interface MeshPreviewBounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface MeshPreviewAssembly {
  readonly camera: EntityHandle;
  readonly subject: EntityHandle;
  readonly bounds: MeshPreviewBounds;
  replaceSubject(mesh: MeshAsset): MeshPreviewBounds;
}

const DEFAULT_MATERIAL = Materials.standard({
  baseColor: [0.72, 0.76, 0.82, 1],
  metallic: 0,
  roughness: 0.68,
});

const GROUND_MATERIAL = Materials.standard({
  baseColor: [0.22, 0.24, 0.28, 1],
  metallic: 0,
  roughness: 0.92,
});

function finiteBounds(mesh: MeshAsset): MeshPreviewBounds {
  const aabb = mesh.aabb;
  if (
    !aabb
    || aabb.length !== 6
    || aabb.some((value) => !Number.isFinite(value))
    || aabb[0]! > aabb[3]!
    || aabb[1]! > aabb[4]!
    || aabb[2]! > aabb[5]!
  ) {
    return { center: [0, 1, 0], radius: 1 };
  }

  const center: [number, number, number] = [
    (aabb[0]! + aabb[3]!) / 2,
    (aabb[1]! + aabb[4]!) / 2,
    (aabb[2]! + aabb[5]!) / 2,
  ];
  const halfX = (aabb[3]! - aabb[0]!) / 2;
  const halfY = (aabb[4]! - aabb[1]!) / 2;
  const halfZ = (aabb[5]! - aabb[2]!) / 2;
  return {
    center,
    radius: Math.max(0.05, Math.hypot(halfX, halfY, halfZ)),
  };
}

function materialCount(mesh: MeshAsset): number {
  return Math.max(1, Array.isArray(mesh.submeshes) ? mesh.submeshes.length : 1);
}

export function assembleMeshPreviewWorld(facade: EngineFacade): MeshPreviewAssembly {
  const materialHandle = facade.allocSharedRef('MaterialAsset', DEFAULT_MATERIAL);
  const groundMaterialHandle = facade.allocSharedRef('MaterialAsset', GROUND_MATERIAL);

  const camera = facade.spawn(
    { component: Transform, data: { pos: [0, 1.5, 4] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 3, aspect: 1 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
        clearColor: [0.08, 0.1, 0.13, 1],
      },
    },
  ).unwrap();

  const subject = facade.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  // A small ground plane and a minimal studio light are preview chrome, not
  // authored scene entities. They keep the first static Mesh slice useful
  // before the environment toggles land in P3.
  facade.spawn(
    { component: Transform, data: { pos: [0, -0.02, 0], scale: [8, 0.08, 8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMaterialHandle] } },
  ).unwrap();
  facade.spawn(
    { component: Transform, data: {} },
    {
      component: DirectionalLight,
      data: {
        direction: [0.35, -1, 0.45],
        color: [1, 0.98, 0.94],
        intensity: 2.2,
        castShadow: true,
      },
    },
  ).unwrap();
  facade.spawn(
    { component: Transform, data: {} },
    { component: Skylight, data: { color: [0.72, 0.78, 0.9], intensity: 0.55 } },
  ).unwrap();

  let bounds: MeshPreviewBounds = { center: [0, 1, 0], radius: 1 };
  const setSubject = (mesh: MeshAsset): MeshPreviewBounds => {
    bounds = finiteBounds(mesh);
    const handle = facade.allocSharedRef('MeshAsset', mesh);
    const materials = Array.from({ length: materialCount(mesh) }, () => materialHandle);
    facade.set(subject, Transform, { pos: [0, 0, 0], scale: [1, 1, 1] });
    facade.set(subject, MeshFilter, { assetHandle: handle });
    facade.set(subject, MeshRenderer, { materials });
    return bounds;
  };

  return {
    camera,
    subject,
    get bounds() {
      return bounds;
    },
    replaceSubject: setSubject,
  };
}

