// @forgeax/engine-runtime - transparent-sort.ts (feat-20260520-2d-sprite-
// layer-mvp / M-3 / w23). SoA Float64Array predicted-key sort consumed by
// the RenderSystem record stage (M-3 / w25) right before recording the
// transparent bucket.
//
// Algorithm (plan-strategy §2 next-tier decision D-8 SoA columnar
// Float64Array; chosen because pure JS Array.sort estimates 4 ms for 10k
// entries / 100 iter ((research §Finding D-2 estimate), and SoA Float64
// preset key sort estimates < 0.2 ms — well under the AC-14 0.5 ms p95
// budget):
//
//   1. Walk `entries` once and project each into:
//        - `layers   : Int32Array(n)`   — primary sort key (Layer.value).
//        - `sortVals : Float64Array(n)` — predicted sort value per entry,
//          derived from `mode` + `yzAlpha` + per-entry inputs OR the
//          per-entity `sortKey` override.
//        - `indices  : number[]`        — initially `[0..n)`.
//   2. `indices.sort((a, b) => ...)` with the composite comparator
//      `(layers[a] - layers[b]) || (sortVals[a] - sortVals[b])`.
//      Array.prototype.sort has been stable since ES2019; tie-breakers
//      fall back to insertion order (charter F1 deterministic output).
//   3. Return entries reordered by the sorted indices.
//
// Why SoA over Object-of-Structs comparator: V8's PSP / TimSort visits
// the comparator O(n log n) times; pulling `entry.layer` + recomputing
// the mode formula per comparator call would multiply cache misses + JS
// engine bridge overhead. Pre-projecting into Int32 + Float64 typed
// arrays keeps the comparator a pair of typed-array index loads (cache
// hot) + 1 / 2 subtractions.
//
// 3-mode formulas (requirements §3 AC-10 + plan-strategy §3.3 sort path):
//
//   | mode | mode constant                      | sortValue formula                                   |
//   |:-:|:----------------------------------|:----------------------------------------------------|
//   |  0 | `TRANSPARENT_SORT_MODE_LAYER_Z`   | `posZ`                                              |
//   |  1 | `TRANSPARENT_SORT_MODE_LAYER_Y`   | `-(posY - pivotY * sizeY)`                          |
//   |  2 | `TRANSPARENT_SORT_MODE_LAYER_YZ`  | `(posY - pivotY * sizeY) + yzAlpha * posZ`          |
//   |  3 | `TRANSPARENT_SORT_MODE_DISTANCE`  | `-(squared distance to cameraPos)`                   |
//
// SortKey override (requirements §3 AC-10 + AC-19 derivation row): when an
// entry carries `sortKey !== undefined`, its sortValue is REPLACED by the
// override - the layer remains the primary key, the mode formula is
// skipped. AI users use this to pin one sprite above / below the procedural
// ordering inside the same layer without reshaping the whole scene.
//
// @derives ECS archetypeStorage SoA column-of-arrays pattern (packages/ecs/
//   src/component.ts:6-9) — typed-array columns indexed by row position,
//   no per-row object allocation.
// @new-surface SoA Float64Array predicted-key sort over Object-of-Structs
//   comparator (research §Finding D-2 path 3); estimated < 0.2 ms p95 for
//   10k entries vs the 4 ms pure-Array.sort baseline; M-4 bench (w27)
//   validates against the 0.5 ms acceptance gate.
//
// charter mapping: F1 (single-import barrel — transparent-sort joins the
// existing render-system surface) + P3 (deterministic stable sort -
// charter "structured failure" extends to "deterministic ordering" inside
// the rendering pipeline; same-key entries preserve insertion order) + P4
// (consistent abstraction - the SoA columnar pattern mirrors the ECS
// archetypeStorage layout).

import type { World } from '@forgeax/engine-ecs';
import type { TransparentEntry } from '../render-system-extract';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './transparent-sort-config';

export type { TransparentEntry } from '../render-system-extract';

/**
 * Sort the transparent-bucket entries by `(layer ASC, sortValue ASC,
 * insertion-order)` and return the reordered list.
 *
 * The world is consumed read-only for `getTransparentSortConfig(world)`
 * (D-2 `hasResource` guard, never throws); no entity / component mutation.
 *
 * Sort stability: Array.prototype.sort is stable per ES2019 — entries that
 * share `(layer, sortValue)` keep their insertion order. This matters for
 * tests that spawn entities in a specific order and expect that order to
 * survive the sort when no other ordering signal is present.
 *
 * @example mode=0 horizontal-z + 4 entries crossing 3 layers
 *   const out = transparentSortEntries(entries, world);
 *   // entries with lower layer first; within a layer, lower posZ first.
 *
 * @example mode=1 JRPG Y-sort, foot pivot
 *   world.insertResource(TRANSPARENT_SORT_CONFIG_KEY,
 *     { mode: TRANSPARENT_SORT_MODE_LAYER_Y, yzAlpha: 1.0 });
 *   const out = transparentSortEntries(entries, world);
 *   // entries with deeper foot-Y draw later (back-to-front).
 *
 * @example SortKey override
 *   // entry { layer: 0, posY: 10, pivotY: 0.5, sizeY: 1, sortKey: -99 }
 *   // -> uses sortValue = -99 instead of the mode formula, but layer
 *   //    remains the primary key (foreground entries still draw last).
 */
export function transparentSortEntries(
  entries: readonly TransparentEntry[],
  world: World,
  cameraPos?: readonly [number, number, number],
): readonly TransparentEntry[] {
  const n = entries.length;
  if (n === 0) return entries;

  const cfg = getTransparentSortConfig(world);
  const mode = cfg.mode;
  const yzAlpha = cfg.yzAlpha;

  // SoA pre-projection columns. Float64Array gives sub-ms / 10k bench
  // headroom over Object-of-Structs comparator (D-8); Int32Array carries
  // the signed i32 Layer.value verbatim (negatives preserved).
  const layers = new Int32Array(n);
  const sortVals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const e = entries[i] as TransparentEntry;
    layers[i] = e.layer;
    sortVals[i] = computeSortValue(e, mode, yzAlpha, cameraPos);
  }

  // indices argsort — Array.prototype.sort stability (ES2019+) preserves
  // insertion order when the comparator returns 0. We avoid TypedArray.sort
  // because its stability is not specified by the ECMAScript standard.
  const indices: number[] = new Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  indices.sort((a, b) => {
    const la = layers[a] as number;
    const lb = layers[b] as number;
    if (la !== lb) return la - lb;
    const va = sortVals[a] as number;
    const vb = sortVals[b] as number;
    if (va !== vb) return va < vb ? -1 : 1;
    return 0;
  });

  const sorted: TransparentEntry[] = new Array(n);
  for (let i = 0; i < n; i++) {
    sorted[i] = entries[indices[i] as number] as TransparentEntry;
  }
  return sorted;
}

/**
 * Per-entry sortValue projection. The 3 mode formulas + the SortKey
 * override are kept in a single branch ladder so V8 can inline the hot
 * path (research §Finding D-2 sort-loop pinning).
 *
 * mode!=0/1/2 is impossible at the helper entry by construction:
 * `setTransparentSortConfig` rejects out-of-range writes with
 * `ResourceInvalidValueError` (M-2 / w13) so the KV resource always holds
 * a valid mode; the `default` branch is a defensive fall-through to
 * mode=0 (horizontal-z, safe default; mirrors `getTransparentSortConfig`'s
 * KV-missing default).
 */
function computeSortValue(
  e: TransparentEntry,
  mode: number,
  yzAlpha: number,
  cameraPos?: readonly [number, number, number],
): number {
  if (e.sortKey !== undefined) return e.sortKey;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) {
    return -(e.posY - e.pivotY * e.sizeY);
  }
  if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) {
    return e.posY - e.pivotY * e.sizeY + yzAlpha * e.posZ;
  }
  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    // Squared-distance back-to-front: far objects draw first.
    // sortValue = -dist^2 so ASC comparator places far-first.
    if (cameraPos !== undefined) {
      const dx = e.posX - cameraPos[0];
      const dy = e.posY - cameraPos[1];
      const dz = e.posZ - cameraPos[2];
      return -(dx * dx + dy * dy + dz * dz);
    }
    // cameraPos missing fallback: use mode=0 posZ (defensive;
    // only reaches here when transparentSortEntries is called via
    // the 2-arg legacy path with mode=3. The 3-arg path with an
    // explicit cameraPos is the canonical API.)
    return e.posZ;
  }
  // TRANSPARENT_SORT_MODE_LAYER_Z (mode=0) + defensive default for any
  // out-of-range value that slipped past the helper guard.
  if (mode !== TRANSPARENT_SORT_MODE_LAYER_Z) {
    // Unreachable in practice — setTransparentSortConfig rejects writes
    // outside {0, 1, 2, 3} with ResourceInvalidValueError. Fall through to
    // the horizontal-z safe default (charter P3 explicit no-silent-coerce
    // is enforced by setTransparentSortConfig, not here; this fallback is
    // strictly defensive against direct world.insertResource writes that
    // bypass the typed helper).
    void mode;
  }
  return e.posZ;
}
