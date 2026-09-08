// @forgeax/editor-edit-runtime — isolated Mesh preview-world assembly (STD-01/T1.1).
//
// The assembly is a disposable presentation carrier. It never receives the
// editor document world and therefore cannot write an authored SceneDoc;
// Engine preview primitives remain the binding authority.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import type { MeshPreviewPrimitive } from '@forgeax/engine-preview';
import type { EngineFacade } from '@forgeax/editor-core';

export interface MeshPreviewBounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}
export interface MeshPreviewAssembly {
  readonly camera: EntityHandle;
  readonly subject: EntityHandle;
  readonly bounds: MeshPreviewBounds;
  /** Current subject local-space AABB [minX,minY,minZ, maxX,maxY,maxZ], or null
   *  when no subject is loaded / the box is degenerate. The subject entity
   *  stays at the origin (scale 1), so this is also its world AABB — consumed
   *  by the bounds overlay to draw the 12-edge wireframe. Returns null while a
   *  Scene subject is active (scene bounds are aggregated by the service). */
  readonly subjectAabb: readonly [number, number, number, number, number, number] | null;
  readonly enginePrimitive?: MeshPreviewPrimitive;
  replaceSubject(mesh: MeshAsset): MeshPreviewBounds;
  /** Hide the static mesh subject (scale 0) and clear its AABB — used when a
   *  Scene subject is instantiated so the placeholder cube does not render. */
  hideMeshSubject(): void;
  setEnginePrimitive?(primitive: MeshPreviewPrimitive): void;
}

function validAabb(mesh: MeshAsset): readonly [number, number, number, number, number, number] | null {
  const aabb = mesh.aabb;
  if (
    !aabb
    || aabb.length !== 6
    || aabb.some((value) => !Number.isFinite(value))
    || aabb[0]! > aabb[3]!
    || aabb[1]! > aabb[4]!
    || aabb[2]! > aabb[5]!
  ) {
    return null;
  }
  return [aabb[0]!, aabb[1]!, aabb[2]!, aabb[3]!, aabb[4]!, aabb[5]!];
}

function finiteBounds(mesh: MeshAsset): MeshPreviewBounds {
  const aabb = validAabb(mesh);
  if (aabb === null) {
    return { center: [0, 1, 0], radius: 1 };
  }

  const center: [number, number, number] = [
    (aabb[0] + aabb[3]) / 2,
    (aabb[1] + aabb[4]) / 2,
    (aabb[2] + aabb[5]) / 2,
  ];
  const halfX = (aabb[3] - aabb[0]) / 2;
  const halfY = (aabb[4] - aabb[1]) / 2;
  const halfZ = (aabb[5] - aabb[2]) / 2;
  return {
    center,
    radius: Math.max(0.05, Math.hypot(halfX, halfY, halfZ)),
  };
}

export function assembleMeshPreviewWorld(facade: EngineFacade): MeshPreviewAssembly {
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
    { component: MeshRenderer, data: { materials: [] } },
  ).unwrap();

  // Studio lights are preview chrome, not authored scene entities.
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
  let subjectAabb: readonly [number, number, number, number, number, number] | null = null;
  let enginePrimitive: MeshPreviewPrimitive | undefined;
  const setSubject = (mesh: MeshAsset): MeshPreviewBounds => {
    bounds = finiteBounds(mesh);
    subjectAabb = validAabb(mesh);
    const handle = facade.allocSharedRef('MeshAsset', mesh);
    facade.set(subject, Transform, { pos: [0, 0, 0], scale: [1, 1, 1] });
    facade.set(subject, MeshFilter, { assetHandle: handle });
    // Empty overrides are semantic inheritance: the renderer resolves each
    // slot from MeshAsset.materialSlots[].defaultMaterial, then the engine
    // default. Preview therefore exercises exactly the same binding path as
    // Edit and Play instead of repainting the asset with preview gray.
    facade.set(subject, MeshRenderer, { materials: [] });
    return bounds;
  };
  const hideMeshSubject = (): void => {
    // Scale 0 collapses the placeholder cube so it is culled out of the
    // rendered preview while a Scene subject (skeletal mesh) is active.
    // replaceSubject restores scale [1,1,1] on the next mesh subject swap.
    facade.set(subject, Transform, { scale: [0, 0, 0] });
    subjectAabb = null;
  };

  return {
    camera,
    subject,
    get bounds() {
      return bounds;
    },
    get subjectAabb() {
      return subjectAabb;
    },
    get enginePrimitive() {
      return enginePrimitive;
    },
    setEnginePrimitive(primitive) {
      if (primitive.subject.guid !== primitive.binding.guid) throw new Error('mesh preview primitive subject mismatch');
      enginePrimitive = primitive;
    },
    replaceSubject: setSubject,
    hideMeshSubject,
  };
}
