// assemble-material-preview-world — spawn a self-contained MI preview scene (M5/C2).
//
// This is a transient presentation carrier only. Canonical subject identity
// and preview binding come from Engine preview primitives; hot updates mutate
// only the disposable carrier material values.

import { HANDLE_CUBE, HANDLE_CYLINDER, HANDLE_QUAD, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
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
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import type { MaterialPreviewPrimitive } from '@forgeax/engine-preview';
import { Transform } from '@forgeax/engine-scene';
import type { EngineFacade } from '@forgeax/editor-core';

export type PreviewMeshKind = 'sphere' | 'cube' | 'plane' | 'cylinder' | 'custom';

export interface MaterialPreviewBounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface MaterialPreviewAssembly {
  readonly camera: EntityHandle;
  readonly previewMesh: EntityHandle;
  readonly material: MaterialAsset;
  readonly materialHandle: unknown;
  readonly enginePrimitive?: MaterialPreviewPrimitive;
  setPreviewMesh(kind: PreviewMeshKind, customMesh?: MeshAsset | unknown): MaterialPreviewBounds;
  applyResolvedValues(values: Record<string, unknown>): void;
  setEnginePrimitive?(primitive: MaterialPreviewPrimitive): void;
}

function meshHandleFor(kind: PreviewMeshKind, customMeshHandle?: unknown): unknown {
  if (kind === 'custom' && customMeshHandle !== undefined) return customMeshHandle;
  if (kind === 'cube') return HANDLE_CUBE;
  if (kind === 'plane') return HANDLE_QUAD;
  if (kind === 'cylinder') return HANDLE_CYLINDER;
  return HANDLE_SPHERE;
}

function finiteBounds(mesh?: MeshAsset): MaterialPreviewBounds {
  const aabb = mesh?.aabb;
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

function checkerMaterial(): MaterialAsset {
  return Materials.standard({
    baseColor: [0.55, 0.55, 0.58, 1],
    metallic: 0,
    roughness: 0.92,
  });
}

export function assembleMaterialPreviewWorld(facade: EngineFacade): MaterialPreviewAssembly {
  let material = Materials.standard({
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
  });
  // The standard shader's paramSchema requires every value Materials.standard
  // seeds (baseColor / metallic / roughness / occlusionStrength / specularTint).
  // Resolved MI values are layered OVER this baseline, never substituted for it:
  // an MI with no enabled overrides — or one whose parent is not catalogued yet —
  // resolves to {}, and swapping that in leaves the uniform block empty and the
  // mesh unshaded.
  const baselineValues: Record<string, unknown> = { ...(material.values as Record<string, unknown>) };
  let materialHandle = facade.allocSharedRef('MaterialAsset', material);
  let previewMaterialSlotCount = 1;
  const groundMatHandle = facade.allocSharedRef('MaterialAsset', checkerMaterial());
  let enginePrimitive: MaterialPreviewPrimitive | undefined;

  const cloneValueRecord = (values: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(values)) {
      out[key] = Array.isArray(val) ? [...val] : val;
    }
    return out;
  };

  const bindMaterialToPreviewMesh = (): void => {
    facade.set(previewMesh, MeshRenderer, {
      materials: Array(previewMaterialSlotCount).fill(materialHandle),
    } as never);
  };

  const camera = facade.spawn(
    { component: Transform, data: { pos: [0, 1.5, 4] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 3, aspect: 1 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
        clearColor: [0.18, 0.2, 0.24, 1],
      },
    },
  ).unwrap();

  const previewMesh = facade.spawn(
    { component: Transform, data: { pos: [0, 1, 0] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  facade.spawn(
    { component: Transform, data: { pos: [0, 0, 0], scale: [8, 0.12, 8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMatHandle] } },
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

  // Solid-color ambient (no equirect) so the first frame is lit without async IBL.
  // Full HDR equirect skybox is optional follow-up once preview pack loading is wired.
  facade.spawn(
    { component: Transform, data: {} },
    { component: Skylight, data: { color: [0.72, 0.78, 0.9], intensity: 0.55 } },
  ).unwrap();

  return {
    camera,
    previewMesh,
    get material() { return material; },
    get materialHandle() { return materialHandle; },
    get enginePrimitive() { return enginePrimitive; },
    setEnginePrimitive(primitive) {
      if (primitive.subject.guid !== primitive.binding.guid) throw new Error('material preview primitive subject mismatch');
      enginePrimitive = primitive;
    },
    setPreviewMesh(kind, customMesh) {
      if (kind === 'custom' && customMesh && typeof customMesh === 'object') {
        const meshAsset = customMesh as MeshAsset;
        const bounds = finiteBounds(meshAsset);
        const handle = facade.allocSharedRef('MeshAsset', meshAsset);
        facade.set(previewMesh, Transform, { pos: [0, 0, 0], scale: [1, 1, 1] } as never);
        facade.set(previewMesh, MeshFilter, { assetHandle: handle } as never);
        const submeshCount = Array.isArray(meshAsset.submeshes) ? Math.max(1, meshAsset.submeshes.length) : 1;
        previewMaterialSlotCount = submeshCount;
        bindMaterialToPreviewMesh();
        return bounds;
      }
      const handle = meshHandleFor(kind, customMesh);
      const scale = kind === 'plane' ? [1.6, 1.6, 1.6] : [1, 1, 1];
      const pos = [0, 1, 0];
      facade.set(previewMesh, Transform, { pos, scale } as never);
      facade.set(previewMesh, MeshFilter, { assetHandle: handle } as never);
      previewMaterialSlotCount = 1;
      bindMaterialToPreviewMesh();
      if (kind === 'plane' || kind === 'cylinder') {
        return { center: [0, 1, 0], radius: 1.2 };
      }
      return { center: [0, 1, 0], radius: 1 };
    },
    applyResolvedValues(values) {
      const merged = cloneValueRecord(baselineValues);
      for (const key of Object.keys(material.values as Record<string, unknown>)) {
        if (!(key in values) && !(key in baselineValues)) delete merged[key];
      }
      for (const [key, val] of Object.entries(values)) {
        merged[key] = Array.isArray(val) ? [...val] : val;
      }
      // Mint a fresh sharedRef so the render extract's cross-frame material
      // snapshot cache cannot serve stale uniforms after chrome-side edits.
      material = {
        ...material,
        values: merged as MaterialAsset['values'],
      };
      materialHandle = facade.allocSharedRef('MaterialAsset', material);
      bindMaterialToPreviewMesh();
    },
  };
}
