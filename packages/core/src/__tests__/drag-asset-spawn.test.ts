// w8 (feat-20260705 M3 / plan-strategy §D-2/D-3/D-5): drag-asset-spawn mesh
// branch output-shape test. RED before w10 splits the mesh/material branch.
//
// After the GUID bridge lands (w10), buildSpawnEntityFromDragRef must emit, for
// a `mesh` ref, an entity whose MeshFilter carries the sentinel handle 0 and a
// command-level marker `EditorPendingMeshAsset` holding the real asset guid — no
// HANDLE_CUBE. The bridge (w11) later reads that marker, resolves the guid to a
// real handle, and patches MeshFilter.assetHandle over the bus. The marker key
// is a schema-outsider: spawnComponentData (document.ts) silently drops any
// component name it does not register, so EditorPendingMeshAsset never reaches
// the world/persist layer (plan-strategy §D-2).
//
// texture/material branches KEEP HANDLE_CUBE — there it is proxy geometry (a
// texture needs a surface to display on; a material needs a mesh to shade), not
// a placeholder for a missing mesh (plan-strategy §D-5 — narrowing of AC-10).
//
// Anchors:
//   plan-tasks.json w8: mesh branch RED — assetHandle:0 + marker guid + no cube
//   requirements AC-10/AC-11: real asset GUID bridged, Edit=Play round-trip
//   plan-strategy §D-2 (schema-outsider marker), §D-3 (sentinel), §D-5 (cube scope)
//   research Finding 4(c): spawnEntity command has no guid field -> carrier needed

import { describe, expect, it } from 'bun:test';
import { buildSpawnEntityFromDragRef, type DragAssetRef } from '../assets/drag-asset-spawn';

const MESH_GUID = 'mesh-guid-abcdef01';

function meshRef(): DragAssetRef {
  return { type: 'asset', guid: MESH_GUID, kind: 'mesh', name: 'Chair' };
}

function materialRef(): DragAssetRef {
  return { type: 'asset', guid: 'mat-guid-99', kind: 'material', name: 'Brass' };
}

function textureRef(): DragAssetRef {
  return { type: 'asset', guid: 'tex-guid-77', kind: 'texture', name: 'Wood', payload: { width: 512, height: 512 } };
}

describe('w8 buildSpawnEntityFromDragRef mesh branch (RED before w10)', () => {
  it('(a) mesh branch: MeshFilter.assetHandle === 0 (sentinel, not HANDLE_CUBE=1)', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef());
    expect(ent).not.toBeNull();
    const mf = ent!.components.MeshFilter as { assetHandle: number };
    expect(mf).toBeDefined();
    expect(mf.assetHandle).toBe(0);
  });

  it('(b) mesh branch: EditorPendingMeshAsset marker carries the real ref guid', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef());
    const marker = ent!.components.EditorPendingMeshAsset as { guid: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.guid).toBe(MESH_GUID);
  });

  it('(c) mesh branch: no HANDLE_CUBE value (assetHandle is 0, not 1)', () => {
    const ent = buildSpawnEntityFromDragRef(meshRef());
    const mf = ent!.components.MeshFilter as { assetHandle: number };
    // HANDLE_CUBE === 1; the mesh branch must not fall back to it.
    expect(mf.assetHandle).not.toBe(1);
  });

  it('(d) material branch: keeps HANDLE_CUBE (proxy geometry) + no pending marker', () => {
    const ent = buildSpawnEntityFromDragRef(materialRef());
    expect(ent).not.toBeNull();
    const mf = ent!.components.MeshFilter as { assetHandle: number };
    expect(mf.assetHandle).toBe(1); // HANDLE_CUBE
    expect(ent!.components.EditorPendingMeshAsset).toBeUndefined();
  });

  it('(d2) texture branch: keeps HANDLE_CUBE (proxy geometry) + no pending marker', () => {
    const ent = buildSpawnEntityFromDragRef(textureRef());
    expect(ent).not.toBeNull();
    const mf = ent!.components.MeshFilter as { assetHandle: number };
    expect(mf.assetHandle).toBe(1); // HANDLE_CUBE
    expect(ent!.components.EditorPendingMeshAsset).toBeUndefined();
  });
});
