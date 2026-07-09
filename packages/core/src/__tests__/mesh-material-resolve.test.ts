// w1 (feat-20260708 M1 / plan-strategy §5.1/§5.3, D-2/D-4): core-side data-path
// RED test — the material marker emit + resolver GUID array shape. Written
// BEFORE w3 (marker emit) / w4 (resolver thin) land, so the marker-emit half is
// RED until buildSpawnEntityFromDragRef learns to carry resolved material GUIDs.
//
// Two independent core-pure surfaces are covered (no core/src/io/ dependency —
// requirements OOS-1 / DEF-1: this fixture must never reach path-1 io territory):
//
//   (1) MARKER EMIT (drag-asset-spawn.ts, w3): the mesh spawn command must carry
//       a command-level `EditorPendingMeshMaterials{guids}` marker (Editor* prefix
//       so document.ts spawnComponentData silently drops it, not the data-loss
//       warning branch — plan-strategy §5.6 + document.ts:148-159) and must NOT
//       author a `Material` component (the collapse deleted Material.submeshMaterials;
//       re-emitting it is the AC-04 death-write we are removing).
//
//   (2) RESOLVER GUID SHAPE (mesh-original-materials.ts, w4): resolveMeshOriginalMaterials
//       returns one GUID per submesh (in submesh order), '' where a primitive had
//       no glTF material, length == submesh count; three states — multi-material
//       (with a '' gap in the middle), single-material, and no-material (-> null).
//       parseGlb is stubbed via mock.module so no GLB fixture is needed.
//
// Anchors:
//   plan-tasks.json w1 · requirements §5 AC-01/AC-02/AC-04
//   research Finding A2 (count align / '' slots), Finding B (both paths emit marker)
//   plan-strategy §5.1 (TDD stance), §5.3 (key test points), D-2 (marker), D-4 (paths)

import { describe, expect, it, mock } from 'bun:test';

// Stub the engine glTF parser so the resolver can run without a real GLB. Each
// test re-primes the stub via a module-level closure the mock reads.
let stubMeshes: { meshIndex: number; materialIndex: number | null }[] = [];
mock.module('@forgeax/engine-gltf', () => ({
  parseGlb: async () => ({ ok: true, value: { meshes: stubMeshes } }),
}));

import { buildSpawnEntityFromDragRef, type DragAssetRef } from '../assets/drag-asset-spawn';
import { resolveMeshOriginalMaterials, _clearMeshMaterialCache } from '../scene/mesh-original-materials';

const MESH_GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function meshRef(): DragAssetRef {
  return { type: 'asset', guid: MESH_GUID, kind: 'mesh', name: 'Chair', path: '/models/chair.glb.meta.json' };
}

// ── (1) marker emit ──────────────────────────────────────────────────────────

describe('w1 buildSpawnEntityFromDragRef material marker (RED before w3)', () => {
  it('(a) mesh branch with resolved material GUIDs emits EditorPendingMeshMaterials{guids}', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef(), { materialGuids: ['matA', '', 'matB'] });
    expect(ent).not.toBeNull();
    const marker = ent!.components.EditorPendingMeshMaterials as { guids: string[] } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.guids).toEqual(['matA', '', 'matB']);
  });

  it('(b) marker key carries the Editor* prefix (document.ts silent-drop whitelist)', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef(), { materialGuids: ['matA'] });
    const keys = Object.keys(ent!.components);
    const markerKey = keys.find((k) => k === 'EditorPendingMeshMaterials');
    expect(markerKey).toBeDefined();
    expect(markerKey!.startsWith('Editor')).toBe(true);
  });

  it('(c) NEVER authors a Material component (AC-04: submeshMaterials death-write removed)', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef(), { materialGuids: ['matA', 'matB'] });
    expect(ent!.components.Material).toBeUndefined();
  });

  it('(d) mesh branch WITHOUT material GUIDs emits no marker (unchanged prior behaviour)', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef());
    expect(ent!.components.EditorPendingMeshMaterials).toBeUndefined();
    // The existing EditorPendingMeshAsset mesh-handle marker is untouched.
    expect(ent!.components.EditorPendingMeshAsset).toBeDefined();
  });

  it('(e) empty material GUID array emits no marker (nothing to resolve)', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef(), { materialGuids: [] });
    expect(ent!.components.EditorPendingMeshMaterials).toBeUndefined();
  });
});

// ── (2) resolver GUID array shape ────────────────────────────────────────────

const META = (subAssets: Array<{ guid: string; kind: string; sourceIndex: number }>) =>
  JSON.stringify({ subAssets });

const deps = (metaText: string) => ({
  fetchText: async () => metaText,
  fetchBytes: async () => new ArrayBuffer(8),
});

describe('w1 resolveMeshOriginalMaterials GUID array shape (three states)', () => {
  it('(f) MULTI-material: one GUID per submesh in order, with a mid-array "" gap, length == submesh count', async () => {
    _clearMeshMaterialCache();
    // 3 primitives on mesh 0: material 0, none, material 1.
    stubMeshes = [
      { meshIndex: 0, materialIndex: 0 },
      { meshIndex: 0, materialIndex: null },
      { meshIndex: 0, materialIndex: 1 },
    ];
    const meta = META([
      { guid: MESH_GUID, kind: 'mesh', sourceIndex: 0 },
      { guid: 'matA', kind: 'material', sourceIndex: 0 },
      { guid: 'matB', kind: 'material', sourceIndex: 1 },
    ]);
    const r = await resolveMeshOriginalMaterials({ guid: MESH_GUID, path: '/x.glb.meta.json' }, deps(meta));
    expect(r).toEqual(['matA', '', 'matB']);
    expect(r!.length).toBe(3); // == submesh (primitive) count
  });

  it('(g) SINGLE-material: one submesh -> one GUID', async () => {
    _clearMeshMaterialCache();
    stubMeshes = [{ meshIndex: 0, materialIndex: 0 }];
    const meta = META([
      { guid: MESH_GUID, kind: 'mesh', sourceIndex: 0 },
      { guid: 'matA', kind: 'material', sourceIndex: 0 },
    ]);
    const r = await resolveMeshOriginalMaterials({ guid: MESH_GUID, path: '/x.glb.meta.json' }, deps(meta));
    expect(r).toEqual(['matA']);
  });

  it('(h) NO-material: every primitive has null materialIndex -> null (caller keeps default)', async () => {
    _clearMeshMaterialCache();
    stubMeshes = [
      { meshIndex: 0, materialIndex: null },
      { meshIndex: 0, materialIndex: null },
    ];
    const meta = META([
      { guid: MESH_GUID, kind: 'mesh', sourceIndex: 0 },
      // A material sub-asset exists (so the resolver does not bail early on an
      // empty material map) but no primitive references it.
      { guid: 'matA', kind: 'material', sourceIndex: 9 },
    ]);
    const r = await resolveMeshOriginalMaterials({ guid: MESH_GUID, path: '/x.glb.meta.json' }, deps(meta));
    expect(r).toBeNull();
  });
});
