// play-sensor-receiver.test.ts (solo round-20, P7) — the editor ▶ Play world
// auto-injects the CollidingEntities receiver onto SENSOR colliders.
//
// The friction this guards: CollidingEntities is the physics set-query receiver,
// but the engine declares it component-level `transient:true` (a derived runtime
// view; persisting it would make instantiateScene double-write, AC-07/AC-08). So
// it is stripped by collect-scene-asset on saveDocToDisk and never reaches the
// disk-reloaded play world. The physics writeback (writebackCollidingEntities)
// fills the overlap set ONLY into entities that ALREADY carry CollidingEntities
// and skips the rest — so an AUTHORED sensor's set stayed empty forever in Play
// (Edit≠Play, the trigger never fires). A code game recovers by re-adding it in
// main.ts every session (collectathon spawnPlayer); the editor's author→save→Play
// flow has no such seam, so play-assemble must inject it.
//
// The fix derives receiver intent from what the entity IS — a Collider{isSensor:
// true} whose whole purpose is overlap detection (architecture §2.5: depend on the
// PERSISTING `isSensor` signal, not the stripped transient marker). A behavioral
// test: build a play world with physics wired, spawn a sensor + a non-sensor
// collider, tick the schedule once, and assert the sensor GAINED CollidingEntities
// while the non-sensor did NOT. Reverting the play-assemble injection turns it red.
//
// Anchors:
//   solo round-20 REPORT friction #1 (authored trigger receiver lost across save→Play)
//   rapier-physics-world-3d.ts writebackCollidingEntities (skips non-owners)
//   physics/components.ts CollidingEntities `transient:true` (deliberate, test-locked)

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import {
  Collider,
  CollidingEntities,
  RigidBody,
  RIGID_BODY_TYPE_STATIC,
  RIGID_BODY_TYPE_DYNAMIC,
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

describe('solo round-20 — editor ▶ Play injects CollidingEntities on sensors (P7)', () => {
  it('adds an empty CollidingEntities receiver to a sensor collider, not to a non-sensor', async () => {
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
    if (!res.ok) return;

    // Author a sensor + a non-sensor collider AFTER assembly (mirrors a scene the
    // play world instantiated). Neither carries CollidingEntities — exactly the
    // post-save→reopen state (transient stripped).
    const w = playWorld as unknown as {
      spawn(...cd: unknown[]): { ok: boolean; value: number };
      get(e: number, c: unknown): { ok: boolean };
      inspect(): { systems: ReadonlyArray<{ name: string }> };
      update(): void;
    };
    const sensor = w.spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: Collider, data: { shape: 0, isSensor: true } },
    );
    const solid = w.spawn(
      { component: Transform, data: { pos: [0, 5, 0] } },
      { component: Collider, data: { shape: 0, isSensor: false } },
    );
    expect(sensor.ok && solid.ok).toBe(true);
    if (!sensor.ok || !solid.ok) return;

    // The receiver system must be registered (structural half — reverting the
    // play-assemble addSystem drops it).
    const names = w.inspect().systems.map((s) => s.name);
    expect(names).toContain('sensor-colliding-entities-receiver');

    // Behavioral half: run the full schedule once (the receiver system runs before
    // physicsSyncBackend each frame, adding the receiver to sensors lacking it).
    w.update();

    // The sensor gained CollidingEntities; the non-sensor did not.
    expect(w.get(sensor.value, CollidingEntities).ok).toBe(true);
    expect(w.get(solid.value, CollidingEntities).ok).toBe(false);
  });

  it('end-to-end: an overlapping body appears in the injected sensor set (the trigger FIRES)', async () => {
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
    if (!res.ok) return;

    const w = playWorld as unknown as {
      spawn(...cd: unknown[]): { ok: boolean; value: number };
      get(e: number, c: unknown): { ok: boolean; value: { entities: ArrayLike<number> } };
      update(deltaSeconds: number): { unwrap(): void };
    };
    // A static SENSOR box at the origin (RigidBody{static} so it enters the sim) —
    // no CollidingEntities authored (the post-save→reopen state). A dynamic body
    // spawned INSIDE it (gravityScale 0 so it stays overlapping). After a few ticks
    // the sensor's injected set must contain the body's handle — the trigger fires.
    const zone = w.spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_STATIC } },
      { component: Collider, data: { shape: 0, halfExtents: [2, 2, 2], isSensor: true } },
    );
    const body = w.spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: RigidBody, data: { type: RIGID_BODY_TYPE_DYNAMIC, gravityScale: 0 } },
      { component: Collider, data: { shape: 1, radius: 0.5 } },
    );
    expect(zone.ok && body.ok).toBe(true);
    if (!zone.ok || !body.ok) return;

    // Step the real rapier sim a few frames. World owns and advances Time from
    // the delta passed to update(), matching the production app loop.
    // The receiver system injects CollidingEntities, then the collision events fill it.
    for (let i = 0; i < 6; i++) {
      w.update(1 / 60).unwrap();
    }

    const set = w.get(zone.value, CollidingEntities);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(Array.from(set.value.entities)).toContain(body.value);
  });
});
