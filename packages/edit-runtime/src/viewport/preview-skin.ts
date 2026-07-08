// @forgeax/editor-edit-runtime — preview-character skin helpers.
//
// Utilities for the `forge.json preview.skin` character loaded into the editor
// viewport for animation preview / pose inspection. Kept dependency-light +
// world-loose (matching main.tsx's `as never` engine access).

import { Skin, Transform } from '@forgeax/engine-runtime';
import type { EngineFacade, EntityHandle } from '@forgeax/editor-core';

/**
 * Normalize the preview character so it stands at the origin: scale the skin
 * root so its largest dimension is `targetHeight` meters, center it on X/Z, and
 * ground its lowest point at Y=0.
 *
 * Measures the live skeleton AABB from each joint's resolved world-matrix
 * translation (Transform.world[12..14]) — so it already reflects the current
 * pose + root transform. Requires `propagateTransforms` to have run at least
 * once (true after a few frames), and assumes an identity-rotation root + a
 * uniform root scale, which the preview-skin hook guarantees.
 *
 * Returns false when the skin/joints/root transform can't be read.
 */
export function normalizeSkinTransform(
  engine: EngineFacade,
  opts: { skinEntity: unknown; skinRoot: unknown; targetHeight?: number },
): boolean {
  // M3 t20 (S4 / AC-05): all engine access goes through the injected EngineFacade
  // (ctx.engine proxy). skinEntity / joint / skinRoot are opaque engine entity
  // handles (branded numbers minted by the engine instantiate path) — cast to the
  // facade's number-entity surface at this loose boundary (the editor's `as never`
  // discipline for handles it never inspects). The Transform normalize write is
  // now trace-visible; it is view scaffolding, so not undo/ledger.
  const { skinEntity, skinRoot } = opts;
  const targetHeight = opts.targetHeight ?? 1.9;
  // skinEntity / joint / skinRoot are opaque engine EntityHandles minted by the
  // engine instantiate path; brand them for the strict facade get/set surface.
  const eid = (h: unknown): EntityHandle => h as EntityHandle;

  const skinRes = engine.get(eid(skinEntity), Skin);
  if (!skinRes.ok || !skinRes.value) return false;
  const joints = (skinRes.value as { joints?: ArrayLike<number> }).joints;
  if (!joints || joints.length === 0) return false;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let counted = 0;
  for (let i = 0; i < joints.length; i++) {
    const ent = joints[i];
    if (ent === undefined) continue;
    const tr = engine.get(eid(ent), Transform);
    if (!tr.ok || !tr.value) continue;
    const m = (tr.value as { world?: ArrayLike<number> }).world;
    if (!m || m.length < 16) continue;
    const x = m[12] as number, y = m[13] as number, z = m[14] as number;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    counted++;
  }
  if (counted === 0) return false;

  // Current root transform (identity rotation, uniform scale assumed).
  const rootRes = engine.get(eid(skinRoot), Transform);
  if (!rootRes.ok || !rootRes.value) return false;
  const root = rootRes.value as { posX: number; posY: number; posZ: number; scaleX: number };
  const p = [root.posX, root.posY, root.posZ];
  const s = root.scaleX || 1;

  const worldHeight = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const sNew = (targetHeight * s) / worldHeight;

  // Convert the world AABB back into the root's unscaled model space, then place
  // the model so its center is at X=Z=0 and its floor (minY) is at Y=0.
  const centerWX = (minX + maxX) / 2;
  const centerWZ = (minZ + maxZ) / 2;
  const modelCenterX = (centerWX - p[0]!) / s;
  const modelCenterZ = (centerWZ - p[2]!) / s;
  const modelMinY = (minY - p[1]!) / s;

  engine.set(eid(skinRoot), Transform, {
    posX: -sNew * modelCenterX,
    posY: -sNew * modelMinY,
    posZ: -sNew * modelCenterZ,
    quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
    scaleX: sNew, scaleY: sNew, scaleZ: sNew,
  });
  return true;
}
