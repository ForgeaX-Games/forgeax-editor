// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/physics-rapier3d/__tests__/collision-event.test.ts
//   - packages/physics-rapier3d/__tests__/despawn-cleanup.test.ts
//   - packages/physics-rapier3d/__tests__/raycast-teleport.test.ts
//   - packages/physics-rapier3d/__tests__/tick-pipeline.test.ts
//   - packages/physics-rapier3d/__tests__/wasm-loader.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from __tests__/ into src/__tests__/; import paths adjusted (../src/xxx → ../xxx).

import { World } from '@forgeax/engine-ecs';
import { Collider, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld, registerPhysicsSystems } from '../rapier-physics-world-3d';
import { detectSimd3D, loadRapier3D } from '../wasm-loader';

{
  // ─── from collision-event.test.ts ───

  describe('collision-event.test.ts', () => {
    describe('feat-20260528 M2 t13 Rapier3D collision events', () => {
      it('two dynamic spheres fall and collide', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const b1 = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, -0.3),
        );
        b1.userData = 101;
        pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
          b1,
        );
        pw.registerBody(101, b1.handle);

        const b2 = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0.3));
        b2.userData = 102;
        pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
          b2,
        );
        pw.registerBody(102, b2.handle);

        for (let i = 0; i < 120; i++) {
          pw.step(1 / 60);
        }

        const pos1 = b1.translation();
        const pos2 = b2.translation();
        expect(pos1.y).toBeLessThan(1);
        expect(pos2.y).toBeLessThan(1);
      });

      it('userData can be read after setting', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));

        body.userData = 42;
        expect(body.userData).toBe(42);
      });

      it('ball bounces on ground without errors', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const ground = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
        ground.userData = 200;
        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setRestitution(0.3), ground);
        pw.registerBody(200, ground.handle);

        const ball = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        ball.userData = 201;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5).setRestitution(0.5), ball);
        pw.registerBody(201, ball.handle);

        for (let i = 0; i < 180; i++) {
          pw.step(1 / 60);
        }

        const pos = ball.translation();
        expect(pos.y).toBeLessThan(5);
      });
    });
  });
}

{
  // ─── from despawn-cleanup.test.ts ───

  describe('despawn-cleanup.test.ts', () => {
    describe('feat-20260528 M2 t14 Rapier3D entity despawn cleanup', () => {
      it('removeEntity reduces body count to zero', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        body.userData = 401;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
        pw.registerBody(401, body.handle);

        pw.step(1 / 60);
        expect(pw.getBodyCount()).toBeGreaterThan(0);

        pw.removeEntity(401);
        expect(pw.getBodyCount()).toBe(0);
      });

      it('multi-entity: remove one, others remain', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        for (let i = 0; i < 3; i++) {
          const body = pw.raw.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(i, 5, 0),
          );
          body.userData = 410 + i;
          pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
          pw.registerBody(410 + i, body.handle);
        }

        const countBefore = pw.getBodyCount();
        expect(countBefore).toBe(3);

        pw.removeEntity(410);
        expect(pw.getBodyCount()).toBe(2);
      });

      it('removeEntity on unknown entity does not throw', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1));

        pw.removeEntity(999);
        expect(pw.getBodyCount()).toBe(0);
      });
    });
  });
}

{
  // ─── from raycast-teleport.test.ts ───

  describe('raycast-teleport.test.ts', () => {
    describe('feat-20260528 M2 t13b Rapier3D raycast + teleport', () => {
      it('raycast: Rapier castRayAndGetNormal hits static ground', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const ground = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
        rw.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 10), ground);
        rw.step();

        const ray = new RAPIER.Ray({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 });
        const hit = rw.castRayAndGetNormal(ray, 100, true);

        expect(hit).toBeDefined();
        if (hit !== null) {
          const point = ray.pointAt(hit.timeOfImpact);
          expect(point.y).toBeLessThan(0);
          expect(point.y).toBeGreaterThan(-3);
          expect(hit.normal.y).toBeGreaterThan(0);
          expect(hit.timeOfImpact).toBeGreaterThan(0);
          expect(hit.timeOfImpact).toBeLessThan(100);
        }
      });

      it('raycast: Rapier castRay pointing away returns null', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const ground = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
        rw.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 10), ground);
        rw.step();

        const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
        const hit = rw.castRayAndGetNormal(ray, 100, true);

        expect(hit).toBeNull();
      });

      it('teleport: Rapier setTranslation + zero velocity', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));
        rw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);

        body.setTranslation({ x: 100, y: 100, z: 100 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);

        const pos = body.translation();
        expect(pos.x).toBeCloseTo(100, 0);
        expect(pos.y).toBeCloseTo(100, 0);
        expect(pos.z).toBeCloseTo(100, 0);
      });
    });
  });
}

{
  // ─── from tick-pipeline.test.ts ───

  describe('tick-pipeline.test.ts', () => {
    describe('feat-20260528 M2 t12 Rapier3D low-level primitives (kinematic teleport, despawn)', () => {
      it('kinematic body: position follows setNextKinematicTranslation', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0),
        );
        body.userData = 3;
        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1), body);
        pw.registerBody(3, body.handle);

        pw.setKinematicPosition(3, { x: 10, y: 3, z: 0 });

        for (let i = 0; i < 60; i++) {
          pw.step(1 / 60);
        }

        const posAfter = body.translation();
        expect(posAfter.x).toBeCloseTo(10, 0);
      });

      it('despawn: removeEntity reduces body count', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        body.userData = 4;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
        pw.registerBody(4, body.handle);

        pw.step(1 / 60);
        expect(pw.getBodyCount()).toBeGreaterThan(0);

        pw.removeEntity(4);
        expect(pw.getBodyCount()).toBe(0);
      });
    });

    describe('bug-20260529 M1 real ECS bridge (regression)', () => {
      it('dynamic ball falls + static ground unchanged through registerPhysicsSystems', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);

        const dynamicEntity = world
          .spawn(
            { component: Transform as never, data: { posX: 0, posY: 5, posZ: 0 } },
            {
              component: RigidBody as never,
              data: {
                type: RigidBodyTypeValue.dynamic,
                mass: 1,
                linearDamping: 0,
                angularDamping: 0,
                gravityScale: 1,
              },
            },
            {
              component: Collider as never,
              data: { shape: 1, radius: 0.5, friction: 0.5, restitution: 0 },
            },
          )
          .unwrap();

        const staticEntity = world
          .spawn(
            { component: Transform as never, data: { posX: 0, posY: 0, posZ: 0 } },
            {
              component: RigidBody as never,
              data: { type: RigidBodyTypeValue.static },
            },
            {
              component: Collider as never,
              data: {
                shape: 0,
                halfExtentsX: 10,
                halfExtentsY: 1,
                halfExtentsZ: 10,
                friction: 0.5,
                restitution: 0,
              },
            },
          )
          .unwrap();

        const initDynamic = world.get(dynamicEntity, Transform as never);
        const initStatic = world.get(staticEntity, Transform as never);
        expect(initDynamic.ok).toBe(true);
        expect(initStatic.ok).toBe(true);
        if (!initDynamic.ok || !initStatic.ok) return;
        const dynPosYBefore = (initDynamic.value as Record<string, number>).posY;
        expect(dynPosYBefore).toBeCloseTo(5, 1);

        registerPhysicsSystems(world, Transform as never);

        for (let i = 0; i < 60; i++) {
          world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
          world.update();
        }

        const finalDynamic = world.get(dynamicEntity, Transform as never);
        if (!finalDynamic.ok) {
          expect(finalDynamic.ok).toBe(true);
          return;
        }
        const dynPosYAfter = (finalDynamic.value as Record<string, number>).posY;
        expect(dynPosYAfter).toBeLessThan(4.5);

        const finalStatic = world.get(staticEntity, Transform as never);
        if (!finalStatic.ok) {
          expect(finalStatic.ok).toBe(true);
          return;
        }
        const staticPosYAfter = (finalStatic.value as Record<string, number>).posY;
        expect(staticPosYAfter).toBeCloseTo(0, 1);

        const bodyCount = pw.getBodyCount();
        expect(bodyCount).toBe(2);
      });
    });
  });
}

{
  // ─── from wasm-loader.test.ts ───

  describe('wasm-loader.test.ts', () => {
    describe('feat-20260528 M2 t10 Rapier3D WASM loader', () => {
      it('loadRapier3D should import and init rapier3d-compat returning a RAPIER instance', async () => {
        const result = await loadRapier3D();

        if ('code' in result) {
          expect(result.code).toBe('wasm-load-failed');
          return;
        }

        expect(result).toBeDefined();
        expect(typeof result.version).toBe('function');
      });

      it('loadRapier3D RAPIER instance should support World + RigidBody creation', async () => {
        const rapier = await loadRapier3D();

        if ('code' in rapier) {
          expect(rapier.code).toBe('wasm-load-failed');
          return;
        }

        const world2 = new rapier.World({ x: 0, y: -9.81, z: 0 });
        expect(world2).toBeDefined();

        const bodyDesc = rapier.RigidBodyDesc.dynamic()
          .setTranslation(0, 5, 0)
          .setLinearDamping(0.1)
          .setAngularDamping(0.1);
        const body = world2.createRigidBody(bodyDesc);
        expect(body).toBeDefined();
        expect(typeof body.handle).toBe('number');
        expect(body.handle).toBeGreaterThanOrEqual(0);

        const colliderDesc = rapier.ColliderDesc.ball(0.5).setFriction(0.5).setRestitution(0.3);
        const collider = world2.createCollider(colliderDesc, body);
        expect(collider).toBeDefined();
        expect(typeof collider.handle).toBe('number');
      });

      it('loadRapier3D should step simulation without errors', async () => {
        const rapier = await loadRapier3D();

        if ('code' in rapier) {
          expect(rapier.code).toBe('wasm-load-failed');
          return;
        }

        const world3 = new rapier.World({ x: 0, y: -9.81, z: 0 });
        const body = world3.createRigidBody(
          rapier.RigidBodyDesc.dynamic().setTranslation(0, 10, 0),
        );
        world3.createCollider(rapier.ColliderDesc.ball(0.5), body);

        for (let i = 0; i < 60; i++) {
          world3.step();
        }

        const pos = body.translation();
        expect(pos.y).toBeLessThan(10);
      });

      it('detectSimd3D should return a boolean', () => {
        const result = detectSimd3D();
        expect(typeof result).toBe('boolean');
      });

      it('detectSimd3D should return consistent results on repeated calls', () => {
        const first = detectSimd3D();
        const second = detectSimd3D();
        expect(first).toBe(second);
      });
    });
  });
}
