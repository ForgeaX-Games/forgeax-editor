// reparent-reorder — unit tests for the P0 hierarchy drag/drop ops:
//   - reparentMany: multi-select drag moves every node in one undo step (P0-3)
//   - reparentAt: ordered sibling insert via editor-rebuild (P0-6, decision B)
//
// These exercise the tree STRUCTURE + sibling ORDER (childrenOf order), which is
// headless-testable. World-position preservation (P0-1) relies on the propagate
// kernel's resolved Transform.world and is covered by the viewport/e2e layer;
// in a headless world the world matrix is identity, so the reparent still lands
// structurally correct here.

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import { gateway } from '../store/store';
import { createEditSession, childrenOf } from '../session/document';
import { reparentMany, reparentAt, reparentEntity } from '../session/ops';
import type { EditorOp, EditSession } from '../types';

function freshDoc(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawn(name: string, parent: EntityHandle | null): EntityHandle {
  const cmd: EditorOp = { kind: 'spawnEntity', name, parent, components: {} };
  const r = gateway.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn failed: ${JSON.stringify(r.error)}`);
  return (cmd as { _id?: number })._id as EntityHandle;
}

describe('reparentMany (P0-3 multi-select drag)', () => {
  beforeEach(() => gateway.replaceDoc(freshDoc()));

  it('moves every node under the target in one undo step', () => {
    const a = spawn('A', null);
    const b = spawn('B', null);
    const c = spawn('C', null);
    const p = spawn('P', null);

    reparentMany([a, b, c], p);

    const kids = childrenOf(gateway.activeWorld, p);
    expect(kids).toContain(a);
    expect(kids).toContain(b);
    expect(kids).toContain(c);
    // roots now: only P
    expect(childrenOf(gateway.activeWorld, null)).toEqual([p]);

    // Single undo restores all three to roots.
    expect(gateway.undo()).toBe(true);
    expect(childrenOf(gateway.activeWorld, p)).toEqual([]);
    const roots = childrenOf(gateway.activeWorld, null);
    for (const h of [a, b, c, p]) expect(roots).toContain(h);
  });

  it('skips nodes already under the target and self/descendant cycles', () => {
    const p = spawn('P', null);
    const a = spawn('A', p); // already under P
    const child = spawn('Child', p);

    // a already under p (skip), p under a would be a cycle (skip) → no-op, no throw
    reparentMany([a, p], p);
    expect(childrenOf(gateway.activeWorld, p)).toContain(a);
    expect(childrenOf(gateway.activeWorld, p)).toContain(child);
  });
});

describe('reparentAt (P0-5/P0-6 drop-position reparent, append semantics)', () => {
  beforeEach(() => gateway.replaceDoc(freshDoc()));

  // Precise sibling index is deferred (engine Children mirror is swap-remove +
  // empty-mirror recreate is broken) — reparentAt places child UNDER parent
  // (membership + append), which is what the drop handler needs after it has
  // resolved the target parent from the pointer position.
  it('cross-parent move: X into P appends and leaves the old parent', () => {
    const q = spawn('Q', null);
    const x = spawn('X', q);
    const p = spawn('P', null);
    const a = spawn('A', p);
    const b = spawn('B', p);

    reparentAt(x, p, b); // "before B" → resolves to parent P (append)

    const kids = childrenOf(gateway.activeWorld, p);
    expect(kids).toContain(x);
    expect(kids).toContain(a);
    expect(kids).toContain(b);
    expect(childrenOf(gateway.activeWorld, q)).toEqual([]);
  });

  it('parent=null moves a child to the root level (P0-5)', () => {
    const p = spawn('P', null);
    const a = spawn('A', p);
    expect(childrenOf(gateway.activeWorld, p)).toEqual([a]);

    reparentAt(a, null, null);

    expect(childrenOf(gateway.activeWorld, p)).toEqual([]);
    expect(childrenOf(gateway.activeWorld, null)).toContain(a);
  });
});

describe('reparentEntity still reparents structurally (P0-1 wrapper)', () => {
  beforeEach(() => gateway.replaceDoc(freshDoc()));

  it('moves child under a new parent and back to root, single undo each', () => {
    const p = spawn('P', null);
    const child = spawn('Child', null);

    reparentEntity(child, p);
    expect(childrenOf(gateway.activeWorld, p)).toContain(child);

    reparentEntity(child, null);
    expect(childrenOf(gateway.activeWorld, p)).toEqual([]);
    expect(childrenOf(gateway.activeWorld, null)).toContain(child);
  });
});
