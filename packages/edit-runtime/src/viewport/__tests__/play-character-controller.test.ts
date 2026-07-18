// play-character-controller.test.ts (solo round-21, P7) — the editor ▶ Play world
// can drive a kinematic CharacterController with moveAndSlide end-to-end.
//
// Round-20 proved sensors/triggers; this is P7's next interaction leg — a walking
// character. moveAndSlide is the engine's unopinionated KCC movement primitive:
// the game layer computes a per-frame desiredDelta (input + gravity) and
// moveAndSlide resolves it against the level geometry, writing back Transform.pos
// + CharacterController.grounded. It requires a KINEMATIC RigidBody + a Collider +
// a CharacterController (engine physics-world.ts moveAndSlide contract).
//
// What this guards (the editor seam, not the engine primitive — that is already
// unit-tested in physics-rapier3d.unit.test.ts AC-01/02/03): the editor's
// assemblePlayWorld must produce a play world whose physics wiring builds the
// kinematic body AND runs the physics schedule so moveAndSlide resolves. A
// regression that dropped physicsPlugin from play-assemble (cf. round-15, which
// fixed the INVERSE leak — physics wrongly assembled into the EDIT world) would
// leave the character unable to move; this test reddens on it.
//
// Unlike round-20's CollidingEntities (component-level `transient` → stripped at
// save → needed an auto-inject fix), CharacterController.grounded is FIELD-level
// transient: the component + all tuning fields persist byte-faithful, only the
// engine-written `grounded` field is stripped and re-derived each move. So the KCC
// has no save→reopen→Play data-loss and needs no receiver injection — this test
// asserts the movement + writeback work, which is the whole capability.
//
// Anchors:
//   solo round-21 REPORT (moveAndSlide proven end-to-end through the editor door)
//   physics/physics-world.ts moveAndSlide contract (kinematic RigidBody+Collider+CC)
//   physics-rapier3d.unit.test.ts §moveAndSlide (engine-level AC-01/02/03)
//   play-sensor-receiver.test.ts (round-20 — the sibling this mirrors)

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import {
  CharacterController,
  Collider,
  RigidBody,
  RIGID_BODY_TYPE_STATIC,
  RIGID_BODY_TYPE_KINEMATIC,
} from '@forgeax/engine-physics';
import { assemblePlayWorld } from '../play-assemble';

function makeFakeRenderer() {
  return {
    ready: Promise.resolve({ ok: true }),
    assets: {
      instantiate() {
        return { ok: true as const, value: 1 };
      },
    },
    draw() {
      return { ok: true } as const;
    },
    dispose() {},
    onError(_cb: (e: unknown) => void) {
      return () => {};
    },
  };
}

// The PhysicsWorld resource surface this test drives (a subset of the engine
// PhysicsWorld interface — physics/physics-world.ts).
interface PhysicsWorldLike {
  hasBody(entity: number): boolean;
  moveAndSlide(entity: number, delta: ArrayLike<number>): ArrayLike<number>;
  getBodyCount(): number;
}

interface PlayWorldLike {
  spawn(...cd: unknown[]): { ok: boolean; value: number };
  get(e: number, c: unknown): { ok: boolean; value: { grounded: boolean; pos: ArrayLike<number> } };
  getResource(key: string): PhysicsWorldLike;
  insertResource(key: string, value: unknown): void;
  update(): void;
}

async function assembleKccWorld(): Promise<{ world: PlayWorldLike; pw: PhysicsWorldLike }> {
  const playWorld = new World();
  const renderer = makeFakeRenderer();
  const res = await assemblePlayWorld({
    renderer: renderer as never,
    loadDefaultScene: async () => null,
    resolveBootstrap: async () => null,
    attachInput: () => undefined,
    newWorld: () => playWorld as never,
    physics: 'rapier-3d',
  });
  expect(res.ok).toBe(true);
  const world = playWorld as unknown as PlayWorldLike;
  const pw = world.getResource('PhysicsWorld');
  return { world, pw };
}

// Step the real rapier sim N frames (PhysicsStepSimulation reads Time.dt), issuing
// `delta` each frame via moveAndSlide — the per-frame driver a game system runs.
// world.update() is stepped FIRST each frame so physicsSyncBackend builds the
// Rapier body (async fire-and-forget on first tick); moveAndSlide is then guarded
// with hasBody (the AI-user contract in physics-world.ts) — mirroring the
// hello-character / player-move guard that no-ops until the body exists.
function drive(world: PlayWorldLike, pw: PhysicsWorldLike, char: number, delta: number[], frames: number, startElapsed = 0): void {
  for (let i = 0; i < frames; i++) {
    world.insertResource('Time', { dt: 1 / 60, elapsed: startElapsed + (i + 1) / 60 });
    world.update();
    if (pw.hasBody(char)) pw.moveAndSlide(char, delta);
  }
}

describe('solo round-21 — editor ▶ Play drives a kinematic CharacterController (P7)', () => {
  it('moveAndSlide walks an open-ground character and writes grounded=true', async () => {
    const { world, pw } = await assembleKccWorld();

    // Static ground slab: top at y=0 (center -0.5, halfExtentY 0.5).
    world.spawn(
      { component: Transform, data: { pos: [0, -0.5, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_STATIC } },
      { component: Collider, data: { shape: 0, halfExtents: [10, 0.5, 10] } },
    );
    // Kinematic capsule character resting on the ground (capsule half-total 0.8).
    const char = world.spawn(
      { component: Transform, data: { pos: [0, 0.8, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_KINEMATIC } },
      { component: Collider, data: { shape: 2, radius: 0.3, halfHeight: 0.5 } },
      { component: CharacterController, data: {} },
    );
    expect(char.ok).toBe(true);
    if (!char.ok) return;

    // A few frames to let the async body build + establish ground contact.
    drive(world, pw, char.value, [0, -0.05, 0], 8);
    expect(pw.hasBody(char.value)).toBe(true);

    // Walk +X on open ground; the applied delta should track the request.
    const startX = readX(world, char.value);
    drive(world, pw, char.value, [0.05, -0.02, 0], 30, 8 / 60);
    const endX = readX(world, char.value);
    expect(endX - startX).toBeGreaterThan(1.0); // moved ~1.5 across 30 frames

    // grounded writeback: standing on the slab, the KCC reports grounded.
    const cc = world.get(char.value, CharacterController);
    expect(cc.ok).toBe(true);
    if (cc.ok) expect(cc.value.grounded).toBe(true);
  });

  it('moveAndSlide is blocked by a wall — no penetration (collision-aware)', async () => {
    const { world, pw } = await assembleKccWorld();

    world.spawn(
      { component: Transform, data: { pos: [0, -0.5, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_STATIC } },
      { component: Collider, data: { shape: 0, halfExtents: [10, 0.5, 10] } },
    );
    // Wall centered at x=3, half-extent x=0.5 → near face at x=2.5.
    world.spawn(
      { component: Transform, data: { pos: [3, 1, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_STATIC } },
      { component: Collider, data: { shape: 0, halfExtents: [0.5, 1, 4] } },
    );
    const char = world.spawn(
      { component: Transform, data: { pos: [0, 0.8, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_KINEMATIC } },
      { component: Collider, data: { shape: 2, radius: 0.3, halfHeight: 0.5 } },
      { component: CharacterController, data: {} },
    );
    expect(char.ok).toBe(true);
    if (!char.ok) return;

    drive(world, pw, char.value, [0, -0.05, 0], 8);
    // Push HARD into the wall for many frames — a naive teleport would clip through.
    drive(world, pw, char.value, [0.1, -0.02, 0], 80, 8 / 60);

    const finalX = readX(world, char.value);
    // The character stops short of the wall face minus its capsule radius
    // (2.5 - 0.3 = 2.2). Collision-aware: never reaches the wall center (x=3),
    // never clips through to the far side.
    expect(finalX).toBeLessThan(2.4);
    expect(finalX).toBeGreaterThan(1.8); // it DID travel toward the wall (not stuck at 0)
  });
});

function readX(world: PlayWorldLike, entity: number): number {
  const r = world.get(entity, Transform);
  return r.ok ? (r.value.pos[0] ?? 0) : 0;
}
