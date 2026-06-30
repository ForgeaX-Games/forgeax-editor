// @forgeax/editor-edit-runtime — Socket (绑点) live preview wiring.
//
// Bridges the editor's SocketDoc (editor-core/socket-store) to the engine world:
// for a socket, it resolves the parent bone entity from the character's Skin,
// parents the prop entity under that bone (ChildOf), and upserts a `Socket`
// component carrying the bone-local TRS. The engine `applySocket` system then
// writes the prop's local Transform each frame and `propagateTransforms` derives
//   prop.world = bone.world × T·R·S
// giving 所见即所得 preview (开发文档 §6 / §8.1).
//
// This module is the integration SEAM. The host (main.tsx) owns the actual
// character/prop entities and the AnimationPlayer clip scrubber; it calls
// `applySocketToWorld` whenever the working doc changes (subscribe via
// editor-core `onSocketPreview`). Kept dependency-light + world-loose (matching
// main.tsx's existing `as never` engine access) so it can be wired without
// reshaping the engine boot.

import { ChildOf, Name, Skin, Socket, Transform } from '@forgeax/engine-runtime';
import { normalizeScale, type SocketDef } from '@forgeax/editor-core';

/** Minimal world surface used here (mirrors main.tsx's loose engine access). */
interface LooseWorld {
  get(entity: unknown, component: unknown): { ok: boolean; value?: unknown };
  set(entity: unknown, component: unknown, data: unknown): unknown;
  addComponent(entity: unknown, payload: { component: unknown; data: unknown }): unknown;
}

/** Resolve the joint entity for `boneName` from a Skin entity's joint list. */
export function resolveBoneEntity(world: LooseWorld, skinEntity: unknown, boneName: string): unknown | null {
  const skinRes = world.get(skinEntity, Skin);
  if (!skinRes.ok || !skinRes.value) return null;
  const joints = (skinRes.value as { joints?: ArrayLike<number> }).joints;
  if (!joints) return null;
  for (let i = 0; i < joints.length; i++) {
    const ent = joints[i];
    if (ent === undefined) continue;
    const nameRes = world.get(ent, Name);
    if (!nameRes.ok) continue;
    if ((nameRes.value as { value?: string }).value === boneName) return ent;
  }
  return null;
}

/**
 * Attach/refresh one socket on the prop entity: parent it under the resolved bone
 * and upsert the Socket component with the bone-local TRS. Returns false if the
 * bone could not be resolved (prop is left untouched).
 */
export function applySocketToProp(
  world: LooseWorld,
  opts: { skinEntity: unknown; propEntity: unknown; def: SocketDef },
): boolean {
  const { skinEntity, propEntity, def } = opts;
  const boneEntity = resolveBoneEntity(world, skinEntity, def.bone);
  if (boneEntity === null) return false;

  // Parent prop under the bone so propagate computes prop.world = bone.world × local.
  const childOfRes = world.get(propEntity, ChildOf);
  if (childOfRes.ok) world.set(propEntity, ChildOf, { parent: boneEntity });
  else world.addComponent(propEntity, { component: ChildOf, data: { parent: boneEntity } });

  const [sx, sy, sz] = normalizeScale(def.scale);
  const socketData = {
    boneName: def.bone,
    boneEntity,
    posX: def.position[0],
    posY: def.position[1],
    posZ: def.position[2],
    rotDegX: def.rotationEulerDegXYZ[0],
    rotDegY: def.rotationEulerDegXYZ[1],
    rotDegZ: def.rotationEulerDegXYZ[2],
    scaleX: sx,
    scaleY: sy,
    scaleZ: sz,
  };

  const socketRes = world.get(propEntity, Socket);
  if (socketRes.ok) world.set(propEntity, Socket, socketData);
  else world.addComponent(propEntity, { component: Socket, data: socketData });
  return true;
}

/** Resolved character + prop entity handles for the active preview. */
export interface SocketPreviewBinding {
  skinEntity: unknown;
  /** Map socket id → its prop entity. */
  propBySocketId: Map<string, unknown>;
}

/**
 * Normalize the preview character so it stands at the origin (需求 §4.1 "归一化
 * 居中落地"): scale the skin root so its largest dimension is `targetHeight`
 * meters, center it on X/Z, and ground its lowest point at Y=0.
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

/**
 * Apply all sockets in `defs` to their bound prop entities. Call this from the
 * host whenever the working SocketDoc changes (editor-core `onSocketPreview`).
 * Returns the ids that failed to resolve their bone (for surfacing warnings).
 */
export function applySocketsToWorld(
  world: LooseWorld,
  binding: SocketPreviewBinding,
  defs: readonly SocketDef[],
): string[] {
  const unresolved: string[] = [];
  for (const def of defs) {
    const propEntity = binding.propBySocketId.get(def.id);
    if (propEntity === undefined) continue;
    if (!applySocketToProp(world, { skinEntity: binding.skinEntity, propEntity, def })) {
      unresolved.push(def.id);
    }
  }
  return unresolved;
}
