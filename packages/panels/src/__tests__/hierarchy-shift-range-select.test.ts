// Hierarchy Shift+range selection unit test
//
// Verifies the flatVisibleOrder + handleShiftClick logic that powers
// Shift+click range selection and Ctrl+click individual toggle in the
// Hierarchy panel. Tests the pure computation (no React rendering).

import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  EditGateway,
  createEditSession,
  childrenOf,
  getSelection,
  getSelectionList,
  deleteManyCascade,
  gateway,
} from '@forgeax/editor-core';
import type { EditorOp, EditSession, EntityHandle } from '@forgeax/editor-core';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

const asHandle = (n: number): EntityHandle => n as EntityHandle;

// Mirror of the Hierarchy panel's flatVisibleOrder — walks the tree in
// display order, skipping collapsed subtrees. M3 (I1): keyed by EntityHandle,
// walks a World (gateway.activeWorld in the panel).
function flatVisibleOrder(
  world: World,
  collapsed: Set<EntityHandle>,
): EntityHandle[] {
  const result: EntityHandle[] = [];
  function walk(parentId: EntityHandle | null): void {
    for (const id of childrenOf(world, parentId)) {
      result.push(id);
      if (!collapsed.has(id)) walk(id);
    }
  }
  walk(null);
  return result;
}

// Simulates the Shift+click range selection logic from Hierarchy.tsx
function simulateShiftClick(
  gw: EditGateway,
  world: World,
  clickedId: EntityHandle,
  anchorId: EntityHandle | null,
  collapsed: Set<EntityHandle>,
): { newAnchor: EntityHandle | null } {
  const anchor = anchorId ?? getSelection();
  if (anchor === null) {
    gw.dispatch({ kind: 'setSelection', id: clickedId } as EditorOp);
    return { newAnchor: clickedId };
  }
  const order = flatVisibleOrder(world, collapsed);
  const ai = order.indexOf(anchor);
  const ci = order.indexOf(clickedId);
  if (ai < 0 || ci < 0) {
    gw.dispatch({ kind: 'setSelection', id: clickedId } as EditorOp);
    return { newAnchor: clickedId };
  }
  const lo = Math.min(ai, ci);
  const hi = Math.max(ai, ci);
  const range = order.slice(lo, hi + 1);
  gw.dispatch({ kind: 'setSelectionMany', ids: range } as EditorOp);
  return { newAnchor: anchorId };
}

describe('Hierarchy Shift+range selection', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
    gw.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
  });

  it('Ctrl+click toggles individual nodes', () => {
    gw.dispatch({ kind: 'setSelection', id: asHandle(1) } as EditorOp);
    expect([...getSelectionList()]).toEqual([asHandle(1)]);

    gw.dispatch({ kind: 'toggleSelection', id: asHandle(3) } as EditorOp);
    expect([...getSelectionList()]).toEqual([asHandle(1), asHandle(3)]);

    gw.dispatch({ kind: 'toggleSelection', id: asHandle(1) } as EditorOp);
    expect([...getSelectionList()]).toEqual([asHandle(3)]);
  });

  it('setSelectionMany replaces the entire selection', () => {
    gw.dispatch({ kind: 'setSelection', id: asHandle(1) } as EditorOp);
    gw.dispatch({ kind: 'setSelectionMany', ids: [2, 3, 4].map(asHandle) } as EditorOp);
    expect([...getSelectionList()]).toEqual([2, 3, 4].map(asHandle));
    expect(getSelection()).toBe(asHandle(4));
  });

  it('Shift+click with no anchor falls back to single select', () => {
    const result = simulateShiftClick(gw, gw.activeWorld, asHandle(5), null, new Set());
    expect(result.newAnchor).toBe(asHandle(5));
    expect([...getSelectionList()]).toEqual([asHandle(5)]);
  });

  it('Shift+click always produces continuous range', () => {
    for (let i = 0; i < 5; i++) {
      gw.dispatch({
        kind: 'spawnEntity',
        name: `E${i}`,
        parent: null,
        components: {},
      } as EditorOp);
    }

    const ids = childrenOf(gw.activeWorld, null);
    expect(ids.length).toBe(5);

    const anchor = ids[1]!;
    gw.dispatch({ kind: 'setSelection', id: anchor } as EditorOp);

    simulateShiftClick(gw, gw.activeWorld, ids[3]!, anchor, new Set());
    expect([...getSelectionList()]).toEqual([ids[1]!, ids[2]!, ids[3]!]);
  });

  it('Shift+click upward selects range in reverse direction', () => {
    for (let i = 0; i < 5; i++) {
      gw.dispatch({
        kind: 'spawnEntity',
        name: `E${i}`,
        parent: null,
        components: {},
      } as EditorOp);
    }

    const ids = childrenOf(gw.activeWorld, null);
    const anchor = ids[3]!;
    gw.dispatch({ kind: 'setSelection', id: anchor } as EditorOp);

    simulateShiftClick(gw, gw.activeWorld, ids[0]!, anchor, new Set());
    expect([...getSelectionList()]).toEqual([ids[0]!, ids[1]!, ids[2]!, ids[3]!]);
  });

  it('collapsed subtrees are skipped in flat order', () => {
    gw.dispatch({ kind: 'spawnEntity', name: 'Root', parent: null, components: {} } as EditorOp);
    const rootId = childrenOf(gw.activeWorld, null)[0]!;

    gw.dispatch({ kind: 'spawnEntity', name: 'Child1', parent: rootId, components: {} } as EditorOp);
    gw.dispatch({ kind: 'spawnEntity', name: 'Child2', parent: rootId, components: {} } as EditorOp);
    gw.dispatch({ kind: 'spawnEntity', name: 'Root2', parent: null, components: {} } as EditorOp);

    const roots = childrenOf(gw.activeWorld, null);
    const kids = childrenOf(gw.activeWorld, rootId);
    expect(roots.length).toBe(2);
    expect(kids.length).toBe(2);
    // M3 (I1): root order is the world-walk order (not spawn order); the OTHER
    // root is whichever isn't rootId.
    const otherRoot = roots.find((r) => r !== rootId)!;

    // Expected flat order derives from the actual root-walk order: each root
    // followed by its (open) children.
    const expectedOpen: EntityHandle[] = [];
    for (const r of roots) {
      expectedOpen.push(r);
      for (const c of childrenOf(gw.activeWorld, r)) expectedOpen.push(c);
    }
    const orderOpen = flatVisibleOrder(gw.activeWorld, new Set());
    expect(orderOpen).toEqual(expectedOpen);
    // The rootId subtree (2 kids) must appear expanded; both kids present.
    expect(orderOpen).toContain(kids[0]!);
    expect(orderOpen).toContain(kids[1]!);

    // Collapsing rootId hides its children — only the two roots remain, in
    // world-walk order.
    const orderCollapsed = flatVisibleOrder(gw.activeWorld, new Set([rootId]));
    expect(orderCollapsed).toEqual(roots);
    expect(orderCollapsed).not.toContain(kids[0]!);
    void otherRoot;
  });
});

describe('Hierarchy multi-select batch operations', () => {
  beforeEach(() => {
    gateway.replaceDoc(createSession());
    gateway.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
  });

  it('deleteManyCascade removes all selected entities', () => {
    for (let i = 0; i < 4; i++) {
      gateway.dispatch({ kind: 'spawnEntity', name: `E${i}`, parent: null, components: {} } as EditorOp);
    }
    const ids = childrenOf(gateway.activeWorld, null);
    expect(ids.length).toBe(4);

    const toDelete = [ids[1]!, ids[2]!];
    gateway.dispatch({ kind: 'setSelectionMany', ids: toDelete } as EditorOp);
    deleteManyCascade(toDelete);

    const remaining = childrenOf(gateway.activeWorld, null);
    expect(remaining.length).toBe(2);
    expect(remaining).toEqual([ids[0]!, ids[3]!]);
    expect(getSelection()).toBeNull();
  });

  it('deleteManyCascade with snapshot preserves correct targets', () => {
    for (let i = 0; i < 3; i++) {
      gateway.dispatch({ kind: 'spawnEntity', name: `E${i}`, parent: null, components: {} } as EditorOp);
    }
    const ids = childrenOf(gateway.activeWorld, null);
    const snapshot = [...ids];

    gateway.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
    deleteManyCascade(snapshot);

    expect(childrenOf(gateway.activeWorld, null).length).toBe(0);
  });

  it('visibility sync: setHidden dispatches successfully on multiple entities', () => {
    for (let i = 0; i < 3; i++) {
      gateway.dispatch({ kind: 'spawnEntity', name: `E${i}`, parent: null, components: {} } as EditorOp);
    }
    const ids = childrenOf(gateway.activeWorld, null);
    expect(ids.length).toBe(3);

    const r1 = gateway.dispatch({ kind: 'setHidden', entity: ids[0]!, hidden: true } as EditorOp);
    const r2 = gateway.dispatch({ kind: 'setHidden', entity: ids[1]!, hidden: true } as EditorOp);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const r3 = gateway.dispatch({ kind: 'setHidden', entity: ids[0]!, hidden: false } as EditorOp);
    const r4 = gateway.dispatch({ kind: 'setHidden', entity: ids[1]!, hidden: false } as EditorOp);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);

    const rNoop = gateway.dispatch({ kind: 'setHidden', entity: ids[2]!, hidden: false } as EditorOp);
    expect(rNoop.ok).toBe(true);
  });
});
