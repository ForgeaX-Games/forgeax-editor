// w19 — notEditing freeze gameplay system TDD red test.
//
// Constructs an editor world with:
// - A gameplay system (runIf with positional tracker, no transform label)
// - A structure system (transform label)
// Injects EditMode resource (active=true), then:
//   1. notEditing(world) === true
//   2. Gameplay system with `and(originalRunIf, notEditing)` does NOT execute.
//   3. Structure system executes normally.
//
// Anchors:
//   plan-tasks.json w19: notEditing freeze gameplay system unit test (TDD red)
//   requirements AC-08: gameplay systems frozen, structure/render systems run
//   plan-strategy D-5: and() + EditMode + notEditing + label filtering
//   charter P3: explicit failure (system freeze is observable)
//   research Finding 6: frozen descriptor must be spread-rebuilt

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { World, defineComponent, defineSystem, getRegisteredSystems } from '@forgeax/engine-ecs';

import { and, notEditing } from '../run-conditions';
import { injectEditMode } from '../edit-mode';

// ── Test fixtures: define components + systems ───────────────────────────────

const Position = defineComponent('Position', {
  x: 'f32',
  y: 'f32',
});

const Transform = defineComponent('Transform', {
  posX: 'f32',
  posY: 'f32',
  posZ: 'f32',
  scaleX: 'f32',
  scaleY: 'f32',
  scaleZ: 'f32',
});

// ── Gameplay system: moves entity each frame (has runIf, no transform label) ──
// The runIf simply returns true (always run). We track execution via a counter.
let gameplayExecuted = 0;
export const PatrolSystem = defineSystem({
  name: 'PatrolSystem',
  queries: [{ with: [Position] }],
  labels: [], // No transform/render/animation label → gameplay
  runIf: (_world: World) => true,
  fn(_world: World, _results: never[], _commands: never) {
    gameplayExecuted += 1;
  },
});

// ── Structure system: runs every frame (has transform label) ──
let structureExecuted = 0;
export const TransformDebug = defineSystem({
  name: 'TransformDebug',
  queries: [{ with: [Transform] }],
  labels: ['transform'], // Has transform label → structure (not frozen)
  fn(_world: World, _results: never[], _commands: never) {
    structureExecuted += 1;
  },
});

// ── Test helpers ─────────────────────────────────────────────────────────────

function freshWorld(): World {
  const w = new World();
  // Reset counters.
  gameplayExecuted = 0;
  structureExecuted = 0;
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════════
// w19 — notEditing freeze tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('w19 — notEditing freeze gameplay system', () => {
  it('notEditing(world) returns true when EditMode is active', () => {
    const world = freshWorld();
    injectEditMode(world, true);
    expect(notEditing(world)).toBe(true);
  });

  it('notEditing(world) returns false when EditMode is inactive', () => {
    const world = freshWorld();
    injectEditMode(world, false);
    expect(notEditing(world)).toBe(false);
  });

  it('notEditing(world) returns false when EditMode resource is absent', () => {
    const world = freshWorld();
    // EditMode resource not injected → defaults to false.
    expect(notEditing(world)).toBe(false);
  });

  it('gameplay system with and(runIf, notEditing) does NOT execute when editing', () => {
    const world = freshWorld();

    // Spawn entities for query matching.
    const posToken = Position;
    const posRes = world.spawn({
      component: posToken,
      data: { x: 0, y: 0 },
    });
    expect(posRes.ok).toBe(true);

    const tRes = world.spawn({
      component: Transform,
      data: { posX: 0, posY: 0, posZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    });
    expect(tRes.ok).toBe(true);

    // Inject EditMode active.
    injectEditMode(world, true);

    // Get the frozen system handles and rebuild with notEditing.
    const patrolHandle = getRegisteredSystems().get('PatrolSystem')!;
    const transformHandle = getRegisteredSystems().get('TransformDebug')!;

    // Rebuild patrol (gameplay) with and(originalRunIf, notEditing).
    const patrolDesc = { ...patrolHandle, runIf: and(patrolHandle.runIf!, notEditing) };
    world.addSystem(patrolDesc);

    // Structure system runs unconditionally (no notEditing wrap).
    const transformDesc = { ...transformHandle };
    world.addSystem(transformDesc);

    // Run one frame.
    world.update();

    // Gameplay system should NOT have executed.
    expect(gameplayExecuted).toBe(0);

    // Structure system should have executed.
    expect(structureExecuted).toBe(1);
  });

  it('gameplay system executes when AND(originalRunIf, notEditing) and editing is false', () => {
    const world = freshWorld();

    // Spawn entity for query.
    const posRes = world.spawn({
      component: Position,
      data: { x: 0, y: 0 },
    });
    expect(posRes.ok).toBe(true);

    const tRes = world.spawn({
      component: Transform,
      data: { posX: 0, posY: 0, posZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    });
    expect(tRes.ok).toBe(true);

    // Inject EditMode inactive (editing disabled).
    injectEditMode(world, false);

    // Get handles.
    const patrolHandle = getRegisteredSystems().get('PatrolSystem')!;
    const transformHandle = getRegisteredSystems().get('TransformDebug')!;

    // Rebuild patrol with and(originalRunIf, notEditing).
    const patrolDesc = { ...patrolHandle, runIf: and(patrolHandle.runIf!, notEditing) };
    world.addSystem(patrolDesc);

    // Structure system runs as-is.
    const transformDesc = { ...transformHandle };
    world.addSystem(transformDesc);

    // Run one frame.
    world.update();

    // Both should have executed (editing is off → notEditing = false → patrol runs).
    expect(gameplayExecuted).toBe(1);
    expect(structureExecuted).toBe(1);
  });

  it('structure system with transform label executes unconditionally (not frozen)', () => {
    const world = freshWorld();

    const tRes = world.spawn({
      component: Transform,
      data: { posX: 0, posY: 0, posZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    });
    expect(tRes.ok).toBe(true);

    // Even with EditMode active, structure system should run.
    injectEditMode(world, true);

    const transformHandle = getRegisteredSystems().get('TransformDebug')!;
    // Structure system does NOT get notEditing — it runs unconditionally.
    world.addSystem(transformHandle);

    world.update();
    expect(structureExecuted).toBe(1);
  });
});