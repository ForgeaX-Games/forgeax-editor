// gltf-flatten.ts — frontend multi-mesh GLB → persistable native doc entities.
//
// WHY (root cause it replaces): a multi-mesh GLB "Add to Scene" / import used to
// route through the platform-io `import-scene` endpoint, which returned an
// editor-only `GltfRef` entity (+ placeholder cubes). `scene-pack` can't persist
// GltfRef, so the geometry vanished on reopen and never reached ▶ Play (Edit≠Play
// data-loss). This module flattens the GLB into N NATIVE doc entities — each a
// plain `Mesh.meshAsset` + `Material` + `Transform` under one empty group node —
// exactly the shape `sessionToPack`/`packToSession` already round-trip for the
// single-mesh drag path. No new component, no new format, no backend.
//
// Reuses the engine parse SSOT (`parseGlb` → GltfDoc) the caller already ran for
// the meta cook, plus the `.meta.json` subAssets table (sourceIndex → GUID, the
// same mapping mesh-original-materials.ts:81-88 uses). Pure + browser-clean +
// DAG-legal (core layer): parse is INJECTED as `doc` so the unit test needs no
// GLB file / no GPU.
//
// The emitted Transform mirrors the engine bridge's `pushLocalTransform`
// (bridge.ts:439) — LOCAL node TRS, hierarchy preserved via parent links; the
// runtime's propagateTransforms is the single world-accumulation path (writing
// world TRS here would double-bake, see bridge.ts:431-438).

import { quatToEuler } from './scene-pack';

// Structural subset of the engine `GltfDoc` — exactly the fields this module
// reads. Declared locally (not `import type { GltfDoc }`) so editor-core does not
// couple to the engine type's name resolution and so the caller's real GltfDoc is
// accepted by structural typing (Pipeline Isolation — declared inputs only).
interface FlatGltfNode {
  readonly name?: string;
  readonly transform: {
    readonly translation: readonly number[];
    readonly rotation: readonly number[];
    readonly scale: readonly number[];
  };
  readonly meshIndex: number | null;
  readonly children: readonly number[];
}
interface FlatGltfMesh {
  readonly meshIndex: number;
  readonly materialIndex: number | null;
}
export interface FlatGltfDoc {
  readonly nodes: readonly FlatGltfNode[];
  readonly meshes: readonly FlatGltfMesh[];
  readonly scenes: readonly { readonly nodes: readonly number[] }[];
  readonly defaultSceneIndex: number;
}

export interface SpawnDocEntity {
  name: string;
  parent: number | null;
  components: Record<string, unknown>;
}

/** A whole-tree spawn payload for VAG mode:'full' (main.tsx VAG_SPAWN_ENTITY).
 *  `order` is topologically sorted (parent before child) so the receiver's
 *  id-remap reserves a parent id before any child references it. */
export interface SpawnDoc {
  order: number[];
  entities: Record<number, SpawnDocEntity>;
}

/** Minimal shape of the cooked `*.glb.meta.json` sub-asset table this reads. */
export interface GlbFlattenMeta {
  subAssets?: Array<{ guid: string; kind: string; sourceIndex: number }>;
}

/**
 * Flatten a parsed GLB into a persistable SpawnDoc: one empty Transform group
 * root (name = `glbName`) + one child entity per glTF node, preserving the node
 * hierarchy. Mesh nodes carry `Mesh.meshAsset` (real imported GUID) and, when
 * their primitives had glTF materials, `Material.submeshMaterials`. Transform-
 * only nodes are kept as hierarchy anchors (mirrors the engine importer's D-2
 * rule).
 *
 * @returns null when nothing is spawnable — no nodes, or the meta has no `mesh`
 *   sub-assets (caller should warn + not spawn, never resurrect GltfRef).
 */
export function flattenGlbToSpawnDoc(
  doc: FlatGltfDoc,
  meta: GlbFlattenMeta,
  glbName: string,
): SpawnDoc | null {
  const subAssets = Array.isArray(meta.subAssets) ? meta.subAssets : [];
  const meshGuidByIndex = new Map<number, string>();
  const matGuidByIndex = new Map<number, string>();
  for (const s of subAssets) {
    if (typeof s?.sourceIndex !== 'number' || typeof s.guid !== 'string') continue;
    if (s.kind === 'mesh') meshGuidByIndex.set(s.sourceIndex, s.guid);
    else if (s.kind === 'material') matGuidByIndex.set(s.sourceIndex, s.guid);
  }
  if (meshGuidByIndex.size === 0) return null; // meta declared no meshes → nothing to spawn

  const nodes = doc.nodes;
  if (nodes.length === 0) return null;

  // Scene roots (fall back to any node no other node lists as a child).
  const scene = doc.scenes[doc.defaultSceneIndex];
  let roots: readonly number[];
  if (scene && scene.nodes.length > 0) {
    roots = scene.nodes;
  } else {
    const childSet = new Set<number>();
    for (const n of nodes) for (const c of n.children) childSet.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !childSet.has(i));
  }

  const GROUP_ID = 0;
  const entities: Record<number, SpawnDocEntity> = {
    [GROUP_ID]: { name: glbName || 'GLB', parent: null, components: { Transform: {} } },
  };
  const order: number[] = [GROUP_ID];

  // Pre-order (parent before child) DFS from scene roots. Local ids start at 1;
  // each glTF node index maps to a local id so parent links resolve.
  const localIdByNode = new Map<number, number>();
  let nextLocal = 1;
  const visited = new Set<number>();

  const buildMaterial = (meshIndex: number): Record<string, unknown> | null => {
    // One doc.meshes row per primitive (submesh order); pair positionally with
    // the material sub-asset GUIDs, same as mesh-original-materials.ts:103-108.
    const prims = doc.meshes.filter((m) => m.meshIndex === meshIndex);
    if (prims.length === 0) return null;
    const guids = prims.map((p) => (p.materialIndex !== null ? (matGuidByIndex.get(p.materialIndex) ?? '') : ''));
    if (guids.every((g) => g === '')) return null;
    return { submeshMaterials: guids };
  };

  const emitTransform = (t: FlatGltfNode['transform']): Record<string, number> => {
    const tr = t.translation, sc = t.scale, ro = t.rotation;
    const x = tr[0] ?? 0, y = tr[1] ?? 0, z = tr[2] ?? 0;
    const sx = sc[0] ?? 1, sy = sc[1] ?? 1, sz = sc[2] ?? 1;
    const qx = ro[0] ?? 0, qy = ro[1] ?? 0, qz = ro[2] ?? 0, qw = ro[3] ?? 1;
    const out: Record<string, number> = { x, y, z, scaleX: sx, scaleY: sy, scaleZ: sz };
    const e = quatToEuler(qx, qy, qz, qw);
    // Omit rot keys when identity — matches sessionToPack's `if (rx||ry||rz)` gate
    // so a save doesn't synthesize a spurious quat.
    if (e.rotX || e.rotY || e.rotZ) { out.rotX = e.rotX; out.rotY = e.rotY; out.rotZ = e.rotZ; }
    return out;
  };

  const visit = (nodeIdx: number, parentLocal: number): void => {
    if (visited.has(nodeIdx)) return; // guard against malformed cyclic child refs
    visited.add(nodeIdx);
    const ir = nodes[nodeIdx];
    if (!ir) return;
    const localId = nextLocal++;
    localIdByNode.set(nodeIdx, localId);

    const components: Record<string, unknown> = { Transform: emitTransform(ir.transform) };
    if (ir.meshIndex !== null) {
      const meshGuid = meshGuidByIndex.get(ir.meshIndex);
      if (meshGuid) {
        components.Mesh = { kind: 'cube', meshAsset: meshGuid };
        const mat = buildMaterial(ir.meshIndex);
        if (mat) components.Material = mat;
      }
      // meshIndex set but no imported mesh GUID → leave as a Transform-only anchor.
    }

    entities[localId] = {
      name: ir.name && ir.name !== '' ? ir.name : `Node_${nodeIdx}`,
      parent: parentLocal,
      components,
    };
    order.push(localId);

    for (const child of ir.children) visit(child, localId);
  };

  for (const r of roots) visit(r, GROUP_ID);

  // Only the group root produced (no visitable nodes) → nothing meaningful.
  if (order.length <= 1) return null;
  return { order, entities };
}
