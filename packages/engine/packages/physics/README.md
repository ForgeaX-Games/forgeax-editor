# @forgeax/engine-physics

Physics interface package: ECS component schemas, PhysicsWorld resource shape, error codes, and enum constants. Backend implementations live in `@forgeax/engine-physics-rapier3d` and `@forgeax/engine-physics-rapier2d`.

## Quick Start

Attach three components to an entity and the physics engine drives its position every frame:

```ts
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-runtime';

// Dynamic body: falls under gravity, responds to forces.
world.spawn(
  { component: Transform, data: { posX: 0, posY: 5, posZ: 0 } },
  { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1 } },
  { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
);

// Static body: immovable, ground/collision target.
world.spawn(
  { component: Transform, data: { posX: 0, posY: 0, posZ: 0 } },
  { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
  { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtentsX: 5, halfExtentsY: 1, halfExtentsZ: 5 } },
);
```

Enable physics when creating the app:

```ts
const app = await createApp(canvas, { physics: 'rapier-3d' });
```

## Three-Phase Tick Pipeline

Three ECS systems run in order every frame (registered by `createApp` when `physics` opt is set):

| Phase | System Name | Runs After | What It Does |
|:--|:--|:--|:--|
| 1. Sync | `physicsSyncBackend` | `propagateTransforms` | Iterates archetypes with (Transform, RigidBody, Collider); calls `ensureBody` to create Rapier bodies for new entities |
| 2. Step | `physicsStepSimulation` | `physicsSyncBackend` | Reads `Time.dt` resource; calls `PhysicsWorld.step()` to advance simulation (skips when dt <= 0 or > 0.1s) |
| 3. Writeback | `physicsWriteback` | `physicsStepSimulation` | Calls `writebackDynamicBodies()`; writes Rapier body positions back to ECS `Transform.posX/Y/Z` |

All three systems early-return safely when the `PhysicsWorld` resource is not yet available (WASM fire-and-forget load).

## Enum Constants and Narrowing Helpers

ECS `enum` fields map to `Uint32Array` numeric columns. Use named constants to avoid magic numbers:

### RigidBodyType

```ts
RigidBodyTypeValue.static    // 0
RigidBodyTypeValue.dynamic   // 1
RigidBodyTypeValue.kinematic // 2
```

Narrowing helper: `rigidBodyTypeFromF32(n: number): RigidBodyType` returns `'static' | 'dynamic' | 'kinematic'`.

### ColliderShape

```ts
ColliderShapeValue.cuboid  // 0
ColliderShapeValue.sphere  // 1
ColliderShapeValue.capsule // 2
```

Narrowing helper: `colliderShapeFromF32(n: number): ColliderShape` returns `'cuboid' | 'sphere' | 'capsule'`.

Backend implementations use the narrowing helpers in `switch` statements for exhaustive matching (no default arm).

## Component Schemas

### RigidBody

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `type` | `enum` | `0` (static) | `static` / `dynamic` / `kinematic` |
| `mass` | `f32` | `0` | Additional mass (dynamic only; collider mass comes from density) |
| `linearDamping` | `f32` | `0` | Velocity damping per second |
| `angularDamping` | `f32` | `0` | Angular velocity damping per second |
| `gravityScale` | `f32` | `1` | Multiplier for world gravity |
| `ccdEnabled` | `bool` | `false` | Continuous collision detection |

### Collider

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `shape` | `enum` | `0` (cuboid) | `cuboid` / `sphere` / `capsule` |
| `halfExtentsX/Y/Z` | `f32` | `0` | Cuboid half-extents |
| `radius` | `f32` | `0` | Sphere radius or capsule radius |
| `halfHeight` | `f32` | `0` | Capsule half-height (along Y) |
| `friction` | `f32` | `0.5` | Coulomb friction coefficient |
| `restitution` | `f32` | `0` | Bounciness (0 = inelastic, 1 = perfectly elastic) |
| `density` | `f32` | `1` | Mass per volume (affects dynamic body total mass) |
| `isSensor` | `bool` | `false` | Sensor-only collider (no contact response) |
| `collisionGroups` | `u32` | `0` | Rapier collision groups bitmask |
| `solverGroups` | `u32` | `0` | Rapier solver groups bitmask |

### CollidingEntities

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `entities` | `array<entity>` | `[]` | Set of entities currently colliding with the holder |

## Error Codes

`PhysicsErrorCode` (8 members, closed union). Exhaustive `switch` without `default`. SSOT: `packages/physics/src/errors.ts`.

## Architecture Notes

- **Not a backend**: this package defines interfaces and schemas only. Runtime simulation requires a backend (`@forgeax/engine-physics-rapier3d` or `@forgeax/engine-physics-rapier2d`).
- **ECS bridge**: backend packages call `registerPhysicsSystems(world, Transform)` to wire the three-phase tick pipeline into the ECS schedule.
- **Fire-and-forget**: WASM backends load asynchronously; entities spawned before load are picked up once the `PhysicsWorld` resource appears.
- **Component schemas SSOT**: `packages/physics/src/components.ts` is the authoritative definition for all physics component fields and types.
