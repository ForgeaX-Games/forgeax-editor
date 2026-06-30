// Recover the ORIGINAL per-submesh material GUIDs for an imported `mesh`
// sub-asset, so a single-mesh drag / "Add to Scene" can restore the source glTF
// materials instead of a single grey placeholder.
//
// WHY this is needed (root cause): a cooked `*.glb.meta.json` splits a GLB into
// independent `mesh` / `material` / `scene` sub-assets. The `mesh` sub-asset is
// geometry ONLY (`submeshes`, no materials); the per-submesh material binding
// lives in the sibling `scene` sub-asset. So when the user drops a single mesh
// card, the drag ref carries no material info.
//
// HOW (self-contained, no engine-internal scene-ref decode): the binding is
// reconstructable from the SOURCE GLB + the meta's sub-asset table:
//   - the mesh sub-asset's `sourceIndex` IS the glTF mesh index;
//   - `parseGlb(...).meshes` yields one row per primitive (in submesh order),
//     each carrying its owning `meshIndex` and `materialIndex`;
//   - material sub-assets map `sourceIndex` (= glTF material index) -> GUID.
// Pair them positionally -> the per-submesh material GUID list.
//
// Design: docs/design/editor-mesh-drag-original-materials.md §3.2/§3.3.

import { parseGlb } from '@forgeax/engine-gltf';

export interface MeshMaterialResolveDeps {
  /** Read a text file (e.g. the `.meta.json`) by project path. `null` on miss. */
  fetchText: (path: string) => Promise<string | null>;
  /** Read raw bytes (e.g. the `.glb`) by project path. `null` on miss. */
  fetchBytes: (path: string) => Promise<ArrayBuffer | null>;
}

interface SubAssetEntry { guid: string; kind: string; sourceIndex: number }

/** Lightweight ref shape (subset of the Content Browser drag ref). */
export interface MeshAssetRef {
  guid: string;
  path?: string;
  payload?: Record<string, unknown>;
}

// Cache by `${metaPath}#${meshGuid}` — a GLB rarely changes mid-session and a
// drag/Add-to-Scene may repeat. `null` (not-resolvable) is cached too.
const cache = new Map<string, string[] | null>();

/**
 * Resolve the original per-submesh material GUIDs for an imported mesh sub-asset.
 *
 * Returns an ordered GUID array (one entry per submesh; `''` where a primitive
 * had no glTF material), or `null` when nothing is resolvable (no meta / not a
 * `.glb` / no material sub-assets / parse miss / all-empty) — in which case the
 * caller keeps the existing single-material fallback.
 */
export async function resolveMeshOriginalMaterials(
  ref: MeshAssetRef,
  deps: MeshMaterialResolveDeps,
): Promise<string[] | null> {
  const metaPath = typeof ref.path === 'string' ? ref.path : undefined;
  // Only the canonical `*.meta.json` sidecar carries the sub-asset table. (.gltf
  // with external resources is unsupported in-browser — same constraint as the
  // cook path; those fall back to the placeholder material.)
  if (!metaPath || !/\.glb\.meta\.json$/i.test(metaPath)) return null;

  const cacheKey = `${metaPath}#${ref.guid}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await resolveUncached(ref.guid, metaPath, deps).catch(() => null);
  cache.set(cacheKey, result);
  return result;
}

async function resolveUncached(
  meshGuid: string,
  metaPath: string,
  deps: MeshMaterialResolveDeps,
): Promise<string[] | null> {
  const metaText = await deps.fetchText(metaPath);
  if (!metaText) return null;
  let meta: { subAssets?: SubAssetEntry[] };
  try { meta = JSON.parse(metaText) as typeof meta; } catch { return null; }
  const subAssets = Array.isArray(meta.subAssets) ? meta.subAssets : [];

  const meshSub = subAssets.find((s) => s.kind === 'mesh' && s.guid === meshGuid);
  if (!meshSub || typeof meshSub.sourceIndex !== 'number') return null;
  const targetMeshIndex = meshSub.sourceIndex;

  const materialGuidByIndex = new Map<number, string>();
  for (const s of subAssets) {
    if (s.kind === 'material' && typeof s.sourceIndex === 'number') materialGuidByIndex.set(s.sourceIndex, s.guid);
  }
  if (materialGuidByIndex.size === 0) return null;

  const glbPath = metaPath.replace(/\.meta\.json$/i, '');
  const bytes = await deps.fetchBytes(glbPath);
  if (!bytes) return null;

  const parsed = (await parseGlb(bytes as never, glbPath)) as {
    ok: boolean;
    value?: { meshes: readonly { meshIndex: number; materialIndex: number | null }[] };
  };
  if (!parsed?.ok || !parsed.value) return null;

  // One row per primitive, in submesh order (parseGlb preserves doc.meshes order;
  // the engine bridge merges by meshIndex with materials[i] <-> submeshes[i]).
  const prims = parsed.value.meshes.filter((m) => m.meshIndex === targetMeshIndex);
  if (prims.length === 0) return null;

  const guids = prims.map((p) =>
    p.materialIndex !== null ? (materialGuidByIndex.get(p.materialIndex) ?? '') : '',
  );
  if (guids.every((g) => g === '')) return null;
  return guids;
}

/** Test/debug: drop the resolve cache. */
export function _clearMeshMaterialCache(): void { cache.clear(); }
