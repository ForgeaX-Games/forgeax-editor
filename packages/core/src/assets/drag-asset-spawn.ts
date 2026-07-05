// Build VAG_SPAWN_ENTITY payloads from Content Browser drag refs.
//
// feat-20260701-editor-world-container-doc-ecs-collapse review round 1 / F-1:
// The former builder emitted editor-legacy components — `Mesh{kind,meshAsset}`,
// `Material{albedo,albedoMap,materialAsset,submeshMaterials}`, and a legacy
// `Transform{x,y,z,scaleX/Y/Z}`. The collapse DELETED that vocabulary from the
// editor schema/spawn, so `spawnComponentData` (document.ts) dropped every one of
// them: a dragged asset materialised as an origin-placed empty Transform with no
// geometry (AGENTS.md #2 data-loss — geometry vanishes, never round-trips).
//
// We now emit only ENGINE-NATIVE components the editor registers:
//   - Transform: engine POD (posX/posY/posZ, quatX/quatY/quatZ/quatW,
//     scaleX/scaleY/scaleZ). Identity rotation is a unit quaternion (w=1) — the
//     collapse pinned Transform on quats end-to-end (AGENTS.md #6).
//   - MeshFilter{assetHandle}: an entity-visible mesh reference. The editor
//     auto-adds a default-material MeshRenderer when MeshFilter is present
//     (document.ts spawnComponentData), so no Material component is needed.
//
// feat-20260705-editor-engine-convergence M3 (AC-10/AC-11, plan-strategy §D-2..D-5):
// the mesh branch now bridges the dragged asset's REAL imported mesh GUID to the
// entity instead of dropping in a builtin cube. It emits:
//   - MeshFilter{assetHandle: 0}     — a sentinel; the engine u32 column accepts
//     0 (w7 spike). The edit-runtime bridge overwrites it with the resolved handle.
//   - EditorPendingMeshAsset{guid}   — a COMMAND-LEVEL marker (NOT an engine
//     component). spawnComponentData drops any unregistered component name, so this
//     key never reaches world/persist (plan-strategy §D-2); it survives only inside
//     the spawnEntity command that the bridge observes over the bus. The bridge
//     (edit-runtime/engine/drag-spawn-resolve.ts, plan-strategy §D-3/D-4) parses
//     the guid, loadByGuid -> allocSharedRef('MeshAsset') -> dispatches
//     setComponent(MeshFilter.assetHandle) over the EditorBus. Round-trip to Play
//     is guaranteed by engine writeback _guidForAsset (research Finding 4e).
//   texture/material branches KEEP HANDLE_CUBE: there the cube is proxy geometry
//   (a texture/material needs a surface to display on), not a missing-mesh
//   placeholder (plan-strategy §D-5 narrows AC-10 to the mesh branch only).

import { HANDLE_CUBE } from '@forgeax/engine-runtime';

export interface DragAssetRef {
  type: 'asset';
  guid: string;
  kind?: string;
  name?: string;
  path?: string;
  payload?: Record<string, unknown>;
}

export interface SpawnRefEntity {
  name: string;
  components: Record<string, unknown>;
}

const TEXTURE_KINDS = new Set(['texture', 'image']);
const PLACEABLE_KINDS = new Set(['texture', 'image', 'material', 'mesh']);

export function stemName(ref: DragAssetRef): string {
  const raw = ref.name?.trim() || ref.guid.slice(0, 8);
  return raw.replace(/[^\w.-]+/g, '_').slice(0, 48) || 'Asset';
}

function textureScale(payload?: Record<string, unknown>): { scaleX: number; scaleY: number; scaleZ: number } {
  const w = typeof payload?.width === 'number' && payload.width > 0 ? payload.width : null;
  const h = typeof payload?.height === 'number' && payload.height > 0 ? payload.height : null;
  const base = 2;
  if (w && h) {
    const aspect = w / h;
    return aspect >= 1
      ? { scaleX: base, scaleY: base / aspect, scaleZ: 0.02 }
      : { scaleX: base * aspect, scaleY: base, scaleZ: 0.02 };
  }
  return { scaleX: base, scaleY: base, scaleZ: 0.02 };
}

/** engine-native Transform POD with identity quaternion rotation. */
function nativeTransform(pos: { x?: number; y?: number; z?: number }, scale: { scaleX: number; scaleY: number; scaleZ: number }): Record<string, unknown> {
  return {
    posX: pos.x ?? 0, posY: pos.y ?? 0, posZ: pos.z ?? 0,
    quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
    ...scale,
  };
}

/** Map a dragged asset ref to a single reference-mode spawn entity, or null if unsupported. */
export function buildSpawnEntityFromDragRef(ref: DragAssetRef): SpawnRefEntity | null {
  const kind = ref.kind ?? '';
  const name = stemName(ref);

  if (!PLACEABLE_KINDS.has(kind)) {
    // `scene` (whole-GLB, mode A) is routed through /api/assets/import-scene, not
    // a single-entity spawn. Everything else is not directly placeable.
    return null;
  }

  if (TEXTURE_KINDS.has(kind)) {
    const scale = textureScale(ref.payload);
    return {
      name,
      components: {
        Transform: nativeTransform({ y: scale.scaleY / 2 + 0.01 }, scale),
        MeshFilter: { assetHandle: HANDLE_CUBE },
      },
    };
  }

  if (kind === 'material') {
    // 'material' — a unit-scale builtin cube that carries the material for
    // display (a material needs a mesh to shade). The cube is proxy geometry,
    // NOT a placeholder for a missing mesh (plan-strategy §D-5 — narrowing of
    // AC-10: HANDLE_CUBE is removed only from the mesh branch).
    return {
      name,
      components: {
        Transform: nativeTransform({ y: 0.5 }, { scaleX: 1, scaleY: 1, scaleZ: 1 }),
        MeshFilter: { assetHandle: HANDLE_CUBE }, // proxy geometry (not a placeholder — a material needs a mesh to display on)
      },
    };
  }

  // 'mesh' — emit a sentinel handle (0) plus an EditorPendingMeshAsset marker
  // holding the real asset guid. The marker is a command-level, schema-outsider
  // key: spawnComponentData (document.ts) drops any component name it does not
  // register, and whitelists the `Editor*` prefix so this marker is dropped
  // WITHOUT the data-loss migration warning — it never reaches world/persist
  // (plan-strategy §D-2). The edit-runtime bridge (installDragSpawnMeshResolver,
  // plan-strategy §D-3/D-4) reads the marker, resolves guid -> real mesh handle,
  // and patches MeshFilter.assetHandle over the bus. No HANDLE_CUBE here — a real
  // mesh must round-trip to Play (AGENTS.md #2, requirements AC-10/AC-11).
  return {
    name,
    components: {
      Transform: nativeTransform({ y: 0.5 }, { scaleX: 1, scaleY: 1, scaleZ: 1 }),
      MeshFilter: { assetHandle: 0 },
      EditorPendingMeshAsset: { guid: ref.guid },
    },
  };
}
