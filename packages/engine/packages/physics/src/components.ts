// @forgeax/engine-physics — ECS Component schemas.
//
// RigidBody and Collider are the two user-facing entry points; AI users
// spawn entities with these components to opt into physics simulation.
// CollidingEntities is the runtime set-query component for continuous
// collision status (started/stopped model, no 'continued' event).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * RigidBody motion type — 3-state discriminant mirroring Rapier's
 * Dynamic / Fixed / KinematicPositionBased triplet.
 *
 * `'static'`: infinite mass, never moves (Rapier Fixed).
 * `'dynamic'`: driven by forces, gravity, collisions (Rapier Dynamic).
 * `'kinematic'`: user-controlled position, velocity derived by engine
 *                (Rapier KinematicPositionBased).
 */
export type RigidBodyType = 'static' | 'dynamic' | 'kinematic';

/**
 * ECS Component: rigid body physics properties.
 *
 * AI user entry point — spawn with `world.spawn(RigidBody({ type: 'dynamic' }))`
 * to opt an entity into physics simulation.
 *
 * | Field | Type | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `type` | `RigidBodyType` | `'dynamic'` | Motion type discriminant |
 * | `mass` | `number` | `1.0` | Linear mass (> 0 for dynamic) |
 * | `linearDamping` | `number` | `0.0` | Velocity damping factor [0, 1] |
 * | `angularDamping` | `number` | `0.0` | Angular velocity damping [0, 1] |
 * | `gravityScale` | `number` | `1.0` | Per-body gravity multiplier |
 * | `ccdEnabled` | `boolean` | `false` | Continuous collision detection |
 */
export const RigidBody = defineComponent('RigidBody', {
  type: { type: 'enum', default: 1 },
  mass: { type: 'f32', default: 1 },
  linearDamping: { type: 'f32', default: 0 },
  angularDamping: { type: 'f32', default: 0 },
  gravityScale: { type: 'f32', default: 1 },
  ccdEnabled: { type: 'bool', default: false },
});

/**
 * Collider shape discriminant — 3 AI-friendly shape names.
 *
 * `'cuboid'`: box shape defined by half-extents (x, y, z).
 * `'sphere'`: sphere defined by radius.
 * `'capsule'`: capsule defined by half-height + radius.
 *
 * Named `'sphere'` not `'ball'` per plan-strategy D-5: AI users see
 * the familiar geometric term; backend maps to Rapier `ColliderDesc.ball()`.
 */
export type ColliderShape = 'cuboid' | 'sphere' | 'capsule';

// ─── D-3: numeric enum constants + narrowing helpers ─────────────────────
//
// Aligned with `packages/runtime/src/components/camera.ts:41-53`
// `cameraProjectionFromF32` pattern. The ECS `enum` field maps to `number`
// (Uint32Array column); these constants let AI users write
// `{ type: RigidBodyTypeValue.dynamic }` instead of bare magic numbers,
// and the narrowing helpers let backends switch cleanly on the string union.

/** Numeric value for static rigid body (Rapier Fixed). */
export const RIGID_BODY_TYPE_STATIC = 0;
/** Numeric value for dynamic rigid body (Rapier Dynamic). */
export const RIGID_BODY_TYPE_DYNAMIC = 1;
/** Numeric value for kinematic rigid body (Rapier KinematicPositionBased). */
export const RIGID_BODY_TYPE_KINEMATIC = 2;

export const RigidBodyTypeValue = {
  static: RIGID_BODY_TYPE_STATIC,
  dynamic: RIGID_BODY_TYPE_DYNAMIC,
  kinematic: RIGID_BODY_TYPE_KINEMATIC,
} as const;

export function rigidBodyTypeFromF32(n: number): RigidBodyType {
  if (n === RIGID_BODY_TYPE_DYNAMIC) return 'dynamic';
  if (n === RIGID_BODY_TYPE_KINEMATIC) return 'kinematic';
  return 'static';
}

/** Numeric value for cuboid collider shape. */
export const COLLIDER_SHAPE_CUBOID = 0;
/** Numeric value for sphere collider shape. */
export const COLLIDER_SHAPE_SPHERE = 1;
/** Numeric value for capsule collider shape. */
export const COLLIDER_SHAPE_CAPSULE = 2;

export const ColliderShapeValue = {
  cuboid: COLLIDER_SHAPE_CUBOID,
  sphere: COLLIDER_SHAPE_SPHERE,
  capsule: COLLIDER_SHAPE_CAPSULE,
} as const;

export function colliderShapeFromF32(n: number): ColliderShape {
  if (n === COLLIDER_SHAPE_SPHERE) return 'sphere';
  if (n === COLLIDER_SHAPE_CAPSULE) return 'capsule';
  return 'cuboid';
}

/**
 * ECS Component: collision geometry.
 *
 * Spawn alongside RigidBody to give an entity a collision shape. Entities
 * with Collider but no RigidBody are treated as static colliders (Rapier
 * native behavior — collider without parent body is fixed).
 *
 * | Field | Type | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `shape` | `ColliderShape` | — | Shape discriminant |
 * | `halfExtentsX` | `number` | `0.5` | Cuboid half-width |
 * | `halfExtentsY` | `number` | `0.5` | Cuboid half-height |
 * | `halfExtentsZ` | `number` | `0.5` | Cuboid half-depth |
 * | `radius` | `number` | `0.5` | Sphere / capsule radius |
 * | `halfHeight` | `number` | `0.5` | Capsule half-height |
 * | `friction` | `number` | `0.5` | Coulomb friction coefficient |
 * | `restitution` | `number` | `0.0` | Elasticity (1.0 = perfect bounce) |
 * | `density` | `number` | `1.0` | Mass density (alternative to mass) |
 * | `isSensor` | `bool` | `false` | Sensor mode (detect, no physical response) |
 * | `collisionGroups` | `u32` | `0x0001_FFFF` | 32-bit packed membership/filter |
 * | `solverGroups` | `u32` | `0xFFFF_FFFF` | 32-bit packed constraint groups |
 */
export const Collider = defineComponent('Collider', {
  shape: { type: 'enum', default: 0 },
  halfExtentsX: { type: 'f32', default: 0.5 },
  halfExtentsY: { type: 'f32', default: 0.5 },
  halfExtentsZ: { type: 'f32', default: 0.5 },
  radius: { type: 'f32', default: 0.5 },
  halfHeight: { type: 'f32', default: 0.5 },
  friction: { type: 'f32', default: 0.5 },
  restitution: { type: 'f32', default: 0 },
  density: { type: 'f32', default: 1 },
  isSensor: { type: 'bool', default: false },
  collisionGroups: { type: 'u32', default: 0x0001_ffff },
  solverGroups: { type: 'u32', default: 0xffff_ffff },
});

/**
 * ECS Component: set of entities currently colliding with the holder entity.
 *
 * Maintained by the physics tick systems — entities are added on collision
 * start (`CollisionEvent.started`) and removed on collision stop
 * (`CollisionEvent.stopped`). AI users query this component to know whose
 * colliders overlap right now without consuming per-frame events.
 *
 * This is the `'continued'` equivalent — no repeated per-frame events,
 * one component query per frame exposes the full active contact set
 * (plan-strategy D-3: CollidingEntities set-query mode).
 */
export const CollidingEntities = defineComponent('CollidingEntities', {
  entities: { type: 'array<entity>' },
});
