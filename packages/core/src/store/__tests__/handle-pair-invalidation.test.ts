// handle-pair-invalidation.test.ts (w22) — three-layer handle invalidation +
// the dual-world-same-live red-line construction (test-first RED, impl w25).
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M5.
//
// This is the FIRST red line of the whole feature (requirements AC-05): after a
// scene reload — and, more subtly, across two live worlds — a super-held handle
// must NEVER silently resolve to some OTHER live entity. The engine's per-entity
// generation guard (F5/RD3) does NOT defend against cross-world misuse: an
// editorWorld handle whose (index, generation) happens to also be live in the
// sceneWorld makes `World.get` silently return the sceneWorld entity. The super
// layer closes this by binding every handle to an explicit worldRef + epoch — a
// HANDLE PAIR — and validating it in three layers before any read/write:
//
//   Layer 1 (worldRef)   — cross-world misuse → code 'world-mismatch' (new, D-8).
//   Layer 2 (epoch)      — a whole-world reload bumped the binding epoch →
//                          code 'stale-entity-handle', detail.reason
//                          'world-epoch-mismatch' (batch invalidation, AC-05).
//   Layer 3 (generation) — same world, entity despawned/recycled → delegate to
//                          engine World.get, code 'stale-entity-handle',
//                          detail.reason 'stale-entity' (engine passthrough).
//
// The four it() below cover each layer plus the red-line "two worlds each spawn
// an entity so (index, gen) collide" construction — and PROVE the collision is
// real by first asserting that the raw engine `World.get` silently succeeds on
// the wrong world (the exact RD3 threat), then that validateHandlePair rejects it.
//
// RED until w25 implements handle-pair.ts.
//
// Anchors:
//   requirements AC-05 (scene reload handle batch invalidation — RED LINE)
//   requirements AC-06 (handle-misuse structured error)
//   plan-strategy §2 D-4 (three-layer validation = worldRef + epoch + engine gen)
//   plan-strategy §2 D-8 (real codes: stale-entity-handle + .detail.reason;
//     new world-mismatch; Δ-concept net +1)
//   research RD3 (engine generation does NOT defend cross-world misuse)

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../../scene/scene-types';
import {
  type HandlePair,
  type HandlePairBinding,
  validateHandlePair,
} from '../handle-pair';

// The stable worldRef indices (mirror WorldBinding.ts WORLD_REF_*): 0 = editor,
// 1 = scene. handle-pair.ts is world-agnostic — it only compares the numbers, so
// the test names them locally rather than reaching into edit-runtime (DAG).
const WORLD_REF_EDITOR = 0;
const WORLD_REF_SCENE = 1;

/** Spawn one Named entity and return its handle (throws on failure). */
function spawnNamed(world: World, name: string): EntityHandle {
  const r = world.spawn({ component: Name, data: { value: name } });
  if (!r.ok) throw new Error(`spawn failed: ${name}`);
  return r.value;
}

/** A binding is the (worldRef, epoch, world) triple validateHandlePair reads. */
function binding(worldRef: number, epoch: number, world: World): HandlePairBinding {
  return { worldRef, epoch, world };
}

describe('w22 — handle-pair three-layer invalidation', () => {
  // ── Layer 1: cross-world misuse → world-mismatch ──────────────────────────
  it('(1) world-mismatch: an editorWorld handle validated against the scene binding is rejected', () => {
    const editorWorld = new World();
    const sceneWorld = new World();
    const ent = spawnNamed(editorWorld, 'orbit-camera');

    const pair: HandlePair = { worldRef: WORLD_REF_EDITOR, epoch: 0, entity: ent };
    // Validate the editor pair against the SCENE binding (wrong world).
    const r = validateHandlePair(pair, binding(WORLD_REF_SCENE, 0, sceneWorld));

    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'world-mismatch') {
      // The self-rescue signal distinguishes a caller bug (fix world routing)
      // from a lifecycle event: it carries the expected vs actual worldRef.
      expect(r.error.detail.expectedWorldRef).toBe(WORLD_REF_SCENE);
      expect(r.error.detail.actualWorldRef).toBe(WORLD_REF_EDITOR);
      expect(typeof r.error.hint).toBe('string');
      expect(r.error.hint.length).toBeGreaterThan(0);
    } else {
      throw new Error(`expected world-mismatch, got ${r.ok ? 'ok' : r.error.code}`);
    }
  });

  // ── Layer 2: epoch bump → stale-entity-handle / world-epoch-mismatch ──────
  it('(2) epoch mismatch: a pair minted at epoch 0 fails once the binding advances to epoch 1', () => {
    const sceneWorld = new World();
    const ent = spawnNamed(sceneWorld, 'authored-cube');

    // Pair minted while the scene binding was at epoch 0.
    const pair: HandlePair = { worldRef: WORLD_REF_SCENE, epoch: 0, entity: ent };
    // A scene reload bumped the binding epoch to 1 (batch invalidation).
    const r = validateHandlePair(pair, binding(WORLD_REF_SCENE, 1, sceneWorld));

    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'stale-entity-handle') {
      // Reuses the editor's real code family (D-8), narrowed by detail.reason.
      expect(r.error.detail.reason).toBe('world-epoch-mismatch');
      expect(r.error.entity).toBe(ent);
    } else {
      throw new Error(`expected stale-entity-handle, got ${r.ok ? 'ok' : r.error.code}`);
    }
  });

  // ── Layer 3: engine generation (despawn) → stale-entity passthrough ───────
  it('(3) engine generation: after despawn the pair fails via engine stale-entity', () => {
    const sceneWorld = new World();
    const ent = spawnNamed(sceneWorld, 'doomed');
    const pair: HandlePair = { worldRef: WORLD_REF_SCENE, epoch: 0, entity: ent };

    // Same world, same epoch, but the entity is despawned — layers 1 & 2 pass,
    // layer 3 delegates to engine World.get which reports stale-entity.
    sceneWorld.despawn(ent);
    const r = validateHandlePair(pair, binding(WORLD_REF_SCENE, 0, sceneWorld));

    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'stale-entity-handle') {
      expect(r.error.detail.reason).toBe('stale-entity');
      expect(r.error.entity).toBe(ent);
    } else {
      throw new Error(`expected stale-entity-handle, got ${r.ok ? 'ok' : r.error.code}`);
    }
  });

  // ── Red line: two worlds each spawn so (index, gen) collide ───────────────
  it('(4) dual-world same-live: worldRef intercepts a handle that is coincidentally live in the other world (zero silent grab)', () => {
    const editorWorld = new World();
    const sceneWorld = new World();

    // First spawn in each fresh world yields identical (index=0, generation=0),
    // so the two handles are the SAME branded number — the RD3 collision.
    const editorEnt = spawnNamed(editorWorld, 'editor-entity');
    const sceneEnt = spawnNamed(sceneWorld, 'scene-entity');
    expect(editorEnt as unknown as number).toBe(sceneEnt as unknown as number);

    // PROVE the threat is real: the raw engine guard silently RESOLVES the
    // editor handle inside the scene world (returns the WRONG entity, ok=true).
    const silent = sceneWorld.get(editorEnt, Name);
    expect(silent.ok).toBe(true);
    if (silent.ok) expect(silent.value.value).toBe('scene-entity'); // wrong one!

    // The super layer closes the gap: the editor pair carries worldRef=EDITOR,
    // validated against the SCENE binding → intercepted at layer 1, never
    // reaching the engine generation check that would have grabbed the wrong one.
    const editorPair: HandlePair = { worldRef: WORLD_REF_EDITOR, epoch: 0, entity: editorEnt };
    const r = validateHandlePair(editorPair, binding(WORLD_REF_SCENE, 0, sceneWorld));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('world-mismatch');
  });

  // ── Happy path: matching worldRef + epoch + live entity ───────────────────
  it('(5) valid pair: matching worldRef + epoch on a live entity resolves ok', () => {
    const sceneWorld = new World();
    const ent = spawnNamed(sceneWorld, 'live-one');
    const pair: HandlePair = { worldRef: WORLD_REF_SCENE, epoch: 0, entity: ent };

    const r = validateHandlePair(pair, binding(WORLD_REF_SCENE, 0, sceneWorld));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entity).toBe(ent);
  });
});
