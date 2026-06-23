// @forgeax/engine-physics-rapier2d — RapierPhysicsWorld2D class and three-phase
// tick systems (syncBackend / stepSimulation / writeback).
//
// Mirrors packages/physics-rapier3d/ with 2D adaptations (research Finding 12):
//   - Vec2 instead of Vec3 for translations
//   - scalar angle instead of Quat for rotation
//   - Rapier2D world.step() (no z-axis)
//
// Three-phase pipeline (plan-strategy D-1):
//   1. syncBackend: apply pending teleports, update kinematic positions.
//   2. stepSimulation: call rapierWorld.step(eventQueue).
//   3. writeback: read Rapier body positions (dynamic only).

import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { Entity as EntityComponent } from '@forgeax/engine-ecs';
import { quat, type Vec2, type Vec3Like } from '@forgeax/engine-math';
import type { PhysicsWorld2D, RaycastHit2D } from '@forgeax/engine-physics';
import {
  Collider,
  colliderShapeFromF32,
  RigidBody,
  rigidBodyTypeFromF32,
} from '@forgeax/engine-physics';
import type { Rapier2DModule } from './wasm-loader';

interface PhysicsEntityRecord {
  bodyHandle: number;
}

// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierWorld2D = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierEventQueue = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierRigidBody2D = any;

export class RapierPhysicsWorld2D implements PhysicsWorld2D {
  readonly raw: RapierWorld2D;

  private readonly rapierModule: Rapier2DModule;

  /** Entity (raw number) -> PhysicsEntityRecord mapping. */
  private readonly entityMap = new Map<number, PhysicsEntityRecord>();

  /** Pending teleports: entity -> target position and rotation. */
  private readonly pendingTeleports = new Map<number, { x: number; y: number; rotation: number }>();

  private readonly eventQueue: RapierEventQueue;

  private currentGravity: { x: number; y: number };

  constructor(rapier: Rapier2DModule) {
    this.rapierModule = rapier;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World constructor is a class exported from a namespace module
    this.raw = new (rapier as any).World({ x: 0, y: -9.81 }) as RapierWorld2D;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier EventQueue constructor comes from a namespace module
    this.eventQueue = new (rapier as any).EventQueue(true) as RapierEventQueue;
    this.currentGravity = { x: 0, y: -9.81 };
  }

  // ─── PhysicsWorld2D interface ──────────────────────────────────────────

  setGravity(gravity: Vec2): void {
    const x = gravity[0] ?? 0;
    const y = gravity[1] ?? 0;
    this.raw.gravity = { x, y };
    this.currentGravity = { x, y };
  }

  getGravity(): Vec2 {
    const { x, y } = this.currentGravity;
    // biome-ignore lint/suspicious/noExplicitAny: Vec2 is a branded Float32Array
    return Float32Array.of(x, y) as any as Vec2;
  }

  raycast(
    origin: Vec2,
    direction: Vec2,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit2D | undefined {
    const RAPIER = this.rapierModule;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier Ray constructor comes from a namespace module
    const RayCtor = (RAPIER as any).Ray as new (
      origin: { x: number; y: number },
      dir: { x: number; y: number },
    ) => { pointAt(t: number): { x: number; y: number } };
    const ray = new RayCtor(
      { x: origin[0] ?? 0, y: origin[1] ?? 0 },
      { x: direction[0] ?? 0, y: direction[1] ?? 0 },
    );
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World castRayAndGetNormal (2D)
    const hit = (this.raw as any).castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      filterMask,
    ) as {
      collider: { parent(): number | null };
      timeOfImpact: number;
      normal: { x: number; y: number };
    } | null;

    if (hit === null) return undefined;

    const point = ray.pointAt(hit.timeOfImpact);
    const colliderParentBody = hit.collider.parent();
    let entity = 0;
    if (colliderParentBody !== null) {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies.get needs any-cast due to dynamic module type
      const body = (this.raw as any).bodies.get(colliderParentBody) as {
        userData: number;
      } | null;
      if (body !== null) {
        entity = body.userData;
      }
    }

    return {
      entity,
      // biome-ignore lint/suspicious/noExplicitAny: Vec2 brand cast
      point: Float32Array.of(point.x, point.y) as any as Vec2,
      // biome-ignore lint/suspicious/noExplicitAny: Vec2 brand cast
      normal: Float32Array.of(hit.normal.x, hit.normal.y) as any as Vec2,
      timeOfImpact: hit.timeOfImpact,
    };
  }

  teleport(entity: number, position: Vec2, rotation: number): void {
    this.pendingTeleports.set(entity, {
      x: position[0] ?? 0,
      y: position[1] ?? 0,
      rotation,
    });
  }

  step(deltaTime: number): void {
    void deltaTime;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
    (this.raw as any).step(this.eventQueue);
  }

  getBodyCount(): number {
    return this.entityMap.size;
  }

  // ─── ECS->Rapier bridge (D-2, 2D variant) ────────────────────────────

  /**
   * Ensure a Rapier 2D body and collider exist for an ECS entity (idempotent).
   *
   * 2D variant of the M1 3D ensureBody: Vec2 {x,y} instead of Vec3 {x,y,z},
   * Rapier2D ColliderDesc.{cuboid(hx,hy), ball(radius), capsule(halfHeight,radius)},
   * scalar rotation from transform quat (extracted via atan2 for z-axis angle).
   *
   * Plan-strategy C-3 symmetry with M1, D-2 + D-5 2D adaptations.
   */
  ensureBody(
    entity: number,
    transform: {
      posX: number;
      posY: number;
      quatX: number;
      quatY: number;
      quatZ: number;
      quatW: number;
    },
    rigidBody: {
      type: number;
      mass: number;
      linearDamping: number;
      angularDamping: number;
      gravityScale: number;
      ccdEnabled: number;
    },
    collider: {
      shape: number;
      halfExtentsX: number;
      halfExtentsY: number;
      halfExtentsZ: number;
      radius: number;
      halfHeight: number;
      friction: number;
      restitution: number;
      density: number;
      isSensor: number;
      collisionGroups: number;
      solverGroups: number;
    },
  ): void {
    if (this.entityMap.has(entity)) return;

    const RAPIER = this.rapierModule;

    // ── Create RigidBodyDesc (2D) ──
    const rbType = rigidBodyTypeFromF32(rigidBody.type);
    let body: RapierRigidBody2D;
    switch (rbType) {
      case 'dynamic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.dynamic()
          .setTranslation(transform.posX, transform.posY)
          .setLinearDamping(rigidBody.linearDamping)
          .setAngularDamping(rigidBody.angularDamping)
          .setGravityScale(rigidBody.gravityScale);
        if (rigidBody.mass > 0) {
          desc.setAdditionalMass(rigidBody.mass);
        }
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'static': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.fixed().setTranslation(
          transform.posX,
          transform.posY,
        );
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'kinematic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.kinematicPositionBased().setTranslation(
          transform.posX,
          transform.posY,
        );
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
    }

    body.userData = entity;
    this.registerBody(entity, body.handle);

    // ── Create ColliderDesc (2D) ──
    const cShape = colliderShapeFromF32(collider.shape);
    switch (cShape) {
      case 'cuboid': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.cuboid(
          collider.halfExtentsX,
          collider.halfExtentsY,
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'sphere': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.ball(collider.radius)
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'capsule': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.capsule(collider.halfHeight, collider.radius)
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
    }
  }

  // ─── ECS integration helpers ───────────────────────────────────────────

  registerBody(entity: number, bodyHandle: number): void {
    this.entityMap.set(entity, { bodyHandle });
  }

  applyPendingTeleports(): void {
    for (const [entity, target] of this.pendingTeleports) {
      const record = this.entityMap.get(entity);
      if (!record) continue;
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
      if (!body) continue;

      body.setTranslation({ x: target.x, y: target.y }, true);
      body.setLinvel({ x: 0, y: 0 }, false);
      body.setAngvel(0, false);
      if (target.rotation !== undefined) {
        body.setRotation(target.rotation, true);
      }
    }
    this.pendingTeleports.clear();
  }

  setKinematicPosition(entity: number, pos: { x: number; y: number }, rotation?: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
    if (!body) return;
    body.setNextKinematicTranslation({ x: pos.x, y: pos.y });
    if (rotation !== undefined) {
      body.setNextKinematicRotation(rotation);
    }
  }

  writebackDynamicBodies(): Array<{
    entity: number;
    pos: { x: number; y: number };
    rotation: number;
  }> {
    const results: Array<{
      entity: number;
      pos: { x: number; y: number };
      rotation: number;
    }> = [];
    for (const [entity, record] of this.entityMap) {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
      if (!body) continue;
      if (body.bodyType() !== this.rapierModule.RigidBodyType.Dynamic) continue;
      const translation = body.translation();
      const rotation = body.rotation();
      results.push({
        entity,
        pos: { x: translation.x, y: translation.y },
        rotation,
      });
    }
    return results;
  }

  removeEntity(entity: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeRigidBody
    (this.raw as any).removeRigidBody({
      handle: record.bodyHandle,
    } as RapierRigidBody2D);
    this.entityMap.delete(entity);
  }
}

export function createRapier2DPhysicsWorld(rapier: Rapier2DModule): RapierPhysicsWorld2D {
  return new RapierPhysicsWorld2D(rapier);
}

// ─── Internal archetype graph surface (mirrors advance-animation-player + 3D) ──
interface GraphLike {
  readonly archetypes: ReadonlyArray<ArchetypeLike | undefined>;
}
interface ArchetypeLike {
  readonly components: ReadonlyArray<{ readonly id: number }>;
  readonly columns: ReadonlyMap<
    number,
    ReadonlyMap<
      string,
      {
        readonly view:
          | Uint32Array
          | Float32Array
          | ReadonlyArray<Uint32Array>
          | ReadonlyArray<Float32Array>;
      }
    >
  >;
  readonly size: number;
}
interface InternalWorldSurface {
  /** @internal Archetype graph accessor mirrored from World; used for tick-system traversal. */
  _getGraph(): GraphLike;
}
function asInternal(w: World): InternalWorldSurface {
  return w as unknown as InternalWorldSurface;
}

/**
 * Read the full packed `Entity` handle for archetype `row` from the essential
 * id=0 `Entity` column (`self` field), present on every archetype.
 */
function readEntityAt(arch: ArchetypeLike, row: number): EntityHandle {
  const selfCol = arch.columns.get((EntityComponent as unknown as Component).id)?.get('self')
    ?.view as Uint32Array | undefined;
  return (selfCol?.[row] ?? 0) as EntityHandle;
}

/** dt upper bound (plan-strategy D-4): skip step if dt exceeds this. */
const PHYSICS_DT_MAX = 0.1;

/**
 * Register three-phase physics tick systems into an ECS World (2D variant).
 *
 * Mirrors registerPhysicsSystems from physics-rapier3d with 2D adaptations
 * (plan-strategy C-3 symmetry):
 *   - physicsSyncBackend2D:  after propagateTransforms — query (Transform,
 *     RigidBody, Collider) and call RapierPhysicsWorld2D.ensureBody for each.
 *   - physicsStepSimulation2D: after physicsSyncBackend2D — read Time.dt and
 *     call pw.step() with dt-gating.
 *   - physicsWriteback2D: after physicsStepSimulation2D — call
 *     pw.writebackDynamicBodies() and write positions + rotation back to ECS
 *     Transform (2D scalar angle -> quat via quat.fromAxisAngle z-axis).
 *
 * @param world              ECS World instance.
 * @param transformComponent The Transform component schema (from
 *                           @forgeax/engine-runtime, passed by caller to
 *                           avoid adding a runtime dependency to this package).
 */
export function registerPhysicsSystems2D(world: World, transformComponent: Component): void {
  // ── System name constants ──
  const PHYSICS_SYNC_BACKEND_2D = 'physicsSyncBackend2D' as const;
  const PHYSICS_STEP_SIMULATION_2D = 'physicsStepSimulation2D' as const;
  const PHYSICS_WRITEBACK_2D = 'physicsWriteback2D' as const;

  // ── physicsSyncBackend2D ─────────────────────────────────────────────
  world.addSystem({
    name: PHYSICS_SYNC_BACKEND_2D,
    queries: [],
    fn: () => {
      let pw: RapierPhysicsWorld2D;
      try {
        pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
      } catch {
        return; // C-2: PhysicsWorld resource not yet ready — safe early out
      }

      pw.applyPendingTeleports();

      const graph = asInternal(world)._getGraph();

      for (const arch of graph.archetypes) {
        if (!arch || arch.size === 0) continue;
        if (
          !arch.components.some((c) => c.id === RigidBody.id) ||
          !arch.components.some((c) => c.id === Collider.id) ||
          !arch.components.some((c) => c.id === transformComponent.id)
        ) {
          continue;
        }

        const rbCols = arch.columns.get(RigidBody.id);
        const cCols = arch.columns.get(Collider.id);
        const tfCols = arch.columns.get(transformComponent.id);
        if (!rbCols || !cCols || !tfCols) continue;

        const rbType = rbCols.get('type')?.view as Uint32Array | undefined;
        const rbMass = rbCols.get('mass')?.view as Float32Array | undefined;
        const rbLinDamp = rbCols.get('linearDamping')?.view as Float32Array | undefined;
        const rbAngDamp = rbCols.get('angularDamping')?.view as Float32Array | undefined;
        const rbGravScale = rbCols.get('gravityScale')?.view as Float32Array | undefined;
        const rbCcd = rbCols.get('ccdEnabled')?.view as Uint32Array | undefined;

        const cShape = cCols.get('shape')?.view as Uint32Array | undefined;
        const cHx = cCols.get('halfExtentsX')?.view as Float32Array | undefined;
        const cHy = cCols.get('halfExtentsY')?.view as Float32Array | undefined;
        const cHz = cCols.get('halfExtentsZ')?.view as Float32Array | undefined;
        const cRadius = cCols.get('radius')?.view as Float32Array | undefined;
        const cHalfH = cCols.get('halfHeight')?.view as Float32Array | undefined;
        const cFric = cCols.get('friction')?.view as Float32Array | undefined;
        const cRest = cCols.get('restitution')?.view as Float32Array | undefined;
        const cDens = cCols.get('density')?.view as Float32Array | undefined;
        const cSensor = cCols.get('isSensor')?.view as Uint32Array | undefined;
        const cCGroups = cCols.get('collisionGroups')?.view as Uint32Array | undefined;
        const cSGroups = cCols.get('solverGroups')?.view as Uint32Array | undefined;

        const tfPx = tfCols.get('posX')?.view as Float32Array | undefined;
        const tfPy = tfCols.get('posY')?.view as Float32Array | undefined;
        const tfQx = tfCols.get('quatX')?.view as Float32Array | undefined;
        const tfQy = tfCols.get('quatY')?.view as Float32Array | undefined;
        const tfQz = tfCols.get('quatZ')?.view as Float32Array | undefined;
        const tfQw = tfCols.get('quatW')?.view as Float32Array | undefined;

        if (
          !rbType ||
          !rbMass ||
          !rbLinDamp ||
          !rbAngDamp ||
          !rbGravScale ||
          !rbCcd ||
          !cShape ||
          !cHx ||
          !cHy ||
          !cHz ||
          !cRadius ||
          !cHalfH ||
          !cFric ||
          !cRest ||
          !cDens ||
          !cSensor ||
          !cCGroups ||
          !cSGroups ||
          !tfPx ||
          !tfPy
        ) {
          continue;
        }

        for (let row = 0; row < arch.size; row++) {
          const entity = readEntityAt(arch, row);

          const transform = {
            posX: tfPx[row] as number,
            posY: tfPy[row] as number,
            quatX: (tfQx?.[row] as number) ?? 0,
            quatY: (tfQy?.[row] as number) ?? 0,
            quatZ: (tfQz?.[row] as number) ?? 0,
            quatW: (tfQw?.[row] as number) ?? 1,
          };

          const rigidBody: {
            type: number;
            mass: number;
            linearDamping: number;
            angularDamping: number;
            gravityScale: number;
            ccdEnabled: number;
          } = {
            type: rbType[row] as number,
            mass: rbMass[row] as number,
            linearDamping: rbLinDamp[row] as number,
            angularDamping: rbAngDamp[row] as number,
            gravityScale: rbGravScale[row] as number,
            ccdEnabled: rbCcd[row] as number,
          };

          const collider: {
            shape: number;
            halfExtentsX: number;
            halfExtentsY: number;
            halfExtentsZ: number;
            radius: number;
            halfHeight: number;
            friction: number;
            restitution: number;
            density: number;
            isSensor: number;
            collisionGroups: number;
            solverGroups: number;
          } = {
            shape: cShape[row] as number,
            halfExtentsX: cHx[row] as number,
            halfExtentsY: cHy[row] as number,
            halfExtentsZ: cHz[row] as number,
            radius: cRadius[row] as number,
            halfHeight: cHalfH[row] as number,
            friction: cFric[row] as number,
            restitution: cRest[row] as number,
            density: cDens[row] as number,
            isSensor: cSensor[row] as number,
            collisionGroups: cCGroups[row] as number,
            solverGroups: cSGroups[row] as number,
          };

          pw.ensureBody(entity, transform, rigidBody, collider);

          // Kinematic position sync (2D).
          const rbTypeVal = rigidBodyTypeFromF32(rigidBody.type);
          if (rbTypeVal === 'kinematic') {
            pw.setKinematicPosition(entity, {
              x: transform.posX,
              y: transform.posY,
            });
          }
        }
      }
    },
    after: ['propagateTransforms'],
  });

  // ── physicsStepSimulation2D ──────────────────────────────────────────
  world.addSystem({
    name: PHYSICS_STEP_SIMULATION_2D,
    queries: [],
    fn: () => {
      let pw: RapierPhysicsWorld2D;
      try {
        pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
      } catch {
        return; // C-2: safe early out
      }

      let time: { dt: number } | undefined;
      try {
        time = world.getResource<{ dt: number }>('Time');
      } catch {
        // Time resource not ready — skip
      }

      const dt = time?.dt ?? 0;
      if (dt <= 0 || dt > PHYSICS_DT_MAX) return; // D-4: skip abnormal dt

      pw.step(dt);
    },
    after: [PHYSICS_SYNC_BACKEND_2D],
  });

  // ── physicsWriteback2D ───────────────────────────────────────────────
  world.addSystem({
    name: PHYSICS_WRITEBACK_2D,
    queries: [],
    fn: () => {
      let pw: RapierPhysicsWorld2D;
      try {
        pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
      } catch {
        return; // C-2: safe early out
      }

      const results = pw.writebackDynamicBodies();
      for (const r of results) {
        const entity = r.entity as EntityHandle;
        // D-5 2D variant: pos from {x,y}, rotation from scalar angle -> quat
        const outQuat = quat.create();
        // biome-ignore lint/suspicious/noExplicitAny: quat accepts Vec3 array
        quat.fromAxisAngle(outQuat, [0, 0, 1] as any as Vec3Like, r.rotation);
        world.set(entity, transformComponent, {
          posX: r.pos.x,
          posY: r.pos.y,
          quatX: outQuat[0],
          quatY: outQuat[1],
          quatZ: outQuat[2],
          quatW: outQuat[3],
        });
      }
    },
    after: [PHYSICS_STEP_SIMULATION_2D],
  });
}
