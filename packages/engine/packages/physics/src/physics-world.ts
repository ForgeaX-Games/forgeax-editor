// @forgeax/engine-physics — PhysicsWorld Resource interface.
//
// The physics backend (RapierPhysicsWorld3D / RapierPhysicsWorld2D) implements
// this interface and registers as the 'PhysicsWorld' World Resource.
// AI users obtain it via `world.getResource<PhysicsWorld>('PhysicsWorld')`.

import type { Vec2, Vec3 } from '@forgeax/engine-math';

/**
 * Raycast hit result — returned by `PhysicsWorld.raycast()`.
 *
 * `entity`: the entity whose collider was hit.
 * `point`: world-space hit point.
 * `normal`: world-space surface normal at hit point.
 * `timeOfImpact`: ray parameter t (origin + direction * toi = hit point).
 */
export interface RaycastHit {
  entity: number;
  point: Vec3;
  normal: Vec3;
  timeOfImpact: number;
}

/**
 * PhysicsWorld Resource interface — the engine-side API surface for physics
 * operations. Backend implementations (RapierPhysicsWorld3D/2D) satisfy this
 * contract.
 *
 * Inserted as `'PhysicsWorld'` resource by `createApp` when `opts.physics`
 * is set. AI users retrieve via `world.getResource<PhysicsWorld>('PhysicsWorld')`.
 *
 * All mutation methods are synchronous; physics step is driven by the tick
 * systems (syncBackend → stepSimulation → writeback), not by user calls.
 */
export interface PhysicsWorld {
  /** Set world gravity vector. */
  setGravity(gravity: Vec3): void;

  /** Get current world gravity vector. */
  getGravity(): Vec3;

  /**
   * Cast a ray into the physics world and return the first hit.
   *
   * @param origin - world-space ray origin.
   * @param direction - normalized world-space ray direction.
   * @param maxDist - maximum ray distance (0 = infinite).
   * @param filterMask - 32-bit packed collision filter mask (optional).
   * @returns RaycastHit on hit, undefined on miss.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit | undefined;

  /**
   * Teleport a dynamic body to a position instantly, zeroing velocity.
   *
   * Use for spawning entities at specific locations or resetting after
   * out-of-bounds. Does not accumulate velocity from the displacement
   * (unlike `world.set(entity, Transform, { translation: ... })` on
   * dynamic bodies, which would cause a velocity spike).
   *
   * @param entity - the entity (must have RigidBody + Collider).
   * @param position - new world-space position.
   */
  teleport(entity: number, position: Vec3): void;

  /** Advance the physics simulation by one timestep. */
  step(deltaTime: number): void;

  /** Return the number of active rigid bodies in the physics world. */
  getBodyCount(): number;
}

/** 2D raycast hit result. */
export interface RaycastHit2D {
  entity: number;
  point: Vec2;
  normal: Vec2;
  timeOfImpact: number;
}

/** 2D PhysicsWorld Resource interface. */
export interface PhysicsWorld2D {
  setGravity(gravity: Vec2): void;
  getGravity(): Vec2;
  raycast(
    origin: Vec2,
    direction: Vec2,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit2D | undefined;
  teleport(entity: number, position: Vec2, rotation: number): void;
  step(deltaTime: number): void;
  getBodyCount(): number;
}
