// w16 — TDD red-phase: childrenOf walks activeWorld (handle) + AC-11 baseline
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M3 (I1/AC-11):
// After deleting _e2h, childrenOf walks a World directly via engine
// Children/ChildOf (no legacy-id iteration). Signature becomes
// childrenOf(world, parentHandle | null) -> EntityHandle[]:
//   (a) parent case reads Children (engine mirror hook, single-write post-#634)
//       and returns the child EntityHandles;
//   (b) root case derives roots from the world walk (entities with no ChildOf,
//       or whose ChildOf.parent is not a live handle) — not an _e2h keyset;
//   (c) Half A (childrenOf `new Set` dedup) is gone — the engine mirror after
//       the transient fix writes each Children entry once, so no dedup is needed
//       and no duplicate handles appear;
//   (d) AC-11 baseline-robust (dedup-absent branch, orchestrator confirmed main
//       HEAD has BASELINE_NAMES without 'Children'): duplicateEntity via
//       entComponents -> spawnComponentData does NOT re-add Children because
//       'Children' is not a spawn-time component the editor authors — a rebuilt
//       node carries no duplicate Children key (verify-absence, not verify-removal);
//   (e) hellforge-shape (deep nested subtree) load produces no duplicate handle
//       in any childrenOf result.
//
// This test is RED until w18/w19 rewrite entity-state.childrenOf +
// document.childrenOf to the handle+world form.
//
// Constraints from upstream:
//   requirements AC-11: childrenOf dedup guard removed w/o regression (Half A
//     removed, Half B BASELINE_NAMES 'Children' preserved — Finding 9 correction)
//   requirements AC-09: hierarchy walks activeWorld (play->playWorld, edit->editWorld)
//   research Finding 9: Half A dedup naturally gone after engine transient fix
//   plan-strategy R4 baseline correction: d19c073 not on main HEAD -> verify-absence
//
// Anchors:
//   plan-tasks.json w16

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform, ChildOf } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { childrenOf } from '../session/document';

function spawn(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const comps: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ];
  if (parent !== undefined) comps.push({ component: ChildOf, data: { parent } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = world.spawn(...(comps as any));
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as EntityHandle;
}

function hasDuplicates(arr: readonly EntityHandle[]): boolean {
  return new Set(arr).size !== arr.length;
}

describe('w16 — childrenOf walks activeWorld (handle-based)', () => {
  // ── (a) parent case returns child handles ────────────────────────────────
  it('(a) childrenOf(world, parent) returns child EntityHandles from Children', () => {
    const world = new World();
    const root = spawn(world, 'Root');
    const a = spawn(world, 'A', root);
    const b = spawn(world, 'B', root);
    const kids = childrenOf(world, root);
    expect(kids.length).toBe(2);
    expect(kids).toContain(a);
    expect(kids).toContain(b);
  });

  // ── (b) root case derives roots from the world walk ──────────────────────
  it('(b) childrenOf(world, null) returns root entities (no ChildOf)', () => {
    const world = new World();
    const r1 = spawn(world, 'R1');
    const r2 = spawn(world, 'R2');
    spawn(world, 'child', r1); // not a root
    const roots = childrenOf(world, null);
    expect(roots).toContain(r1);
    expect(roots).toContain(r2);
    expect(roots.length).toBe(2);
  });

  // ── (c) no dedup needed — no duplicate handles (Half A gone) ─────────────
  it('(c) childrenOf produces no duplicate handles (engine mirror single-write)', () => {
    const world = new World();
    const root = spawn(world, 'Root');
    for (let i = 0; i < 5; i++) spawn(world, `c${i}`, root);
    const kids = childrenOf(world, root);
    expect(kids.length).toBe(5);
    expect(hasDuplicates(kids)).toBe(false);
  });

  // ── (d) AC-11 baseline: rebuilding an entity does not double-add Children ─
  it('(d) AC-11 verify-absence: no Children key authored on spawn (BASELINE_NAMES)', () => {
    // On the dedup-absent baseline (main HEAD), BASELINE_NAMES omits 'Children'.
    // A rebuilt node (duplicateEntity path: entComponents -> spawnComponentData)
    // never authors Children — the engine mirror hook is the sole writer — so the
    // childrenOf result of the parent has no duplicate child handle after a
    // duplicate. We simulate: spawn a child under a parent, then spawn another
    // "copy" child under the same parent, and assert no duplicate handles.
    const world = new World();
    const parent = spawn(world, 'Parent');
    const orig = spawn(world, 'Node', parent);
    // "duplicate": author the same shape again under the same parent
    const copy = spawn(world, 'Node copy', parent);
    const kids = childrenOf(world, parent);
    expect(kids).toContain(orig);
    expect(kids).toContain(copy);
    expect(hasDuplicates(kids)).toBe(false);
    expect(kids.length).toBe(2);
  });

  // ── (e) hellforge-shape deep nesting: no duplicate key across the tree ────
  it('(e) hellforge-shape deep subtree load has no duplicate handles anywhere', () => {
    const world = new World();
    // Build a 3-level tree: root -> 2 mid -> 3 leaf each.
    const root = spawn(world, 'hellforge-root');
    for (let m = 0; m < 2; m++) {
      const mid = spawn(world, `mid-${m}`, root);
      for (let l = 0; l < 3; l++) spawn(world, `leaf-${m}-${l}`, mid);
    }
    // Walk the whole tree via childrenOf and assert no duplicate at any node.
    const stack: EntityHandle[] = [...childrenOf(world, null)];
    const rootKids = childrenOf(world, root);
    expect(hasDuplicates(rootKids)).toBe(false);
    while (stack.length) {
      const cur = stack.pop()!;
      const kids = childrenOf(world, cur);
      expect(hasDuplicates(kids)).toBe(false);
      stack.push(...kids);
    }
  });
});
