import { describe, expect, it } from 'bun:test';
import { HANDLE_CUBE, HANDLE_CYLINDER, HANDLE_QUAD, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import { createEngineFacade } from '@forgeax/editor-core';
import type { MeshAsset } from '@forgeax/engine-types';
import { assembleMaterialPreviewWorld } from '../assemble-material-preview-world';

const valuesOf = (assembly: ReturnType<typeof assembleMaterialPreviewWorld>): Record<string, unknown> =>
  (assembly.material.values ?? {}) as Record<string, unknown>;

describe('assembleMaterialPreviewWorld', () => {
  it('spawns a camera + default sphere and swaps builtin mesh handles', () => {
    const world = new World();
    const facade = createEngineFacade(world as never);
    const assembly = assembleMaterialPreviewWorld(facade);

    expect(assembly.camera).toBeDefined();
    expect(assembly.previewMesh).toBeDefined();
    expect(world.get(assembly.previewMesh, MeshFilter).unwrap().assetHandle).toBe(HANDLE_SPHERE);

    const cubeBounds = assembly.setPreviewMesh('cube');
    expect(world.get(assembly.previewMesh, MeshFilter).unwrap().assetHandle).toBe(HANDLE_CUBE);
    expect(cubeBounds.center).toEqual([0, 1, 0]);

    const planeBounds = assembly.setPreviewMesh('plane');
    expect(world.get(assembly.previewMesh, MeshFilter).unwrap().assetHandle).toBe(HANDLE_QUAD);
    expect(planeBounds.radius).toBeGreaterThan(0.5);

    const cylBounds = assembly.setPreviewMesh('cylinder');
    expect(world.get(assembly.previewMesh, MeshFilter).unwrap().assetHandle).toBe(HANDLE_CYLINDER);
    expect(cylBounds.radius).toBeGreaterThan(0.5);

    assembly.applyResolvedValues({ baseColor: [1, 0, 0, 1], metallic: 0.7, roughness: 0.2 });
    expect(valuesOf(assembly).baseColor).toEqual([1, 0, 0, 1]);
    expect(valuesOf(assembly).metallic).toBe(0.7);
    expect(valuesOf(assembly).roughness).toBe(0.2);
  });

  it('handles custom mesh asset and computes finite bounds', () => {
    const world = new World();
    const facade = createEngineFacade(world as never);
    const assembly = assembleMaterialPreviewWorld(facade);

    const customMesh: MeshAsset = {
      aabb: [-2, -1, -2, 2, 3, 2],
      submeshes: [{ start: 0, count: 36, materialIndex: 0 }],
    } as never;

    const bounds = assembly.setPreviewMesh('custom', customMesh);
    expect(bounds.center).toEqual([0, 1, 0]);
    expect(bounds.radius).toBeCloseTo(Math.hypot(2, 2, 2), 2);
  });

  // Regression: an MI with no enabled overrides — or one whose parent is not
  // catalogued yet — resolves to {}. Substituting that for material.values left
  // the standard shader's uniform block empty and the preview mesh unshaded.
  it('keeps the standard-material baseline when the resolve yields nothing', () => {
    const facade = createEngineFacade(new World() as never);
    const assembly = assembleMaterialPreviewWorld(facade);
    const baseline = { ...valuesOf(assembly) };
    expect(Object.keys(baseline).length).toBeGreaterThan(0);

    assembly.applyResolvedValues({});
    expect(valuesOf(assembly)).toEqual(baseline);
  });

  it('restores a baseline param once its override is resolved away', () => {
    const facade = createEngineFacade(new World() as never);
    const assembly = assembleMaterialPreviewWorld(facade);
    const baselineRoughness = valuesOf(assembly).roughness;

    assembly.applyResolvedValues({ roughness: 0.05 });
    expect(valuesOf(assembly).roughness).toBe(0.05);

    assembly.applyResolvedValues({});
    expect(valuesOf(assembly).roughness).toBe(baselineRoughness);
  });

  it('rebinds the preview material handle when resolved values change', () => {
    const facade = createEngineFacade(new World() as never);
    const assembly = assembleMaterialPreviewWorld(facade);
    const before = assembly.materialHandle;
    assembly.applyResolvedValues({ baseColor: [0.2, 0.4, 0.9, 1] });
    expect(assembly.materialHandle).not.toBe(before);
    expect(valuesOf(assembly).baseColor).toEqual([0.2, 0.4, 0.9, 1]);
  });

  it('drops a resolved-only param that is no longer resolved', () => {
    const facade = createEngineFacade(new World() as never);
    const assembly = assembleMaterialPreviewWorld(facade);

    assembly.applyResolvedValues({ emissiveIntensity: 3 });
    expect(valuesOf(assembly).emissiveIntensity).toBe(3);

    assembly.applyResolvedValues({});
    expect('emissiveIntensity' in valuesOf(assembly)).toBe(false);
  });
});
