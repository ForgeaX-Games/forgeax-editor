// @forgeax/editor-edit-runtime — preview-character skin helpers.
//
// Utilities for the `forge.json preview.skin` character loaded into the editor
// viewport for animation preview / pose inspection. Kept dependency-light +
// world-loose (matching main.tsx's `as never` engine access).

import { Skin, Transform } from '@forgeax/engine-runtime';

/** Minimal world surface used here (mirrors main.tsx's loose engine access). */
interface LooseWorld {
  get(entity: unknown, component: unknown): { ok: boolean; value?: unknown };
  set(entity: unknown, component: unknown, data: unknown): unknown;
}

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
  world: LooseWorld,
  opts: { skinEntity: unknown; skinRoot: unknown; targetHeight?: number },
): boolean {
  const { skinEntity, skinRoot } = opts;
  const targetHeight = opts.targetHeight ?? 1.9;

  const skinRes = world.get(skinEntity, Skin);
  if (!skinRes.ok || !skinRes.value) return false;
  const joints = (skinRes.value as { joints?: ArrayLike<number> }).joints;
  if (!joints || joints.length === 0) return false;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let counted = 0;
  for (let i = 0; i < joints.length; i++) {
    const ent = joints[i];
    if (ent === undefined) continue;
    const tr = world.get(ent, Transform);
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
  const rootRes = world.get(skinRoot, Transform);
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

  world.set(skinRoot, Transform, {
    posX: -sNew * modelCenterX,
    posY: -sNew * modelMinY,
    posZ: -sNew * modelCenterZ,
    quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
    scaleX: sNew, scaleY: sNew, scaleZ: sNew,
  });
  return true;
}
