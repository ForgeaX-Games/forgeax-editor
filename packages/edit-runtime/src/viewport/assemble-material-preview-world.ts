// assemble-material-preview-world — spawn a self-contained MI preview scene (M5/C2).
//
// Lives entirely on the preview world's EngineFacade. Hot updates mutate the
// preview MaterialAsset.values object in place (sharedRef identity preserved).

import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
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
import type { MaterialAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';
import type { EngineFacade } from '@forgeax/editor-core';

export type PreviewMeshKind = 'sphere' | 'cube' | 'plane' | 'custom';

export interface MaterialPreviewAssembly {
  readonly camera: EntityHandle;
  readonly previewMesh: EntityHandle;
  readonly material: MaterialAsset;
  readonly materialHandle: unknown;
  setPreviewMesh(kind: PreviewMeshKind, customMeshHandle?: unknown): void;
  applyResolvedValues(values: Record<string, unknown>): void;
}

function meshHandleFor(kind: PreviewMeshKind, customMeshHandle?: unknown): unknown {
  if (kind === 'custom' && customMeshHandle !== undefined) return customMeshHandle;
  if (kind === 'cube') return HANDLE_CUBE;
  if (kind === 'plane') return HANDLE_QUAD;
  return HANDLE_SPHERE;
}

function checkerMaterial(): MaterialAsset {
  return Materials.standard({
    baseColor: [0.55, 0.55, 0.58, 1],
    metallic: 0,
    roughness: 0.92,
  });
}

export function assembleMaterialPreviewWorld(facade: EngineFacade): MaterialPreviewAssembly {
  const material = Materials.standard({
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
  const materialHandle = facade.allocSharedRef('MaterialAsset', material);
  const groundMatHandle = facade.allocSharedRef('MaterialAsset', checkerMaterial());

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
    material,
    materialHandle,
    setPreviewMesh(kind, customMeshHandle) {
      const handle = meshHandleFor(kind, customMeshHandle);
      const scale = kind === 'plane' ? [1.6, 1.6, 1.6] : [1, 1, 1];
      const pos = kind === 'plane' ? [0, 1, 0] : [0, 1, 0];
      facade.set(previewMesh, Transform, { pos, scale } as never);
      facade.set(previewMesh, MeshFilter, { assetHandle: handle } as never);
      facade.set(previewMesh, MeshRenderer, { materials: [materialHandle] } as never);
    },
    applyResolvedValues(values) {
      // Mutate in place — the sharedRef handle points at this exact object.
      const next = material.values as Record<string, unknown>;
      for (const key of Object.keys(next)) {
        if (!(key in values) && !(key in baselineValues)) delete next[key];
      }
      Object.assign(next, baselineValues, values);
    },
  };
}
