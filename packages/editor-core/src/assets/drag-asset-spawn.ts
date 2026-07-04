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
//   - MeshFilter{assetHandle: HANDLE_CUBE}: a VISIBLE builtin placeholder. The
//     editor auto-adds a default-material MeshRenderer when MeshFilter is present
//     (document.ts spawnComponentData), so no Material component is needed.
//
// Associating the dragged asset's REAL imported mesh / material GUID with the
// entity (so it renders the source geometry / look instead of a builtin cube) is
// engine-MVP-OOS: custom-mesh registration is `feat-future-asset-system` (engine
// mesh-filter.ts:44) and there is no collapsed component field carrying an
// unresolved GUID. Tracked as follow-up (review F-4). Until then, a builtin cube
// is an honest, rendering, round-tripping placeholder — not a silent drop.

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

function stemName(ref: DragAssetRef): string {
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

  // 'material' | 'mesh' — a unit-scale builtin cube placeholder (real asset
  // association is feat-future-asset-system, see file header).
  const y = kind === 'material' ? 0.5 : 0.5;
  return {
    name,
    components: {
      Transform: nativeTransform({ y }, { scaleX: 1, scaleY: 1, scaleZ: 1 }),
      MeshFilter: { assetHandle: HANDLE_CUBE },
    },
  };
}
